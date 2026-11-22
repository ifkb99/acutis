import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { AgentEvent } from "../src/core/types";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeControls, type FakeScript } from "./helpers";

const background = (c: FakeControls, running: number) =>
  c.emit({ kind: "agent.background", running, tasks: Array.from({ length: running }, () => ({ type: "general-purpose", description: "look around" })) } as AgentEvent);

async function setup(scripts: FakeScript[], opts: { backgroundGraceMs?: number; backgroundMaxWaitMs?: number } = {}, workflow = "---\ngates:\n  - test -f done.txt\nmax_attempts: 1\n---\n") {
  const repoPath = await makeRepo({ "README.md": "# Demo\n", ".acutis/workflow.md": workflow });
  const app = createApp({ home: tempDir("acutis-home-"), port: 0 }, { runner: new FakeRunner(scripts), ...opts });
  app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
  return { app };
}
const kinds = (app: ReturnType<typeof createApp>, id: number) => app.store.events(id).map((e) => e.kind);

describe("background subagents", () => {
  test("a turn that ends while a background subagent works is not checked until the turn after it", async () => {
    let finish!: () => void;
    const script: FakeScript = async (c) => {
      background(c, 1);
      c.result(); // "I've started the agent and will report back" — the work isn't done
      await new Promise<void>((r) => (finish = r));
      await Bun.write(`${c.spec.cwd}/done.txt`, "done\n");
      background(c, 0);
      c.result(); // the SDK's follow-up turn, with the real answer
      await c.nextMessage();
    };
    const { app } = await setup([script]);
    const run = await app.runs.start(app.tickets.create({ repo: "demo", title: "t", body: "" }).id);
    await waitFor(() => kinds(app, run.id).filter((k) => k === "agent.result").length === 1, 10000);
    await Bun.sleep(100);
    expect(app.store.getRun(run.id)!.state).toBe("running"); // not verifying the unfinished work
    expect(kinds(app, run.id)).not.toContain("gate.start");
    expect(app.store.events(run.id).some((e) => e.kind === "system.log" && String((e.data as any).msg).includes("1 background task(s) still running"))).toBe(true);
    finish();
    await waitFor(() => app.store.getRun(run.id)!.state === "awaiting_review", 10000);
    const ev = kinds(app, run.id);
    expect(ev.lastIndexOf("agent.result")).toBeLessThan(ev.indexOf("gate.start")); // checked after the second turn
    expect(app.store.getRun(run.id)!.gates_ok).toBe(1);
  });

  test("if the tasks finish but no new turn comes, the work is checked after the grace period", async () => {
    const script: FakeScript = async (c) => {
      background(c, 1);
      await Bun.write(`${c.spec.cwd}/done.txt`, "done\n");
      c.result();
      await Bun.sleep(50);
      background(c, 0); // done, but the agent doesn't continue
      await c.nextMessage();
    };
    const { app } = await setup([script], { backgroundGraceMs: 200 });
    const run = await app.runs.start(app.tickets.create({ repo: "demo", title: "t", body: "" }).id);
    await waitFor(() => app.store.getRun(run.id)!.state === "awaiting_review", 10000);
    expect(app.store.events(run.id).some((e) => e.kind === "system.log" && String((e.data as any).msg).includes("didn't continue"))).toBe(true);
  });

  test("tasks that never finish don't hold the run forever", async () => {
    const script: FakeScript = async (c) => {
      background(c, 2);
      await Bun.write(`${c.spec.cwd}/done.txt`, "done\n");
      c.result();
      await c.nextMessage();
    };
    const { app } = await setup([script], { backgroundMaxWaitMs: 200 });
    const run = await app.runs.start(app.tickets.create({ repo: "demo", title: "t", body: "" }).id);
    await waitFor(() => app.store.getRun(run.id)!.state === "awaiting_review", 10000);
    expect(app.store.events(run.id).some((e) => e.kind === "system.log" && String((e.data as any).msg).includes("still running"))).toBe(true);
  });

  test("a scout waits the same way before it finishes (finishing deletes its workspace)", async () => {
    let finish!: () => void;
    const script: FakeScript = async (c) => {
      background(c, 1);
      c.result();
      await new Promise<void>((r) => (finish = r));
      background(c, 0);
      c.emit({ kind: "agent.result", subtype: "success", result: "found things", is_error: false, cost_usd: 0.02, turns: 2, duration_ms: 5 } as AgentEvent);
      await c.nextMessage();
    };
    const { app } = await setup([script], {}, "---\n---\n");
    const run = await app.runs.startScout("demo", "tests");
    await waitFor(() => kinds(app, run.id).includes("agent.result"), 10000);
    await Bun.sleep(100);
    expect(app.store.getRun(run.id)!.state).toBe("running");
    finish();
    await waitFor(() => app.store.getRun(run.id)!.state === "done", 10000);
  });
});
