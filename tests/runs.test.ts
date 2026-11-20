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
