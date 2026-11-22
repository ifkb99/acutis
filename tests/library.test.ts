import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import { chunkText, ftsQuery, readDocSafely, SEARCH_BUDGET_CHARS } from "../src/core/library";
import type { AcutisTool, AgentEvent } from "../src/core/types";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeControls, type FakeScript } from "./helpers";

describe("library units", () => {
  test("markdown splits at headings (not inside code fences), with heading paths and start lines", () => {
    const md = ["# Guide", "intro", "## Auth", "tokens live here", "```", "# not a heading", "```", "### Rotation", "rotate often"].join("\n");
    const chunks = chunkText(md, true);
    expect(chunks.map((c) => [c.line, c.heading])).toEqual([
      [1, "Guide"],
      [3, "Guide > Auth"],
      [8, "Guide > Auth > Rotation"],
    ]);
    expect(chunks[1]!.body).toContain("# not a heading");
  });

  test("long sections are split so no chunk is much over 2000 characters", () => {
    const md = ["# Big", ...Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`)].join("\n");
    const chunks = chunkText(md, true);
    expect(chunks.length).toBeGreaterThan(3);
    expect(Math.max(...chunks.map((c) => c.body.length))).toBeLessThan(2100);
    expect(chunks.every((c) => c.heading === "Big")).toBe(true);
  });

  test("one very long line (a wide table, a data URI) is split, so no chunk is unbounded", () => {
    const chunks = chunkText(`# Data\n${"y".repeat(50_000)}\nafter`, true);
    expect(Math.max(...chunks.map((c) => c.body.length))).toBeLessThanOrEqual(2000);
    expect(chunks.map((c) => c.body).join("").replace(/\s|# Data|after/g, "").length).toBe(50_000);
    expect(chunks.filter((c) => c.line === 2).length).toBeGreaterThan(20); // the pieces keep their source line
    expect(chunks.at(-1)!.line).toBe(3);
  });

  test("library globs parse from the workflow; each list replaces its default", async () => {
    const { parseWorkflow } = await import("../src/core/workflow");
    expect(parseWorkflow("---\nlibrary:\n  include: [\"wiki/**/*.md\"]\n---\n", "t").library).toEqual({
      include: ["wiki/**/*.md"],
      exclude: ["**/node_modules/**", "**/vendor/**", ".acutis/**"],
      describe: false,
      describe_budget_usd: 0.5,
      librarian: false,
    });
    expect(() => parseWorkflow("---\nlibrary: [1]\n---\n", "t")).toThrow(/library/);
  });

  test("queries become quoted words, so FTS operators in the input can't break or widen the search", () => {
    expect(ftsQuery('auth* OR "x" NEAR(a b) -token')).toBe('"auth" OR "near" OR "token"');
    expect(ftsQuery("how do I add a unit")).toBe('"add" OR "unit"');
    expect(ftsQuery("what is it")).toBe('"what" OR "is" OR "it"'); // only stop words: keep them
    expect(ftsQuery("!!")).toBeNull();
  });

  test("only plain files inside the workspace are read: symlinks, binaries and big files are skipped", () => {
    const root = tempDir("acutis-lib-");
    const outside = join(tempDir("acutis-outside-"), "secret.txt");
    writeFileSync(outside, "SECRETVALUE");
    writeFileSync(join(root, "ok.md"), "# ok");
    symlinkSync(outside, join(root, "link.md"));
    writeFileSync(join(root, "bin.md"), Buffer.from([0x23, 0x00, 0x01]));
    writeFileSync(join(root, "big.md"), "x".repeat(300 * 1024));
    expect(readDocSafely(root, "ok.md")).toBe("# ok");
    expect(readDocSafely(root, "link.md")).toBeNull();
    expect(readDocSafely(root, "bin.md")).toBeNull();
    expect(readDocSafely(root, "big.md")).toBeNull();
    expect(readDocSafely(root, "../escape.md")).toBeNull();
    // A symlinked directory on the way: the file itself is plain, but its real path is outside.
    const outDir = tempDir("acutis-outdir-");
    writeFileSync(join(outDir, "inner.md"), "SECRETVALUE");
    symlinkSync(outDir, join(root, "sub"));
    expect(readDocSafely(root, "sub/inner.md")).toBeNull();
  });
});

describe("library and noticed in runs", () => {
  const tool = (c: FakeControls, name: string): AcutisTool => {
    const t = c.spec.tools?.find((x) => x.name === name);
    if (!t) throw new Error(`no ${name} tool`);
    return t;
  };
  const finalReport = (c: FakeControls, text: string) =>
    c.emit({ kind: "agent.result", subtype: "success", result: text, is_error: false, cost_usd: 0.01, turns: 1, duration_ms: 5 } as AgentEvent);

  async function setup(scripts: FakeScript[], files: Record<string, string>) {
    const repoPath = await makeRepo(files);
    const app = createApp({ home: tempDir("acutis-home-"), port: 0 }, { runner: new FakeRunner(scripts) });
    app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
    return { app, repoPath, ticket: (title: string) => app.tickets.create({ repo: "demo", title, body: `Ticket body for ${title}` }) };
  }

  test("search finds trunk docs with path:line; secrets behind symlinks and setup-step edits never appear", async () => {
    const outside = join(tempDir("acutis-outside-"), "secret.md");
    writeFileSync(outside, "SECRETVALUE lives here");
    const out: Record<string, string> = {};
    const script: FakeScript = async (c) => {
      const search = tool(c, "search_project");
      out.token = (await search.handler({ query: "where does the daemon token live" })).text;
      out.secret = (await search.handler({ query: "SECRETVALUE" })).text;
      out.setup = (await search.handler({ query: "SETUPWORD" })).text;
      const id = /\[(L\d+)\] docs\/auth\.md/.exec(out.token)?.[1] ?? "";
      out.read = (await tool(c, "read_project_entry").handler({ id })).text;
      c.result();
      await c.nextMessage();
    };
    const workflow = "---\nsetup:\n  - echo SETUPWORD >> README.md\n---\n";
    const { app, repoPath, ticket } = await setup([script], {
      "README.md": "# Demo\n\nA demo repo.\n",
      "docs/auth.md": "# Auth\n\nIntro.\n\n## Tokens\n\nThe daemon token lives in ACUTIS_HOME and is 0600.\n",
      ".acutis/workflow.md": workflow,
    });
    // A tracked symlink to a file outside the repo (committed after makeRepo's first commit).
    symlinkSync(outside, join(repoPath, "docs/leak.md"));
    await Bun.$`jj commit -m leak && jj bookmark set main -r @-`.cwd(repoPath).quiet();
    const run = await app.runs.start(ticket("t").id);
    await waitFor(() => app.store.getRun(run.id)!.state === "awaiting_review", 10000);

    expect(out.token).toContain("docs/auth.md:5 [approved: trunk doc] · Auth > Tokens");
    expect(out.token!.length).toBeLessThan(SEARCH_BUDGET_CHARS + 200);
    expect(out.read).toContain("The daemon token lives in ACUTIS_HOME");
    expect(out.secret).toContain("No library results");
    expect(out.setup).toContain("No library results");
    const log = app.store.events(run.id).find((e) => e.kind === "system.log" && String((e.data as any).msg).startsWith("Project library"));
    expect((log?.data as any)?.msg).toMatch(/Project library: 2 docs/);
  });

  test("a landed run's ticket and final report are searchable by later runs, labelled as worker-written", async () => {
    let found = "";
    const lands: FakeScript = async (c) => {
      writeFileSync(join(c.spec.cwd, "x.txt"), "x\n");
      finalReport(c, "Switched the cache to an LRU with a 512-entry cap.");
      await c.nextMessage();
    };
    const searches: FakeScript = async (c) => {
      found = (await tool(c, "search_project").handler({ query: "LRU cache cap" })).text;
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([lands, searches], { "README.md": "# Demo\n" });
    const r1 = await app.runs.start(ticket("Cache tuning").id);
    await waitFor(() => app.store.getRun(r1.id)!.state === "awaiting_review", 10000);
    await app.runs.approve(r1.id);
    const r2 = await app.runs.start(ticket("Next").id);
    await waitFor(() => app.store.getRun(r2.id)!.state === "awaiting_review", 10000);
    expect(found).toContain(`run ${r1.id} [reviewed: landed run, summary written by its worker] · Run ${r1.id}: Cache tuning`);
  });

  test("run summary ids stay valid after another run lands", async () => {
    const outs: string[] = [];
    let opened = "";
    const lands = (text: string): FakeScript => async (c) => {
      writeFileSync(join(c.spec.cwd, `${text.length}.txt`), "x\n");
      finalReport(c, text);
      await c.nextMessage();
    };
    let firstId = "";
    const searchesTwice: FakeScript = async (c) => {
      outs.push((await tool(c, "search_project").handler({ query: "cache" })).text);
      firstId = /\[(L\d+)\] run/.exec(outs[0]!)?.[1] ?? "";
      await c.nextMessage(); // the operator lands another run meanwhile, then messages
      outs.push((await tool(c, "search_project").handler({ query: "cache" })).text);
      opened = (await tool(c, "read_project_entry").handler({ id: firstId })).text;
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([lands("Cache A: added an LRU cache."), searchesTwice, lands("Cache B: tuned the cache size.")], { "README.md": "# Demo\n" });
    const r1 = await app.runs.start(ticket("A").id);
    await waitFor(() => app.store.getRun(r1.id)!.state === "awaiting_review", 10000);
    await app.runs.approve(r1.id);
    const r2 = await app.runs.start(ticket("searcher").id);
    await waitFor(() => outs.length === 1, 10000);
    const r3 = await app.runs.start(ticket("B").id);
    await waitFor(() => app.store.getRun(r3.id)!.state === "awaiting_review", 10000);
    await app.runs.approve(r3.id);
    await app.runs.message(r2.id, "go on");
    await waitFor(() => opened !== "", 10000);
    expect(outs[1]).toContain(`run ${r3.id}`);
    expect(opened).toContain(`run ${r1.id}`);
    expect(opened).toContain("Cache A: added an LRU cache.");
  });

  test("an indexing failure warns but never fails the run", async () => {
    let tools: string[] = [];
    const script: FakeScript = async (c) => {
      tools = (c.spec.tools ?? []).map((t) => t.name);
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([script], { "README.md": "# Demo\n" });
    app.workspaces.listFiles = async () => {
      throw new Error("jj exploded");
    };
    const run = await app.runs.start(ticket("t").id);
    await waitFor(() => app.store.getRun(run.id)!.state === "awaiting_review", 10000);
    const warn = app.store.events(run.id).find((e) => e.kind === "system.log" && (e.data as any).level === "warn");
    expect((warn?.data as any)?.msg).toContain("Project library unavailable for this run: jj exploded");
    expect(tools).toContain("search_project");
  });

  test("library: false offers no search tools, but report_noticed stays", async () => {
    let tools: string[] = [];
    const script: FakeScript = async (c) => {
      tools = (c.spec.tools ?? []).map((t) => t.name);
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([script], { "README.md": "# Demo\n", ".acutis/workflow.md": "---\nlibrary: false\n---\n" });
    const run = await app.runs.start(ticket("t").id);
    await waitFor(() => app.store.getRun(run.id)!.state === "awaiting_review", 10000);
    expect(tools).toEqual(["report_noticed"]);
  });

  test("noticed reports merge by title, cap per run, and become tickets that say they're worker-written", async () => {
    const replies: string[] = [];
    const report = async (c: FakeControls, title: string) =>
      replies.push((await tool(c, "report_noticed").handler({ title, detail: "clippy fails on base", evidence: "tests/assault.rs:12", kind: "failing-check" })).text);
    const first: FakeScript = async (c) => {
      await report(c, "Clippy fails on base");
      c.result();
      await c.nextMessage();
    };
    const second: FakeScript = async (c) => {
      await report(c, "clippy FAILS on base!");
      for (let i = 0; i < 10; i++) await report(c, `other ${i}`);
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([first, second], { "README.md": "# Demo\n" });
    const r1 = await app.runs.start(ticket("one").id);
    const r2 = await app.runs.start(ticket("two").id);
    await waitFor(() => ["awaiting_review"].includes(app.store.getRun(r2.id)!.state) && app.store.getRun(r1.id)!.state === "awaiting_review", 10000);

    const open = app.runs.listNoticed("open");
    const clippy = open.find((n) => n.title === "Clippy fails on base")!;
    expect(clippy.count).toBe(2);
    expect(clippy.run_ids.split(",").sort()).toEqual([String(r1.id), String(r2.id)].sort());
    expect(open.length).toBe(1 + 9); // the second run's 11th report hit the cap of 10
    expect(replies.at(-1)).toContain("already filed 10 reports");
    expect(app.store.events(r1.id).some((e) => e.kind === "noticed")).toBe(true);

    const t = app.runs.ticketFromNoticed(clippy.id);
    expect(t.title).toBe("Clippy fails on base");
    expect(t.body).toContain("written by a worker and hasn't been checked");
    expect(t.body).toContain("tests/assault.rs:12");
    expect(app.store.getNoticed(clippy.id)).toMatchObject({ status: "ticketed", ticket_id: t.id });
    expect(() => app.runs.ticketFromNoticed(clippy.id)).toThrow(/already ticketed/);
    const other = open.find((n) => n.title === "other 0")!;
    expect(app.runs.dismissNoticed(other.id).status).toBe("dismissed");
  });

  test("a problem the operator dismissed or ticketed isn't reopened by the next report, unless its ticket is done", async () => {
    const replies: string[] = [];
    const reports = (n: number): FakeScript => async (c) => {
      for (let i = 0; i < n; i++) {
        await c.nextMessage();
        replies.push((await tool(c, "report_noticed").handler({ title: i % 2 ? "Clippy\nfails on base" : "Clippy fails on base", detail: "d" })).text);
      }
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([reports(4)], { "README.md": "# Demo\n" });
    const run = await app.runs.start(ticket("t").id);
    await waitFor(() => app.store.getRun(run.id)!.state === "running", 10000);
    const say = async (n: number) => (await app.runs.message(run.id, "next"), await waitFor(() => replies.length === n, 5000));

    await say(1);
    const first = app.runs.listNoticed("open")[0]!;
    app.runs.dismissNoticed(first.id);
    await say(2); // same problem (the title's newline is folded), already dismissed
    expect(replies[1]).toContain("already looked at this and dismissed it");
    expect(app.runs.listNoticed("open")).toEqual([]);
    expect(app.store.getNoticed(first.id)).toMatchObject({ status: "dismissed", count: 2, title: "Clippy fails on base" });

    // A ticketed one counts too, until its ticket is done; then the problem is back.
    app.store.updateNoticed(first.id, { status: "open" });
    const t = app.runs.ticketFromNoticed(first.id);
    await say(3);
    expect(replies[2]).toContain(`already ticket #${t.id}`);
    app.tickets.setStatus(t.id, "done");
    await say(4);
    expect(replies[3]).toContain("Recorded as noticed");
    expect(app.runs.listNoticed("open").length).toBe(1);
  });

  test("the noticed API lists, tickets and dismisses (with the token)", async () => {
    const { startServer } = await import("../src/server/server");
    const port = 19000 + Math.floor(Math.random() * 1000);
    const repoPath = await makeRepo({ "README.md": "# Demo\n" });
    const app = createApp({ home: tempDir("acutis-home-"), port }, { runner: new FakeRunner([]) });
    app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
    const run = app.store.createRun({ ticket_id: app.tickets.create({ repo: "demo", title: "t", body: "" }).id, repo: "demo", state: "running" });
    const a = app.store.addNoticed({ repo: "demo", runId: run.id, kind: "bug", title: "A", detail: "", evidence: "" }).noticed;
    const b = app.store.addNoticed({ repo: "demo", runId: run.id, kind: "docs", title: "B", detail: "", evidence: "" }).noticed;
    const server = startServer(app);
    try {
      const h = { authorization: `Bearer ${app.token}`, "x-acutis": "1" };
      const base = `http://127.0.0.1:${port}/api/noticed`;
      expect(((await (await fetch(base, { headers: h })).json()) as any[]).map((n) => n.title).sort()).toEqual(["A", "B"]);
      expect((await fetch(base)).status).toBe(401);
      expect(((await (await fetch(`${base}/${a.id}/ticket`, { method: "POST", headers: h })).json()) as any).title).toBe("A");
      expect((await fetch(`${base}/${b.id}/dismiss`, { method: "POST", headers: h })).status).toBe(200);
      expect(((await (await fetch(base, { headers: h })).json()) as any[]).length).toBe(0);
      expect(((await (await fetch(`${base}?status=all`, { headers: h })).json()) as any[]).length).toBe(2);
    } finally {
      server.stop(true);
    }
  });
});
