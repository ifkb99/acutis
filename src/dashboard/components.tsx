/**
 * Panels and run view shared by every sample layout. They hold only local form state; data and
 * actions come from `useDashboard()` (state.ts). Class names are stable so each sample can style
 * them from its own scoped stylesheet.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Lesson, PermissionRequest, Run, RunEvent, Ticket } from "../core/types";
import { api, authHeaders } from "./api";
import { Markdown } from "./markdown";
import { LIVE_STATES, readPng, stateLabel, toolArg, type Dashboard, type DecideBody, type Draft, type DraftAction, type LessonAction, type RankedDecision } from "./state";

// ------------------------------------------------------------------- chrome

export function TokenPlaceholder() {
  return (
    <div className="placeholder token-placeholder">
      <p>This dashboard needs the Acutis API token.</p>
      <p>
        Open the link that <code>acutis serve</code> printed, or get it again with <code>acutis dashboard</code>.
      </p>
    </div>
  );
}

export function ErrorToast({ d }: { d: Dashboard }) {
  if (!d.error) return null;
  return (
    <div className="error-toast" role="alert" onClick={() => d.setError(null)} title="Dismiss">
      {d.error}
    </div>
  );
}

/** The offline and sandbox badges. */
export function Badges({ d }: { d: Dashboard }) {
  return (
    <div className="row badges">
      {!d.connected && <span className="badge off">offline</span>}
      {d.sandbox !== null && (
        <span
          className={`badge ${d.sandbox ? "on" : "off"}`}
          title={d.sandbox ? "bubblewrap sandbox active" : `Sandbox off: ${d.sandboxReason ?? "unavailable"}. Commands outside the allowlist ask you first.`}
        >
          sandbox {d.sandbox ? "on" : "off"}
        </span>
      )}
    </div>
  );
}

/** What to show where a run would be when none is selected. */
export function noRunHint(d: Dashboard): string {
  return d.repos.length === 0
    ? "No repos yet. Register one with: bun src/cli.ts repo add <path>"
    : "Create a ticket and press Start, or select a ticket to watch its run.";
}

/** The selected run, or the empty-state hint. */
export function SelectedRun({ d, empty }: { d: Dashboard; empty?: React.ReactNode }) {
  if (!d.run) return <div className="placeholder">{empty ?? noRunHint(d)}</div>;
  return <RunView key={d.run.id} run={d.run} ticket={d.tickets.get(d.run.ticket_id) ?? null} eventSink={d.eventSink} act={d.act} queuePos={d.queuePos} />;
}

/** Runs that need the operator: a permission request, or work waiting for review. */
export function WaitingRuns({ d, onOpen, exclude }: { d: Dashboard; onOpen?: (runId: number) => void; exclude?: number | null }) {
  const runs = d.attention.waitingRuns.filter((r) => r.id !== exclude);
  if (!runs.length) return null;
  return (
    <ul className="waiting">
      {runs.map((r) => (
        <li key={r.id}>
          <a
            href={`#run-${r.id}`}
            className={r.id === d.selected ? "sel" : ""}
            onClick={() => {
              d.setSelected(r.id);
              onOpen?.(r.id);
            }}
          >
            <span className={`chip ${d.pendingRuns.has(r.id) ? "needs" : r.state}`}>{d.pendingRuns.has(r.id) ? "permission" : "review"}</span>
            <span className="waiting-title">
              #{r.ticket_id} {d.tickets.get(r.ticket_id)?.title ?? ""}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------- tickets

export function NewTicket({ d }: { d: Dashboard }) {
  const { repos } = d;
  const [repo, setRepo] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  useEffect(() => {
    if (!repo && repos[0]) setRepo(repos[0].name);
  }, [repos, repo]);
  if (repos.length === 0) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await d.createTicket(repo, title, body)) {
      setTitle("");
      setBody("");
    }
  };
  return (
    <form className="newticket" onSubmit={submit}>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <select value={repo} onChange={(e) => setRepo(e.target.value)} style={{ width: "auto", maxWidth: "50%", flex: "0 0 auto" }} title={repo} aria-label="Repo">
          {repos.map((r) => (
            <option key={r.name}>{r.name}</option>
          ))}
        </select>
        <input placeholder="New ticket title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="New ticket title" />
      </div>
      <textarea placeholder="Description, acceptance criteria…" value={body} onChange={(e) => setBody(e.target.value)} aria-label="New ticket description" />
      <div className="row">
        <button className="btn" disabled={!title.trim()}>
          Add ticket
        </button>
        <button
          type="button"
          className="btn"
          disabled={!(title.trim() || body.trim())}
          title="The ticket writer reads the repo and turns this into a full ticket, asking you what only you can decide"
          onClick={async () => {
            await d.draftTicket(repo, [title.trim(), body.trim()].filter(Boolean).join("\n\n"));
            setTitle("");
            setBody("");
          }}
        >
          Draft with agent
        </button>
      </div>
    </form>
  );
}

/** Accept/reject a proposed ticket, or start a todo one. */
export function TicketButtons({ d, t }: { d: Dashboard; t: Ticket }) {
  if (t.status === "proposed")
    return (
      <>
        <button className="btn sm primary" onClick={(e) => (e.stopPropagation(), d.acceptTicket(t.id))}>
          Accept
        </button>
        <button className="btn sm" onClick={(e) => (e.stopPropagation(), d.rejectTicket(t.id))}>
          Reject
        </button>
      </>
    );
  if (t.status === "todo")
    return (
      <button className="btn sm primary" onClick={(e) => (e.stopPropagation(), d.startTicket(t.id))}>
        Start
      </button>
    );
  return null;
}

/** Why a scout filed it, or why a worker asked for it. */
export function TicketWhy({ t }: { t: Ticket }) {
  if (!((t.source.startsWith("scout:") || t.source === "work-request") && (t.status === "proposed" || t.status === "todo"))) return null;
  return (
    <details className="ticketbody" onClick={(e) => e.stopPropagation()}>
      <summary>{t.source === "work-request" ? "Why a worker asked for it" : "Why the scout filed it"}</summary>
      <Markdown text={t.body} />
    </details>
  );
}

/** A ticket on the board: its latest run's state, and accept/reject/start where they apply. */
export function TicketCard({ d, t }: { d: Dashboard; t: Ticket }) {
  const r = d.latestRun.get(t.id);
  return (
    <div className={`card ticket ${r && r.id === d.selected ? "sel" : ""} ${r ? "has-run" : ""}`} onClick={() => r && d.setSelected(r.id)}>
      <div className="t">
        #{t.id} {t.title}
      </div>
      <TicketWhy t={t} />
      <div className="meta">
        <span>{t.repo}</span>
        {r && <span className={`chip ${r.state}`}>{stateLabel(r, d.queuePos)}</span>}
        {r && d.pendingRuns.has(r.id) && <span className="chip needs">needs you</span>}
        {t.confidence && (
          <span className={`chip conf-${t.confidence}`} title={`Filed by ${t.source}`}>
            {t.confidence}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <TicketButtons d={d} t={t} />
      </div>
    </div>
  );
}

/** The ticket board as stacked columns. `only` limits it to some statuses. */
export function Board({ d, only, emptyText = "Nothing here." }: { d: Dashboard; only?: Ticket["status"][]; emptyText?: string }) {
  return (
    <>
      {d.board
        .filter((col) => !only || only.includes(col.key))
        .map((col) => {
          const { items } = col;
          if ((col.collapsed || col.hideEmpty) && items.length === 0) return null;
          const cards = items.map((t) => <TicketCard key={t.id} d={d} t={t} />);
          if (col.collapsed) {
            return (
              <details className={`col col-${col.key}`} key={col.key}>
                <summary>
                  <h2>
                    {col.label} · {items.length}
                  </h2>
                </summary>
                {cards}
              </details>
            );
          }
          return (
            <section className={`col col-${col.key}`} key={col.key}>
              <h2>
                {col.label} · {items.length}
              </h2>
              {items.length === 0 && <div className="empty">{emptyText}</div>}
              {cards}
            </section>
          );
        })}
    </>
  );
}

/** Operator guidance per repo. Stored in Acutis's DB (not the repo), appended to every worker's prompt. */
export function RepoNotes({ d, open }: { d: Dashboard; open?: boolean }) {
  const { repos } = d;
  const [repo, setRepo] = useState("");
  const [text, setText] = useState("");
  const current = repos.find((r) => r.name === repo);
  useEffect(() => {
    if (!repo && repos[0]) setRepo(repos[0].name);
  }, [repos, repo]);
  useEffect(() => setText(current?.notes ?? ""), [current?.name, current?.notes]);
  if (repos.length === 0) return null;
  const dirty = text !== (current?.notes ?? "");
  return (
    <details className="reponotes" open={open}>
      <summary>Operator notes for workers{current?.notes ? " ✓" : ""}</summary>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <select value={repo} onChange={(e) => setRepo(e.target.value)} style={{ width: "auto" }} aria-label="Repo">
          {repos.map((r) => (
            <option key={r.name}>{r.name}</option>
          ))}
        </select>
      </div>
      <textarea
        placeholder="Guidance every worker on this repo gets, e.g. “Use the Edit tool, not scripts, for file changes.”"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Operator notes"
      />
      <button className="btn" disabled={!dirty} onClick={() => d.saveNotes(repo, text)}>
        Save notes
      </button>
    </details>
  );
}

// ------------------------------------------------------------------- inbox lists

/** Ticket drafts the writer is working on or waiting with: answer its questions, edit, save. */
export function DraftsList({ d }: { d: Dashboard }) {
  return (
    <>
      {d.drafts.map((x) => (
        <DraftCard key={x.run_id} d={x} onAct={d.draftAct} onOpenRun={d.setSelected} />
      ))}
    </>
  );
}

/**
 * The decision register: open questions from scouts, the ones holding the most work first. The
 * operator writes the decision (it goes into every worker's prompt) and keeps or drops held tickets.
 */
export function DecisionsList({ d }: { d: Dashboard }) {
  return (
    <>
      {d.openDecisions.map((x) => (
        <DecisionCard key={`${x.id}-${x.version}`} d={x} onDecide={d.decide} onWithdraw={d.withdrawDecision} />
      ))}
      {d.decided.length > 0 && (
        <details className="decided">
          <summary className="muted">Decided · {d.decided.length}</summary>
          {d.decided.map((x) => (
            <div className="card decision-done" key={x.id}>
              {x.question && (
                <div className="muted">
                  #{x.id} {x.question}
                </div>
              )}
              <div>{x.decision}</div>
            </div>
          ))}
        </details>
      )}
    </>
  );
}

export function lessonGroups(items: Lesson[]) {
  return {
    proposed: items.filter((l) => l.status === "proposed"),
    stale: items.filter((l) => l.status === "approved" && l.stale),
    approved: items.filter((l) => l.status === "approved" && !l.stale),
  };
}

/** The Lessons heading. tests/e2e-lessons.test.ts reads it as `.lessons h2`, so every sample uses it. */
export function lessonsTitle(items: Lesson[]): string {
  const { proposed, stale } = lessonGroups(items);
  return `Lessons · ${proposed.length} proposed${stale.length ? ` · ${stale.length} to recheck` : ""}`;
}

/** Short how-tos for a repo: proposed ones to approve, stale ones to recheck, approved ones to retire. */
export function LessonsList({ d }: { d: Dashboard }) {
  const { proposed, stale, approved } = lessonGroups(d.lessons);
  const onAct = d.lessonAct;
  return (
    <>
      {stale.map((l) => (
        <div className="card lesson-item lesson-stale" key={l.id}>
          <div className="row">
            <span className="chip needs">recheck</span>
            <span className="muted">
              L{l.id} · {l.repo} · trunk changed {(JSON.parse(l.stale!).paths as string[]).join(", ")}
            </span>
          </div>
          <div>{l.text}</div>
          <div className="muted">Not given to runs until you confirm it's still true, or retire it.</div>
          <div className="row">
            <button className="btn primary" onClick={() => onAct(l.id, "confirm")}>
              Still true
            </button>
            <button className="btn" onClick={() => onAct(l.id, "retire")}>
              Retire
            </button>
          </div>
        </div>
      ))}
      {proposed.map((l) => (
        <LessonCard key={l.id} l={l} onAct={onAct} onOpenRun={d.setSelected} />
      ))}
      {approved.length > 0 && (
        <details className="approved">
          <summary className="muted">Approved · {approved.length}</summary>
          {approved.map((l) => (
            <div className="card lesson-done" key={l.id}>
              <div>
                L{l.id}: {l.text}
              </div>
              <div className="row">
                <span className="muted">
                  {l.repo} · given to {l.uses} run{l.uses === 1 ? "" : "s"}
                </span>
                <span style={{ flex: 1 }} />
                <button className="btn sm" onClick={() => onAct(l.id, "retire")} title="Stop giving this lesson to new runs">
                  Retire
                </button>
              </div>
            </div>
          ))}
        </details>
      )}
    </>
  );
}

/** Problems workers noticed outside their tickets: the operator makes a ticket or dismisses each. */
export function NoticedList({ d }: { d: Dashboard }) {
  return (
    <>
      {d.noticed.map((n) => (
        <div className="card noticed-item" key={n.id}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className={`chip kind-${n.kind}`}>{n.kind}</span>
            {n.count > 1 && (
              <span className="chip" title="Reports merged into this one">
                ×{n.count}
              </span>
            )}
          </div>
          <div className="title">{n.title}</div>
          {n.detail && <div className="detail">{n.detail.length > 240 ? `${n.detail.slice(0, 240)}…` : n.detail}</div>}
          <div className="row">
            <span className="muted">
              {n.repo} ·{" "}
              {n.run_ids
                .split(",")
                .filter(Boolean)
                .map((r) => (
                  <a key={r} href={`#run-${r}`} onClick={() => d.setSelected(Number(r))}>
                    run {r}{" "}
                  </a>
                ))}
            </span>
          </div>
          <div className="row">
            <button className="btn" onClick={() => d.noticedTicket(n.id)} title="Create a ticket from this report (marked as worker-written)">
              Make ticket
            </button>
            <button className="btn" onClick={() => d.noticedDismiss(n.id)}>
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

/** Start a scout on a repo; shows each scout's latest run. */
export function ScoutsList({ d }: { d: Dashboard }) {
  const { repos, scoutTypes: types, selected } = d;
  if (!repos.length || !types.length) return null;
  const runs = [...d.runs.values()];
  return (
    <>
      {repos.map((repo) => (
        <div className="card scout-repo" key={repo.name}>
          <div className="title">{repo.name}</div>
          {types.map((t) => {
            const last = runs.filter((r) => r.kind === "scout" && r.scout === t.id && r.repo === repo.name).sort((a, b) => b.id - a.id)[0];
            const running = last && LIVE_STATES.includes(last.state);
            return (
              <div className="row" key={t.id}>
                <span style={{ minWidth: 100 }}>{t.title}</span>
                {last && (
                  <a href={`#run-${last.id}`} className={last.id === selected ? "sel" : ""} onClick={() => d.setSelected(last.id)}>
                    <span className={`chip ${last.state}`}>{last.state.replace("_", " ")}</span> ≈${last.cost_usd.toFixed(2)}
                  </a>
                )}
                <span style={{ flex: 1 }} />
                <button className="btn sm" disabled={running} onClick={() => d.startScout(repo.name, t.id)}>
                  {running ? "Running" : "Run"}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

// ------------------------------------------------------------------- cards

export function DraftCard({ d, onAct, onOpenRun }: { d: Draft; onAct: (id: number, action: DraftAction, body?: unknown) => void; onOpenRun: (runId: number) => void }) {
  const busy = ["queued", "preparing", "running"].includes(d.run.state);
  const [title, setTitle] = useState(d.draft?.title ?? "");
  const [body, setBody] = useState(d.draft?.body ?? "");
  const [editing, setEditing] = useState(false);
  // The version loaded into the fields. Your edits (fields differing from it) are kept when the
  // writer revises; untouched fields follow the latest version.
  const [base, setBase] = useState(d.draft ?? null);
  const shown = base?.version ?? 0;
  const edited = Boolean(base) && (title !== base!.title || body !== base!.body);
  const load = (v: NonNullable<Draft["draft"]>) => {
    setTitle(v.title);
    setBody(v.body);
    setBase(v);
  };
  useEffect(() => {
    if (d.draft && d.draft.version !== shown && !edited) load(d.draft);
  }, [d.draft?.version]);
  const takeLatest = () => load(d.draft!);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [decide, setDecide] = useState<Record<number, boolean>>({});
  const [note, setNote] = useState("");
  const round = d.questions.map((q) => `${q.n}:${q.question}`).join("|");
  useEffect(() => {
    setAnswers({});
    setDecide({});
  }, [round]);
  const status = busy
    ? d.run.state === "queued"
      ? "queued"
      : "writing…"
    : d.run.state === "failed"
      ? "failed"
      : d.questions.length
        ? `${d.questions.length} question${d.questions.length > 1 ? "s" : ""} for you`
        : d.draft
          ? "ready"
          : "stopped";
  const chip = busy ? d.run.state : d.run.state === "failed" ? "failed" : d.questions.length ? "awaiting_review" : "done";
  const canSend = !busy && (note.trim() || Object.values(answers).some((a) => a.trim()));
  const send = () => {
    onAct(d.run_id, "answer", {
      answers: d.questions.map((q) => ({ n: q.n, answer: answers[q.n] ?? "", decide: Boolean(decide[q.n]) })).filter((a) => a.answer.trim()),
      note,
    });
    setNote("");
  };
  return (
    <div className="card draft-item">
      <div className="row">
        <span className={`chip ${chip}`}>{status}</span>
        <span className="muted">
          {d.repo} ·{" "}
          <a href={`#run-${d.run_id}`} onClick={() => onOpenRun(d.run_id)} title="The writer's run: what it read, and its cost">
            run {d.run_id}
          </a>{" "}
          · ≈${d.run.cost_usd.toFixed(2)}
        </span>
      </div>
      <div className="muted draft-prompt" title={d.prompt}>
        You asked: {d.prompt.length > 160 ? `${d.prompt.slice(0, 160)}…` : d.prompt}
      </div>
      {d.run.state === "failed" && d.run.error && <div className="detail err">{d.run.error}</div>}
      {busy && !d.draft && <div className="muted">Reading the repo{d.run.state === "queued" ? " once a run slot is free" : ""}…</div>}

      {d.questions.length > 0 && (
        <div className="draft-questions">
          {d.questions.map((q) => (
            <div className="draft-q" key={q.n}>
              <div className="title">
                Q{q.n}. {q.question}
              </div>
              {q.why && <div className="muted">{q.why}</div>}
              {q.options.length > 0 && (
                <div className="row">
                  {q.options.map((o) => (
                    <button key={o} className={`btn sm ${answers[q.n] === o ? "primary" : ""}`} disabled={busy} onClick={() => setAnswers((a) => ({ ...a, [q.n]: o }))}>
                      {o}
                    </button>
                  ))}
                </div>
              )}
              <input placeholder="Your answer" value={answers[q.n] ?? ""} disabled={busy} onChange={(e) => setAnswers((a) => ({ ...a, [q.n]: e.target.value }))} />
              <label className="muted" title="Kept as an operator decision that every later worker, scout and writer on this repo follows">
                <input type="checkbox" checked={Boolean(decide[q.n])} disabled={busy} onChange={(e) => setDecide((x) => ({ ...x, [q.n]: e.target.checked }))} /> Save as a repo decision
              </label>
            </div>
          ))}
        </div>
      )}

      {d.draft && (
        <div className="draft-body">
          {edited && d.draft.version !== shown && (
            <div className="row muted">
              The writer wrote v{d.draft.version}; you have edits on v{shown}.
              <button className="btn sm" onClick={takeLatest}>
                Use v{d.draft.version}
              </button>
            </div>
          )}
          <input className="draft-title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Ticket title" />
          {editing ? (
            <textarea value={body} rows={14} onChange={(e) => setBody(e.target.value)} aria-label="Ticket body" />
          ) : (
            <div className="draft-md">
              <Markdown text={body} />
            </div>
          )}
          <div className="row">
            <button className="btn sm" onClick={() => setEditing((x) => !x)}>
              {editing ? "Preview" : "Edit"}
            </button>
            <span className="muted">v{shown}{edited ? " · edited" : ""}</span>
          </div>
        </div>
      )}

      {!busy && (
        <textarea
          className="draft-note"
          placeholder={d.questions.length ? "Anything else for the writer (optional)" : "Ask for a revision, e.g. “split the tests into their own ticket”"}
          value={note}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
        />
      )}
      <div className="row">
        {busy ? (
          <button className="btn" onClick={() => onAct(d.run_id, d.run.state === "running" ? "stop" : "discard")} title={d.run.state === "running" ? "Stop this turn; the draft so far is kept" : "Drop this draft"}>
            {d.run.state === "running" ? "Stop" : "Discard"}
          </button>
        ) : (
          <>
            {(canSend || d.questions.length > 0) && (
              <button className="btn draft-send" disabled={!canSend} onClick={send}>
                {d.questions.length ? "Send answers" : "Revise"}
              </button>
            )}
            {!canSend && !d.questions.length && !d.draft && (
              <button className="btn" onClick={() => onAct(d.run_id, "continue")}>
                Continue
              </button>
            )}
            {d.draft && (
              <>
                <button className="btn primary" disabled={!title.trim()} onClick={() => onAct(d.run_id, "save", { title, body })} title="Add it to Todo">
                  Save ticket
                </button>
                <button className="btn" disabled={!title.trim()} onClick={() => onAct(d.run_id, "save", { title, body, start: true })}>
                  Save &amp; start
                </button>
              </>
            )}
            <button className="btn danger" onClick={() => onAct(d.run_id, "discard")}>
              Discard
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function DecisionCard({
  d,
  onDecide,
  onWithdraw,
}: {
  d: RankedDecision;
  onDecide: (id: number, body: DecideBody) => void;
  onWithdraw: (id: number) => void;
}) {
  const [text, setText] = useState("");
  const [keep, setKeep] = useState<Set<number>>(() => new Set(d.held_tickets.map((t) => t.id)));
  const options = d.options.split("\n").map((o) => o.trim()).filter(Boolean);
  return (
    <div className="card decision-item">
      <div className="row">
        <span className="chip">{d.area}</span>
        {d.held > 0 && <span className="chip needs">holds {d.held}</span>}
        <span className="muted">asked by {d.asked_by}</span>
      </div>
      <div className="title">{d.question}</div>
      {d.context && (
        <details>
          <summary className="muted">Context (from {d.asked_by === "worker" ? "a worker" : `the ${d.asked_by} scout`})</summary>
          <div className="detail">{d.context}</div>
        </details>
      )}
      {options.length > 0 && (
        <div className="row wrap">
          {options.map((o) => (
            <button key={o} className="btn sm" title="Start your decision from this suggestion" onClick={() => setText(o)}>
              {o.length > 60 ? `${o.slice(0, 60)}…` : o}
            </button>
          ))}
        </div>
      )}
      {d.held_tickets.length > 0 && (
        <div className="held">
          <div className="muted">Tickets waiting on this (checked go to todo, unchecked are dropped):</div>
          {d.held_tickets.map((t) => (
            <label key={t.id} className="row">
              <input
                type="checkbox"
                checked={keep.has(t.id)}
                onChange={(e) =>
                  setKeep((prev) => {
                    const n = new Set(prev);
                    e.target.checked ? n.add(t.id) : n.delete(t.id);
                    return n;
                  })
                }
              />
              #{t.id} {t.title}
            </label>
          ))}
        </div>
      )}
      <textarea
        placeholder="Your decision, written to stand alone (e.g. 'Support phones from 390px wide.'); workers follow it"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
      />
      <div className="row">
        <button className="btn primary" disabled={!text.trim()} onClick={() =>
            onDecide(d.id, {
              decision: text.trim(),
              version: d.version,
              keep: [...keep],
              drop: d.held_tickets.map((t) => t.id).filter((id) => !keep.has(id)),
            })
          }>
          Decide
        </button>
        <button className="btn" onClick={() => onWithdraw(d.id)} title="Drop the question; held tickets go back to Proposed">
          Withdraw
        </button>
      </div>
    </div>
  );
}

export function LessonCard({ l, onAct, onOpenRun }: { l: Lesson; onAct: (id: number, action: LessonAction, text?: string) => void; onOpenRun: (runId: number) => void }) {
  const [text, setText] = useState(l.text);
  const from = l.source === "draft" ? "drafted from a run's report" : l.source === "worker" ? "a worker" : l.source.startsWith("scout:") ? `the ${l.source.slice(6)} scout` : l.source;
  return (
    <div className="card lesson-item">
      <div className="row">
        <span className="muted">
          L{l.id} · {l.repo} · from {from}
          {l.run_id && (
            <>
              {" "}
              (
              <a href={`#run-${l.run_id}`} onClick={() => onOpenRun(l.run_id!)}>
                run {l.run_id}
              </a>
              )
            </>
          )}
        </span>
      </div>
      <textarea className="lesson-text" value={text} rows={3} maxLength={300} onChange={(e) => setText(e.target.value)} />
      {l.evidence && (
        <details>
          <summary className="muted">Evidence (agent-written)</summary>
          <div className="detail">{l.evidence}</div>
        </details>
      )}
      <div className="row">
        <button className="btn primary" onClick={() => onAct(l.id, "approve", text.trim() === l.text ? undefined : text)} title="Approved lessons go into later runs' instructions">
          Approve
        </button>
        <button className="btn" onClick={() => onAct(l.id, "reject")}>
          Reject
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- run view

export function RunView({
  run,
  ticket,
  eventSink,
  act,
  queuePos,
}: {
  run: Run;
  ticket: Ticket | null;
  eventSink: React.MutableRefObject<((e: RunEvent) => void) | null>;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  queuePos: Map<number, number>;
}) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [acceptContracts, setAcceptContracts] = useState(false);
  const touchesContract = events.some((e) => e.kind === "contract.changed" || e.kind === "contract.stale");
  const [perms, setPerms] = useState<PermissionRequest[]>([]);
  const [tab, setTab] = useState<"activity" | "diff">("activity");
  const [text, setText] = useState("");
  const [image, setImage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const buffered: RunEvent[] = [];
    eventSink.current = (e) => {
      if (e.run_id !== run.id) return;
      if (cancelled) return;
      buffered.push(e);
      setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e]));
      if (e.kind === "permission.request") setPerms((p) => [...p, e.data as unknown as PermissionRequest]);
      if (e.kind === "permission.decision") setPerms((p) => p.filter((x) => x.id !== (e.data as any).id));
    };
    api(`/api/runs/${run.id}`).then((d) => {
      if (cancelled) return;
      const ids = new Set<number>(d.events.map((e: RunEvent) => e.id));
      setEvents([...d.events, ...buffered.filter((e) => !ids.has(e.id))]);
      setPerms(d.permissions);
    });
    return () => {
      cancelled = true;
      eventSink.current = null;
    };
  }, [run.id, eventSink]);

  const post = (path: string, body?: unknown) => act(() => api(`/api/runs/${run.id}/${path}`, "POST", body));
  const s = run.state;
  const canMessage = ["running", "paused", "awaiting_review", "failed"].includes(s);
  const canNote = s !== "preparing";
  const send = (mode: "message" | "redirect") => {
    if (!text.trim()) return;
    post(mode, { text }).then(() => setText(""));
  };
  const addNote = () => {
    if (!text.trim() && !image) return;
    post("notes", { text, image: image ?? undefined }).then(() => {
      setText("");
      setImage(null);
    });
  };
  const openPreview = () =>
    act(async () => {
      const { url } = await api<{ url: string }>(`/api/runs/${run.id}/preview`, "POST");
      window.open(url, "_blank", "noopener");
    });

  return (
    <>
      <div className="runhead">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>
            #{run.ticket_id} {ticket?.title ?? ""}
          </h2>
          <span className={`chip ${s}`} title={s === "queued" ? "The daemon's run limit (ACUTIS_MAX_RUNS) is reached; this run starts when another finishes, pauses or reaches review." : undefined}>
            {stateLabel(run, queuePos)}
          </span>
        </div>
        <div className="facts">
          <span>run {run.id}</span>
          <span>{run.repo}</span>
          {run.model && <span>{run.model}</span>}
          <span>attempt {run.attempt}</span>
          <span title="API-equivalent estimate; billed against your subscription. Updated live while the agent works.">≈${run.cost_usd.toFixed(2)}</span>
          {run.gates_ok !== null && <span style={{ color: run.gates_ok ? "var(--ok)" : "var(--err)" }}>checks {run.gates_ok ? "passed" : "failed"}</span>}
          {run.bookmark && <span>bookmark {run.bookmark}</span>}
          {run.workspace_path && <span title={run.workspace_path}>workspace {run.workspace_name}</span>}
        </div>
        {ticket?.body && (
          <details className="ticketbody" open={ticket.body.length < 400}>
            <summary>Ticket</summary>
            <Markdown text={ticket.body} />
          </details>
        )}
        <div className="row">
          {s === "running" && <button className="btn" onClick={() => post("pause")}>Pause</button>}
          {s === "paused" && <button className="btn" onClick={() => post("resume")}>Resume</button>}
          {s === "awaiting_review" && touchesContract && (
            <label className="row contract-accept" title="This run changes a contract, or a contract it relies on changed: approving needs your explicit acceptance">
              <input type="checkbox" checked={acceptContracts} onChange={(e) => setAcceptContracts(e.target.checked)} />
              I've reviewed the contract change
            </label>
          )}
          {s === "awaiting_review" && (
            <button className="btn primary" onClick={() => post("approve", { acceptContracts })}>
              Approve &amp; land
            </button>
          )}
          {run.workspace_path && !["done", "failed", "cancelled"].includes(s) && (
            <button className="btn" onClick={openPreview} title="Start this run's preview server (if the repo has one) and open it">
              Open preview
            </button>
          )}
          {s === "queued" && (
            <button className="btn danger" onClick={() => post("kill")}>
              Remove from queue
            </button>
          )}
          {["preparing", "running", "paused", "verifying", "awaiting_review"].includes(s) && (
            <button className="btn danger" onClick={() => confirm("Kill this run? The workspace is kept until you discard it.") && post("kill")}>
              Kill
            </button>
          )}
          {["paused", "awaiting_review", "failed", "cancelled"].includes(s) && run.workspace_path && (
            <button className="btn danger" onClick={() => confirm("Discard this run's changes and delete its workspace?") && post("discard")}>
              Discard
            </button>
          )}
        </div>
      </div>

      {perms.map((p) => (
        <div className="perm" key={p.id}>
          <div>
            <b>Permission needed:</b> <code>{p.tool}</code>
            {p.blockedPath && <> (path outside workspace: <code>{p.blockedPath}</code>)</>}
            {p.reason && <div className="hint">Why: {p.reason}</div>}
          </div>
          <pre>{p.tool === "Bash" ? String((p.input as any).command ?? "") : JSON.stringify(p.input, null, 2)}</pre>
          <div className="row">
            <button className="btn ok" onClick={() => post(`permissions/${p.id}`, { behavior: "allow" })}>Allow once</button>
            {p.canAlwaysAllow && (
              <button className="btn ok" onClick={() => post(`permissions/${p.id}`, { behavior: "allow", always: true })}>
                Allow for this run
              </button>
            )}
            <button
              className="btn danger"
              onClick={() => {
                const message = prompt("Tell the agent why (optional):") ?? undefined;
                post(`permissions/${p.id}`, { behavior: "deny", message });
              }}
            >
              Deny
            </button>
          </div>
        </div>
      ))}

      <div className="tabs">
        <button className={`tab ${tab === "activity" ? "on" : ""}`} onClick={() => setTab("activity")}>Activity</button>
        <button className={`tab ${tab === "diff" ? "on" : ""}`} onClick={() => setTab("diff")}>Diff</button>
      </div>

      {tab === "activity" ? <Timeline events={events} root={run.workspace_path} /> : <DiffView run={run} />}

      {canNote && (
        <div className="composer">
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            <textarea
              placeholder={
                !canMessage
                  ? "Add a review note to this run"
                  : s === "awaiting_review"
                    ? "Send back with a note: what should change? (or Add note to record it without sending)"
                    : s === "running"
                      ? "Message the agent (queued), or Redirect to interrupt it"
                      : "Message to continue the session"
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(e.shiftKey ? "redirect" : "message");
              }}
              onPaste={(e) => {
                const f = [...e.clipboardData.files].find((f) => f.type === "image/png");
                if (f) {
                  e.preventDefault();
                  readPng(f).then(setImage, (err) => act(() => Promise.reject(err)));
                }
              }}
            />
            <span className="hint">
              Ctrl+Enter sends · Ctrl+Shift+Enter redirects · paste a PNG to attach it to a note
              {image && (
                <>
                  {" "}· image attached{" "}
                  <button className="btn sm" onClick={() => setImage(null)}>remove</button>
                </>
              )}
            </span>
          </div>
          <div className="row" style={{ flexDirection: "column", alignItems: "stretch" }}>
            {canMessage && (
              <button className="btn primary" disabled={!text.trim()} onClick={() => send("message")}>
                {s === "awaiting_review" ? "Send back" : "Send"}
              </button>
            )}
            {s === "running" && (
              <button className="btn" disabled={!text.trim()} onClick={() => send("redirect")} title="Interrupt the current turn and give new instructions">
                Redirect
              </button>
            )}
            <button className="btn" disabled={!text.trim() && !image} onClick={addNote} title="Save a review note on this run (not sent to the agent)">
              Add note
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function Timeline({ events, root }: { events: RunEvent[]; root: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const results = useMemo(() => {
    const m = new Map<string, any>();
    for (const e of events) if (e.kind === "agent.tool_result") m.set((e.data as any).tool_use_id, e.data);
    return m;
  }, [events]);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  return (
    <div
      className="scroll"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {events.length === 0 && <div className="empty">Waiting for events…</div>}
      {events.map((e) => (
        <EventRow key={e.id} e={e} results={results} root={root} runId={e.run_id} />
      ))}
    </div>
  );
}

/** Artifacts need the token, which an <img src> can't send, so fetch them and show a blob URL. */
export function Shot({ runId, name, caption }: { runId: number; name: string; caption?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    fetch(`/api/runs/${runId}/artifacts/${encodeURIComponent(name)}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((b) => {
        if (!live) return;
        url = URL.createObjectURL(b);
        setSrc(url);
      })
      .catch(() => {});
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [runId, name]);
  if (!src) return <span className="shot">loading screenshot…</span>;
  return (
    <a className="shot" href={src} target="_blank" rel="noreferrer noopener" title={caption}>
      <img src={src} alt={caption ?? "screenshot"} />
    </a>
  );
}

export function EventRow({ e, results, root, runId }: { e: RunEvent; results: Map<string, any>; root: string | null; runId: number }) {
  const d = e.data as any;
  switch (e.kind) {
    case "run.state":
      return (
        <div className="ev state">
          {d.to.replace("_", " ")}
          {d.reason ? ` — ${d.reason}` : ""}
        </div>
      );
    case "agent.init":
      return <div className="ev log">session {String(d.session_id).slice(0, 8)} · {d.model} · sandbox {d.sandboxed ? "on" : "off"}</div>;
    case "agent.text":
      return (
        <div className="ev text">
          <Markdown text={String(d.text)} />
        </div>
      );
    case "agent.tool_use": {
      const r = results.get(d.id);
      return (
        <div className="ev">
          <details className="tool">
            <summary>
              <span className="name">{d.name}</span>
              <span className="arg">{toolArg(d.name, d.input, root)}</span>
              <span className={`st ${r ? (r.is_error ? "err" : "ok") : ""}`}>{r ? (r.is_error ? "error" : "✓") : "…"}</span>
            </summary>
            <pre>{JSON.stringify(d.input, null, 2)}</pre>
            {r && <pre>{r.content}</pre>}
          </details>
        </div>
      );
    }
    case "agent.tool_result":
      return null;
    case "agent.result":
      return (
        <div className="ev result">
          turn ended: {d.subtype} · {d.turns} turns · {(d.duration_ms / 1000).toFixed(0)}s · ≈${Number(d.turn_cost_usd ?? d.cost_usd).toFixed(3)}
        </div>
      );
    case "user.message":
      return (
        <div className="ev user">
          <div className="who">{d.by === "acutis" ? "Acutis (check results)" : d.mode === "redirect" ? "You — redirect" : "You"}</div>
          {d.text}
        </div>
      );
    case "gate.start":
    case "setup.start":
    case "worker-check.start":
      return null;
    case "gate.result":
    case "setup.result":
      return (
        <div className="ev">
          <details className={`tool gate ${d.ok ? "ok" : "fail"}`} open={!d.ok}>
            <summary>
              <span className="name">{d.ok ? "✓" : "✗"} {e.kind === "setup.result" ? "setup" : "check"}</span>
              <span className="arg">{d.run}</span>
              <span className="st">{(d.duration_ms / 1000).toFixed(1)}s</span>
            </summary>
            {d.artifact && <Shot runId={runId} name={d.artifact} caption={d.name} />}
            <pre>{d.output || "(no output)"}</pre>
          </details>
        </div>
      );
    case "artifact":
      if (d.source === "gate" || d.source === "operator") return null; // shown with the check or note
      return (
        <div className="ev log">
          {d.caption}
          <Shot runId={runId} name={d.name} caption={d.caption} />
        </div>
      );
    case "scout.ticket":
      return (
        <div className="ev log">
          filed ticket #{d.id} [{d.status}, {d.confidence}] {d.title}
        </div>
      );
    case "scout.decision":
      return <div className="ev log">asked decision #{d.id}: {d.question}</div>;
    case "noticed":
      return (
        <div className="ev log">
          noticed #{d.id} [{d.kind}] {d.title}
          {d.merged ? ` (merged; ${d.count} reports)` : ""}
        </div>
      );
    case "review.note":
      return (
        <div className="ev note">
          <div className="who">Review note</div>
          {d.text && <Markdown text={d.text} />}
          {d.artifact && <Shot runId={runId} name={d.artifact} caption={d.text} />}
        </div>
      );
    case "permission.request":
      return (
        <div className="ev log warn">
          permission requested: {d.tool} {toolArg(d.tool, d.input)}
          {d.reason ? ` — ${d.reason}` : ""}
        </div>
      );
    case "permission.decision":
      return (
        <div className="ev log">
          permission {d.behavior === "allow" ? (d.always ? "allowed for run" : "allowed") : d.by === "timeout" ? "timed out (denied)" : "denied"}: {d.tool}
          {d.message ? ` (${d.message})` : ""}
        </div>
      );
    case "contract.changed":
    case "contract.stale":
      return <div className="ev flag">⚠ {d.msg}</div>;
    case "worker-check.result":
      return (
        <div className="ev log">
          the agent ran a check through Acutis: <code>{d.name ?? d.run}</code> {d.ok ? "passed" : `failed (exit ${d.exit_code})`}
        </div>
      );
    case "scout.triggered":
      return (
        <div className="ev log">
          woken by a trunk change ({String(d.from).slice(0, 8)}..{String(d.to).slice(0, 8)}): <code>{(d.paths ?? []).slice(0, 8).join(", ")}</code>
          {(d.paths ?? []).length > 8 ? " …" : ""}
        </div>
      );
    case "lessons.given":
      return (
        <div className="ev log">
          given {(d.lessons ?? []).length} of {d.of} approved lesson{d.of === 1 ? "" : "s"}
          {d.by === "all" ? "" : ` (chosen by ${d.by})`}
          {(d.lessons ?? []).length > 0 && `: ${(d.lessons as { id: number }[]).map((l) => `L${l.id}`).join(", ")}`}
        </div>
      );
    case "lesson.stale":
      return (
        <div className="ev flag">
          ⚠ Lesson L{d.id} needs a recheck: trunk changed <code>{(d.paths ?? []).join(", ")}</code>. It isn't given to runs until the operator confirms it.
        </div>
      );
    case "writer.started":
      return <div className="ev log">drafting a ticket for: {d.prompt}</div>;
    case "writer.question":
      return (
        <div className="ev log">
          asked Q{d.n}: {d.question}
          {(d.options ?? []).length > 0 && ` [${(d.options as string[]).join(" | ")}]`}
        </div>
      );
    case "writer.draft":
      return (
        <div className="ev log">
          wrote draft v{d.version}: <b>{d.title}</b>
          <details>
            <summary>body</summary>
            <Markdown text={d.body} />
          </details>
        </div>
      );
    case "writer.answered":
      return (
        <div className="ev log">
          the operator answered {(d.answers ?? []).length} question(s){d.note ? " and left a note" : ""}
          {d.decisions ? ` (${d.decisions} kept as repo decisions)` : ""}
        </div>
      );
    case "writer.saved":
      return <div className="ev log">saved as ticket #{d.ticket_id}{d.edited ? " (edited by the operator)" : ""}</div>;
    case "writer.ready":
      return null;
    case "lesson.proposed":
      return (
        <div className="ev log">
          proposed lesson L{d.id}
          {d.source === "draft" ? " (drafted from the report)" : ""}: {d.text}
        </div>
      );
    case "work.request":
      return (
        <div className="ev flag">
          ⚠ This run asked for work outside its ticket: #{d.ticket} {d.title} ({d.existing ? `already requested, ${d.status}` : "proposed"}). Its summary should
          say what is unfinished until that lands.
        </div>
      );
    case "contract.request":
      return (
        <div className="ev log">
          requested a change to the {d.contract} contract (decision #{d.decision}, ticket #{d.ticket}): {d.change}
        </div>
      );
    case "policy.flag":
      return (
        <div className="ev flag">
          ⚠ {d.msg} <code>{(d.files ?? []).join(", ")}</code>
        </div>
      );
    case "system.log":
      return (
        <div className={`ev log ${d.level ?? ""}`}>
          {d.msg}
          {d.gates?.length ? ` · checks: ${d.gates.join(", ")}` : ""}
        </div>
      );
    default:
      return <div className="ev log">{e.kind}</div>;
  }
}

export function DiffView({ run }: { run: Run }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api<string>(`/api/runs/${run.id}/diff`)
      .then((d) => {
        setDiff(d);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
  }, [run.id]);
  useEffect(load, [load, run.state, run.updated_at]);

  if (err) return <div className="scroll"><div className="ev log error">{err}</div></div>;
  if (diff === null) return <div className="scroll"><div className="empty">Loading…</div></div>;
  if (!diff.trim()) {
    return (
      <div className="scroll">
        <div className="empty">{run.workspace_path ? "No changes yet." : "Workspace is gone (landed or discarded)."}</div>
      </div>
    );
  }
  return (
    <div className="scroll">
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn sm" onClick={load}>Refresh</button>
      </div>
      <div className="diff">
        {diff.split("\n").map((line, i) => {
          const cls = line.startsWith("diff --git")
            ? "file"
            : line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+") && !line.startsWith("+++")
                ? "add"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "del"
                  : "";
          if (line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---")) return null;
          return (
            <div key={i} className={cls}>
              {cls === "file" ? line.replace(/^diff --git a\/(.*) b\/.*$/, "$1") : line || " "}
            </div>
          );
        })}
      </div>
    </div>
  );
}

