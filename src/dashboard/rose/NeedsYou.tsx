/**
 * The left sidebar: only what needs the operator, most urgent first, each answerable in place
 * (allow a permission, answer a draft's questions, decide, approve a lesson, …). Anything that
 * needs more room (editing a draft, withdrawing a decision, approving a run) stays in the full
 * view: the item links there.
 */
import React, { useEffect, useState } from "react";
import type { Lesson, Noticed, Run, Ticket } from "../../core/types";
import { lessonGroups, TicketWhy } from "../components";
import type { Dashboard, Draft, PendingPermission, RankedDecision } from "../state";
import { WRITER_BUSY } from "../state";

export type SidebarPetal = "waiting" | "drafts" | "decisions" | "lessons" | "noticed" | "proposed";

type Props = { d: Dashboard; onOpenRun: (runId: number) => void; onPetal: (id: SidebarPetal) => void };

/** Drafts the writer has stopped on: with questions first, then ones ready to save. */
function waitingDrafts(d: Dashboard): { asking: Draft[]; ready: Draft[] } {
  const idle = d.drafts.filter((x) => !WRITER_BUSY.includes(x.run.state) && x.run.state !== "failed");
  return { asking: idle.filter((x) => x.questions.length > 0), ready: idle.filter((x) => !x.questions.length && x.draft) };
}

/** How many items the sidebar shows (for the phone toggle). */
export function needsCount(d: Dashboard): number {
  const { asking, ready } = waitingDrafts(d);
  const { proposed, stale } = lessonGroups(d.lessons);
  const reviews = d.attention.waitingRuns.filter((r) => r.kind === "work" && r.state === "awaiting_review" && !d.pendingRuns.has(r.id));
  const tickets = d.board.find((c) => c.key === "proposed")?.items.length ?? 0;
  return d.pending.size + reviews.length + asking.length + ready.length + d.openDecisions.length + stale.length + proposed.length + d.noticed.length + tickets;
}

export function NeedsYou({ d, onOpenRun, onPetal, open }: Props & { open: boolean }) {
  const perms = [...d.pending.values()].sort((a, b) => a.runId - b.runId);
  const reviews = d.attention.waitingRuns.filter((r) => r.kind === "work" && r.state === "awaiting_review" && !d.pendingRuns.has(r.id));
  const { asking, ready } = waitingDrafts(d);
  const { proposed: lessons, stale } = lessonGroups(d.lessons);
  const tickets = d.board.find((c) => c.key === "proposed")?.items ?? [];
  const total = needsCount(d);
  return (
    <aside className={`needs-bar ${open ? "open" : ""}`} aria-label="Needs you">
      <h2 className="needs-head">
        Needs you <span className="needs-total">{total}</span>
      </h2>
      {total === 0 && <p className="needs-empty">Nothing needs you right now. New requests from runs, scouts and workers show up here.</p>}
      {perms.map((p) => (
        <PermItem key={p.req.id} d={d} p={p} onOpenRun={onOpenRun} />
      ))}
      {reviews.map((r) => (
        <ReviewItem key={r.id} d={d} r={r} onOpenRun={onOpenRun} />
      ))}
      {asking.map((x) => (
        <DraftItem key={x.run_id} d={d} x={x} onPetal={onPetal} />
      ))}
      {ready.map((x) => (
        <div className="needs-item needs-draft-ready" key={x.run_id}>
          <Kind tint="lemon" label="draft ready" />
          <div className="needs-title">{x.draft!.title}</div>
          <button className="btn sm" onClick={() => onPetal("drafts")}>
            Review &amp; save
          </button>
        </div>
      ))}
      {d.openDecisions.map((x) => (
        <DecisionItem key={`${x.id}-${x.version}`} d={d} x={x} onPetal={onPetal} />
      ))}
      {stale.map((l) => (
        <LessonItem key={l.id} d={d} l={l} stale />
      ))}
      {lessons.map((l) => (
        <LessonItem key={l.id} d={d} l={l} />
      ))}
      {d.noticed.map((n) => (
        <NoticedItem key={n.id} d={d} n={n} />
      ))}
      {tickets.map((t) => (
        <ProposedItem key={t.id} d={d} t={t} />
      ))}
    </aside>
  );
}

function Kind({ tint, label }: { tint: string; label: string }) {
  return <span className={`needs-kind tint-${tint}`}>{label}</span>;
}

function RunLink({ d, runId, onOpenRun }: { d: Dashboard; runId: number; onOpenRun: (runId: number) => void }) {
  const r = d.runs.get(runId);
  const title = r ? `#${r.ticket_id} ${d.tickets.get(r.ticket_id)?.title ?? ""}` : `run ${runId}`;
  return (
    <a
      className="needs-run"
      href={`#run-${runId}`}
      onClick={(e) => {
        e.preventDefault();
        onOpenRun(runId);
      }}
    >
      {title}
    </a>
  );
}

function PermItem({ d, p, onOpenRun }: { d: Dashboard; p: PendingPermission; onOpenRun: (runId: number) => void }) {
  const { req } = p;
  const what = req.tool === "Bash" ? String((req.input as any).command ?? "") : JSON.stringify(req.input, null, 2);
  const answer = (body: Parameters<Dashboard["answerPermission"]>[2]) => d.answerPermission(p.runId, req.id, body);
  return (
    <div className="needs-item needs-perm">
      <div className="needs-row">
        <Kind tint="rose" label="permission" />
        <RunLink d={d} runId={p.runId} onOpenRun={onOpenRun} />
      </div>
      <div>
        <code className="needs-tool">{req.tool}</code>
        {req.blockedPath && (
          <span className="muted">
            {" "}
            outside the workspace: <code>{req.blockedPath}</code>
          </span>
        )}
      </div>
      <pre className="needs-cmd">{what}</pre>
      {req.reason && <div className="needs-why">Why: {req.reason}</div>}
      <div className="row">
        <button className="btn sm ok allow-once" onClick={() => answer({ behavior: "allow" })}>
          Allow once
        </button>
        {req.canAlwaysAllow && (
          <button className="btn sm ok allow-run" onClick={() => answer({ behavior: "allow", always: true })}>
            Allow for this run
          </button>
        )}
        <button
          className="btn sm danger"
          onClick={() => {
            const message = prompt("Deny this request. Tell the agent why (optional):");
            if (message !== null) answer({ behavior: "deny", message: message || undefined });
          }}
        >
          Deny…
        </button>
      </div>
    </div>
  );
}

function ReviewItem({ d, r, onOpenRun }: { d: Dashboard; r: Run; onOpenRun: (runId: number) => void }) {
  return (
    <div className="needs-item needs-review">
      <div className="needs-row">
        <Kind tint="peach" label="review" />
        {r.gates_ok !== null && <span className={r.gates_ok ? "needs-ok" : "needs-bad"}>checks {r.gates_ok ? "passed" : "failed"}</span>}
      </div>
      <RunLink d={d} runId={r.id} onOpenRun={onOpenRun} />
    </div>
  );
}

function DraftItem({ d, x, onPetal }: { d: Dashboard; x: Draft; onPetal: (id: SidebarPetal) => void }) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const round = x.questions.map((q) => `${q.n}:${q.question}`).join("|");
  useEffect(() => setAnswers({}), [round]);
  const filled = x.questions.map((q) => ({ n: q.n, answer: (answers[q.n] ?? "").trim(), decide: false })).filter((a) => a.answer);
  return (
    <div className="needs-item needs-draft">
      <div className="needs-row">
        <Kind tint="lemon" label="draft" />
        <span className="muted needs-clip" title={x.prompt}>
          {x.repo} · {x.draft?.title ?? x.prompt}
        </span>
      </div>
      {x.questions.map((q) => (
        <div className="needs-q" key={q.n}>
          <div className="needs-title">{q.question}</div>
          {q.options.length > 0 && (
            <div className="row">
              {q.options.map((o) => (
                <button key={o} className={`btn sm ${answers[q.n] === o ? "primary" : ""}`} onClick={() => setAnswers((a) => ({ ...a, [q.n]: o }))}>
                  {o}
                </button>
              ))}
            </div>
          )}
          <input placeholder="Your answer" aria-label={`Answer to: ${q.question}`} value={answers[q.n] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.n]: e.target.value }))} />
        </div>
      ))}
      <div className="row">
        <button className="btn sm primary needs-send" disabled={!filled.length} onClick={() => d.draftAct(x.run_id, "answer", { answers: filled, note: "" })}>
          Send
        </button>
        <button className="btn sm needs-more" onClick={() => onPetal("drafts")}>
          Full view
        </button>
      </div>
    </div>
  );
}

function DecisionItem({ d, x, onPetal }: { d: Dashboard; x: RankedDecision; onPetal: (id: SidebarPetal) => void }) {
  const [text, setText] = useState("");
  const options = x.options.split("\n").map((o) => o.trim()).filter(Boolean);
  const held = x.held_tickets.map((t) => t.id);
  return (
    <div className="needs-item needs-decision">
      <div className="needs-row">
        <Kind tint="sky" label="decision" />
        {x.held > 0 && <span className="chip needs">holds {x.held}</span>}
        <span className="muted">{x.area}</span>
      </div>
      <div className="needs-title">{x.question}</div>
      {options.length > 0 && (
        <div className="row needs-options">
          {options.map((o) => (
            <button key={o} className="btn sm" title={o} onClick={() => setText(o)}>
              {o.length > 40 ? `${o.slice(0, 40)}…` : o}
            </button>
          ))}
        </div>
      )}
      <textarea rows={2} placeholder="Your decision; workers follow it" aria-label="Your decision" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <button
          className="btn sm primary needs-decide"
          disabled={!text.trim()}
          title={held.length ? "Held tickets go to todo; to drop some, use the full view" : undefined}
          onClick={() => d.decide(x.id, { decision: text.trim(), version: x.version, keep: held, drop: [] })}
        >
          Decide
        </button>
        <button className="btn sm needs-more" onClick={() => onPetal("decisions")}>
          Full view
        </button>
      </div>
    </div>
  );
}

function LessonItem({ d, l, stale }: { d: Dashboard; l: Lesson; stale?: boolean }) {
  return (
    <div className={`needs-item ${stale ? "needs-lesson-stale" : "needs-lesson"}`}>
      <div className="needs-row">
        <Kind tint="mint" label={stale ? "lesson to recheck" : "lesson"} />
        <span className="muted">
          L{l.id} · {l.repo}
        </span>
      </div>
      <div className="needs-text">{l.text}</div>
      {stale && <div className="muted">Trunk changed {(JSON.parse(l.stale!).paths as string[]).join(", ")}</div>}
      <div className="row">
        {stale ? (
          <>
            <button className="btn sm primary" onClick={() => d.lessonAct(l.id, "confirm")}>
              Still true
            </button>
            <button className="btn sm" onClick={() => d.lessonAct(l.id, "retire")}>
              Retire
            </button>
          </>
        ) : (
          <>
            <button className="btn sm primary" onClick={() => d.lessonAct(l.id, "approve")}>
              Approve
            </button>
            <button className="btn sm" onClick={() => d.lessonAct(l.id, "reject")}>
              Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function NoticedItem({ d, n }: { d: Dashboard; n: Noticed }) {
  return (
    <div className="needs-item needs-noticed">
      <div className="needs-row">
        <Kind tint="lilac" label="noticed" />
        <span className={`chip kind-${n.kind}`}>{n.kind}</span>
        {n.count > 1 && <span className="chip">×{n.count}</span>}
      </div>
      <div className="needs-title">{n.title}</div>
      {n.detail && <div className="muted needs-clip3">{n.detail}</div>}
      <div className="row">
        <button className="btn sm primary" onClick={() => d.noticedTicket(n.id)} title="Create a ticket from this report (marked as worker-written)">
          Make ticket
        </button>
        <button className="btn sm" onClick={() => d.noticedDismiss(n.id)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

function ProposedItem({ d, t }: { d: Dashboard; t: Ticket }) {
  const from = t.source === "work-request" ? "a worker asked" : t.source.startsWith("scout:") ? `${t.source.slice(6)} scout` : t.source;
  return (
    <div className="needs-item needs-proposed">
      <div className="needs-row">
        <Kind tint="aqua" label="proposed" />
        <span className="muted">
          {t.repo} · {from}
        </span>
        {t.confidence && <span className={`chip conf-${t.confidence}`}>{t.confidence}</span>}
      </div>
      <div className="needs-title">
        #{t.id} {t.title}
      </div>
      <TicketWhy t={t} />
      <div className="row">
        <button className="btn sm primary" onClick={() => d.acceptTicket(t.id)}>
          Accept
        </button>
        <button className="btn sm" onClick={() => d.rejectTicket(t.id)}>
          Reject
        </button>
      </div>
    </div>
  );
}
