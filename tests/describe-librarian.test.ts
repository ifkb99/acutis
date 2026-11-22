import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app";
import { Store } from "../src/core/db";
import type { AcutisTool, AgentEvent, OneShotModel } from "../src/core/types";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeControls, type FakeScript } from "./helpers";

const tool = (c: FakeControls, name: string): AcutisTool => c.spec.tools!.find((x) => x.name === name)!;
const call = async (c: FakeControls, name: string, args: Record<string, string | number | undefined>) => (await tool(c, name).handler(args)).text;

/** Describes every section it's asked about with a fixed phrase per heading, and records each call. */
class FakeDescriber implements OneShotModel {
  calls: string[] = [];
  /** While set, describing waits for it (to look at search before descriptions exist). */
  gate: Promise<void> | null = null;
  constructor(private words: Record<string, string> = {}, private cost = 0.01) {}
  async ask(opts: Parameters<OneShotModel["ask"]>[0]) {
    if (this.gate) await this.gate;
    this.calls.push(opts.prompt);
    const ids = [...opts.prompt.matchAll(/<section id="(s\d+)" heading="([^"]*)">/g)];
    const out: Record<string, string> = {};
    for (const [, id, heading] of ids) out[id!] = this.words[heading!] ?? `Covers ${heading}.`;
    if (opts.prompt.includes("<file path=")) out.file = "A file about things.";
    return { text: "```json\n" + JSON.stringify(out) + "\n```", costUsd: this.cost };
  }
}

const long = (s: string) => `${s} ${"Plenty of detail here. ".repeat(20)}`;

async function setup(oneShot: OneShotModel, scripts: FakeScript[], files: Record<string, string>, home = tempDir("acutis-home-")) {
  const repoPath = await makeRepo(files);
  const app = createApp({ home, port: 0 }, { runner: new FakeRunner(scripts), oneShot });
  app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
  return { app, repoPath, home };
}
const until = (app: ReturnType<typeof createApp>, id: number, s: string) => waitFor(() => app.store.getRun(id)!.state === s, 10000);
const wf = "---\nlibrary:\n  describe: true\n---\n";

describe("descriptions (for finding, not reading)", () => {
  test("a description lets search find a section by words the text never uses; one call per file; thin sections skipped", async () => {
    const describer = new FakeDescriber({ "Guide > Persistence": "How saving and loading works: savegame serialization." });
    const files = {
      "README.md": "# Demo\n\nShort.\n",
      "docs/guide.md": `# Guide\n\n## Persistence\n\n${long("State is written with the store module.")}\n\n## Tiny\n\nok\n`,
      "docs/other.md": `# Other\n\n${long("Unrelated text about rendering.")}\n`,
      ".acutis/workflow.md": wf,
    };
    let before = "";
    let open!: () => void;
    describer.gate = new Promise<void>((r) => (open = r));
    const script: FakeScript = async (c) => {
      before = await call(c, "search_project", { query: "savegame serialization" });
      open();
      c.result();
      await c.nextMessage();
    };
    const second: FakeScript = async (c) => {
      const after = await call(c, "search_project", { query: "savegame serialization" });
      expect(after).toContain("docs/guide.md:3");
      expect(after).toContain("about (model-written, check the text): How saving and loading works");
      c.result();
      await c.nextMessage();
    };
    const { app } = await setup(describer, [script, second], files);
    const r1 = await app.runs.start(app.tickets.create({ repo: "demo", title: "a", body: "" }).id);
    await until(app, r1.id, "awaiting_review");
    await app.runs.describeIdle();
    expect(before).toContain("No library results"); // the words aren't in the docs
    // One call per file with describable sections, each holding only that file's sections.
    expect(describer.calls.length).toBe(2);
    expect(describer.calls.every((p) => (p.match(/^File: /gm) ?? []).length === 1)).toBe(true);
    expect(describer.calls.some((p) => p.includes('heading="Guide > Tiny"'))).toBe(false); // thin: no model call
    const job = app.runs.library.describeJob("demo", app.store.getRun(r1.id)!.base_commit!)!;
    expect(job).toMatchObject({ status: "done", described: 2 });
    expect(job.cost_usd).toBeCloseTo(0.02);
    const r2 = await app.runs.start(app.tickets.create({ repo: "demo", title: "b", body: "" }).id);
    await until(app, r2.id, "awaiting_review");
  });

  test("descriptions are cached by content: a new commit only pays for changed sections", async () => {
    const describer = new FakeDescriber();
    const files = { "docs/a.md": `# A\n\n${long("alpha")}\n`, "docs/b.md": `# B\n\n${long("beta")}\n`, ".acutis/workflow.md": wf };
    const quick: FakeScript = async (c) => {
      c.result();
      await c.nextMessage();
    };
    const { app, repoPath } = await setup(describer, [quick, quick], files);
    const r1 = await app.runs.start(app.tickets.create({ repo: "demo", title: "a", body: "" }).id);
    await until(app, r1.id, "awaiting_review");
    await app.runs.describeIdle();
    expect(describer.calls.length).toBe(2);
    await Bun.write(`${repoPath}/docs/b.md`, `# B\n\n${long("beta, changed")}\n`);
    await Bun.$`jj commit -m change && jj bookmark set main -r @-`.cwd(repoPath).quiet();
    const r2 = await app.runs.start(app.tickets.create({ repo: "demo", title: "b", body: "" }).id);
    await until(app, r2.id, "awaiting_review");
    await app.runs.describeIdle();
    expect(describer.calls.length).toBe(3); // only b.md again
    expect(describer.calls.at(-1)).toContain("File: docs/b.md");
  });

  test("describing stops at its budget and when the daemon shuts down", async () => {
    const describer = new FakeDescriber({}, 0.3);
    const files: Record<string, string> = { ".acutis/workflow.md": "---\nlibrary:\n  describe: true\n  describe_budget_usd: 0.5\n---\n" };
    for (const n of ["a", "b", "c", "d"]) files[`docs/${n}.md`] = `# ${n}\n\n${long(n)}\n`;
    const quick: FakeScript = async (c) => {
      c.result();
      await c.nextMessage();
    };
    const { app } = await setup(describer, [quick], files);
    const r = await app.runs.start(app.tickets.create({ repo: "demo", title: "a", body: "" }).id);
    await until(app, r.id, "awaiting_review");
    await app.runs.describeIdle();
    const job = app.runs.library.describeJob("demo", app.store.getRun(r.id)!.base_commit!)!;
    expect(describer.calls.length).toBe(2); // $0.30 + $0.30 crosses $0.50, then it stops
    expect(job).toMatchObject({ status: "partial" });
    expect(job.note).toContain("budget");
  });

  test("a library from phase 1 (no description column) is rebuilt, and decisions are put back", () => {
    const path = `${tempDir("acutis-db-")}/acutis.db`;
    const old = new Database(path, { create: true });
    old.exec(`CREATE VIRTUAL TABLE library USING fts5(heading, body, repo UNINDEXED, commit_id UNINDEXED, kind UNINDEXED, ref UNINDEXED, line UNINDEXED);
      CREATE TABLE library_commits (repo TEXT NOT NULL, commit_id TEXT NOT NULL, files INTEGER NOT NULL, chunks INTEGER NOT NULL, indexed_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (repo, commit_id));
      INSERT INTO library VALUES ('h', 'old body', 'demo', 'c1', 'doc', 'a.md', 1);
      INSERT INTO library_commits VALUES ('demo', 'c1', 1, 1, '');`);
    old.close();
    const store = new Store(path);
    store.addRepo({ name: "demo", path: tempDir("r-"), base: "main" });
    store.addDecision({ repo: "demo", area: "general", question: "", status: "decided", decision: "Keep the API stable.", asked_by: "operator" });
    const home = path.replace(/\/acutis\.db$/, "");
    const app = createApp({ home, port: 0 }, { runner: new FakeRunner([]) });
    expect(app.runs.library.isIndexed("demo", "c1")).toBe(false); // reindexed on the next run start
    expect(app.runs.library.search("demo", null, "API stable", 5).map((h) => h.kind)).toEqual(["decision"]);
  });
});

describe("citations", () => {
  test("one [SRC] marker can cite several entries, including same-file shorthand", async () => {
    const { citationRefs } = await import("../src/core/runs");
    expect(citationRefs("docs/a.md:41, :116")).toEqual(["docs/a.md:41", "docs/a.md:116"]);
    expect(citationRefs("docs/a.md:64; README.md:11")).toEqual(["docs/a.md:64", "README.md:11"]);
    expect(citationRefs("run 5")).toEqual(["run 5"]);
    expect(citationRefs("decision #2")).toEqual(["decision #2"]);
    expect(citationRefs("docs/a.md:3-9")).toEqual(["docs/a.md:3-9"]);
  });
});

describe("overview and librarian", () => {
  test("project_overview lists doc files with headings and file descriptions, at no model cost", async () => {
    const describer = new FakeDescriber();
    let out = "";
    const script: FakeScript = async (c) => {
      out = await call(c, "project_overview", {});
      c.result();
      await c.nextMessage();
    };
    const files = { "docs/guide.md": `# Guide\n\n## Install\n\n${long("x")}\n\n## Usage\n\n${long("y")}\n`, ".acutis/workflow.md": wf };
    const warmUp: FakeScript = async (c) => {
      c.result();
      await c.nextMessage();
    };
    const { app } = await setup(describer, [warmUp, script], files);
    const warm = await app.runs.start(app.tickets.create({ repo: "demo", title: "warm", body: "" }).id);
    await until(app, warm.id, "awaiting_review");
    await app.runs.describeIdle(); // the second run then sees the descriptions
    const calls = describer.calls.length;
    const r = await app.runs.start(app.tickets.create({ repo: "demo", title: "o", body: "" }).id);
    await until(app, r.id, "awaiting_review");
    expect(out).toContain("docs/guide.md (3 sections)");
    expect(out).toContain("about: A file about things.");
    expect(out).toContain("- Guide > Install");
    expect(describer.calls.length).toBe(calls); // the overview itself costs no model call
    app.runs.shutdown();
  });

  test("ask_librarian answers through the library tools; unopened [SRC] citations are flagged; its cost is the run's", async () => {
    let seenTools: string[] = [];
    const librarian: OneShotModel = {
      async ask(opts) {
        seenTools = (opts.tools ?? []).map((t) => t.name);
        const search = opts.tools!.find((t) => t.name === "search_project")!;
        const hits = (await search.handler({ query: "cache cap" })).text;
        const id = /\[(L\d+)\]/.exec(hits)![1]!;
        await opts.tools!.find((t) => t.name === "read_project_entry")!.handler({ id });
        return { text: "The cache is an LRU capped at 512 [SRC: docs/cache.md:3]. It was chosen for speed [SRC: docs/history.md:9]. [GEN] LRUs evict the least recently used.", costUsd: 0.004 };
      },
    };
    let answer = "";
    let workerTools: string[] = [];
    const script: FakeScript = async (c) => {
      workerTools = (c.spec.tools ?? []).map((t) => t.name);
      answer = await call(c, "ask_librarian", { question: "How big is the cache?" });
      c.result("success", 0.01);
      await c.nextMessage();
    };
    const files = { "docs/cache.md": "# Cache\n\nThe cache is an LRU with a 512-entry cap.\n", ".acutis/workflow.md": "---\nlibrary:\n  librarian: true\n---\n" };
    const { app } = await setup(librarian, [script], files);
    const r = await app.runs.start(app.tickets.create({ repo: "demo", title: "q", body: "" }).id);
    await until(app, r.id, "awaiting_review");
    expect(workerTools).toContain("ask_librarian");
    expect(seenTools.sort()).toEqual(["project_overview", "read_project_entry", "search_project"]);
    expect(answer).toContain("[SRC: docs/cache.md:3]");
    expect(answer).toContain("1 [SRC] citation(s) point at entries the librarian didn't open: docs/history.md:9");
    expect(app.store.getRun(r.id)!.cost_usd).toBeCloseTo(0.014);
    const ev = app.store.events(r.id);
    expect(ev.find((e) => e.kind === "library.search")!.data).toMatchObject({ by: "librarian" });
    expect(ev.find((e) => e.kind === "library.librarian")!.data).toMatchObject({ cited: 2, unverified: 1 });
  });
});
