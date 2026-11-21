import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Repo, Run, RunEvent, RunState } from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  name TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  base TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL REFERENCES repos(name),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  source TEXT NOT NULL DEFAULT 'local',
  external_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  repo TEXT NOT NULL REFERENCES repos(name),
  state TEXT NOT NULL,
  workspace_name TEXT,
  workspace_path TEXT,
  base_commit TEXT,
  session_id TEXT,
  model TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  gates_ok INTEGER,
  cost_usd REAL NOT NULL DEFAULT 0,
  session_cost REAL,
  error TEXT,
  bookmark TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, id);
CREATE INDEX IF NOT EXISTS runs_ticket ON runs(ticket_id);
`;

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** CREATE TABLE IF NOT EXISTS never adds columns, so add the ones newer code expects. */
  private migrate() {
    const has = (table: string, col: string) =>
      this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!has("repos", "notes")) this.db.exec("ALTER TABLE repos ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
    if (!has("runs", "session_cost")) this.db.exec("ALTER TABLE runs ADD COLUMN session_cost REAL");
  }

  // ---- repos
  addRepo(r: { name: string; path: string; base: string }): Repo {
    this.db
      .query("INSERT INTO repos (name, path, base) VALUES ($name, $path, $base)")
      .run(r);
    return this.getRepo(r.name)!;
  }
  getRepo(name: string): Repo | null {
    return this.db.query<Repo, [string]>("SELECT * FROM repos WHERE name = ?").get(name);
  }
  listRepos(): Repo[] {
    return this.db.query<Repo, []>("SELECT * FROM repos ORDER BY name").all();
  }
  setRepoNotes(name: string, notes: string): Repo {
    this.db.query("UPDATE repos SET notes = ? WHERE name = ?").run(notes, name);
    return this.getRepo(name)!;
  }

  // ---- runs
  createRun(r: { ticket_id: number; repo: string; state: RunState }): Run {
    const row = this.db
      .query<{ id: number }, any>(
        "INSERT INTO runs (ticket_id, repo, state) VALUES ($ticket_id, $repo, $state) RETURNING id",
      )
      .get(r)!;
    return this.getRun(row.id)!;
  }
  getRun(id: number): Run | null {
    return this.db.query<Run, [number]>("SELECT * FROM runs WHERE id = ?").get(id);
  }
  listRuns(limit = 200): Run[] {
    return this.db.query<Run, [number]>("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit);
  }
  runsForTicket(ticketId: number): Run[] {
    return this.db.query<Run, [number]>("SELECT * FROM runs WHERE ticket_id = ? ORDER BY id").all(ticketId);
  }
  updateRun(id: number, patch: Partial<Omit<Run, "id">>): Run {
    const keys = Object.keys(patch);
    if (keys.length) {
      const sets = keys.map((k) => `${k} = $${k}`).join(", ");
      this.db
        .query(`UPDATE runs SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $id`)
        .run({ ...patch, id } as any);
    }
    return this.getRun(id)!;
  }

  // ---- events
  addEvent(runId: number, kind: string, data: Record<string, unknown>): RunEvent {
    const row = this.db
      .query<{ id: number; ts: string }, any>(
        "INSERT INTO events (run_id, kind, data) VALUES ($run_id, $kind, $data) RETURNING id, ts",
      )
      .get({ run_id: runId, kind, data: JSON.stringify(data) })!;
    return { id: row.id, ts: row.ts, run_id: runId, kind, data };
  }
  events(runId: number, afterId = 0): RunEvent[] {
    return this.db
      .query<{ id: number; run_id: number; ts: string; kind: string; data: string }, [number, number]>(
        "SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id",
      )
      .all(runId, afterId)
      .map((e) => ({ ...e, data: JSON.parse(e.data) }));
  }
}
