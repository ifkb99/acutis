import type { HubMessage } from "../core/hub";

/**
 * Tell the operator when a run needs them: a permission request, or a run reaching review or
 * failing. Desktop notifications via notify-send (if installed), and/or a POST to a webhook such as
 * an ntfy.sh topic. ACUTIS_NOTIFY=off disables desktop notifications; ACUTIS_NOTIFY_URL sets the webhook.
 */
export function makeNotifier(opts: { port: number; desktop?: boolean; webhook?: string | null }) {
  const notifySend = opts.desktop === false ? null : Bun.which("notify-send");
  const webhook = opts.webhook ?? null;
  const send = (title: string, body: string, runId: number) => {
    const link = `http://127.0.0.1:${opts.port}/#run-${runId}`;
    if (notifySend) {
      Bun.spawn([notifySend, "--app-name=Acutis", title, `${body}\n${link}`], { stdout: "ignore", stderr: "ignore" });
    }
    if (webhook) {
      fetch(webhook, { method: "POST", body: `${body}\n${link}`, headers: { Title: title } }).catch(() => {});
    }
  };
  const enabled = Boolean(notifySend || webhook);
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
      }
    },
  };
}
