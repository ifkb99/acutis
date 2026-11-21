import type { Database } from "bun:sqlite";
import { lstatSync, openSync, readSync, closeSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * The project library: a repo's docs, searchable by workers in short excerpts (phase 1 of the
 * scouts/library/contracts plan). Docs are indexed per (repo, commit) from the files tracked at
 * the run's base commit, read from the fresh workspace before setup steps or the agent touch it,
 * so a worker's edits never reach it. Finished runs' summaries ride along, refreshed per search.
 */

export const DEFAULT_LIBRARY_INCLUDE = ["**/*.md", "**/*.mdx", "**/*.rst", "docs/**/*.txt"];
export const DEFAULT_LIBRARY_EXCLUDE = ["**/node_modules/**", "**/vendor/**", ".acutis/**"];
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 2000;
const CHUNK_CHARS = 2000;
/** Total characters a search returns: about 1.5k tokens, so a search never floods a worker's context. */
export const SEARCH_BUDGET_CHARS = 6000;

export interface LibraryConfig {
  include: string[];
  exclude: string[];
}

export interface Chunk {
  line: number;
  heading: string;
  body: string;
}

export interface LibraryHit {
  id: string;
  kind: "doc" | "run" | "decision";
  ref: string;
  line: number;
  heading: string;
  snippet: string;
}

export interface RunSummary {
  runId: number;
  title: string;
  body: string;
}

/** Split markdown into chunks at headings (outside code fences), each at most ~CHUNK_CHARS. */
export function chunkText(text: string, markdown: boolean): Chunk[] {
  // One long line (a wide table, a data URI) would otherwise be a chunk of any size: split it.
  const lines: string[] = [];
  const lineNo: number[] = [];
  text.split("\n").forEach((l, i) => {
    for (let at = 0; at === 0 || at < l.length; at += CHUNK_CHARS) {
      lines.push(l.slice(at, at + CHUNK_CHARS));
      lineNo.push(i + 1);
    }
  });
  const chunks: Chunk[] = [];
  const stack: string[] = [];
  let buf: string[] = [];
  let start = 1;
  let size = 0;
  let fence = false;
  const flush = (nextStart: number) => {
    const body = buf.join("\n").trim();
    if (body) chunks.push({ line: start, heading: stack.filter(Boolean).join(" > "), body });
    buf = [];
    size = 0;
    start = nextStart;
  };
  lines.forEach((line, i) => {
    if (markdown && /^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = markdown && !fence ? line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/) : null;
    if (h) {
      flush(lineNo[i]!);
      stack.length = h[1]!.length - 1;
      stack.push(h[2]!.slice(0, 200));
    } else if (size + line.length > CHUNK_CHARS && size > 0) {
      flush(lineNo[i]!);
    }
    buf.push(line);
    size += line.length + 1;
  });
  flush((lineNo.at(-1) ?? 0) + 1);
  return chunks;
}

/** Words for an FTS5 query: quoted terms joined with OR (ranked by bm25), no operators from the input. */
export function ftsQuery(text: string): string | null {
  const words = [...new Set((text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? []).slice(0, 12))];
  return words.length ? words.map((w) => `"${w}"`).join(" OR ") : null;
}

const isInside = (root: string, p: string) => p === root || p.startsWith(root + sep);

/**
 * Read a tracked doc only if it's a plain file inside the workspace: a tracked symlink to
 * ~/.ssh or $ACUTIS_HOME/token must not be served to the worker by a tool that runs outside
 * the sandbox. Skips large and binary files.
 */
export function readDocSafely(root: string, rel: string): string | null {
  const abs = join(root, rel);
  try {
    const st = lstatSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    if (!isInside(realpathSync(root), realpathSync(abs))) return null;
    const fd = openSync(abs, "r");
    const head = Buffer.alloc(Math.min(8192, st.size));
    readSync(fd, head, 0, head.length, 0);
    closeSync(fd);
    if (head.includes(0)) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

export class Library {
  constructor(private db: Database) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS library USING fts5(
        heading, body, repo UNINDEXED, commit_id UNINDEXED, kind UNINDEXED, ref UNINDEXED, line UNINDEXED,
        tokenize = 'porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS library_commits (
        repo TEXT NOT NULL, commit_id TEXT NOT NULL, files INTEGER NOT NULL, chunks INTEGER NOT NULL,
        indexed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (repo, commit_id)
      );
    `);
  }

  isIndexed(repo: string, commit: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM library_commits WHERE repo = ? AND commit_id = ?").get(repo, commit));
  }

  /** The newest indexed commit for a repo (a fallback when a run's own commit isn't indexed). */
  latestCommit(repo: string): string | null {
    const row = this.db
      .query<{ commit_id: string }, [string]>("SELECT commit_id FROM library_commits WHERE repo = ? ORDER BY indexed_at DESC LIMIT 1")
      .get(repo);
    return row?.commit_id ?? null;
  }

  /** Index the docs among `files` (tracked paths) read from `root`, a checkout of `commit`. */
  index(repo: string, commit: string, root: string, files: string[], cfg: LibraryConfig): { files: number; chunks: number } {
    const include = cfg.include.map((g) => new Bun.Glob(g));
    const exclude = cfg.exclude.map((g) => new Bun.Glob(g));
    const docs = files.filter((f) => include.some((g) => g.match(f)) && !exclude.some((g) => g.match(f))).slice(0, MAX_FILES);
    const insert = this.db.query(
      "INSERT INTO library (heading, body, repo, commit_id, kind, ref, line) VALUES (?, ?, ?, ?, 'doc', ?, ?)",
    );
    let fileCount = 0;
    let chunkCount = 0;
    this.db.transaction(() => {
      this.db.query("DELETE FROM library WHERE repo = ? AND commit_id = ? AND kind = 'doc'").run(repo, commit);
      for (const rel of docs) {
        const text = readDocSafely(root, rel);
        if (text === null) continue;
        fileCount++;
        for (const c of chunkText(text, /\.mdx?$/i.test(rel))) {
          insert.run(c.heading, c.body, repo, commit, rel, c.line);
          chunkCount++;
        }
      }
      this.db
        .query("INSERT OR REPLACE INTO library_commits (repo, commit_id, files, chunks) VALUES (?, ?, ?, ?)")
        .run(repo, commit, fileCount, chunkCount);
    })();
    return { files: fileCount, chunks: chunkCount };
  }

  /** Drop indexed commits of a repo that no live run uses. */
  prune(repo: string, keep: string[]) {
    const commits = this.db
      .query<{ commit_id: string }, [string]>("SELECT commit_id FROM library_commits WHERE repo = ?")
      .all(repo)
      .map((r) => r.commit_id)
      .filter((c) => !keep.includes(c));
    for (const c of commits) {
      this.db.query("DELETE FROM library WHERE repo = ? AND commit_id = ?").run(repo, c);
      this.db.query("DELETE FROM library_commits WHERE repo = ? AND commit_id = ?").run(repo, c);
    }
  }

  /** Run ids whose summaries are already in the library for a repo. */
  summarizedRuns(repo: string): Set<number> {
    return new Set(
      this.db
        .query<{ ref: string }, [string]>("SELECT ref FROM library WHERE repo = ? AND kind = 'run'")
        .all(repo)
        .map((r) => Number(r.ref.slice(4))),
    );
  }

  /** Add summaries of newly landed runs. Existing ones stay, so ids from earlier searches still open. */
  addRunSummaries(repo: string, runs: RunSummary[]) {
    const insert = this.db.query(
      "INSERT INTO library (heading, body, repo, commit_id, kind, ref, line) VALUES (?, ?, ?, '', 'run', ?, 0)",
    );
    this.db.transaction(() => {
      for (const r of runs) insert.run(r.title, r.body, repo, `run ${r.runId}`);
    })();
  }

  /** Replace the repo's decisions (operator-written; few, and they change when superseded). */
  setDecisions(repo: string, decisions: { id: number; question: string; decision: string }[]) {
    const insert = this.db.query(
      "INSERT INTO library (heading, body, repo, commit_id, kind, ref, line) VALUES (?, ?, ?, '', 'decision', ?, 0)",
    );
    this.db.transaction(() => {
      this.db.query("DELETE FROM library WHERE repo = ? AND kind = 'decision'").run(repo);
      for (const d of decisions) insert.run(d.question || "Operator decision", d.decision, repo, `decision #${d.id}`);
    })();
  }

  search(repo: string, commit: string | null, query: string, limit: number): LibraryHit[] {
    const q = ftsQuery(query);
    if (!q) return [];
    return this.db
      .query<{ rowid: number; kind: LibraryHit["kind"]; ref: string; line: number; heading: string; snip: string }, any[]>(
        `SELECT rowid, kind, ref, line, heading, snippet(library, 1, '', '', '…', 32) AS snip
         FROM library WHERE library MATCH ? AND repo = ? AND (commit_id = ? OR kind IN ('run', 'decision'))
         ORDER BY bm25(library, 4.0, 1.0) LIMIT ?`,
      )
      .all(q, repo, commit ?? "", Math.max(1, Math.min(10, limit)))
      .map((r) => ({ id: `L${r.rowid}`, kind: r.kind, ref: r.ref, line: Number(r.line), heading: r.heading, snippet: r.snip }));
  }

  read(repo: string, id: string): { kind: string; ref: string; line: number; heading: string; body: string } | null {
    const rowid = Number(/^L(\d+)$/.exec(id.trim())?.[1]);
    if (!rowid) return null;
    const row = this.db
      .query<{ kind: string; ref: string; line: number; heading: string; body: string; repo: string }, [number]>(
        "SELECT kind, ref, line, heading, body, repo FROM library WHERE rowid = ?",
      )
      .get(rowid);
    return row && row.repo === repo ? { ...row, line: Number(row.line) } : null;
  }
}

/** Format search hits for a worker within SEARCH_BUDGET_CHARS. */
export function formatHits(hits: LibraryHit[], header: string): string {
  const out = [header];
  let used = header.length;
  let shown = 0;
  for (const h of hits) {
    const where =
      h.kind === "doc" ? `${h.ref}:${h.line}` : h.kind === "decision" ? `${h.ref} (the operator's decision)` : `${h.ref} (landed; summary written by its worker)`;
    const block = `\n[${h.id}] ${where}${h.heading ? ` · ${h.heading}` : ""}\n  ${h.snippet.replace(/\s+/g, " ").trim()}`;
    if (used + block.length > SEARCH_BUDGET_CHARS) break;
    out.push(block);
    used += block.length;
    shown++;
  }
  if (shown < hits.length) out.push(`\n(${hits.length - shown} more not shown; narrow the query.)`);
  return out.join("\n");
}
