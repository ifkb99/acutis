import type { Store } from "./db";
import type { Run, RunEvent, Ticket } from "./types";

export type HubMessage =
  | { type: "event"; event: RunEvent }
  | { type: "run"; run: Run }
  | { type: "ticket"; ticket: Ticket };

/** Persists run events and fans every change out to subscribers (the dashboard). */
export class Hub {
  private subs = new Set<(m: HubMessage) => void>();
  constructor(private store: Store) {}

  subscribe(fn: (m: HubMessage) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private publish(m: HubMessage) {
    for (const fn of this.subs) {
      try {
        fn(m);
      } catch (e) {
        console.error("hub subscriber failed", e);
      }
    }
  }

  emit(runId: number, kind: string, data: Record<string, unknown> = {}): RunEvent {
    const event = this.store.addEvent(runId, kind, data);
    this.publish({ type: "event", event });
    return event;
  }

  run(run: Run) {
    this.publish({ type: "run", run });
  }

  ticket(ticket: Ticket) {
    this.publish({ type: "ticket", ticket });
  }
}
