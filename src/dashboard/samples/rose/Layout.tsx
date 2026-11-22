/**
 * Rose window: a hub and a focus view. The hub is a rose of eight petals around a centre that
 * counts what needs you; each petal is one kind of work (runs waiting, drafts, decisions, …) and
 * opens beside the rose. Opening a run switches to a focused, full-width run view; the petals
 * stay reachable from its top bar.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  Badges,
  Board,
  DecisionsList,
  DraftsList,
  lessonGroups,
  LessonsList,
  lessonsTitle,
  NewTicket,
  noRunHint,
  NoticedList,
  RepoNotes,
  ScoutsList,
  SelectedRun,
  TicketCard,
  WaitingRuns,
} from "../../components";
import type { Dashboard } from "../../state";
import "./styles.css";

type PetalId = "waiting" | "drafts" | "decisions" | "lessons" | "noticed" | "proposed" | "board" | "new";
type Petal = { id: PetalId; label: string; count: number; urgent: boolean; hint: string; tint: string };

function petals(d: Dashboard): Petal[] {
  const a = d.attention;
  const active = d.board.filter((c) => c.key === "review" || c.key === "in_progress" || c.key === "todo").reduce((n, c) => n + c.items.length, 0);
  return [
    { id: "waiting", label: "Runs waiting", count: a.waitingRuns.length, urgent: a.waitingRuns.length > 0, hint: "permissions and reviews", tint: "rose" },
    { id: "drafts", label: "Drafts", count: a.drafts, urgent: a.drafts > 0, hint: `${d.drafts.length} with the writer`, tint: "lemon" },
    { id: "decisions", label: "Decisions", count: a.decisions, urgent: a.decisions > 0, hint: `${d.decided.length} decided`, tint: "sky" },
    { id: "lessons", label: "Lessons", count: a.lessons, urgent: a.lessons > 0, hint: "to approve or recheck", tint: "mint" },
    { id: "noticed", label: "Noticed", count: a.noticed, urgent: a.noticed > 0, hint: "found by workers", tint: "lilac" },
    { id: "proposed", label: "Proposed", count: a.proposed, urgent: a.proposed > 0, hint: "tickets to accept", tint: "peach" },
    { id: "board", label: "Board", count: active, urgent: false, hint: "todo, running, review", tint: "aqua" },
    { id: "new", label: "New work", count: 0, urgent: false, hint: "ticket, scouts, notes", tint: "pearl" },
  ];
}

/** The tracery behind the petals: rings and spokes. */
function Tracery() {
  return (
    <svg className="tracery" viewBox="-100 -100 200 200" aria-hidden="true">
      <circle r="98" />
      <circle r="94" />
      <circle r="42" />
      {Array.from({ length: 8 }, (_, i) => (
        <line key={i} x1="0" y1="-42" x2="0" y2="-94" transform={`rotate(${i * 45 + 22.5})`} />
      ))}
      {Array.from({ length: 8 }, (_, i) => (
        <circle key={`c${i}`} cx="0" cy="-84" r="8" transform={`rotate(${i * 45 + 22.5})`} />
      ))}
    </svg>
  );
}

function PetalBody({ d, id }: { d: Dashboard; id: PetalId }) {
  const { proposed: pl, stale } = lessonGroups(d.lessons);
  const empty = (text: React.ReactNode) => <p className="petal-empty">{text}</p>;
  switch (id) {
    case "waiting":
      return d.attention.waitingRuns.length ? <WaitingRuns d={d} /> : empty("No run is waiting on you. Running work shows on the Board.");
    case "drafts":
      return d.drafts.length ? <DraftsList d={d} /> : empty("No drafts. Under New work, describe what you want and press “Draft with agent”.");
    case "decisions":
      return (
        <>
          {!d.openDecisions.length && empty("No open questions. Scouts and workers ask here when only you can decide.")}
          <DecisionsList d={d} />
        </>
      );
    case "lessons":
      return (
        <>
          {!pl.length && !stale.length && empty("No lessons to review.")}
          <LessonsList d={d} />
        </>
      );
    case "noticed":
      return d.noticed.length ? <NoticedList d={d} /> : empty("Nothing noticed. Workers report problems outside their tickets here.");
    case "proposed": {
      const items = d.board.find((c) => c.key === "proposed")?.items ?? [];
      return items.length ? <>{items.map((t) => <TicketCard key={t.id} d={d} t={t} />)}</> : empty("No proposed tickets. Run a scout under New work to find some.");
    }
    case "board":
      return (
        <div className="board">
          <Board d={d} only={["review", "in_progress", "todo", "done", "cancelled"]} />
        </div>
      );
    case "new":
      if (!d.repos.length) return empty(noRunHint(d));
      return (
        <>
          <h3>New ticket</h3>
          <NewTicket d={d} />
          {d.scoutTypes.length > 0 && (
            <>
              <h3>Scouts</h3>
              <ScoutsList d={d} />
            </>
          )}
          <h3>Notes for workers</h3>
          <RepoNotes d={d} open />
        </>
      );
  }
}

export function Layout({ d }: { d: Dashboard }) {
  const ps = petals(d);
  const [mode, setMode] = useState<"hub" | "run">(() => (d.selected ? "run" : "hub"));
  // Until the operator picks a petal, show the first one that needs them.
  // Until the operator picks a petal, open the first that needs them once the data is in, and keep
  // it open (so answering its last item doesn't make the panel jump away).
  const [chosen, setPetal] = useState<PetalId | null>(null);
  const firstUrgent = ps.find((p) => p.urgent)?.id ?? null;
  useEffect(() => {
    if (!chosen && firstUrgent) setPetal(firstUrgent);
  }, [chosen, firstUrgent]);
  const petal = chosen ?? "board";
  // Opening a run from anywhere (Start, Save & start, a scout) switches to the focused run view.
  const first = useRef(d.selected);
  useEffect(() => {
    if (d.selected && d.selected !== first.current) setMode("run");
    first.current = null;
  }, [d.selected]);
  /** Clicking a run link or a ticket with a run opens it, even when it is already selected. */
  const openRunsOnClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("button, summary, input, textarea, select")) return;
    if (t.closest('a[href^="#run-"]') || t.closest(".card.has-run")) setMode("run");
  };
  const total = d.attention.total;
  const current = ps.find((p) => p.id === petal)!;
  const goPetal = (id: PetalId) => {
    setPetal(id);
    setMode("hub");
  };

  if (mode === "run") {
    return (
      <div className="rose rose-focus">
        <header className="focus-bar">
          <button className="back" onClick={() => setMode("hub")} title="Back to the rose">
            <span className="rosette" aria-hidden="true">
              {total || "✿"}
            </span>
            Rose
          </button>
          <nav className="petal-chips" aria-label="Needs you">
            {ps
              .filter((p) => p.urgent)
              .map((p) => (
                <button key={p.id} className={`petal-chip tint-${p.tint}`} onClick={() => goPetal(p.id)}>
                  {p.label} <b>{p.count}</b>
                </button>
              ))}
          </nav>
          <Badges d={d} />
        </header>
        {d.attention.waitingRuns.some((r) => r.id !== d.selected) && (
          <div className="focus-waiting" onClick={openRunsOnClick}>
            <span className="muted">Also waiting:</span>
            <WaitingRuns d={d} exclude={d.selected} />
          </div>
        )}
        <main className="focus-run">
          <SelectedRun d={d} empty={<p>No run is open. Go back to the rose and pick one from the Board.</p>} />
        </main>
      </div>
    );
  }

  return (
    <div className="rose rose-hub">
      <section className="wheel-wrap" aria-label="What needs you">
        <div className="wheel">
          <Tracery />
          {ps.map((p, i) => (
            <button
              key={p.id}
              className={`petal tint-${p.tint} ${p.urgent ? "urgent" : ""} ${petal === p.id ? "on" : ""}`}
              style={{ "--i": i } as React.CSSProperties}
              onClick={() => setPetal(p.id)}
              aria-pressed={petal === p.id}
            >
              <span className="petal-count">{p.id === "new" ? "+" : p.count}</span>
              <span className="petal-label">{p.label}</span>
              <span className="petal-hint">{p.hint}</span>
            </button>
          ))}
          <div className="hub">
            <span className="hub-name">Acutis</span>
            <span className="hub-total">{total}</span>
            <span className="hub-label">{total ? (total === 1 ? "thing needs you" : "things need you") : "all calm"}</span>
          </div>
        </div>
        <Badges d={d} />
        {d.run && (
          <button className="btn resume" onClick={() => setMode("run")}>
            Back to run #{d.run.ticket_id}
          </button>
        )}
      </section>
      <section className={`petal-panel tint-${current.tint} ${petal === "lessons" ? "lessons" : ""}`} onClick={openRunsOnClick}>
        <h2>
          {petal === "lessons" ? lessonsTitle(d.lessons) : current.label}
          {current.count > 0 && petal !== "lessons" && <span className="panel-count">{current.count}</span>}
        </h2>
        <div className="petal-body">
          <PetalBody d={d} id={petal} />
        </div>
      </section>
    </div>
  );
}
