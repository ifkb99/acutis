import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { AcutisTool, RunState } from "../src/core/types";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeScript } from "./helpers";

/**
 * Epics: tickets that build one shared branch (acutis/epic-<id>-…). Each ticket's run starts on
 * the branch tip and lands by moving it forward; the branch goes to trunk as one unit. The repo
 * lands as a bookmark, so trunk never moves here unless a test moves it.
 */

const wf = (gate: string, land = "bookmark") => `---\nland: ${land}\nmax_attempts: 1\ngates:\n  - ${gate}\n---\nDo {{ticket.title}}\n`;
const GATE = "test -f a.txt -o -f b.txt -o -f c.txt";

/** Writes `files` in the workspace, then ends the turn and stays alive until closed. */
const writes =
  (files: Record<string, string>): FakeScript =>
  async (c) => {
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(c.spec.cwd, p, ".."), { recursive: true });
      writeFileSync(join(c.spec.cwd, p), body);
    }
    c.emit({ kind: "agent.text", text: "done" });
    c.result();
    await c.nextMessage();
  };

async function setup(scripts: FakeScript[], workflow = wf(GATE)) {
  const repoPath = await makeRepo({ "README.md": "hello\n", ".acutis/workflow.md": workflow, "shared.txt": "base\n" });
  const runner = new FakeRunner(scripts);
  const home = tempDir("acutis-home-");
  const app = createApp({ home, port: 0 }, { runner });
  app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
  return { app, runner, repoPath, home };
}

type App = ReturnType<typeof createApp>;
const state = (app: App, id: number) => app.store.getRun(id)!.state;
const until = (app: App, id: number, s: RunState) => waitFor(() => state(app, id) === s, 10000);
const rev = async (repoPath: string, r: string) => (await $`jj log --no-graph -r ${r} -T commit_id`.cwd(repoPath).text()).trim();
const NAME_T = 'name ++ "\\n"';
const LINE_T = 'description.first_line() ++ "\\n"';
const bookmarks = async (repoPath: string) => (await $`jj bookmark list -T ${NAME_T}`.cwd(repoPath).text()).split("\n").filter(Boolean);
/** First lines of the commits on `r` that aren't on main, oldest first. */
const branchLog = async (repoPath: string, r: string) =>
  (await $`jj log --no-graph --reversed -r ${`::${r} & ~::main`} -T ${LINE_T}`.cwd(repoPath).text()).split("\n").filter(Boolean);
const logs = (app: App, id: number) =>
  app.store
    .events(id)
    .filter((e) => e.kind === "system.log")
    .map((e) => String((e.data as any).msg));
const gateResults = (app: App, id: number) => app.store.events(id).filter((e) => e.kind === "gate.result");

async function startTicket(app: App, title: string, epic_id: number | null, extra: { builds_on?: number } = {}) {
  const t = app.tickets.create({ repo: "demo", title, body: "", epic_id, ...extra });
  const run = await app.runs.start(t.id);
  await until(app, run.id, "awaiting_review");
  return { ticket: t, run: app.store.getRun(run.id)! };
}

describe("epics", () => {
  test("tickets land one after another on the epic's branch; each starts on the last one's work", async () => {
    const { app, runner, repoPath } = await setup([writes({ "a.txt": "A\n" }), writes({ "b.txt": "B\n" })]);
    const trunk = await rev(repoPath, "main");
    const epic = app.runs.createEpic("demo", "Dashboard polish");
    expect(epic.bookmark).toBe(`acutis/epic-${epic.id}-dashboard-polish`);

    const one = await startTicket(app, "First step", epic.id);
    expect(one.run.base_commit).toBe(trunk); // nothing on the epic yet
    expect(logs(app, one.run.id).some((m) => m.includes("nothing has landed on it yet"))).toBe(true);
    await app.runs.approve(one.run.id);
    expect(state(app, one.run.id)).toBe("done");
    const tip1 = await rev(repoPath, epic.bookmark);
    expect(app.store.getRun(one.run.id)!.landed_commit).toBe(tip1);
    expect(app.store.getRun(one.run.id)!.bookmark).toBe(epic.bookmark);
    expect(await rev(repoPath, "main")).toBe(trunk); // trunk untouched
    // No per-ticket bookmark: the epic's branch is the one place the work goes.
    expect((await bookmarks(repoPath)).filter((b) => b.startsWith("acutis/"))).toEqual([epic.bookmark]);

    const two = await startTicket(app, "Second step", epic.id);
    expect(two.run.base_commit).toBe(tip1);
    expect(two.run.trunk_commit).toBe(trunk);
    expect(existsSync(join(two.run.workspace_path!, "a.txt"))).toBe(true);
    const diff = await app.runs.diff(two.run.id);
    expect(diff).toContain("b.txt");
    expect(diff).not.toContain("a.txt");
    expect(runner.sessions[1]!.spec.systemAppend).toContain(`part of epic ${epic.id} (Dashboard polish)`);
    expect(runner.sessions[1]!.spec.systemAppend).toContain(epic.bookmark);
    expect(runner.sessions[0]!.spec.systemAppend).not.toContain("part of epic"); // it started on trunk
    await app.runs.approve(two.run.id);
    expect(gateResults(app, two.run.id).length).toBe(1); // a fast-forward: no re-check needed
    expect(await branchLog(repoPath, epic.bookmark)).toEqual(["First step", "Second step"]);
    app.runs.shutdown();
  });

  test("two tickets in review at once: the second is rebased onto the moved branch and checked again", async () => {
    const { app, repoPath } = await setup([writes({ "a.txt": "A\n" }), writes({ "b.txt": "B\n" })]);
    const trunk = await rev(repoPath, "main");
    const epic = app.runs.createEpic("demo", "Parallel");
    const one = await startTicket(app, "One", epic.id);
    const two = await startTicket(app, "Two", epic.id); // started before One landed
    expect(two.run.base_commit).toBe(trunk);
    await app.runs.approve(one.run.id);
    const tip1 = await rev(repoPath, epic.bookmark);

    await app.runs.approve(two.run.id);
    expect(state(app, two.run.id)).toBe("done");
    const r = app.store.getRun(two.run.id)!;
    expect(r.base_commit).toBe(tip1); // the workspace's base moved to the tip
    expect(r.trunk_commit).toBe(trunk); // policy still judged from trunk
    expect(gateResults(app, two.run.id).length).toBe(2); // checked again on the combination
    expect(logs(app, two.run.id).some((m) => m.includes(`Rebased onto epic ${epic.id}'s branch`))).toBe(true);
    expect(await branchLog(repoPath, epic.bookmark)).toEqual(["One", "Two"]);
    // Two's own change, relative to the new base, is still only b.txt.
    const files = await $`jj diff --name-only --from ${tip1} --to ${epic.bookmark}`.cwd(repoPath).text();
    expect(files.trim()).toBe("b.txt");
    app.runs.shutdown();
  });

  test("a rebase conflict sends the run back to review and leaves the branch where it was", async () => {
    const { app, repoPath } = await setup([writes({ "shared.txt": "from one\n", "a.txt": "A\n" }), writes({ "shared.txt": "from two\n", "b.txt": "B\n" })]);
    const epic = app.runs.createEpic("demo", "Clash");
    const one = await startTicket(app, "One", epic.id);
    const two = await startTicket(app, "Two", epic.id);
    await app.runs.approve(one.run.id);
    const tip1 = await rev(repoPath, epic.bookmark);
    await expect(app.runs.approve(two.run.id)).rejects.toThrow(/rebasing onto epic \d+'s branch .* left conflicts in: shared\.txt/);
    expect(state(app, two.run.id)).toBe("awaiting_review");
    expect(await rev(repoPath, epic.bookmark)).toBe(tip1);
    app.runs.shutdown();
  });

  test("an earlier ticket's policy edit doesn't change a later one's checks, at landing and after a restart", async () => {
    // One rewrites the policy to a gate that always fails; trunk's gate passes for Two.
    const { app, repoPath, home } = await setup([writes({ ".acutis/workflow.md": wf("false"), "a.txt": "A\n" }), writes({ "b.txt": "B\n" })]);
    const trunk = await rev(repoPath, "main");
    const epic = app.runs.createEpic("demo", "Policy");
    const one = await startTicket(app, "One", epic.id);
    const two = await startTicket(app, "Two", epic.id);
    await app.runs.approve(one.run.id);
    app.runs.shutdown();

    // A new daemon on the same data approves Two: it rebases onto One's policy edit and re-checks
    // under trunk's policy (which passes), not the branch's (which would fail).
    const app2 = createApp({ home, port: 0 }, { runner: new FakeRunner([]) });
    app2.runs.recover();
    await app2.runs.approve(two.run.id);
    expect(state(app2, two.run.id)).toBe("done");
    const results = gateResults(app2, two.run.id);
    expect(results.length).toBe(2);
    expect(results.every((e) => (e.data as any).ok === true)).toBe(true);
    expect(app2.store.getRun(two.run.id)!.trunk_commit).toBe(trunk);

    // A third ticket starts on the branch, whose workflow.md fails everything: its checks still
    // come from trunk.
    const app3 = createApp({ home, port: 0 }, { runner: new FakeRunner([writes({ "c.txt": "C\n" })]) });
    app3.runs.recover();
    const three = await startTicket(app3, "Three", epic.id);
    expect(three.run.base_commit).toBe(await rev(repoPath, epic.bookmark));
    expect(three.run.gates_ok).toBe(1);
    expect(logs(app3, three.run.id)[0]).toContain(`.acutis/workflow.md@${trunk.slice(0, 12)}`);
    app2.runs.shutdown();
    app3.runs.shutdown();
  });

  test("once the branch is merged into trunk, the next ticket starts from trunk and the branch moves on", async () => {
    const { app, repoPath } = await setup([writes({ "a.txt": "A\n" }), writes({ "b.txt": "B\n" })]);
    const epic = app.runs.createEpic("demo", "Merged");
    const one = await startTicket(app, "One", epic.id);
    await app.runs.approve(one.run.id);
    // The operator merges the epic (a fast-forward here) and trunk moves on.
    await $`jj bookmark set main -r ${epic.bookmark}`.cwd(repoPath).quiet();
    await $`jj new main && echo other > other.txt && jj commit -m other && jj bookmark set main -r @-`.cwd(repoPath).quiet();
    const trunk = await rev(repoPath, "main");
    expect((await app.runs.epicDetail(epic.id)).on_trunk).toBe(true);
    const two = await startTicket(app, "Two", epic.id);
    expect(two.run.base_commit).toBe(trunk);
    expect(logs(app, two.run.id).some((m) => m.includes("is already on main, so starting from main"))).toBe(true);
    await app.runs.approve(two.run.id);
    expect(gateResults(app, two.run.id).length).toBe(1); // the old tip is under it: no rebase
    expect(await rev(repoPath, `${epic.bookmark}-`)).toBe(trunk);
    app.runs.shutdown();
  });

  test("builds_on inside an epic waits for the parent; across an open epic it's refused", async () => {
    const { app } = await setup([writes({ "a.txt": "A\n" }), writes({ "b.txt": "B\n" })]);
    const epic = app.runs.createEpic("demo", "Order");
    const p = app.tickets.create({ repo: "demo", title: "Parent", body: "", epic_id: epic.id });
    const c = app.tickets.create({ repo: "demo", title: "Child", body: "", epic_id: epic.id, builds_on: p.id });
    await expect(app.runs.start(c.id)).rejects.toThrow(/hasn't landed yet/);
    // A ticket outside the epic can't build on one inside it while the epic is open.
    const outside = app.tickets.create({ repo: "demo", title: "Outside", body: "" });
    expect(() => app.runs.setBuildsOn(outside.id, p.id)).toThrow(new RegExp(`is in epic ${epic.id}: a ticket that builds on it must be in epic ${epic.id} too`));
    // Joining the epic makes the link fine; leaving it while linked is refused.
    app.runs.setEpic(outside.id, epic.id);
    app.runs.setBuildsOn(outside.id, p.id);
    expect(() => app.runs.setEpic(outside.id, null)).toThrow(/must be in epic/);

    const pr = await app.runs.start(p.id);
    await until(app, pr.id, "awaiting_review");
    await app.runs.approve(pr.id);
    const run = await app.runs.start(c.id);
    await until(app, run.id, "awaiting_review");
    expect(app.store.getRun(run.id)!.base_commit).toBe(app.store.getRun(pr.id)!.landed_commit);
    app.runs.shutdown();
  });

  test("an epic ticket that builds on work outside the branch is refused at start", async () => {
    const { app } = await setup([writes({ "a.txt": "A\n" })]);
    const loose = app.tickets.create({ repo: "demo", title: "Loose", body: "" });
    const lr = await app.runs.start(loose.id);
    await until(app, lr.id, "awaiting_review");
    await app.runs.approve(lr.id); // landed as its own bookmark, not on main
    const epic = app.runs.createEpic("demo", "E");
    const t = app.tickets.create({ repo: "demo", title: "In epic", body: "", epic_id: epic.id, builds_on: loose.id });
    await expect(app.runs.start(t.id)).rejects.toThrow(/whose landed work isn't on the epic's branch or on main/);
    app.runs.shutdown();
  });

  test("joining, leaving and closing are validated", async () => {
    const { app } = await setup([writes({ "a.txt": "A\n" })]);
    const repo2 = await makeRepo({ "README.md": "x\n" });
    app.store.addRepo({ name: "other", path: repo2, base: "main" });
    const epic = app.runs.createEpic("demo", "Rules");
    expect(() => app.runs.createEpic("demo", "  ")).toThrow(/needs a title/);
    expect(() => app.runs.createEpic("nope", "x")).toThrow(/unknown repo/);
    const elsewhere = app.tickets.create({ repo: "other", title: "Elsewhere", body: "" });
    expect(() => app.runs.setEpic(elsewhere.id, epic.id)).toThrow(/is in repo "demo", not "other"/);
    expect(() => app.runs.setEpic(elsewhere.id, 999)).toThrow(/epic 999 not found/);

    const t = app.tickets.create({ repo: "demo", title: "Work", body: "" });
    app.runs.setEpic(t.id, epic.id);
    const run = await app.runs.start(t.id);
    await until(app, run.id, "awaiting_review");
    expect(() => app.runs.setEpic(t.id, null)).toThrow(/only a ticket that hasn't started can join or leave an epic/);
    expect(() => app.runs.closeEpic(epic.id)).toThrow(new RegExp(`still has unfinished tickets: #${t.id} \\(review\\)`));
    await app.runs.approve(run.id);
    expect(app.runs.closeEpic(epic.id).status).toBe("closed");
    expect(app.runs.listEpics().map((e) => e.id)).not.toContain(epic.id);
    expect(app.runs.listEpics({ all: true }).find((e) => e.id === epic.id)!.tickets.map((x) => x.id)).toEqual([t.id]);
    const late = app.tickets.create({ repo: "demo", title: "Late", body: "" });
    expect(() => app.runs.setEpic(late.id, epic.id)).toThrow(/is closed/);
    // A ticket building on one in a closed epic starts from trunk (the epic may have been squashed).
    app.runs.setBuildsOn(late.id, t.id);
    app.runs.shutdown();
  });

  test("a closed epic's leftover tickets and a builds-on child of its work start correctly", async () => {
    const { app, repoPath } = await setup([writes({ "a.txt": "A\n" }), writes({ "b.txt": "B\n" })]);
    const epic = app.runs.createEpic("demo", "Squashed");
    const one = await startTicket(app, "One", epic.id);
    await app.runs.approve(one.run.id);
    app.runs.closeEpic(epic.id);
    const child = await startTicket(app, "Child", null, { builds_on: one.ticket.id });
    expect(child.run.base_commit).toBe(await rev(repoPath, "main"));
    expect(logs(app, child.run.id).some((m) => m.includes(`whose epic ${epic.id} is closed: starting from main`))).toBe(true);
    // A ticket put in the epic before it closed (here: by hand in the store) can't start in it.
    const stray = app.tickets.create({ repo: "demo", title: "Stray", body: "", epic_id: epic.id });
    await expect(app.runs.start(stray.id)).rejects.toThrow(/which is closed\. Take it out/);
    app.runs.shutdown();
  });

  test("a vanished epic bookmark is a clear error once work has landed on it", async () => {
    const { app, repoPath } = await setup([writes({ "a.txt": "A\n" })]);
    const epic = app.runs.createEpic("demo", "Gone");
    const one = await startTicket(app, "One", epic.id);
    await app.runs.approve(one.run.id);
    await $`jj bookmark delete ${epic.bookmark}`.cwd(repoPath).quiet();
    const t = app.tickets.create({ repo: "demo", title: "Next", body: "", epic_id: epic.id });
    await expect(app.runs.start(t.id)).rejects.toThrow(new RegExp(`branch ${epic.bookmark} is gone, but #${one.ticket.id} landed on it`));
    app.runs.shutdown();
  });

  test("land: trunk repos refuse epic tickets", async () => {
    const { app } = await setup([], wf(GATE, "trunk"));
    const epic = app.runs.createEpic("demo", "Trunk");
    const t = app.tickets.create({ repo: "demo", title: "x", body: "", epic_id: epic.id });
    const run = await app.runs.start(t.id);
    await until(app, run.id, "failed");
    expect(app.store.getRun(run.id)!.error).toMatch(/epics need land: bookmark or push/);
    app.runs.shutdown();
  });

  test("a worker's follow-up joins its ticket's epic", async () => {
    const asks: FakeScript = async (c) => {
      const t = c.spec.tools!.find((x) => x.name === "request_work") as AcutisTool;
      await t.handler({ title: "Next step", need: "more", why: "plan", follow_up: true });
      await t.handler({ title: "Unrelated dep", need: "an API", why: "stubbed" });
      writeFileSync(join(c.spec.cwd, "a.txt"), "x\n");
      c.result();
      await c.nextMessage();
    };
    const { app } = await setup([asks]);
    const epic = app.runs.createEpic("demo", "Follow");
    const one = await startTicket(app, "One", epic.id);
    const filed = app.tickets.list({ repo: "demo" }).filter((t) => t.source === "work-request");
    expect(filed.find((t) => t.title === "Next step")!.epic_id).toBe(epic.id);
    expect(filed.find((t) => t.title === "Next step")!.builds_on).toBe(one.ticket.id);
    expect(filed.find((t) => t.title === "Unrelated dep")!.epic_id).toBeNull();
    app.runs.shutdown();
  });
});
