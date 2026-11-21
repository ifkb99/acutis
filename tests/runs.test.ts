import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { RunState } from "../src/core/types";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeScript } from "./helpers";

async function setup(scripts: FakeScript[], files?: Record<string, string>) {
  const repoPath = await makeRepo(files);
  const runner = new FakeRunner(scripts);
  const app = createApp({ home: tempDir("acutis-home-"), port: 0 }, { runner });
  app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
  const ticket = app.tickets.create({ repo: "demo", title: "Add greeting", body: "Create greeting.txt" });
  return { app, runner, repoPath, ticket };
}

const state = (app: ReturnType<typeof createApp>, id: number) => app.store.getRun(id)!.state;
const until = (app: ReturnType<typeof createApp>, id: number, s: RunState) =>
  waitFor(() => state(app, id) === s, 8000);

/** Writes greeting.txt in the workspace, then ends the turn. */
const writesGreeting: FakeScript = async (c) => {
  writeFileSync(join(c.spec.cwd, "greeting.txt"), "hi\n");
  c.emit({ kind: "agent.text", text: "Added greeting.txt" });
  c.result();
  await c.nextMessage(); // stay alive until closed
};

describe("run lifecycle", () => {
  test("happy path: workspace → agent → review → approve lands a bookmark", async () => {
    const { app, repoPath, ticket } = await setup([writesGreeting]);
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "awaiting_review");

    const r = app.store.getRun(run.id)!;
    expect(r.workspace_path).toBeTruthy();
    expect(await app.runs.diff(run.id)).toContain("+hi");
    expect(app.tickets.get(ticket.id)!.status).toBe("review");
    expect(app.runs.isLive(run.id)).toBe(false); // session closed while waiting for review

    await app.runs.approve(run.id);
    expect(state(app, run.id)).toBe("done");
    expect(app.tickets.get(ticket.id)!.status).toBe("done");
    expect(existsSync(r.workspace_path!)).toBe(false);

    const show = await $`jj file show -r acutis/${ticket.id}-add-greeting greeting.txt`.cwd(repoPath).text();
    expect(show).toBe("hi\n");
    const desc = await $`jj log --no-graph -r acutis/${ticket.id}-add-greeting -T description`.cwd(repoPath).text();
    expect(desc).toContain("Acutis-Ticket: #1");
  });

  test("a ticket can only be claimed once", async () => {
    const { app, ticket } = await setup([writesGreeting]);
    await app.runs.start(ticket.id);
    await expect(app.runs.start(ticket.id)).rejects.toThrow(/not in "todo"/);
  });

  test("failing checks are sent back to the agent, then pass", async () => {
    const workflow = `---\ngates:\n  - test -f fixed.txt\nmax_attempts: 3\n---\nDo {{ticket.title}}`;
    let feedback = "";
    const script: FakeScript = async (c) => {
      c.result(); // finishes without the file
      feedback = await c.nextMessage();
      writeFileSync(join(c.spec.cwd, "fixed.txt"), "ok\n");
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([script], { ".acutis/workflow.md": workflow });
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "awaiting_review");
    expect(feedback).toContain("test -f fixed.txt");
    const r = app.store.getRun(run.id)!;
    expect(r.gates_ok).toBe(1);
    expect(r.attempt).toBe(2);
  });

  test("policy is read from trunk; workspace edits to .acutis are flagged", async () => {
    const workflow = `---\ngates:\n  - "false"\nmax_attempts: 1\n---\n`;
    const script: FakeScript = async (c) => {
      // The agent tries to neuter its own gate. Acutis must ignore this.
      writeFileSync(join(c.spec.cwd, ".acutis/workflow.md"), "---\ngates: []\n---\n");
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([script], { ".acutis/workflow.md": workflow });
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "awaiting_review");
    const r = app.store.getRun(run.id)!;
    expect(r.gates_ok).toBe(0);
    expect(app.store.events(run.id).some((e) => e.kind === "policy.flag")).toBe(true);
  });

  test("pause, message to resume, redirect", async () => {
    const script: FakeScript = async (c) => {
      c.emit({ kind: "agent.text", text: "working…" });
      await c.interrupted(); // pause
      c.result("error_during_execution");
      const m1 = await c.nextMessage(); // resume message
      c.emit({ kind: "agent.text", text: `got: ${m1}` });
      await c.interrupted(); // redirect
      c.result("error_during_execution");
      const m2 = await c.nextMessage();
      c.emit({ kind: "agent.text", text: `redirected: ${m2}` });
      writeFileSync(join(c.spec.cwd, "x.txt"), m2);
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([script]);
    const run = await app.runs.start(ticket.id);
    await waitFor(() => app.store.events(run.id).some((e) => e.kind === "agent.text"));

    await app.runs.pause(run.id);
    await until(app, run.id, "paused");
    await app.runs.resume(run.id);
    await until(app, run.id, "running");
    await waitFor(() => app.store.events(run.id).some((e) => (e.data as any).text?.startsWith("got:")));

    await app.runs.redirect(run.id, "use x.txt instead");
    await until(app, run.id, "awaiting_review");
    const texts = app.store.events(run.id).filter((e) => e.kind === "agent.text").map((e) => (e.data as any).text);
    expect(texts).toContain("redirected: use x.txt instead");
    expect(app.store.events(run.id).some((e) => e.kind === "run.state" && (e.data as any).to === "failed")).toBe(false);
  });

  test("permission requests wait for the operator", async () => {
    let decision: any;
    const script: FakeScript = async (c) => {
      decision = await c.spec.onPermission({ id: "p1", tool: "Bash", input: { command: "npm i" }, canAlwaysAllow: true });
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([script]);
    const run = await app.runs.start(ticket.id);
    await waitFor(() => app.runs.pendingPermissions(run.id).length === 1);
    app.runs.decidePermission(run.id, "p1", { behavior: "allow", always: true });
    await until(app, run.id, "awaiting_review");
    expect(decision).toEqual({ behavior: "allow", always: true });
  });

  test("send back from review resumes the same session", async () => {
    const first: FakeScript = async (c) => {
      writeFileSync(join(c.spec.cwd, "a.txt"), "1");
      c.result();
      await c.nextMessage();
    };
    let resumedWith: string | undefined;
    let prompt = "";
    const second: FakeScript = async (c) => {
      resumedWith = c.spec.resumeSessionId;
      prompt = c.spec.prompt;
      writeFileSync(join(c.spec.cwd, "a.txt"), "2");
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([first, second]);
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "awaiting_review");
    const sessionId = app.store.getRun(run.id)!.session_id;
    await app.runs.message(run.id, "make it 2");
    await waitFor(() => resumedWith);
    await until(app, run.id, "awaiting_review");
    expect(resumedWith).toBe(sessionId!);
    expect(prompt).toBe("make it 2");
    expect(await app.runs.diff(run.id)).toContain("+2");
  });

  test("kill then discard removes the workspace and returns the ticket to todo", async () => {
    const script: FakeScript = async (c) => {
      writeFileSync(join(c.spec.cwd, "half.txt"), "wip");
      await c.nextMessage();
    };
    const { app, ticket, repoPath } = await setup([script]);
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "running");
    await app.runs.kill(run.id);
    expect(state(app, run.id)).toBe("cancelled");
    const ws = app.store.getRun(run.id)!.workspace_path!;
    expect(existsSync(ws)).toBe(true);
    await app.runs.discard(run.id);
    expect(existsSync(ws)).toBe(false);
    expect(app.tickets.get(ticket.id)!.status).toBe("todo");
    const wsList = await $`jj workspace list`.cwd(repoPath).text();
    expect(wsList).not.toContain(`acutis-t${ticket.id}`);
  });

  test("kill during verification stops the check and does not reach review", async () => {
    const workflow = `---\ngates:\n  - sleep 30\n---\n`;
    const { app, ticket } = await setup([writesGreeting], { ".acutis/workflow.md": workflow });
    const run = await app.runs.start(ticket.id);
    await waitFor(() => app.store.events(run.id).some((e) => e.kind === "gate.start"));
    const t0 = Date.now();
    await app.runs.kill(run.id);
    await Bun.sleep(300);
    expect(state(app, run.id)).toBe("cancelled");
    expect(app.tickets.get(ticket.id)!.status).toBe("todo");
    expect(app.store.events(run.id).some((e) => e.kind === "gate.result")).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  test("kill during verification doesn't wait on a cost poll, so the killed check is never reported", async () => {
    const workflow = `---\ngates:\n  - sleep 30\n---\n`;
    const slowCost: FakeScript = async (c) => {
      c.setTotal(0.1);
      c.holdTotal = new Promise(() => {}); // a poll would take the full 2s cap
      writeFileSync(join(c.spec.cwd, "greeting.txt"), "hi\n");
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([slowCost], { ".acutis/workflow.md": workflow });
    const run = await app.runs.start(ticket.id);
    await waitFor(() => app.store.events(run.id).some((e) => e.kind === "gate.start"));
    const t0 = Date.now();
    await app.runs.kill(run.id);
    expect(Date.now() - t0).toBeLessThan(500);
    await Bun.sleep(300);
    expect(state(app, run.id)).toBe("cancelled");
    expect(app.store.events(run.id).some((e) => e.kind === "gate.result")).toBe(false);
  });

  test("kill during preparation never launches an agent", async () => {
    const { app, ticket, runner } = await setup([writesGreeting]);
    const run = await app.runs.start(ticket.id);
    await app.runs.kill(run.id); // still preparing: workspace creation is async
    await Bun.sleep(1500);
    expect(state(app, run.id)).toBe("cancelled");
    expect(runner.sessions.length).toBe(0);
  });

  test("an agent error fails the run", async () => {
    const script: FakeScript = async (c) => {
      c.result("error_max_turns");
      await c.nextMessage();
    };
    const { app, ticket } = await setup([script]);
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "failed");
    expect(app.store.getRun(run.id)!.error).toContain("error_max_turns");
  });

  test("recover() detaches runs left running by a dead daemon", async () => {
    const { app, ticket } = await setup([writesGreeting]);
    const run = app.store.createRun({ ticket_id: ticket.id, repo: "demo", state: "running" });
    app.runs.recover();
    expect(state(app, run.id)).toBe("paused");
  });
});

describe("run limit (maxRuns)", () => {
  async function limited(scripts: FakeScript[], maxRuns: number, home = tempDir("acutis-home-")) {
    const repoPath = await makeRepo();
    const runner = new FakeRunner(scripts);
    const app = createApp({ home, port: 0, maxRuns }, { runner });
    app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
    const ticket = (title: string) => app.tickets.create({ repo: "demo", title, body: "" });
    return { app, runner, ticket, home };
  }
  /** Holds the turn open until released, then finishes it (so the run reaches review). */
  function held() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const script: FakeScript = async (c) => {
      await gate;
      c.result();
      await c.nextMessage();
    };
    return { script, release };
  }

  test("runs past the limit queue, start oldest first when a slot frees, and can be removed", async () => {
    const one = held();
    const two = held();
    const { app, ticket } = await limited([one.script, two.script], 1);
    const r1 = await app.runs.start(ticket("one").id);
    const r2 = await app.runs.start(ticket("two").id);
    const t3 = ticket("three");
    const r3 = await app.runs.start(t3.id);
    expect(r2.state).toBe("queued");
    expect(r3.state).toBe("queued");
    await until(app, r1.id, "running");
    expect(state(app, r2.id)).toBe("queued");
    await expect(app.runs.message(r2.id, "hi")).rejects.toThrow(/queued/);

    // Removing a queued run cancels it and gives its ticket back.
    await app.runs.kill(r3.id);
    expect(state(app, r3.id)).toBe("cancelled");
    expect(app.tickets.get(t3.id)!.status).toBe("todo");

    // Reaching review frees the slot: the oldest queued run starts.
    one.release();
    await until(app, r1.id, "awaiting_review");
    await until(app, r2.id, "running");
    two.release();
    await until(app, r2.id, "awaiting_review");
  });

  test("pausing frees a slot", async () => {
    const pausable: FakeScript = async (c) => {
      await c.interrupted();
      c.result("error_during_execution");
      await c.nextMessage();
    };
    const two = held();
    const { app, ticket } = await limited([pausable, two.script], 1);
    const r1 = await app.runs.start(ticket("one").id);
    const r2 = await app.runs.start(ticket("two").id);
    await until(app, r1.id, "running");
    expect(state(app, r2.id)).toBe("queued");
    await app.runs.pause(r1.id);
    await until(app, r1.id, "paused");
    await until(app, r2.id, "running");
    two.release();
  });

  test("queued runs survive a daemon restart and start after recover()", async () => {
    const one = held();
    const { app, ticket, home } = await limited([one.script], 1);
    const r1 = await app.runs.start(ticket("one").id);
    const r2 = await app.runs.start(ticket("two").id);
    await until(app, r1.id, "running");
    expect(state(app, r2.id)).toBe("queued");
    app.runs.shutdown();

    // A new daemon on the same data: the running run is paused, which frees the slot for the queued one.
    const runner = new FakeRunner([writesGreeting]);
    const app2 = createApp({ home, port: 0, maxRuns: 1 }, { runner });
    app2.runs.recover();
    expect(state(app2, r1.id)).toBe("paused");
    await until(app2, r2.id, "awaiting_review");
    app2.runs.shutdown();
    one.release();
  });

  test("a queued run that can't start fails instead of blocking the queue", async () => {
    const one = held();
    const { app, ticket } = await limited([one.script, writesGreeting], 1);
    const gonePath = await makeRepo();
    app.store.addRepo({ name: "gone", path: gonePath, base: "main" });
    const r1 = await app.runs.start(ticket("one").id);
    const r2 = await app.runs.start(app.tickets.create({ repo: "gone", title: "two", body: "" }).id);
    const r3 = await app.runs.start(ticket("three").id);
    await until(app, r1.id, "running");
    await $`rm -rf ${gonePath}`; // the queued run's repo vanished while it waited
    one.release();
    await until(app, r2.id, "failed");
    await until(app, r3.id, "awaiting_review");
  });
});

describe("cost", () => {
  async function costApp(scripts: FakeScript[], home = tempDir("acutis-home-")) {
    const repoPath = await makeRepo();
    const runner = new FakeRunner(scripts);
    const app = createApp({ home, port: 0 }, { runner, costPollMs: 0 });
    app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
    return { app, runner, home, ticket: app.tickets.create({ repo: "demo", title: "t", body: "" }) };
  }
  const cost = (app: ReturnType<typeof createApp>, id: number) => app.store.getRun(id)!.cost_usd;

  test("cost updates live mid-turn, and the turn result still reports the whole turn", async () => {
    let step!: () => void;
    const script: FakeScript = async (c) => {
      c.setTotal(0.2);
      c.emit({ kind: "agent.text", text: "working" });
      await new Promise<void>((r) => (step = r));
      c.result("success", 0.3);
      await c.nextMessage();
    };
    const { app, ticket } = await costApp([script]);
    const run = await app.runs.start(ticket.id);
    await waitFor(() => cost(app, run.id) > 0.19);
    expect(cost(app, run.id)).toBeCloseTo(0.2);
    step();
    await until(app, run.id, "awaiting_review");
    expect(cost(app, run.id)).toBeCloseTo(0.3);
    const result = app.store.events(run.id).find((e) => e.kind === "agent.result")!.data as any;
    expect(result.turn_cost_usd).toBeCloseTo(0.3);
  });

  test("a killed turn's spend is counted (it never sends a result)", async () => {
    const script: FakeScript = async (c) => {
      c.emit({ kind: "agent.text", text: "working" }); // its live poll sees no total yet
      await Bun.sleep(50);
      c.setTotal(0.42); // spent after the last poll
      await c.nextMessage();
    };
    const { app, ticket } = await costApp([script]);
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "running");
    await Bun.sleep(100);
    expect(cost(app, run.id)).toBe(0);
    await app.runs.kill(run.id);
    expect(state(app, run.id)).toBe("cancelled");
    expect(cost(app, run.id)).toBeCloseTo(0.42);
  });

  test("after a restart, a resumed session's restored total counts the interrupted turn once", async () => {
    // Process 1 is polled at 0.1, then the daemon dies mid-turn (spend continued to 0.25, unseen).
    const dies: FakeScript = async (c) => {
      c.setTotal(0.1);
      c.emit({ kind: "agent.text", text: "working" });
      await c.nextMessage();
    };
    const { app, ticket, home } = await costApp([dies]);
    const run = await app.runs.start(ticket.id);
    await waitFor(() => cost(app, run.id) > 0.09);
    app.runs.shutdown();

    // Process 2 resumes: its total starts at the transcript's 0.25 and the turn ends at 0.3.
    const resumes: FakeScript = async (c) => {
      c.setTotal(0.25);
      await Bun.sleep(30);
      c.result("success", 0.3);
      await c.nextMessage();
    };
    const runner = new FakeRunner([resumes]);
    const app2 = createApp({ home, port: 0 }, { runner, costPollMs: 0 });
    app2.runs.recover();
    await app2.runs.resume(run.id);
    await until(app2, run.id, "awaiting_review");
    expect(cost(app2, run.id)).toBeCloseTo(0.3); // not 0.1 + 0.3, not 0.1 + 0.25 + 0.3
    const log = app2.store.events(run.id).find((e) => e.kind === "system.log" && String((e.data as any).msg).includes("interrupted turn"));
    expect((log?.data as any)?.msg).toContain("0.150");
    app2.runs.shutdown();
  });

  test("a resumed total restored just under what was counted rebaselines instead of adding it again", async () => {
    const dies: FakeScript = async (c) => {
      c.setTotal(0.1);
      c.emit({ kind: "agent.text", text: "working" });
      await c.nextMessage();
    };
    const { app, ticket, home } = await costApp([dies]);
    const run = await app.runs.start(ticket.id);
    await waitFor(() => cost(app, run.id) > 0.09);
    app.runs.shutdown();
    const resumes: FakeScript = async (c) => {
      c.setTotal(0.099); // the transcript saved slightly less than our last poll saw
      await Bun.sleep(30);
      c.result("success", 0.15);
      await c.nextMessage();
    };
    const app2 = createApp({ home, port: 0 }, { runner: new FakeRunner([resumes]), costPollMs: 0 });
    app2.runs.recover();
    await app2.runs.resume(run.id);
    await until(app2, run.id, "awaiting_review");
    expect(cost(app2, run.id)).toBeCloseTo(0.151, 5); // 0.1 + (0.15 - 0.099): not 0.1 + 0.099 + …, and not 0.15 (ignoring the lower total)
    app2.runs.shutdown();
  });

  test("runs queued under a limit still start after a restart with no limit", async () => {
    const repoPath = await makeRepo();
    const home = tempDir("acutis-home-");
    const app = createApp({ home, port: 0, maxRuns: 1 }, { runner: new FakeRunner([async (c) => void (await c.nextMessage())]) });
    app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
    const r1 = await app.runs.start(app.tickets.create({ repo: "demo", title: "one", body: "" }).id);
    const r2 = await app.runs.start(app.tickets.create({ repo: "demo", title: "two", body: "" }).id);
    await until(app, r1.id, "running");
    expect(state(app, r2.id)).toBe("queued");
    app.runs.shutdown();
    const app2 = createApp({ home, port: 0, maxRuns: 0 }, { runner: new FakeRunner([writesGreeting]) });
    app2.runs.recover();
    await until(app2, r2.id, "awaiting_review");
    app2.runs.shutdown();
  });

  test("a slow poll overtaken by a turn result doesn't move the baseline back", async () => {
    let release!: () => void;
    const script: FakeScript = async (c) => {
      c.setTotal(0.2);
      c.holdTotal = new Promise<void>((r) => (release = r));
      c.emit({ kind: "agent.text", text: "working" }); // starts a poll that reads 0.2, then waits
      await c.interrupted();
      c.holdTotal = null;
      c.result("error_during_execution", 0.5); // paused: the session stays live
      await Bun.sleep(20);
      release(); // the stale 0.2 arrives after the 0.5 result
      await c.nextMessage();
      c.result("success", 0.6);
      await c.nextMessage();
    };
    const { app, ticket } = await costApp([script]);
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "running");
    await Bun.sleep(20);
    await app.runs.pause(run.id);
    await until(app, run.id, "paused");
    await Bun.sleep(60);
    expect(cost(app, run.id)).toBeCloseTo(0.5);
    await app.runs.message(run.id, "go on");
    await until(app, run.id, "awaiting_review");
    expect(cost(app, run.id)).toBeCloseTo(0.6); // not 0.5 + (0.6 - 0.2)
  });
});
