import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { AcutisTool, AgentEvent } from "../src/core/types";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeControls, type FakeScript } from "./helpers";

const tool = (c: FakeControls, name: string): AcutisTool => {
  const t = c.spec.tools?.find((x) => x.name === name);
  if (!t) throw new Error(`no ${name} tool (have ${(c.spec.tools ?? []).map((x) => x.name).join(", ")})`);
  return t;
};
const call = async (c: FakeControls, name: string, args: Record<string, string | number | undefined>) => (await tool(c, name).handler(args)).text;
const finalReport = (c: FakeControls, text: string) =>
  c.emit({ kind: "agent.result", subtype: "success", result: text, is_error: false, cost_usd: 0.01, turns: 1, duration_ms: 5 } as AgentEvent);

async function setup(scripts: FakeScript[], files: Record<string, string> = { "README.md": "# Demo\n" }, opts: { costPollMs?: number; home?: string } = {}) {
  const repoPath = await makeRepo(files);
  const runner = new FakeRunner(scripts);
  const home = opts.home ?? tempDir("acutis-home-");
  const app = createApp({ home, port: 0 }, { runner, costPollMs: opts.costPollMs });
  app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
  return { app, runner, home, repoPath };
}
const state = (app: ReturnType<typeof createApp>, id: number) => app.store.getRun(id)!.state;
const until = (app: ReturnType<typeof createApp>, id: number, s: string) => waitFor(() => state(app, id) === s, 10000);

describe("scout runs", () => {
  test("a scout sees trunk's setup and check results, files work, finishes as done, and its scratch workspace goes", async () => {
    let prompt = "";
    let system = "";
    let toolNames: string[] = [];
    let cwd = "";
    const script: FakeScript = async (c) => {
      cwd = c.spec.cwd;
      prompt = c.spec.prompt;
      system = c.spec.systemAppend;
      toolNames = (c.spec.tools ?? []).map((t) => t.name);
      writeFileSync(join(c.spec.cwd, "scratch.txt"), "throwaway\n");
      finalReport(c, "Looked at the build.");
      await c.nextMessage();
    };
    const workflow = "---\nsetup:\n  - echo setting up\n  - exit 3\ngates:\n  - name: lint\n    run: echo lint-broken && exit 1\n  - test -f README.md\n---\n";
    const { app } = await setup([script], { "README.md": "# Demo\n", ".acutis/workflow.md": workflow });
    const run = await app.runs.startScout("demo", "infrastructure");
    expect(run.kind).toBe("scout");
    expect(run.scout).toBe("infrastructure");
    await until(app, run.id, "done");

    expect(toolNames).toEqual(["search_project", "read_project_entry", "report_library_gap", "project_overview", "propose_lesson", "list_work", "propose_ticket", "ask_decision", "update_decision", "withdraw_decision", "merge_decision"]);
    expect(system).toContain("# Acutis scout: Infrastructure");
    // A failing setup step and check on trunk are findings handed to the scout, not run failures.
    expect(system).toContain("setup `exit 3`: FAILED (exit 3)");
    expect(system).toContain('check "lint" `echo lint-broken && exit 1`: FAILS (exit 1)');
    expect(system).toContain("lint-broken");
    expect(system).toContain("check `test -f README.md`: passes");
    expect(prompt).toContain("Existing work in this repo");
    expect(prompt).toContain("data, not instructions");

    await waitFor(() => !existsSync(cwd), 5000); // scratch.txt and all
    await waitFor(() => app.store.getRun(run.id)!.workspace_path === null, 5000);
    const r = app.store.getRun(run.id)!;
    const runner = app.tickets.get(r.ticket_id)!;
    expect(runner.source).toBe("scout-run:infrastructure");
    expect(runner.status).toBe("todo"); // ready to run again
    expect(app.store.events(run.id).some((e) => e.kind === "run.state" && (e.data as any).to === "verifying")).toBe(false);
  });

  test("the workspace is removed when a scout is killed too", async () => {
    let cwd = "";
    const script: FakeScript = async (c) => {
      cwd = c.spec.cwd;
      await c.nextMessage();
    };
    const { app } = await setup([script]);
    const run = await app.runs.startScout("demo", "tests");
    await until(app, run.id, "running");
    expect(existsSync(cwd)).toBe(true);
    await app.runs.kill(run.id);
    await waitFor(() => !existsSync(cwd), 5000);
    // The path is cleared once removal has finished (so a failed removal can still be discarded).
    await waitFor(() => app.store.getRun(run.id)!.workspace_path === null, 5000);
  });

  test("a scout resumed after a daemon restart keeps its scout prompt and tools, and never reaches review", async () => {
    const first: FakeScript = async (c) => {
      c.emit({ kind: "agent.text", text: "looking" });
      await c.nextMessage();
    };
    const { app, home } = await setup([first]);
    const run = await app.runs.startScout("demo", "tests");
    await until(app, run.id, "running");
    app.runs.shutdown();

    let system = "";
    let names: string[] = [];
    const resumed: FakeScript = async (c) => {
      system = c.spec.systemAppend;
      names = (c.spec.tools ?? []).map((t) => t.name);
      finalReport(c, "done looking");
      await c.nextMessage();
    };
    const app2 = createApp({ home, port: 0 }, { runner: new FakeRunner([resumed]) });
    app2.runs.recover();
    await app2.runs.resume(run.id);
    await until(app2, run.id, "done");
    expect(system).toContain("# Acutis scout: Tests");
    expect(names).toContain("propose_ticket");
    expect(names).not.toContain("report_noticed");
    app2.runs.shutdown();
  });

  test("a scout's final report never shows up in the library as landed work", async () => {
    let found = "";
    const scout: FakeScript = async (c) => {
      finalReport(c, "ZEBRAWORD scouting report");
      await c.nextMessage();
    };
    const worker: FakeScript = async (c) => {
      found = await call(c, "search_project", { query: "ZEBRAWORD" });
      c.result();
      await c.nextMessage();
    };
    const { app } = await setup([scout, worker]);
    const s = await app.runs.startScout("demo", "tests");
    await until(app, s.id, "done");
    const w = await app.runs.start(app.tickets.create({ repo: "demo", title: "w", body: "" }).id);
    await until(app, w.id, "awaiting_review");
    expect(found).toContain("No library results");
  });

  test("scouts: false, or one scout turned off, fails the scout run with the reason", async () => {
    const { app } = await setup([], { "README.md": "# Demo\n", ".acutis/workflow.md": "---\nscouts:\n  tests: false\n---\n" });
    const run = await app.runs.startScout("demo", "tests");
    await until(app, run.id, "failed");
    expect(app.store.getRun(run.id)!.error).toContain("the tests scout is turned off");
    await expect(app.runs.startScout("demo", "astrology")).rejects.toThrow(/unknown scout/);
  });

  test("a restart during a scout's preparation frees its runner ticket, so the scout can run again", async () => {
    const wf = "---\nsetup:\n  - sleep 30\n---\n";
    const { app, home } = await setup([], { "README.md": "# Demo\n", ".acutis/workflow.md": wf });
    const run = await app.runs.startScout("demo", "tests");
    await waitFor(() => app.store.events(run.id).some((e) => e.kind === "setup.start"), 10000);
    app.runs.shutdown();
    const app2 = createApp({ home, port: 0 }, { runner: new FakeRunner([async (c) => { finalReport(c, "ok"); await c.nextMessage(); }]) });
    app2.runs.recover();
    expect(state(app2, run.id)).toBe("failed");
    expect(app2.tickets.get(app2.store.getRun(run.id)!.ticket_id)!.status).toBe("todo");
    const again = await app2.runs.startScout("demo", "tests");
    expect(again.ticket_id).toBe(run.ticket_id);
    app2.runs.shutdown();
  });

  test("scouts get a hard spend cap from the SDK too; hitting it finishes the scout instead of failing it", async () => {
    let cap: number | undefined;
    const script: FakeScript = async (c) => {
      cap = c.spec.maxBudgetUsd;
      c.emit({ kind: "agent.result", subtype: "error_max_budget_usd", result: "", is_error: true, cost_usd: 1.5, turns: 3, duration_ms: 5 } as AgentEvent);
      await c.nextMessage();
    };
    const { app } = await setup([script], { "README.md": "# Demo\n", ".acutis/workflow.md": "---\nscouts:\n  budget_usd: 1.5\n---\n" });
    const run = await app.runs.startScout("demo", "infrastructure");
    await until(app, run.id, "done");
    expect(cap).toBeCloseTo(1.5);
    const why = app.store.events(run.id).find((e) => e.kind === "run.state" && (e.data as any).to === "done")!.data as any;
    expect(why.reason).toContain("stopped at its budget");
  });

  test("a scout over its budget mid-turn is finished, and what it filed is kept", async () => {
    const script: FakeScript = async (c) => {
      await call(c, "propose_ticket", { title: "Pin the toolchain", body: "b", evidence: "e", confidence: "medium" });
      c.setTotal(0.6);
      c.emit({ kind: "agent.text", text: "still going" });
      await c.nextMessage();
    };
    const wf = "---\nscouts:\n  budget_usd: 0.5\n---\n";
    const { app } = await setup([script], { "README.md": "# Demo\n", ".acutis/workflow.md": wf }, { costPollMs: 0 });
    const run = await app.runs.startScout("demo", "infrastructure");
    await until(app, run.id, "done");
    const why = app.store.events(run.id).find((e) => e.kind === "run.state" && (e.data as any).to === "done")!.data as any;
    expect(why.reason).toContain("stopped at its budget ($0.50)");
    expect(why.reason).toContain("1 ticket(s)");
    expect(app.tickets.list({ repo: "demo" }).some((t) => t.title === "Pin the toolchain")).toBe(true);
  });
});

describe("tickets and decisions from scouts", () => {
  test("confidence routes tickets; duplicates and rejected tickets aren't filed again; the per-run cap holds", async () => {
    const replies: string[] = [];
    const script: FakeScript = async (c) => {
      const file = async (title: string, confidence: string) =>
        replies.push(await call(c, "propose_ticket", { title, body: "why", evidence: "src/x.ts:3", confidence, rationale: "seen it" }));
      await file("Fix the flaky login test", "high");
      await file("Speed up the build", "medium");
      await c.nextMessage(); // the operator rejects #2 meanwhile
      await file("speed up the BUILD", "high");
      await file("Fix the flaky login test", "low");
      await file("Three", "low");
      await file("Four", "low");
      await file("Five", "low");
      await file("Six", "low");
      finalReport(c, "done");
      await c.nextMessage();
    };
    const { app } = await setup([script]);
    const run = await app.runs.startScout("demo", "tests");
    await waitFor(() => replies.length === 2, 10000);
    const [high, medium] = app.tickets.list({ repo: "demo" }).filter((t) => t.source === "scout:tests");
    expect(high).toMatchObject({ title: "Fix the flaky login test", status: "todo", confidence: "high" });
    expect(medium).toMatchObject({ status: "proposed", confidence: "medium" });
    expect(high!.body).toContain("Scout-written and unchecked");
    expect(high!.body).toContain("src/x.ts:3");
    app.runs.rejectTicket(medium!.id);
    await app.runs.message(run.id, "go on");
    await until(app, run.id, "done");
    expect(replies[2]).toContain(`The operator rejected this before (ticket #${medium!.id})`);
    expect(replies[3]).toContain(`Already ticket #${high!.id}`);
    expect(replies.at(-1)).toContain("limit");
  });

  test("auto_tickets: never sends even high-confidence tickets to proposed; accept moves them to todo", async () => {
    const script: FakeScript = async (c) => {
      await call(c, "propose_ticket", { title: "Upgrade the lockfile", body: "b", evidence: "e", confidence: "high" });
      finalReport(c, "done");
      await c.nextMessage();
    };
    const { app } = await setup([script], { "README.md": "# Demo\n", ".acutis/workflow.md": "---\nscouts:\n  auto_tickets: never\n---\n" });
    const run = await app.runs.startScout("demo", "infrastructure");
    await until(app, run.id, "done");
    const t = app.tickets.list({ repo: "demo" }).find((x) => x.title === "Upgrade the lockfile")!;
    expect(t.status).toBe("proposed");
    expect(app.runs.acceptTicket(t.id).status).toBe("todo");
    expect(() => app.runs.acceptTicket(t.id)).toThrow(/not proposed/);
  });

  test("a noticed report a scout ticketed is marked ticketed only when the ticket is accepted", async () => {
    let nid = 0;
    const script: FakeScript = async (c) => {
      await call(c, "propose_ticket", { title: "Deny unknown fields in VehicleDef", body: "b", evidence: "e", confidence: "medium", from_noticed: nid });
      finalReport(c, "done");
      await c.nextMessage();
    };
    const { app } = await setup([script]);
    const holder = app.store.createRun({ ticket_id: app.tickets.create({ repo: "demo", title: "h", body: "" }).id, repo: "demo", state: "done" });
    nid = app.store.addNoticed({ repo: "demo", runId: holder.id, kind: "bug", title: "validate-mods accepts typos", detail: "", evidence: "" }).noticed.id;
    const run = await app.runs.startScout("demo", "tests");
    await until(app, run.id, "done");
    const t = app.tickets.list({ repo: "demo" }).find((x) => x.noticed_id === nid)!;
    expect(app.store.getNoticed(nid)!.status).toBe("open");
    app.runs.acceptTicket(t.id);
    expect(app.store.getNoticed(nid)).toMatchObject({ status: "ticketed", ticket_id: t.id });
  });

  test("questions hold tickets; the answer names its version; kept tickets go to todo and the rest are dropped", async () => {
    const out: Record<string, string> = {};
    const script: FakeScript = async (c) => {
      out.ask = await call(c, "ask_decision", { question: "Do we support mobile?", context: "The layout breaks at 390px.", options: "Yes, phones too\nDesktop only" });
      const id = Number(/#(\d+)/.exec(out.ask)![1]);
      out.dupAsk = await call(c, "ask_decision", { question: "do we support MOBILE", context: "again" });
      await call(c, "propose_ticket", { title: "Mobile nav", body: "b", evidence: "e", confidence: "high", depends_on: id });
      await call(c, "propose_ticket", { title: "Mobile tables", body: "b", evidence: "e", confidence: "medium", depends_on: id });
      out.update = await call(c, "update_decision", { id, question: "Do we support phones (390px and up)?" });
      finalReport(c, "done");
      await c.nextMessage();
    };
    const { app } = await setup([script]);
    const run = await app.runs.startScout("demo", "tests");
    await until(app, run.id, "done");
    expect(out.dupAsk).toContain("Already asked as decision");
    expect(out.update).toContain("v2");

    const [open] = app.runs.rankedDecisions("demo");
    expect(open).toMatchObject({ question: "Do we support phones (390px and up)?", version: 2, held: 2, asked_by: "tests" });
    const [nav, tables] = open!.held_tickets.sort((a, b) => a.id - b.id);
    expect(nav!.status).toBe("held"); // held even at high confidence

    // Answering what you read before the scout's edit is refused.
    expect(() => app.runs.decide(open!.id, { decision: "Phones too.", version: 1, keep: [nav!.id] })).toThrow(/changed since you read it/);
    expect(() => app.runs.decide(open!.id, { decision: "  ", version: 2 })).toThrow(/write the decision/);
    const d = app.runs.decide(open!.id, { decision: "Support phones from 390px; tables may scroll sideways.", version: 2, keep: [nav!.id] });
    expect(d.status).toBe("decided");
    expect(app.tickets.get(nav!.id)!.status).toBe("todo");
    // Not named either way (e.g. filed after the operator looked): back to Proposed, never dropped unseen.
    expect(app.tickets.get(tables!.id)!.status).toBe("proposed");
    expect(() => app.runs.decide(open!.id, { decision: "x", version: 2 })).toThrow(/is decided/);
  });

  test("held tickets named in drop are cancelled; a done ticket doesn't block filing the problem again", async () => {
    let reply = "";
    const script: FakeScript = async (c) => {
      reply = await call(c, "propose_ticket", { title: "Fix the flaky test", body: "b", evidence: "e", confidence: "medium" });
      finalReport(c, "done");
      await c.nextMessage();
    };
    const { app } = await setup([script]);
    const q = app.store.addDecision({ repo: "demo", area: "tests", question: "Q?", asked_by: "tests" });
    const a = app.tickets.create({ repo: "demo", title: "a", body: "", source: "scout:tests", status: "held", decision_id: q.id });
    const b = app.tickets.create({ repo: "demo", title: "b", body: "", source: "scout:tests", status: "held", decision_id: q.id });
    app.runs.decide(q.id, { decision: "Do a, not b.", version: 1, keep: [a.id], drop: [b.id] });
    expect([app.tickets.get(a.id)!.status, app.tickets.get(b.id)!.status]).toEqual(["todo", "cancelled"]);

    app.tickets.setStatus(app.tickets.create({ repo: "demo", title: "Fix the flaky test", body: "" }).id, "done");
    const run = await app.runs.startScout("demo", "tests");
    await until(app, run.id, "done");
    expect(reply).toContain("Filed ticket");
  });

  test("a scout can only change open questions its own type asked, in its repo", async () => {
    const out: string[] = [];
    let ids: number[] = [];
    const script: FakeScript = async (c) => {
      for (const id of ids) out.push(await call(c, "update_decision", { id, question: "changed?" }));
      out.push(await call(c, "withdraw_decision", { id: ids[2]!, reason: "stale" }));
      finalReport(c, "done");
      await c.nextMessage();
    };
    const { app } = await setup([script]);
    app.store.addRepo({ name: "other", path: tempDir("other-"), base: "main" });
    const infra = app.store.addDecision({ repo: "demo", area: "infrastructure", question: "infra q", asked_by: "infrastructure" });
    const elsewhere = app.store.addDecision({ repo: "other", area: "tests", question: "other repo q", asked_by: "tests" });
    const mine = app.store.addDecision({ repo: "demo", area: "tests", question: "mine", asked_by: "tests" });
    const held = app.tickets.create({ repo: "demo", title: "waits", body: "", source: "scout:tests", status: "held", decision_id: mine.id });
    ids = [infra.id, elsewhere.id, mine.id];
    const run = await app.runs.startScout("demo", "tests");
    await until(app, run.id, "done");
    expect(out[0]).toContain("you can only change questions tests scouts asked");
    expect(out[1]).toContain(`No decision #${elsewhere.id} in this repo`);
    expect(out[2]).toContain("v2");
    expect(out[3]).toContain(`Withdrew decision #${mine.id}`);
    expect(app.tickets.get(held.id)!.status).toBe("proposed"); // back to waiting for the operator
  });

  test("merging a duplicate question moves its held tickets", async () => {
    let a = 0;
    let b = 0;
    const script: FakeScript = async (c) => {
      await call(c, "merge_decision", { id: b, into: a });
      finalReport(c, "done");
      await c.nextMessage();
    };
    const { app } = await setup([script]);
    a = app.store.addDecision({ repo: "demo", area: "infrastructure", question: "Pin node?", asked_by: "infrastructure" }).id;
    b = app.store.addDecision({ repo: "demo", area: "tests", question: "Should node be pinned?", asked_by: "tests" }).id;
    const t = app.tickets.create({ repo: "demo", title: "pin it", body: "", source: "scout:tests", status: "held", decision_id: b });
    const run = await app.runs.startScout("demo", "tests");
    await until(app, run.id, "done");
    expect(app.store.getDecision(b)).toMatchObject({ status: "superseded", superseded_by: a });
    expect(app.tickets.get(t.id)!.decision_id).toBe(a);
    expect(app.runs.rankedDecisions("demo")[0]).toMatchObject({ id: a, held: 1 });
  });

  test("open questions are ranked by the work they hold, then age", async () => {
    const { app } = await setup([]);
    const q1 = app.store.addDecision({ repo: "demo", area: "tests", question: "q1", asked_by: "tests" });
    const q2 = app.store.addDecision({ repo: "demo", area: "tests", question: "q2", asked_by: "tests" });
    const q3 = app.store.addDecision({ repo: "demo", area: "tests", question: "q3", asked_by: "tests" });
    for (const [title, d] of [["a", q3], ["b", q3], ["c", q2]] as const) {
      app.tickets.create({ repo: "demo", title, body: "", source: "scout:tests", status: "held", decision_id: d.id });
    }
    expect(app.runs.rankedDecisions("demo").map((d) => d.id)).toEqual([q3.id, q2.id, q1.id]);
  });

  test("decisions reach worker prompts and the library; asking a decided question returns the decision", async () => {
    let system = "";
    let found = "";
    let ask = "";
    const worker: FakeScript = async (c) => {
      system = c.spec.systemAppend;
      found = await call(c, "search_project", { query: "monorepo workspaces" });
      c.result();
      await c.nextMessage();
    };
    const scout: FakeScript = async (c) => {
      ask = await call(c, "ask_decision", { question: "Should we use npm workspaces?", context: "c" });
      finalReport(c, "done");
      await c.nextMessage();
    };
    const { app } = await setup([worker, scout]);
    const q = app.store.addDecision({ repo: "demo", area: "infrastructure", question: "Should we use npm workspaces?", asked_by: "infrastructure" });
    app.runs.decide(q.id, { decision: "Yes: one monorepo with npm workspaces.", version: 1 });
    const op = app.runs.addDecision("demo", "Never add a dependency without asking.");
    const w = await app.runs.start(app.tickets.create({ repo: "demo", title: "w", body: "" }).id);
    await until(app, w.id, "awaiting_review");
    expect(system).toContain("Operator decisions for this repo");
    expect(system).toContain("Yes: one monorepo with npm workspaces.");
    expect(system).toContain(`#${op.id}: Never add a dependency without asking.`);
    expect(found).toContain(`decision #${q.id} [approved: the operator's decision]`);

    const s = await app.runs.startScout("demo", "infrastructure");
    await until(app, s.id, "done");
    expect(ask).toContain(`already decided this (decision #${q.id}): Yes: one monorepo`);

    const next = app.runs.supersedeDecision(op.id, "Ask before adding a runtime dependency; dev dependencies are fine.");
    expect(app.store.getDecision(op.id)).toMatchObject({ status: "superseded", superseded_by: next.id });
    expect(() => app.runs.supersedeDecision(op.id, "again")).toThrow(/only a decided/);
  });

  test("the decision API needs the token and refuses a stale version", async () => {
    const { startServer } = await import("../src/server/server");
    const port = 19500 + Math.floor(Math.random() * 400);
    const repoPath = await makeRepo({ "README.md": "# Demo\n" });
    const app = createApp({ home: tempDir("acutis-home-"), port }, { runner: new FakeRunner([]) });
    app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
    const q = app.store.addDecision({ repo: "demo", area: "tests", question: "Q?", asked_by: "tests" });
    const server = startServer(app);
    try {
      const h = { authorization: `Bearer ${app.token}`, "x-acutis": "1", "content-type": "application/json" };
      const base = `http://127.0.0.1:${port}/api/decisions`;
      expect((await fetch(base)).status).toBe(401);
      expect(((await (await fetch(base, { headers: h })).json()) as any[])[0]).toMatchObject({ id: q.id, held: 0 });
      const stale = await fetch(`${base}/${q.id}/decide`, { method: "POST", headers: h, body: JSON.stringify({ decision: "A", version: 0 }) });
      expect(stale.status).toBe(409);
      const ok = await fetch(`${base}/${q.id}/decide`, { method: "POST", headers: h, body: JSON.stringify({ decision: "A", version: 1 }) });
      expect(((await ok.json()) as any).status).toBe("decided");
      const runner = app.tickets.create({ repo: "demo", title: "Scout", body: "", source: "scout-run:tests" });
      const cancel = await fetch(`http://127.0.0.1:${port}/api/tickets/${runner.id}/cancel`, { method: "POST", headers: h });
      expect(cancel.status).toBe(409);
    } finally {
      server.stop(true);
    }
  });
});
