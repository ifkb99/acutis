import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import { Library } from "../src/core/library";
import type { AcutisTool, AgentEvent } from "../src/core/types";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeControls, type FakeScript } from "./helpers";

const tool = (c: FakeControls, name: string): AcutisTool => c.spec.tools!.find((x) => x.name === name)!;
const call = async (c: FakeControls, name: string, args: Record<string, string | number | undefined>) => (await tool(c, name).handler(args)).text;
const finalReport = (c: FakeControls) =>
  c.emit({ kind: "agent.result", subtype: "success", result: "done", is_error: false, cost_usd: 0.01, turns: 1, duration_ms: 5 } as AgentEvent);

async function setup(scripts: FakeScript[], files: Record<string, string> = { "README.md": "# Demo\n" }) {
  const repoPath = await makeRepo(files);
  const app = createApp({ home: tempDir("acutis-home-"), port: 0 }, { runner: new FakeRunner(scripts) });
  app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
  return { app };
}
const until = (app: ReturnType<typeof createApp>, id: number, s: string) => waitFor(() => app.store.getRun(id)!.state === s, 10000);

describe("trust tiers", () => {
  test("on equal relevance an approved trunk doc ranks above a landed run's worker-written summary", () => {
    const lib = new Library(new Database(":memory:"));
    const root = tempDir("acutis-lib-");
    writeFileSync(join(root, "a.md"), "# Caching\n\nThe cache uses an LRU policy with a fixed cap.");
    lib.index("r", "c1", root, ["a.md"], { include: ["**/*.md"], exclude: [] });
    lib.addRunSummaries("r", [{ runId: 9, title: "Caching", body: "The cache uses an LRU policy with a fixed cap." }]);
    const hits = lib.search("r", "c1", "cache LRU policy cap", 5);
    expect(hits.map((h) => h.kind)).toEqual(["doc", "run"]);
  });
});

describe("library gaps", () => {
  test("gaps merge by question, cap per run, and come back only once settled; searches leave receipts", async () => {
    const out: string[] = [];
    const script: FakeScript = async (c) => {
      out.push(await call(c, "search_project", { query: "zebra migration policy" }));
      out.push(await call(c, "report_library_gap", { question: "How are mods validated?", tried: "searched 'mod validation'" }));
      out.push(await call(c, "report_library_gap", { question: "how are MODS validated", tried: "again" }));
      for (let i = 0; i < 5; i++) out.push(await call(c, "report_library_gap", { question: `q${i}`, tried: "" }));
      c.result();
      await c.nextMessage();
    };
    const { app } = await setup([script]);
    const run = await app.runs.start(app.tickets.create({ repo: "demo", title: "t", body: "" }).id);
    await until(app, run.id, "awaiting_review");
    expect(out[0]).toContain("report_library_gap");
    expect(out[1]).toContain("Recorded as gap");
    expect(out[2]).toContain("(2 reports)");
    expect(out.at(-1)).toContain("already reported 5 gaps");
    const receipt = app.store.events(run.id).find((e) => e.kind === "library.search")!.data as any;
    expect(receipt).toMatchObject({ query: "zebra migration policy", ids: [] });
    expect(receipt.chars).toBeGreaterThan(0);
    const g = app.runs.listGaps("demo").find((x) => x.question === "How are mods validated?")!;
    expect(g.count).toBe(2);
    app.runs.dismissGap(g.id);
    expect(() => app.runs.dismissGap(g.id)).toThrow(/dismissed/);
  });

  test("the Docs scout sees open gaps; a gap closes when the ticket that covers it is accepted, and reopens if it's rejected", async () => {
    let brief = "";
    const replies: string[] = [];
    let gapA = 0;
    let gapB = 0;
    const script: FakeScript = async (c) => {
      brief = c.spec.prompt;
      replies.push(await call(c, "propose_ticket", { title: "Document mod validation", body: "b", evidence: "e", confidence: "medium", from_gaps: `${gapA}` }));
      replies.push(await call(c, "propose_ticket", { title: "Document the save format", body: "b", evidence: "e", confidence: "medium", from_gaps: `${gapB}` }));
      replies.push(await call(c, "propose_ticket", { title: "Bad gap", body: "b", evidence: "e", confidence: "medium", from_gaps: "9999" }));
      finalReport(c);
      await c.nextMessage();
    };
    const { app } = await setup([script]);
    const holder = app.store.createRun({ ticket_id: app.tickets.create({ repo: "demo", title: "h", body: "" }).id, repo: "demo", state: "done" });
    gapA = app.store.addGap({ repo: "demo", runId: holder.id, question: "How are mods validated?", tried: "searched" }, () => false).gap.id;
    gapB = app.store.addGap({ repo: "demo", runId: holder.id, question: "What is the save format?", tried: "" }, () => false).gap.id;
    const run = await app.runs.startScout("demo", "docs");
    await until(app, run.id, "done");
    expect(brief).toContain(`gap #${gapA} (×1): How are mods validated? (they tried: searched)`);
    expect(replies[2]).toContain("isn't an open gap");
    const [a, b] = [app.tickets.list({ repo: "demo" }).find((t) => t.title === "Document mod validation")!, app.tickets.list({ repo: "demo" }).find((t) => t.title === "Document the save format")!];
    expect(app.store.getGap(gapA)).toMatchObject({ status: "open", ticket_id: a.id });
    app.runs.acceptTicket(a.id);
    expect(app.store.getGap(gapA)).toMatchObject({ status: "ticketed", ticket_id: a.id });
    app.runs.rejectTicket(b.id);
    expect(app.store.getGap(gapB)).toMatchObject({ status: "open", ticket_id: null });
  });
});
