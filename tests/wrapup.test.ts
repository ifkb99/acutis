import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { HubMessage } from "../src/core/hub";
import type { AcutisTool } from "../src/core/types";
import { makeNotifier } from "../src/server/notify";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeControls, type FakeScript } from "./helpers";

const tool = (c: FakeControls, name: string): AcutisTool => c.spec.tools!.find((t) => t.name === name)!;
const ev = (run_id: number, kind: string, data: Record<string, unknown>): HubMessage =>
  ({ type: "event", event: { id: 0, run_id, ts: new Date().toISOString(), kind, data } }) as unknown as HubMessage;

describe("notification batching", () => {
  const setup = (quiet = 60, max = 200) => {
    const sent: { title: string; body: string; link: string }[] = [];
    const n = makeNotifier({ port: 1, batchQuietMs: quiet, batchMaxMs: max, sender: (title, body, link) => sent.push({ title, body, link }) });
    return { n, sent };
  };

  test("a burst of questions and proposed tickets becomes one notification", async () => {
    const { n, sent } = setup();
    for (let i = 1; i <= 5; i++) n.handle(ev(1, "scout.decision", { scout: "security", id: i, question: `Question ${i}?` }));
    n.handle(ev(1, "scout.ticket", { scout: "security", id: 9, title: "t", status: "proposed" }));
    n.handle(ev(1, "scout.ticket", { scout: "security", id: 10, title: "t2", status: "todo" })); // already on the board: not "waiting"
    n.handle(ev(2, "work.request", { ticket: 11, title: "w", status: "proposed" }));
    n.handle(ev(3, "work.request", { ticket: 11, title: "w", status: "proposed", existing: true })); // a second worker sharing #11
    expect(sent).toEqual([]);
    await waitFor(() => sent.length > 0, 2000);
    await Bun.sleep(150);
    expect(sent.length).toBe(1);
    expect(sent[0]!.title).toBe("Acutis: 5 questions and 2 proposed tickets waiting for you");
    expect(sent[0]!.body).toContain("• Question 1?");
    expect(sent[0]!.body).toContain("…and 2 more");
  });

  test("a steady trickle still sends by the max wait", async () => {
    // Quiet window 1s, max wait 300ms: only the max wait can send while questions keep coming.
    const { n, sent } = setup(1000, 300);
    const t0 = Date.now();
    while (Date.now() - t0 < 600) {
      n.handle(ev(1, "scout.decision", { id: 0, question: "q" }));
      await Bun.sleep(30);
    }
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]!.title).toMatch(/^Acutis: \d+ questions? waiting for you$/);
  });

  test("permission requests and reviews are still sent at once", () => {
    const { n, sent } = setup();
    n.handle(ev(3, "permission.request", { tool: "Bash", input: { command: "rm -rf build" } }));
    n.handle(ev(3, "run.state", { to: "awaiting_review" }));
    expect(sent.map((s) => s.title)).toEqual(["Acutis run 3 needs permission", "Acutis run 3: ready for review"]);
    expect(sent[0]!.link).toContain("#run-3");
  });

  test("drain waits for a slow webhook post before shutdown", async () => {
    const got: string[] = [];
    const hook = Bun.serve({
      port: 0,
      fetch: async (req) => {
        await Bun.sleep(300);
        got.push(`${req.headers.get("title")}|${await req.text()}`);
        return new Response("ok");
      },
    });
    try {
      const n = makeNotifier({ port: 1, desktop: false, webhook: `http://127.0.0.1:${hook.port}/`, batchQuietMs: 60_000, batchMaxMs: 60_000 });
      n.handle(ev(1, "scout.decision", { id: 1, question: "Which lockfile wins?" }));
      await n.drain();
      expect(got.length).toBe(1);
      expect(got[0]).toContain("Acutis: 1 question waiting for you|• Which lockfile wins?");
    } finally {
      hook.stop(true);
    }
  });

  test("drain sends what is batched", async () => {
    const { n, sent } = setup(60_000, 60_000);
    n.handle(ev(1, "contract.request", { contract: "api", change: "add a field", decision: 1, ticket: 2 }));
    await n.drain();
    expect(sent.map((s) => s.title)).toEqual(["Acutis: 1 question waiting for you"]);
    expect(sent[0]!.body).toContain("Change the api contract: add a field");
  });
});

describe("request_work (needs between areas)", () => {
  async function setup(scripts: FakeScript[]) {
    const repoPath = await makeRepo({ "src/a.ts": "export const a = 1;\n", ".acutis/workflow.md": "---\nland: bookmark\nmax_attempts: 1\n---\n" });
    const app = createApp({ home: tempDir("acutis-home-"), port: 0 }, { runner: new FakeRunner(scripts) });
    app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
    return { app, ticket: (t: string) => app.tickets.create({ repo: "demo", title: t, body: "" }) };
  }

  test("files a proposed ticket naming the waiting one, flags the run, and two workers share one ticket", async () => {
    const outs: string[] = [];
    let prompt = "";
    const asks =
      (title: string): FakeScript =>
      async (c) => {
        prompt = c.spec.systemAppend;
        outs.push((await tool(c, "request_work").handler({ title, need: "export getMoves(tile) from the engine", why: "the AI needs per-tile moves; stubbed for now" })).text);
        writeFileSync(join(c.spec.cwd, "src/a.ts"), "export const a = 2;\n");
        c.result();
        await c.nextMessage();
      };
    const { app, ticket } = await setup([asks("Engine: export getMoves(tile)"), asks("engine — export getMoves (tile)")]);
    const t1 = ticket("AI per-tile eval");
    const r1 = await app.runs.start(t1.id);
    await waitFor(() => app.store.getRun(r1.id)!.state === "awaiting_review", 10000);
    expect(prompt).toContain("mcp__acutis__request_work");
    expect(outs[0]).toMatch(/Filed as proposed ticket #(\d+)/);
    const filed = app.tickets.list({ repo: "demo" }).find((t) => t.source === "work-request")!;
    expect(filed).toMatchObject({ status: "proposed", title: "Engine: export getMoves(tile)", origin_run_id: r1.id });
    expect(filed.body).toContain(`ticket #${t1.id} (AI per-tile eval) waits on it`);
    expect(filed.body).toContain("Worker-written");
    expect(app.store.events(r1.id).find((e) => e.kind === "work.request")!.data).toMatchObject({ ticket: filed.id, status: "proposed" });

    const r2 = await app.runs.start(ticket("AI other").id);
    await waitFor(() => app.store.getRun(r2.id)!.state === "awaiting_review", 10000);
    expect(outs[1]).toContain(`Already requested as ticket #${filed.id}`);
    expect(app.tickets.list({ repo: "demo" }).filter((t) => t.source === "work-request").length).toBe(1);
    expect(app.tickets.get(filed.id)!.origin_run_id).toBe(r1.id); // the first requester stays the origin
    expect(app.store.events(r2.id).find((e) => e.kind === "work.request")!.data).toMatchObject({ ticket: filed.id, existing: true });

    expect(app.runs.acceptTicket(filed.id).status).toBe("todo");
  });

  test("a request the operator rejected isn't filed again", async () => {
    const outs: string[] = [];
    const asks: FakeScript = async (c) => {
      outs.push((await tool(c, "request_work").handler({ title: "engine: add undo", need: "x", why: "y" })).text);
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([asks, asks]);
    const r1 = await app.runs.start(ticket("one").id);
    await waitFor(() => app.store.getRun(r1.id)!.state === "awaiting_review", 10000);
    const filed = app.tickets.list({ repo: "demo" }).find((t) => t.source === "work-request")!;
    app.runs.rejectTicket(filed.id);
    const r2 = await app.runs.start(ticket("two").id);
    await waitFor(() => app.store.getRun(r2.id)!.state === "awaiting_review", 10000);
    expect(outs[1]).toContain(`already rejected this request (ticket #${filed.id})`);
    expect(app.tickets.list({ repo: "demo" }).filter((t) => t.source === "work-request").length).toBe(1);
  });

  test("capped per run, and empty requests are refused", async () => {
    const outs: string[] = [];
    const many: FakeScript = async (c) => {
      const t = tool(c, "request_work");
      outs.push((await t.handler({ title: "", need: "x", why: "y" })).text);
      for (let i = 0; i < 4; i++) outs.push((await t.handler({ title: `need ${i}`, need: "x", why: "y" })).text);
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([many]);
    const r = await app.runs.start(ticket("busy").id);
    await waitFor(() => app.store.getRun(r.id)!.state === "awaiting_review", 10000);
    expect(outs[0]).toContain("required");
    expect(outs[4]).toContain("already made 3 work requests");
    expect(app.tickets.list({ repo: "demo" }).filter((t) => t.source === "work-request").length).toBe(3);
  });
});
