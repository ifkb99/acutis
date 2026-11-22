import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision, Lesson, LibraryGap, Noticed, NoticedKind, Repo, Run, RunEvent, RunState } from "./types";

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
CREATE TABLE IF NOT EXISTS noticed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  count INTEGER NOT NULL DEFAULT 1,
  run_ids TEXT NOT NULL DEFAULT '',
  ticket_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT 'general',
  question TEXT NOT NULL DEFAULT '',
  question_key TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  decision TEXT NOT NULL DEFAULT '',
  asked_by TEXT NOT NULL,
  run_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  superseded_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS library_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  question TEXT NOT NULL,
  question_key TEXT NOT NULL,
  tried TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  count INTEGER NOT NULL DEFAULT 1,
  run_ids TEXT NOT NULL DEFAULT '',
  ticket_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  text TEXT NOT NULL,
  text_key TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed',
  source TEXT NOT NULL,
  run_id INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS trunk_seen (
  repo TEXT PRIMARY KEY,
  commit_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
    if (!has("runs", "kind")) this.db.exec("ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'work'");
    if (!has("runs", "scout")) this.db.exec("ALTER TABLE runs ADD COLUMN scout TEXT");
    if (!has("tickets", "confidence")) this.db.exec("ALTER TABLE tickets ADD COLUMN confidence TEXT");
    if (!has("tickets", "decision_id")) this.db.exec("ALTER TABLE tickets ADD COLUMN decision_id INTEGER");
    if (!has("tickets", "noticed_id")) this.db.exec("ALTER TABLE tickets ADD COLUMN noticed_id INTEGER");
    if (!has("runs", "woken_by")) this.db.exec("ALTER TABLE runs ADD COLUMN woken_by TEXT");
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
  createRun(r: { ticket_id: number; repo: string; state: RunState; kind?: Run["kind"]; scout?: string | null; woken_by?: string | null }): Run {
    const row = this.db
      .query<{ id: number }, any>(
        "INSERT INTO runs (ticket_id, repo, state, kind, scout, woken_by) VALUES ($ticket_id, $repo, $state, $kind, $scout, $woken_by) RETURNING id",
      )
      .get({ ...r, kind: r.kind ?? "work", scout: r.scout ?? null, woken_by: r.woken_by ?? null })!;
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

  // ---- noticed (no foreign key to runs: reports outlive a discarded run)
  /**
   * Add a report, or count it against the latest one with the same normalised title in the repo,
   * whatever its status (a dismissed or ticketed problem is still known), unless `resolved` says
   * that one is settled (e.g. its ticket is done), in which case the problem is back: a new report.
   */
  addNoticed(
    n: { repo: string; runId: number; kind: NoticedKind; title: string; detail: string; evidence: string },
    resolved: (existing: Noticed) => boolean = () => false,
  ): { noticed: Noticed; merged: boolean } {
    const key = n.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const open = this.db
      .query<Noticed, [string, string]>("SELECT * FROM noticed WHERE repo = ? AND title_key = ? ORDER BY id DESC LIMIT 1")
      .get(n.repo, key);
    if (open && !resolved(open)) {
      const runs = new Set(open.run_ids.split(",").filter(Boolean));
      runs.add(String(n.runId));
      this.db
        .query("UPDATE noticed SET count = count + 1, run_ids = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .run([...runs].join(","), open.id);
      return { noticed: this.getNoticed(open.id)!, merged: true };
    }
    const row = this.db
      .query<{ id: number }, any>(
        "INSERT INTO noticed (repo, kind, title, title_key, detail, evidence, run_ids) VALUES ($repo, $kind, $title, $key, $detail, $evidence, $runs) RETURNING id",
      )
      .get({ repo: n.repo, kind: n.kind, title: n.title, key, detail: n.detail, evidence: n.evidence, runs: String(n.runId) })!;
    return { noticed: this.getNoticed(row.id)!, merged: false };
  }
  getNoticed(id: number): Noticed | null {
    return this.db.query<Noticed, [number]>("SELECT * FROM noticed WHERE id = ?").get(id);
  }
  listNoticed(status?: Noticed["status"]): Noticed[] {
    return status
      ? this.db.query<Noticed, [string]>("SELECT * FROM noticed WHERE status = ? ORDER BY id DESC").all(status)
      : this.db.query<Noticed, []>("SELECT * FROM noticed ORDER BY id DESC LIMIT 500").all();
  }
  updateNoticed(id: number, patch: { status: Noticed["status"]; ticket_id?: number | null }): Noticed {
    this.db
      .query("UPDATE noticed SET status = ?, ticket_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(patch.status, patch.ticket_id ?? null, id);
    return this.getNoticed(id)!;
  }

  // ---- library gaps
  /** Add a gap, or count it against the latest one with the same question (any status), unless `resolved` says that one is settled. */
  addGap(g: { repo: string; runId: number; question: string; tried: string }, resolved: (existing: LibraryGap) => boolean): { gap: LibraryGap; merged: boolean } {
    const key = Store.key(g.question);
    const prev = this.db
      .query<LibraryGap, [string, string]>("SELECT * FROM library_gaps WHERE repo = ? AND question_key = ? ORDER BY id DESC LIMIT 1")
      .get(g.repo, key);
    if (prev && !resolved(prev)) {
      const runs = new Set(prev.run_ids.split(",").filter(Boolean));
      runs.add(String(g.runId));
      this.db
        .query("UPDATE library_gaps SET count = count + 1, run_ids = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .run([...runs].join(","), prev.id);
      return { gap: this.getGap(prev.id)!, merged: true };
    }
    const row = this.db
      .query<{ id: number }, any>("INSERT INTO library_gaps (repo, question, question_key, tried, run_ids) VALUES ($repo, $q, $key, $tried, $runs) RETURNING id")
      .get({ repo: g.repo, q: g.question, key, tried: g.tried, runs: String(g.runId) })!;
    return { gap: this.getGap(row.id)!, merged: false };
  }
  getGap(id: number): LibraryGap | null {
    return this.db.query<LibraryGap, [number]>("SELECT * FROM library_gaps WHERE id = ?").get(id);
  }
  listGaps(filter: { repo?: string; status?: LibraryGap["status"] } = {}): LibraryGap[] {
    return this.db
      .query<LibraryGap, any>(
        "SELECT * FROM library_gaps WHERE ($repo IS NULL OR repo = $repo) AND ($status IS NULL OR status = $status) ORDER BY count DESC, id DESC LIMIT 500",
      )
      .all({ repo: filter.repo ?? null, status: filter.status ?? null });
  }
  updateGap(id: number, patch: { status?: LibraryGap["status"]; ticket_id?: number | null }): LibraryGap {
    const cur = this.getGap(id)!;
    this.db
      .query("UPDATE library_gaps SET status = ?, ticket_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(patch.status ?? cur.status, patch.ticket_id === undefined ? cur.ticket_id : patch.ticket_id, id);
    return this.getGap(id)!;
  }

  // ---- decisions
  /** Normalised text for matching duplicate questions. */
  static key(text: string): string {
    return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }
  addDecision(d: {
    repo: string;
    area: string;
    question: string;
    context?: string;
    options?: string;
    status?: Decision["status"];
    decision?: string;
    asked_by: string;
    run_id?: number | null;
  }): Decision {
    const decided = d.status === "decided";
    const row = this.db
      .query<{ id: number }, any>(
        `INSERT INTO decisions (repo, area, question, question_key, context, options, status, decision, asked_by, run_id, decided_at)
         VALUES ($repo, $area, $question, $key, $context, $options, $status, $decision, $asked_by, $run_id,
                 CASE WHEN $decided THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') END) RETURNING id`,
      )
      .get({
        repo: d.repo,
        area: d.area,
        question: d.question,
        key: Store.key(d.question),
        context: d.context ?? "",
        options: d.options ?? "",
        status: d.status ?? "open",
        decision: d.decision ?? "",
        asked_by: d.asked_by,
        run_id: d.run_id ?? null,
        decided: decided ? 1 : 0,
      })!;
    return this.getDecision(row.id)!;
  }
  getDecision(id: number): Decision | null {
    return this.db.query<Decision, [number]>("SELECT * FROM decisions WHERE id = ?").get(id);
  }
  listDecisions(filter: { repo?: string; status?: Decision["status"] } = {}): Decision[] {
    return this.db
      .query<Decision, any>(
        `SELECT * FROM decisions WHERE ($repo IS NULL OR repo = $repo) AND ($status IS NULL OR status = $status) ORDER BY id DESC LIMIT 500`,
      )
      .all({ repo: filter.repo ?? null, status: filter.status ?? null });
  }
  /** The latest open or decided decision with the same normalised question in a repo. */
  findDecisionByQuestion(repo: string, question: string): Decision | null {
    return this.db
      .query<Decision, [string, string]>(
        "SELECT * FROM decisions WHERE repo = ? AND question_key = ? AND status IN ('open', 'decided') ORDER BY id DESC LIMIT 1",
      )
      .get(repo, Store.key(question));
  }
  updateDecision(id: number, patch: Partial<Pick<Decision, "question" | "context" | "options" | "status" | "decision" | "superseded_by">> & { bump?: boolean; decided?: boolean }): Decision {
    const cur = this.getDecision(id)!;
    const next = { ...cur, ...patch };
    this.db
      .query(
        `UPDATE decisions SET question = $question, question_key = $key, context = $context, options = $options, status = $status,
           decision = $decision, superseded_by = $superseded_by, version = version + $bump,
           decided_at = CASE WHEN $decided THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE decided_at END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $id`,
      )
      .run({
        id,
        question: next.question,
        key: Store.key(next.question),
        context: next.context,
        options: next.options,
        status: next.status,
        decision: next.decision,
        superseded_by: next.superseded_by,
        bump: patch.bump ? 1 : 0,
        decided: patch.decided ? 1 : 0,
      });
    return this.getDecision(id)!;
  }

  /** The data of a run's latest event of one kind (one query, not the whole log). */
  lastEventData(runId: number, kind: string): Record<string, unknown> | null {
    const row = this.db
      .query<{ data: string }, [number, string]>("SELECT data FROM events WHERE run_id = ? AND kind = ? ORDER BY id DESC LIMIT 1")
      .get(runId, kind);
    return row ? JSON.parse(row.data) : null;
  }

  // ---- trunk triggers
  getTrunkSeen(repo: string): string | null {
    return this.db.query<{ commit_id: string }, [string]>("SELECT commit_id FROM trunk_seen WHERE repo = ?").get(repo)?.commit_id ?? null;
  }
  setTrunkSeen(repo: string, commit: string) {
    this.db
      .query("INSERT INTO trunk_seen (repo, commit_id) VALUES (?1, ?2) ON CONFLICT(repo) DO UPDATE SET commit_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')")
      .run(repo, commit);
  }
  /** Trigger-woken scout runs in a repo since an ISO time. */
  countTriggeredRuns(repo: string, sinceIso: string): number {
    return this.db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM runs WHERE repo = ? AND woken_by IS NOT NULL AND created_at >= ?").get(repo, sinceIso)!.n;
  }

  // ---- lessons
  addLesson(l: { repo: string; text: string; text_key: string; evidence?: string; tags?: string; status: Lesson["status"]; source: string; run_id?: number | null }): Lesson {
    const row = this.db
      .query<{ id: number }, any>(
        `INSERT INTO lessons (repo, text, text_key, evidence, tags, status, source, run_id, decided_at)
         VALUES ($repo, $text, $text_key, $evidence, $tags, $status, $source, $run_id, $decided_at) RETURNING id`,
      )
      .get({
        repo: l.repo,
        text: l.text,
        text_key: l.text_key,
        evidence: l.evidence ?? "",
        tags: l.tags ?? "",
        status: l.status,
        source: l.source,
        run_id: l.run_id ?? null,
        decided_at: l.status === "proposed" ? null : new Date().toISOString(),
      })!;
    return this.getLesson(row.id)!;
  }
  getLesson(id: number): Lesson | null {
    return this.db.query<Lesson, [number]>("SELECT * FROM lessons WHERE id = ?").get(id);
  }
  findLessonByKey(repo: string, key: string): Lesson | null {
    return this.db.query<Lesson, [string, string]>("SELECT * FROM lessons WHERE repo = ? AND text_key = ? ORDER BY id DESC LIMIT 1").get(repo, key);
  }
  listLessons(filter: { repo?: string; status?: Lesson["status"] } = {}): Lesson[] {
    return this.db
      .query<Lesson, [string | null, string | null]>(
        "SELECT * FROM lessons WHERE (?1 IS NULL OR repo = ?1) AND (?2 IS NULL OR status = ?2) ORDER BY id DESC",
      )
      .all(filter.repo ?? null, filter.status ?? null);
  }
  updateLesson(id: number, patch: { status?: Lesson["status"]; text?: string; text_key?: string }): Lesson {
    const cur = this.getLesson(id)!;
    const status = patch.status ?? cur.status;
    this.db
      .query(
        "UPDATE lessons SET status = ?, text = ?, text_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), decided_at = CASE WHEN ? != status THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE decided_at END WHERE id = ?",
      )
      .run(status, patch.text ?? cur.text, patch.text_key ?? cur.text_key, status, id);
    return this.getLesson(id)!;
  }
  countLessonUse(ids: number[]) {
    for (const id of ids) this.db.query("UPDATE lessons SET uses = uses + 1 WHERE id = ?").run(id);
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
