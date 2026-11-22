import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import { parseWorkflow } from "../src/core/workflow";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeScript } from "./helpers";

const wf = (opts: { debounce?: number; cap?: number; land?: string } = {}) =>
  `---\nland: ${opts.land ?? "trunk"}\nmax_attempts: 1\nscouts:\n  trigger_debounce_min: ${opts.debounce ?? 0}\n  trigger_daily_cap: ${opts.cap ?? 3}\n  infrastructure:\n    triggers: ["package-lock.json", ".github/**"]\n---\n`;

/** A scout that records its brief and finishes. */
const briefs: string[] = [];
const scout: FakeScript = async (c) => {
  briefs.push(c.spec.prompt);
  c.result();
  await c.nextMessage();
};

async function setup(scripts: FakeScript[], opts: Parameters<typeof wf>[0] = {}) {
  const repoPath = await makeRepo({ "README.md": "# r\n", "package-lock.json": "{}\n", ".acutis/workflow.md": wf(opts) });
  const app = createApp({ home: tempDir("acutis-home-"), port: 0 }, { runner: new FakeRunner(scripts) });
  app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
  const commit = async (file: string, text: string) => {
    await Bun.write(join(repoPath, file), text);
    await $`jj commit -m ${`edit ${file}`} && jj bookmark set main -r @-`.cwd(repoPath).quiet();
  };
  const scoutRuns = () => app.store.listRuns().filter((r) => r.kind === "scout");
  return { app, repoPath, commit, scoutRuns };
}

describe("trunk triggers", () => {
  test("workflow: triggers per scout, debounce and daily cap", () => {
    const w = parseWorkflow(wf({ debounce: 5, cap: 2 }), "t");
    expect(w.scouts && w.scouts.types.infrastructure!.triggers).toEqual(["package-lock.json", ".github/**"]);
    expect(w.scouts && [w.scouts.trigger_debounce_min, w.scouts.trigger_daily_cap]).toEqual([5, 2]);
    expect(parseWorkflow("---\n---\n", "t").scouts).toMatchObject({ trigger_debounce_min: 10, trigger_daily_cap: 3 });
    expect(() => parseWorkflow("---\nscouts:\n  tests:\n    triggers: lockfile\n---\n", "t")).toThrow(/list of path globs/);
  });

  test("the first look records trunk; an unwatched change wakes nothing; a watched one wakes the scout, which is told what changed", async () => {
    briefs.length = 0;
    const { app, commit, scoutRuns } = await setup([scout]);
    expect(await app.runs.checkTriggers("demo")).toEqual([]);
    const first = app.store.getTrunkSeen("demo");
    expect(first).toBeTruthy();

    await commit("README.md", "# r\nmore\n");
    expect(await app.runs.checkTriggers("demo")).toEqual([]);
    expect(app.store.getTrunkSeen("demo")).not.toBe(first); // dealt with: nothing watched it
    expect(scoutRuns()).toEqual([]);

    await commit("package-lock.json", '{"lockfileVersion": 3}\n');
    const out = await app.runs.checkTriggers("demo");
    expect(out).toMatchObject([{ scout: "infrastructure", outcome: "started", paths: ["package-lock.json"] }]);
    const [run] = scoutRuns();
    expect(JSON.parse(run!.woken_by!)).toMatchObject({ paths: ["package-lock.json"] });
    await waitFor(() => app.store.getRun(run!.id)!.state === "done", 10000);
    expect(briefs[0]).toContain("You were woken because trunk changed paths this repo asks you to watch");
    expect(briefs[0]).toContain("- package-lock.json");
    expect(app.store.events(run!.id).some((e) => e.kind === "scout.triggered")).toBe(true);
    expect(await app.runs.checkTriggers("demo")).toEqual([]); // seen advanced
  });

  test("a burst of landings within the debounce wakes the scout once; nothing is marked seen until then", async () => {
    briefs.length = 0;
    const { app, commit, scoutRuns } = await setup([scout, scout], { debounce: 0.01 }); // 600ms
    await app.runs.checkTriggers("demo");
    const before = app.store.getTrunkSeen("demo");
    await commit("package-lock.json", "{1}\n");
    await app.runs.checkTriggers("demo");
    await commit(".github/workflows/ci.yml", "on: push\n");
    await app.runs.checkTriggers("demo");
    expect(app.store.getTrunkSeen("demo")).toBe(before); // pending: a restart would find it again
    expect(scoutRuns()).toEqual([]);
    await waitFor(() => scoutRuns().length > 0, 5000);
    await Bun.sleep(800);
    expect(scoutRuns().length).toBe(1);
    await waitFor(() => briefs.length > 0, 10000);
    expect(briefs[0]).toContain("- package-lock.json");
    expect(briefs[0]).toContain("- .github/workflows/ci.yml");
  });

  test("two checks at once (a landing and the timer) wake one scout", async () => {
    const { app, commit, scoutRuns } = await setup([scout, scout]);
    await app.runs.checkTriggers("demo");
    await commit("package-lock.json", "{2}\n");
    const [a, b] = await Promise.all([app.runs.checkTriggers("demo"), app.runs.checkTriggers("demo")]);
    expect([...a, ...b].map((o) => o.outcome)).toEqual(["started"]); // the second check sees it dealt with, not "busy"
    expect(scoutRuns().length).toBe(1);
  });

  test("the daily cap: past it, the change is noted and not acted on", async () => {
    const { app, commit, scoutRuns } = await setup([scout, scout], { cap: 1 });
    await app.runs.checkTriggers("demo");
    await commit("package-lock.json", "{3}\n");
    await app.runs.checkTriggers("demo");
    await waitFor(() => scoutRuns()[0] && app.store.getRun(scoutRuns()[0]!.id)!.state === "done", 10000);
    await commit("package-lock.json", "{4}\n");
    expect(await app.runs.checkTriggers("demo")).toMatchObject([{ scout: "infrastructure", outcome: "capped" }]);
    expect(scoutRuns().length).toBe(1);
    expect(await app.runs.checkTriggers("demo")).toEqual([]); // not retried forever
  });

  test("a scout already running: the change stays unseen and wakes it again once it's free", async () => {
    let release!: () => void;
    const held: FakeScript = async (c) => {
      await new Promise<void>((r) => (release = r));
      c.result();
      await c.nextMessage();
    };
    const { app, commit, scoutRuns } = await setup([held, scout]);
    await app.runs.checkTriggers("demo");
    const r1 = await app.runs.startScout("demo", "infrastructure"); // started by hand
    await waitFor(() => app.store.getRun(r1.id)!.state === "running", 10000);
    await commit("package-lock.json", "{5}\n");
    expect(await app.runs.checkTriggers("demo")).toMatchObject([{ outcome: "busy" }]);
    release();
    await waitFor(() => app.store.getRun(r1.id)!.state === "done", 10000);
    expect(await app.runs.checkTriggers("demo")).toMatchObject([{ outcome: "started" }]);
    expect(scoutRuns().length).toBe(2);
  });

  test("a trunk move made with git outside Acutis (a pull, a merge) is picked up", async () => {
    const { app, repoPath, scoutRuns } = await setup([scout]);
    await app.runs.checkTriggers("demo");
    // A plain git commit on main in the colocated repo; jj hasn't imported it yet.
    await $`git checkout -q main`.cwd(repoPath).quiet();
    await Bun.write(join(repoPath, "package-lock.json"), '{"from": "git"}\n');
    await $`git -c user.name=t -c user.email=t@example.invalid commit -qam ${"bump lock via git"}`.cwd(repoPath).quiet();
    expect(await app.runs.checkTriggers("demo")).toMatchObject([{ scout: "infrastructure", outcome: "started", paths: ["package-lock.json"] }]);
    expect(scoutRuns().length).toBe(1);
  });

  test("a trunk landing that touches a watched path wakes the scout", async () => {
    const editsLock: FakeScript = async (c) => {
      writeFileSync(join(c.spec.cwd, "package-lock.json"), '{"bumped": true}\n');
      c.result();
      await c.nextMessage();
    };
    const { app, scoutRuns } = await setup([editsLock, scout]);
    await app.runs.checkTriggers("demo");
    const r = await app.runs.start(app.tickets.create({ repo: "demo", title: "bump deps", body: "" }).id);
    await waitFor(() => app.store.getRun(r.id)!.state === "awaiting_review", 10000);
    expect((await app.runs.approve(r.id)).landed).toBe(true);
    await waitFor(() => scoutRuns().length === 1, 10000);
    expect(JSON.parse(scoutRuns()[0]!.woken_by!).paths).toEqual(["package-lock.json"]);
  });
});
