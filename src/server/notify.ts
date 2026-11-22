import type { HubMessage } from "../core/hub";

/**
 * Tell the operator when something needs them. A permission request, or a run reaching review or
 * failing, is sent at once. Questions (from scouts, contract requests) and proposed tickets (from
 * scouts, a worker's request_work) arrive in bursts, so they are batched: one notification once
 * things go quiet for a minute, and never more than five minutes after the first.
 * Desktop notifications via notify-send (if installed), and/or a POST to a webhook such as an
 * ntfy.sh topic. ACUTIS_NOTIFY=off disables desktop notifications; ACUTIS_NOTIFY_URL sets the webhook.
 */
export function makeNotifier(opts: {
  port: number;
  desktop?: boolean;
  webhook?: string | null;
  /** Batch questions and proposed tickets: send once things go quiet this long (ms)… */
  batchQuietMs?: number;
  /** …but no later than this after the first one. */
  batchMaxMs?: number;
  /** Replaces the desktop/webhook senders (tests). */
  sender?: (title: string, body: string, link: string) => void;
}) {
  const notifySend = opts.sender || opts.desktop === false ? null : Bun.which("notify-send");
  const webhook = opts.sender ? null : (opts.webhook ?? null);
  const pending = new Set<Promise<unknown>>();
  const send = (title: string, body: string, runId: number | null) => {
    const link = `http://127.0.0.1:${opts.port}/${runId === null ? "" : `#run-${runId}`}`;
    if (opts.sender) return opts.sender(title, body, link);
    if (notifySend) {
      Bun.spawn([notifySend, "--app-name=Acutis", title, `${body}\n${link}`], { stdout: "ignore", stderr: "ignore" });
    }
    if (webhook) {
      const p = fetch(webhook, { method: "POST", body: `${body}\n${link}`, headers: { Title: title } })
        .catch(() => {})
        .finally(() => pending.delete(p));
      pending.add(p);
    }
  };
  const enabled = Boolean(opts.sender || notifySend || webhook);

  // Questions for the operator and tickets waiting for them arrive in bursts (a scout files several
  // at once), so they are batched into one notification, sent when the burst settles.
  const batch = { questions: [] as string[], proposed: 0, first: 0 };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const q = batch.questions.length;
    const p = batch.proposed;
    if (!q && !p) return;
    const parts = [q ? `${q} question${q > 1 ? "s" : ""}` : "", p ? `${p} proposed ticket${p > 1 ? "s" : ""}` : ""].filter(Boolean);
    const lines = batch.questions.slice(0, 3).map((t) => `• ${t.slice(0, 120)}`);
    send(`Acutis: ${parts.join(" and ")} waiting for you`, [...lines, q > 3 ? `…and ${q - 3} more` : ""].filter(Boolean).join("\n"), null);
    batch.questions = [];
    batch.proposed = 0;
    batch.first = 0;
  };
  const queue = (question: string | null) => {
    if (question) batch.questions.push(question);
    else batch.proposed++;
    const now = Date.now();
    if (!batch.first) batch.first = now;
    if (timer) clearTimeout(timer);
    const quiet = opts.batchQuietMs ?? 60_000;
    const left = (opts.batchMaxMs ?? 5 * 60_000) - (now - batch.first);
    timer = setTimeout(flush, Math.max(0, Math.min(quiet, left)));
    timer.unref?.();
  };
  return {
    enabled,
    describe: () => [notifySend ? "desktop (notify-send)" : null, webhook ? "webhook" : null].filter(Boolean).join(" + ") || "off",
    handle(m: HubMessage) {
      if (!enabled || m.type !== "event") return;
      const { kind, data, run_id } = m.event;
      const d = data as any;
      if (kind === "permission.request") {
        const what = d.tool === "Bash" ? String(d.input?.command ?? "").slice(0, 120) : d.tool;
        send(`Acutis run ${run_id} needs permission`, what, run_id);
      } else if (kind === "run.state" && (d.to === "awaiting_review" || d.to === "failed")) {
        send(`Acutis run ${run_id}: ${d.to === "failed" ? "failed" : "ready for review"}`, d.reason ?? "", run_id);
      } else if (kind === "scout.decision") {
        queue(String(d.question ?? "a question"));
      } else if (kind === "contract.request") {
        queue(`Change the ${d.contract} contract: ${d.change}`);
      } else if ((kind === "scout.ticket" || kind === "work.request") && d.status === "proposed" && !d.existing) {
        queue(null);
      }
    },
    /** Send anything batched now and wait (up to timeoutMs) for webhook posts to finish: daemon shutdown. */
    async drain(timeoutMs = 2000) {
      flush();
      if (pending.size) await Promise.race([Promise.allSettled([...pending]), Bun.sleep(timeoutMs)]);
    },
  };
}
