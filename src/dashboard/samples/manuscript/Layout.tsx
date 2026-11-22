/**
 * Manuscript: one readable page at a time. The margin holds the marginalia: status, ribbon
 * bookmarks to each folio (what needs you, the open run, the contents, the scriptorium) and the
 * runs waiting on you in red ink. The contents folio is a table of contents of tickets and runs.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  Badges,
  DecisionsList,
  DraftsList,
  LessonsList,
  lessonsTitle,
  NewTicket,
  noRunHint,
  NoticedList,
  RepoNotes,
  ScoutsList,
  SelectedRun,
  TicketButtons,
  TicketWhy,
  WaitingRuns,
} from "../../components";
import { stateLabel, type Dashboard } from "../../state";
import "./styles.css";

type Folio = "attention" | "run" | "contents" | "scriptorium";
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

/** A decorated initial: the first letter set large in a gilt-framed lapis square. */
function Initial({ children }: { children: string }) {
  return (
    <span className="initial" aria-hidden="true">
      {children}
    </span>
  );
}

/** A section with a rubricated (red-ink) heading; its first letter is set as a decorated initial (CSS). */
function Chapter({ title, note, className = "", children }: { title: string; note?: string; className?: string; children: React.ReactNode }) {
  return (
    <section className={`chapter ${className}`}>
      <h2 className="rubric">{title}</h2>
      {note && <p className="rubric-note">{note}</p>}
      {children}
    </section>
  );
}

function Contents({ d, onOpen }: { d: Dashboard; onOpen: () => void }) {
  const cols = d.board.filter((c) => !(c.hideEmpty && c.items.length === 0));
  return (
    <div className="contents">
      <h1 className="folio-title">Contents</h1>
      {d.repos.length === 0 && <p className="lede">{noRunHint(d)}</p>}
      {cols.map((col, i) => {
        const body = (
          <ol className="toc">
            {col.items.length === 0 && <li className="toc-empty">Nothing here.</li>}
            {col.items.map((t) => {
              const r = d.latestRun.get(t.id);
              return (
                <li key={t.id} className={`toc-entry ${r && r.id === d.selected ? "sel" : ""}`}>
                  <div className="toc-line">
                    {r ? (
                      <a href={`#run-${r.id}`} className="toc-title" onClick={() => (d.setSelected(r.id), onOpen())}>
                        <span className="toc-num">{t.id}</span> {t.title}
                      </a>
                    ) : (
                      <span className="toc-title">
                        <span className="toc-num">{t.id}</span> {t.title}
                      </span>
                    )}
                    <span className="leader" aria-hidden="true" />
                    <span className="toc-state">
                      {r && d.pendingRuns.has(r.id) && <span className="chip needs">needs you</span>}
                      {r ? <span className={`chip ${r.state}`}>{stateLabel(r, d.queuePos)}</span> : <span className="muted">no run</span>}
                      {t.confidence && <span className={`chip conf-${t.confidence}`}>{t.confidence}</span>}
                      <TicketButtons d={d} t={t} />
                    </span>
                  </div>
                  <div className="toc-sub">
                    <span className="muted">{t.repo}</span>
                    <TicketWhy t={t} />
                  </div>
                </li>
              );
            })}
          </ol>
        );
        const head = (
          <>
            <span className="roman">{ROMAN[i]}.</span> {col.label} <span className="count">{col.items.length}</span>
          </>
        );
        return col.collapsed ? (
          <details className="toc-chapter" key={col.key}>
            <summary className="toc-head">{head}</summary>
            {body}
          </details>
        ) : (
          <section className="toc-chapter" key={col.key}>
            <h2 className="toc-head">{head}</h2>
            {body}
          </section>
        );
      })}
    </div>
  );
}

export function Layout({ d }: { d: Dashboard }) {
  const a = d.attention;
  const [folio, setFolio] = useState<Folio>(() => (d.selected ? "run" : "attention"));
  // Opening a run anywhere (a link, Start, Save & start) turns to the run's folio.
  const firstSelected = useRef(d.selected);
  useEffect(() => {
    if (d.selected && d.selected !== firstSelected.current) setFolio("run");
    firstSelected.current = null;
  }, [d.selected]);
  const proposedTickets = d.board.find((c) => c.key === "proposed")?.items ?? [];
  const run = d.run;
  const nothing = a.total === 0 && !d.drafts.length;

  const ribbons: { id: Folio; label: string; note?: string; count?: number; disabled?: boolean }[] = [
    { id: "attention", label: "Needs you", count: a.total },
    { id: "run", label: "The run", note: run ? `#${run.ticket_id} ${d.tickets.get(run.ticket_id)?.title ?? ""}` : "none open", disabled: !run },
    { id: "contents", label: "Contents", note: `${d.board.reduce((n, c) => n + c.items.length, 0)} tickets` },
    { id: "scriptorium", label: "Scriptorium", note: "new ticket, scouts, notes" },
  ];

  return (
    <div className="ms">
      <aside className="margin">
        <div className="brand">
          <Initial>A</Initial>
          <h1>
            <span className="sr-first">A</span>cutis
          </h1>
        </div>
        <Badges d={d} />
        <nav className="ribbons" aria-label="Folios">
          {ribbons.map((r) => (
            <button key={r.id} className={`ribbon ${folio === r.id ? "on" : ""}`} disabled={r.disabled} onClick={() => setFolio(r.id)} aria-current={folio === r.id}>
              <span className="ribbon-label">
                {r.label}
                {r.count !== undefined && r.count > 0 && <span className="ribbon-count">{r.count}</span>}
              </span>
              {r.note && <span className="ribbon-note">{r.note}</span>}
            </button>
          ))}
        </nav>
        {a.waitingRuns.length > 0 && (
          <div className="gloss">
            <div className="gloss-head">Waiting on you</div>
            <WaitingRuns d={d} onOpen={() => setFolio("run")} />
          </div>
        )}
      </aside>

      <main className={`page folio-${folio}`}>
        {folio === "run" ? (
          <div className="run-folio">
            <SelectedRun d={d} empty={<p className="lede">No run is open. Choose one from the Contents.</p>} />
          </div>
        ) : (
          <div className="folio-scroll">
            <div className="leaf">
              {folio === "attention" && (
                <>
                  <h1 className="folio-title">Needs you</h1>
                  {nothing && (
                    <div className="lede">
                      <p>Nothing awaits you. The work is in hand.</p>
                      <p className="muted">
                        Start a ticket from the{" "}
                        <button className="linkish" onClick={() => setFolio("contents")}>
                          Contents
                        </button>
                        , or write a new one in the{" "}
                        <button className="linkish" onClick={() => setFolio("scriptorium")}>
                          Scriptorium
                        </button>
                        .
                      </p>
                    </div>
                  )}
                  {a.waitingRuns.length > 0 && (
                    <Chapter title="Runs waiting on you" note="a permission to give, or work to review">
                      <WaitingRuns d={d} onOpen={() => setFolio("run")} />
                    </Chapter>
                  )}
                  {d.drafts.length > 0 && (
                    <Chapter title="Ticket drafts" note="the writer's questions and drafts">
                      <DraftsList d={d} />
                    </Chapter>
                  )}
                  {(d.openDecisions.length > 0 || d.decided.length > 0) && (
                    <Chapter title="Decisions" note={d.openDecisions.length ? "questions only you can answer" : "none open; the decided ones are below"}>
                      <DecisionsList d={d} />
                    </Chapter>
                  )}
                  {d.lessons.length > 0 && (
                    <Chapter title={lessonsTitle(d.lessons)} className="lessons" note="how-tos given to later workers; approve, recheck or retire them">
                      <LessonsList d={d} />
                    </Chapter>
                  )}
                  {d.noticed.length > 0 && (
                    <Chapter title="Noticed by workers" note="worker-written, unchecked">
                      <NoticedList d={d} />
                    </Chapter>
                  )}
                  {proposedTickets.length > 0 && (
                    <Chapter title="Proposed tickets" note="filed by scouts and workers">
                      {proposedTickets.map((t) => (
                        <div className="card" key={t.id}>
                          <div className="t">
                            #{t.id} {t.title}
                          </div>
                          <TicketWhy t={t} />
                          <div className="meta">
                            <span>{t.repo}</span>
                            {t.confidence && <span className={`chip conf-${t.confidence}`}>{t.confidence}</span>}
                            <span style={{ flex: 1 }} />
                            <TicketButtons d={d} t={t} />
                          </div>
                        </div>
                      ))}
                    </Chapter>
                  )}
                </>
              )}
              {folio === "contents" && <Contents d={d} onOpen={() => setFolio("run")} />}
              {folio === "scriptorium" && (
                <>
                  <h1 className="folio-title">Scriptorium</h1>
                  {d.repos.length === 0 ? (
                    <p className="lede">{noRunHint(d)}</p>
                  ) : (
                    <>
                      <Chapter title="A new ticket" note="add it yourself, or let the writer draft it">
                        <NewTicket d={d} />
                      </Chapter>
                      {d.scoutTypes.length > 0 && (
                        <Chapter title="Scouts" note="they look through a repo and file tickets and questions">
                          <ScoutsList d={d} />
                        </Chapter>
                      )}
                      <Chapter title="Notes for workers" note="given to every worker on the repo">
                        <RepoNotes d={d} open />
                      </Chapter>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
