/** The rose's eight petals: one kind of work each, with a count, and the full list behind each. */
import React from "react";
import { Board, DecisionsList, DraftsList, lessonGroups, LessonsList, NewTicket, noRunHint, NoticedList, RepoNotes, ScoutsList, TicketCard, WaitingRuns } from "../components";
import type { Dashboard } from "../state";
import type { PetalId } from "./graph";

export type Petal = { id: PetalId; label: string; count: number; urgent: boolean; hint: string; tint: string };

export function petals(d: Dashboard): Petal[] {
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

/** A petal's full list: what the drawer shows for the petal at the centre of the web. */
export function PetalBody({ d, id }: { d: Dashboard; id: PetalId }) {
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
