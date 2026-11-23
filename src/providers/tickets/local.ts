import type { Store } from "../../core/db";
import type { Ticket, TicketSource, TicketStatus } from "../../core/types";

/** Tickets stored in Acutis's own SQLite database. */
export class LocalTicketSource implements TicketSource {
  readonly name = "local";
  constructor(private store: Store) {}

  list(filter: { repo?: string; status?: TicketStatus } = {}): Ticket[] {
    return this.store.db
      .query<Ticket, any>(
        `SELECT * FROM tickets
         WHERE ($repo IS NULL OR repo = $repo) AND ($status IS NULL OR status = $status)
         ORDER BY id`,
      )
      .all({ repo: filter.repo ?? null, status: filter.status ?? null });
  }

  get(id: number): Ticket | null {
    return this.store.db.query<Ticket, [number]>("SELECT * FROM tickets WHERE id = ?").get(id);
  }

  create(input: Parameters<TicketSource["create"]>[0]): Ticket {
    const row = this.store.db
      .query<{ id: number }, any>(
        `INSERT INTO tickets (repo, title, body, source, status, confidence, decision_id, noticed_id, builds_on, origin_run_id, epic_id)
         VALUES ($repo, $title, $body, $source, $status, $confidence, $decision_id, $noticed_id, $builds_on, $origin_run_id, $epic_id) RETURNING id`,
      )
      .get({
        repo: input.repo,
        title: input.title,
        body: input.body,
        source: input.source ?? "local",
        status: input.status ?? "todo",
        confidence: input.confidence ?? null,
        decision_id: input.decision_id ?? null,
        noticed_id: input.noticed_id ?? null,
        builds_on: input.builds_on ?? null,
        origin_run_id: input.origin_run_id ?? null,
        epic_id: input.epic_id ?? null,
      })!;
    return this.get(row.id)!;
  }

  /** Move held tickets from one decision to another (merging duplicate questions), or to proposed. */
  moveHeld(fromDecision: number, toDecision: number | null): number[] {
    const ids = this.store.db
      .query<{ id: number }, [number]>("SELECT id FROM tickets WHERE decision_id = ? AND status = 'held'")
      .all(fromDecision)
      .map((r) => r.id);
    this.store.db
      .query(
        `UPDATE tickets SET decision_id = $to, status = CASE WHEN $to IS NULL THEN 'proposed' ELSE status END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE decision_id = $from AND status = 'held'`,
      )
      .run({ from: fromDecision, to: toDecision });
    return ids;
  }

  claim(id: number): boolean {
    const res = this.store.db
      .query(
        `UPDATE tickets SET status = 'in_progress', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND status = 'todo'`,
      )
      .run(id);
    return res.changes === 1;
  }

  setBuildsOn(id: number, buildsOn: number | null): Ticket {
    this.store.db
      .query("UPDATE tickets SET builds_on = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(buildsOn, id);
    return this.get(id)!;
  }

  setEpic(id: number, epicId: number | null): Ticket {
    this.store.db
      .query("UPDATE tickets SET epic_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(epicId, id);
    return this.get(id)!;
  }

  setStatus(id: number, status: TicketStatus): Ticket {
    this.store.db
      .query(
        "UPDATE tickets SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
      )
      .run(status, id);
    return this.get(id)!;
  }
}
