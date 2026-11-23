import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { AcutisTool, RunState } from "../src/core/types";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeScript } from "./helpers";

/**
 * Tickets that build on another ticket's landed work (#19). The repo lands as a bookmark, so
 * trunk doesn't move when a run lands; a follow-up must still start on top of what came before,
 * while policy and contract checks keep coming from trunk.
 */

const wf = (gate: string, extra = "") => `---\nland: bookmark\nmax_attempts: 1\ngates:\n  - ${gate}\n${extra}---\nDo {{ticket.title}}\n`;

/** Writes `files` in the workspace, then ends the turn and stays alive until closed. */
const writes =
  (files: Record<string, string>, text = "done"): FakeScript =>
  async (c) => {
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(c.spec.cwd, p, ".."), { recursive: true });
      writeFileSync(join(c.spec.cwd, p), body);
    }
    c.emit({ kind: "agent.text", text });
    c.result();
    await c.nextMessage();
  };

async function setup(scripts: FakeScript[], workflow = wf("test -f b.txt -o -f a.txt")) {
  const repoPath = await makeRepo({ "README.md": "hello\n", ".acutis/workflow.md": workflow, "src/api.ts": "export const v = 1;\n" });
  const runner = new FakeRunner(scripts);
  const home = tempDir("acutis-home-");
  const app = createApp({ home, port: 0 }, { runner });
  app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
  return { app, runner, repoPath, home };
}

type App = ReturnType<typeof createApp>;
const state = (app: App, id: number) => app.store.getRun(id)!.state;
const until = (app: App, id: number, s: RunState) => waitFor(() => state(app, id) === s, 10000);
const trunkOf = async (repoPath: string) => (await $`jj log --no-graph -r main -T commit_id`.cwd(repoPath).text()).trim();
const logs = (app: App, id: number) =>
  app.store
    .events(id)
    .filter((e) => e.kind === "system.log")
    .map((e) => String((e.data as any).msg));

/** Land ticket A (writes a.txt), returning its run. */
async function landParent(app: App, files: Record<string, string> = { "a.txt": "from A\n" }, opts: { acceptContracts?: boolean } = {}) {
  const a = app.tickets.create({ repo: "demo", title: "Parent work", body: "" });
  const run = await app.runs.start(a.id);
  await until(app, run.id, "awaiting_review");
  await app.runs.approve(run.id, opts);
  expect(state(app, run.id)).toBe("done");
  return { ticket: a, run: app.store.getRun(run.id)! };
}

describe("a ticket that builds on another", () => {
  test("starts on top of the parent's landed bookmark; the diff shows only its own change; policy still from trunk", async () => {
    const { app, runner, repoPath } = await setup([writes({ "a.txt": "from A\n" }), writes({ "b.txt": "from B\n" })]);
    const trunk = await trunkOf(repoPath);
    const parent = await landParent(app);
    expect(parent.run.landed_commit).toBeTruthy();
    expect(await trunkOf(repoPath)).toBe(trunk); // bookmark landing: main didn't move

    const b = app.tickets.create({ repo: "demo", title: "Child work", body: "", builds_on: parent.ticket.id });
    const run = await app.runs.start(b.id);
    await until(app, run.id, "awaiting_review");
    const r = app.store.getRun(run.id)!;
    expect(r.base_commit).toBe(parent.run.landed_commit);
    expect(r.trunk_commit).toBe(trunk);
    // A's file is in B's workspace, but B's diff is only B's change.
    expect(existsSync(join(r.workspace_path!, "a.txt"))).toBe(true);
    const diff = await app.runs.diff(run.id);
    expect(diff).toContain("b.txt");
    expect(diff).not.toContain("a.txt");
    expect(logs(app, run.id).some((m) => m.includes(`Builds on #${parent.ticket.id}`) && m.includes("starting on top of it"))).toBe(true);
    // The worker is told what it stands on.
    expect(runner.sessions[1]!.spec.systemAppend).toContain(`builds on ticket #${parent.ticket.id}`);

    await app.runs.approve(run.id);
    // The child's bookmark stacks on the parent's: one branch carries both.
    const both = await $`jj log --no-graph -r ${"::acutis/" + b.id + "-child-work & ~::main"} -T 'description.first_line() ++ "\\n"'`.cwd(repoPath).text();
    expect(both).toContain("Parent work");
    expect(both).toContain("Child work");
    app.runs.shutdown();
  });

  test("a parent that edits .acutis/workflow.md doesn't change the child's checks, even after a restart", async () => {
    // Trunk's gate passes for the child (b.txt). The parent rewrites the policy to a gate that always fails.
    const sendBack: FakeScript = async (c) => {
      writeFileSync(join(c.spec.cwd, "b.txt"), "from B\n");
      c.result();
      await c.nextMessage();
    };
    const { app, repoPath, home } = await setup([writes({ ".acutis/workflow.md": wf("false") }), sendBack]);
    const parent = await landParent(app);
    const b = app.tickets.create({ repo: "demo", title: "Child", body: "", builds_on: parent.ticket.id });
    const run = await app.runs.start(b.id);
    await until(app, run.id, "awaiting_review");
    expect(app.store.getRun(run.id)!.gates_ok).toBe(1);
    expect(logs(app, run.id)[0]).toContain(`.acutis/workflow.md@${(await trunkOf(repoPath)).slice(0, 12)}`);
    app.runs.shutdown();

    // A new daemon on the same data: sending the run back re-verifies under policy from trunk_commit.
    const again: FakeScript = async (c) => {
      writeFileSync(join(c.spec.cwd, "b.txt"), "from B, revised\n");
      c.result();
      await c.nextMessage();
    };
    const app2 = createApp({ home, port: 0 }, { runner: new FakeRunner([again]) });
    app2.runs.recover();
    await app2.runs.message(run.id, "one more tweak");
    await waitFor(() => app2.store.events(run.id).filter((e) => e.kind === "gate.result").length >= 2, 10000);
    await until(app2, run.id, "awaiting_review");
    const results = app2.store.events(run.id).filter((e) => e.kind === "gate.result");
    expect(results.every((e) => (e.data as any).ok === true)).toBe(true);
    expect(app2.store.getRun(run.id)!.gates_ok).toBe(1);
    app2.runs.shutdown();
  });

  test("start is refused until the parent lands, and when it was cancelled", async () => {
    const { app } = await setup([]);
    const a = app.tickets.create({ repo: "demo", title: "Parent", body: "" });
    const b = app.tickets.create({ repo: "demo", title: "Child", body: "", builds_on: a.id });
    await expect(app.runs.start(b.id)).rejects.toThrow(new RegExp(`builds on #${a.id}, which hasn't landed yet \\(it is todo\\)`));
    expect(app.tickets.get(b.id)!.status).toBe("todo"); // not claimed
    app.tickets.setStatus(a.id, "cancelled");
    await expect(app.runs.start(b.id)).rejects.toThrow(/was cancelled\. Clear the link/);
    // Clearing the link makes it an ordinary ticket again.
    app.runs.setBuildsOn(b.id, null);
    expect(app.tickets.get(b.id)!.builds_on).toBeNull();
    app.runs.shutdown();
  });

  test("a parent closed as done without a landed run is refused at start, before claiming", async () => {
    const { app } = await setup([]);
    const a = app.tickets.create({ repo: "demo", title: "Parent", body: "" });
    app.tickets.setStatus(a.id, "done");
    const b = app.tickets.create({ repo: "demo", title: "Child", body: "", builds_on: a.id });
    await expect(app.runs.start(b.id)).rejects.toThrow(/is done but has no landed run/);
    expect(app.tickets.get(b.id)!.status).toBe("todo");
    app.runs.shutdown();
  });

  test("a run from before trunk_commit existed still re-verifies and lands after a restart", async () => {
    const { app, home } = await setup([writes({ "a.txt": "A\n" })]);
    const t = app.tickets.create({ repo: "demo", title: "Old run", body: "" });
    const run = await app.runs.start(t.id);
    await until(app, run.id, "awaiting_review");
    app.store.updateRun(run.id, { trunk_commit: null }); // as the old code left it
    app.runs.shutdown();

    const again: FakeScript = async (c) => {
      writeFileSync(join(c.spec.cwd, "a.txt"), "A, revised\n");
      c.result();
      await c.nextMessage();
    };
    const app2 = createApp({ home, port: 0 }, { runner: new FakeRunner([again]) });
    app2.runs.recover();
    await app2.runs.message(run.id, "tweak it");
    await waitFor(() => app2.store.events(run.id).filter((e) => e.kind === "gate.result").length >= 2, 10000);
    await until(app2, run.id, "awaiting_review");
    expect(app2.store.getRun(run.id)!.gates_ok).toBe(1);
    expect((await app2.runs.approve(run.id)).landed).toBe(true);
    expect(app2.store.getRun(run.id)!.landed_commit).toBeTruthy();
    app2.runs.shutdown();
  });

  test("once the parent is merged into trunk, the child starts from trunk", async () => {
    const { app, repoPath } = await setup([writes({ "a.txt": "from A\n" }), writes({ "b.txt": "from B\n" })]);
    const parent = await landParent(app);
    // The operator merges A (a fast-forward here) and trunk moves on with other work.
    await $`jj bookmark set main -r ${parent.run.landed_commit!}`.cwd(repoPath).quiet();
    await $`jj new main && echo other > other.txt && jj commit -m other && jj bookmark set main -r @-`.cwd(repoPath).quiet();
    const trunk = await trunkOf(repoPath);
    const b = app.tickets.create({ repo: "demo", title: "Child", body: "", builds_on: parent.ticket.id });
    const run = await app.runs.start(b.id);
    await until(app, run.id, "awaiting_review");
    expect(app.store.getRun(run.id)!.base_commit).toBe(trunk);
    expect(logs(app, run.id).some((m) => m.includes("which is on main: starting from main"))).toBe(true);
    app.runs.shutdown();
  });

  test("runs from before landed_commit fall back to the bookmark; a vanished bookmark is a clear error", async () => {
    const { app, repoPath } = await setup([writes({ "a.txt": "from A\n" }), writes({ "b.txt": "from B\n" })]);
    const parent = await landParent(app);
    app.store.updateRun(parent.run.id, { landed_commit: null });
    const b = app.tickets.create({ repo: "demo", title: "Child", body: "", builds_on: parent.ticket.id });
    const run = await app.runs.start(b.id);
    await until(app, run.id, "awaiting_review");
    expect(app.store.getRun(run.id)!.base_commit).toBe(parent.run.landed_commit);
    await app.runs.discard(run.id);

    await $`jj bookmark delete ${parent.run.bookmark!}`.cwd(repoPath).quiet();
    const c = app.tickets.create({ repo: "demo", title: "Child 2", body: "", builds_on: parent.ticket.id });
    const run2 = await app.runs.start(c.id);
    await until(app, run2.id, "failed");
    expect(app.store.getRun(run2.id)!.error).toMatch(/landed work can't be found/);
    app.runs.shutdown();
  });

  test("links are validated: same repo, no runner tickets, no cycles, only before starting", async () => {
    const { app } = await setup([]);
    const other = await makeRepo();
    app.store.addRepo({ name: "other", path: other, base: "main" });
    const a = app.tickets.create({ repo: "demo", title: "A", body: "" });
    const b = app.tickets.create({ repo: "demo", title: "B", body: "", builds_on: a.id });
    const x = app.tickets.create({ repo: "other", title: "X", body: "" });
    expect(() => app.runs.setBuildsOn(x.id, a.id)).toThrow(/is in repo "demo", not "other"/);
    expect(() => app.runs.setBuildsOn(a.id, b.id)).toThrow(/already builds on/);
    expect(() => app.runs.setBuildsOn(a.id, a.id)).toThrow(/already builds on/);
    const runner = app.tickets.create({ repo: "demo", title: "draft", body: "", source: "writer-run" });
    expect(() => app.runs.setBuildsOn(b.id, runner.id)).toThrow(/runner's own ticket/);
    app.tickets.setStatus(b.id, "done");
    expect(() => app.runs.setBuildsOn(b.id, null)).toThrow(/only a ticket that hasn't started/);
    app.runs.shutdown();
  });

  test("request_work with follow_up files a ticket that builds on the requester's own ticket", async () => {
    const replies: string[] = [];
    const asks: FakeScript = async (c) => {
      const t = c.spec.tools!.find((x) => x.name === "request_work") as AcutisTool;
      const first = await t.handler({ title: "Next step: wire it up", need: "use a.txt everywhere", why: "the plan's second half", follow_up: true });
      const id = Number(/#(\d+)/.exec(first.text)![1]);
      // The step after that needs it: it builds on the first follow-up, not on the worker's ticket.
      await t.handler({ title: "Step three: polish", need: "polish", why: "after step two", follow_up: true, after: id });
      // An id this run didn't file as a follow-up is refused.
      replies.push((await t.handler({ title: "Sneaky", need: "x", why: "y", follow_up: true, after: 1 })).text);
      await t.handler({ title: "Engine: export getMoves", need: "an engine API", why: "stubbed for now" });
      writeFileSync(join(c.spec.cwd, "a.txt"), "x\n");
      c.result();
      await c.nextMessage();
    };
    const { app } = await setup([asks]);
    const a = app.tickets.create({ repo: "demo", title: "Plan part 1", body: "" });
    const run = await app.runs.start(a.id);
    await until(app, run.id, "awaiting_review");
    const filed = app.tickets.list({ repo: "demo" }).filter((t) => t.source === "work-request");
    const follow = filed.find((t) => t.title.startsWith("Next step"))!;
    const dep = filed.find((t) => t.title.startsWith("Engine"))!;
    expect(follow.builds_on).toBe(a.id);
    expect(follow.body).toContain(`builds on ticket #${a.id}`);
    expect(filed.find((t) => t.title.startsWith("Step three"))!.builds_on).toBe(follow.id);
    expect(replies[0]).toMatch(/after must be the id of a follow-up you filed in this run/);
    expect(filed.some((t) => t.title === "Sneaky")).toBe(false);
    expect(dep.builds_on).toBeNull();
    expect(dep.body).toContain("waits on it");
    app.runs.shutdown();
  });
});

describe("contracts and trunk landing with a stacked run", () => {
  const contract = 'contracts:\n  api:\n    files: ["src/api.ts"]\n';

  test("the parent's own contract change isn't reported as a change on trunk; a real one still is", async () => {
    const { app, repoPath } = await setup(
      [writes({ "src/api.ts": "export const v = 2;\n", "a.txt": "A\n" }), writes({ "b.txt": "B\n" })],
      wf("test -f b.txt -o -f a.txt", contract),
    );
    const parent = await landParent(app, undefined, { acceptContracts: true });
    const b = app.tickets.create({ repo: "demo", title: "Child", body: "", builds_on: parent.ticket.id });
    const run = await app.runs.start(b.id);
    await until(app, run.id, "awaiting_review");

    // Now the contract really changes on trunk while B waits for review.
    await $`jj new main && echo 'export const v = 3;' > src/api.ts && jj commit -m api && jj bookmark set main -r @-`.cwd(repoPath).quiet();
    await expect(app.runs.approve(run.id)).rejects.toThrow(/the api contract changed on main since this run started/);
    // Accepting it lands (bookmark mode never rebases).
    await app.runs.approve(run.id, { acceptContracts: true });
    expect(state(app, run.id)).toBe("done");
    app.runs.shutdown();
  });

  test("no false stale report when trunk's contract didn't change", async () => {
    const { app } = await setup(
      [writes({ "src/api.ts": "export const v = 2;\n", "a.txt": "A\n" }), writes({ "b.txt": "B\n" })],
      wf("test -f b.txt -o -f a.txt", contract),
    );
    const parent = await landParent(app, undefined, { acceptContracts: true });
    const b = app.tickets.create({ repo: "demo", title: "Child", body: "", builds_on: parent.ticket.id });
    const run = await app.runs.start(b.id);
    await until(app, run.id, "awaiting_review");
    const out = await app.runs.approve(run.id);
    expect(out.landed).toBe(true);
    app.runs.shutdown();
  });

  test("land: trunk refuses a stacked run whose start isn't on trunk (it would drop the parent's work)", async () => {
    const { app, repoPath } = await setup([writes({ "a.txt": "A\n" }), writes({ "b.txt": "B\n" })]);
    const parent = await landParent(app);
    // The operator then switches the repo to trunk landing on main, before the child starts.
    await $`jj new main && printf '%s' ${wf("test -f b.txt -o -f a.txt").replace("land: bookmark", "land: trunk")} > .acutis/workflow.md && jj commit -m policy && jj bookmark set main -r @-`
      .cwd(repoPath)
      .quiet();
    const b = app.tickets.create({ repo: "demo", title: "Child", body: "", builds_on: parent.ticket.id });
    const run = await app.runs.start(b.id);
    await until(app, run.id, "awaiting_review");
    await expect(app.runs.approve(run.id)).rejects.toThrow(new RegExp(`started on #${parent.ticket.id}'s landed work, which isn't on main yet`));
    expect(state(app, run.id)).toBe("awaiting_review");
    app.runs.shutdown();
  });
});
