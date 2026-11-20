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

  create(input: { repo: string; title: string; body: string }): Ticket {
    const row = this.store.db
      .query<{ id: number }, any>(
        "INSERT INTO tickets (repo, title, body, source) VALUES ($repo, $title, $body, 'local') RETURNING id",
      )
      .get(input)!;
    return this.get(row.id)!;
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

  setStatus(id: number, status: TicketStatus): Ticket {
    this.store.db
      .query(
        "UPDATE tickets SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
      )
      .run(status, id);
    return this.get(id)!;
  }
}
