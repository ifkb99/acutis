/**
 * Cathedral: a nave and two chapels. The selected run fills the nave; the left chapel is the
 * inbox (everything waiting on the operator, most urgent first), the right chapel the work
 * board (new ticket, tickets by status, scouts, notes). Jewel-toned leaded glass on the chrome.
 */
import React from "react";
import {
  Badges,
  Board,
  DecisionsList,
  DraftsList,
  lessonGroups,
  LessonsList,
  lessonsTitle,
  NewTicket,
  NoticedList,
  RepoNotes,
  ScoutsList,
  SelectedRun,
  WaitingRuns,
} from "../../components";
import type { Dashboard } from "../../state";
import "./styles.css";

type Jewel = "ruby" | "cobalt" | "emerald" | "gold" | "amethyst";

/** A chapel section: a glass pane with a jewel-coloured heading. */
function Pane({ id, jewel, title, count, open = true, className = "", children }: { id?: string; jewel: Jewel; title: string; count?: number; open?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <details className={`pane jewel-${jewel} ${className}`} id={id} open={open}>
      <summary>
        <h2 className="pane-title">{title}</h2>
        {count !== undefined && count > 0 && <span className="pane-count">{count}</span>}
      </summary>
      <div className="pane-body">{children}</div>
    </details>
  );
}

/** A small rose window, the brand mark. */
function Rose() {
  const petals = Array.from({ length: 8 }, (_, i) => i * 45);
  const fills = ["#b3203f", "#2456b8", "#c9952a", "#1f8a52"];
  return (
    <svg className="mark" viewBox="-20 -20 40 40" aria-hidden="true">
      <circle r="19" fill="#241f2c" />
      {petals.map((a, i) => (
        <path key={a} d="M0 0 L-5 -15 A5.5 5.5 0 0 1 5 -15 Z" transform={`rotate(${a})`} fill={fills[i % 4]} stroke="#241f2c" strokeWidth="1.2" />
      ))}
      <circle r="5" fill="#e8c766" stroke="#241f2c" strokeWidth="1.2" />
    </svg>
  );
}

export function Layout({ d }: { d: Dashboard }) {
  const a = d.attention;
  const { proposed: proposedLessons, stale } = lessonGroups(d.lessons);
  const jump = (id: string) => {
    const el = document.getElementById(id) as HTMLDetailsElement | null;
    if (!el) return;
    el.open = true;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const tallies: { id: string; label: string; n: number; jewel: Jewel }[] = [
    { id: "c-waiting", label: "runs waiting", n: a.waitingRuns.length, jewel: "ruby" },
    { id: "c-drafts", label: "drafts", n: a.drafts, jewel: "gold" },
    { id: "c-decisions", label: "decisions", n: a.decisions, jewel: "cobalt" },
    { id: "c-lessons", label: "lessons", n: a.lessons, jewel: "emerald" },
    { id: "c-noticed", label: "noticed", n: a.noticed, jewel: "amethyst" },
  ];
  const inboxEmpty = !a.waitingRuns.length && !d.drafts.length && !d.openDecisions.length && !proposedLessons.length && !stale.length && !d.noticed.length;

  return (
    <div className="cath">
      <header className="clerestory">
        <div className="brand">
          <Rose />
          <h1>Acutis</h1>
        </div>
        <nav className="tallies" aria-label="Needs you">
          {a.total === 0 ? (
            <span className="tally quiet">Nothing needs you</span>
          ) : (
            tallies
              .filter((t) => t.n > 0)
              .map((t) => (
                <button key={t.id} className={`tally jewel-${t.jewel}`} onClick={() => jump(t.id)}>
                  <b>{t.n}</b> {t.label}
                </button>
              ))
          )}
          {a.proposed > 0 && (
            <button className="tally jewel-cobalt" onClick={() => jump("c-board")}>
              <b>{a.proposed}</b> proposed tickets
            </button>
          )}
        </nav>
        <Badges d={d} />
      </header>

      <aside className="chapel inbox" aria-label="Inbox">
        <h2 className="chapel-name">Inbox</h2>
        {inboxEmpty && (
          <div className="quiet-note">
            <p>All quiet. Nothing is waiting on you.</p>
            <p className="muted">Add a ticket on the right, or press Start on one in Todo.</p>
          </div>
        )}
        {a.waitingRuns.length > 0 && (
          <Pane id="c-waiting" jewel="ruby" title="Runs waiting on you" count={a.waitingRuns.length}>
            <WaitingRuns d={d} />
          </Pane>
        )}
        {d.drafts.length > 0 && (
          <Pane id="c-drafts" jewel="gold" title="Ticket drafts" count={a.drafts}>
            <DraftsList d={d} />
          </Pane>
        )}
        {(d.openDecisions.length > 0 || d.decided.length > 0) && (
          <Pane id="c-decisions" jewel="cobalt" title="Decisions" count={a.decisions} open={d.openDecisions.length > 0}>
            {d.openDecisions.length === 0 && <div className="empty">No open questions.</div>}
            <DecisionsList d={d} />
          </Pane>
        )}
        {d.lessons.length > 0 && (
          <Pane id="c-lessons" jewel="emerald" title={lessonsTitle(d.lessons)} className="lessons" open={a.lessons > 0}>
            {a.lessons === 0 && <div className="empty">No lessons to review.</div>}
            <LessonsList d={d} />
          </Pane>
        )}
        {d.noticed.length > 0 && (
          <Pane id="c-noticed" jewel="amethyst" title="Noticed by workers" count={a.noticed}>
            <NoticedList d={d} />
          </Pane>
        )}
      </aside>

      <main className="nave">
        <div className="nave-frame">
          <SelectedRun
            d={d}
            empty={
              <div className="nave-empty">
                <Rose />
                <p>{d.repos.length === 0 ? "No repos yet. Register one with: bun src/cli.ts repo add <path>" : "Pick a ticket on the board to watch its run here."}</p>
                {d.repos.length > 0 && <p className="muted">Runs waiting on you are listed in the inbox on the left.</p>}
              </div>
            }
          />
        </div>
      </main>

      <aside className="chapel board" aria-label="Board">
        <h2 className="chapel-name">Board</h2>
        {d.repos.length > 0 && (
          <Pane jewel="gold" title="New ticket">
            <NewTicket d={d} />
          </Pane>
        )}
        <div className="board-cols" id="c-board">
          <Board d={d} />
        </div>
        {d.repos.length > 0 && d.scoutTypes.length > 0 && (
          <Pane jewel="emerald" title="Scouts" open={false}>
            <ScoutsList d={d} />
          </Pane>
        )}
        <RepoNotes d={d} />
      </aside>
    </div>
  );
}
