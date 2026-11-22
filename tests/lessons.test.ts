import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import { DRAFT_SYSTEM, PICK_SYSTEM, lessonKey, parseDraft, parsePick } from "../src/core/lessons";
import { scoutSystemPrompt } from "../src/core/scouts";
import type { AcutisTool, OneShotModel } from "../src/core/types";
import { parseWorkflow } from "../src/core/workflow";
import type { HubMessage } from "../src/core/hub";
import { makeNotifier } from "../src/server/notify";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeControls, type FakeScript } from "./helpers";

const tool = (c: FakeControls, name: string): AcutisTool => c.spec.tools!.find((t) => t.name === name)!;

/** A one-shot model whose answers are scripted per kind of request (pick vs draft). */
class FakeOneShot implements OneShotModel {
  calls: { system: string; prompt: string }[] = [];
  constructor(private answers: { pick?: () => string | Error; draft?: () => string | Error }) {}
  async ask(opts: { system: string; prompt: string }) {
    this.calls.push({ system: opts.system, prompt: opts.prompt });
    const f = opts.system === PICK_SYSTEM ? this.answers.pick : opts.system === DRAFT_SYSTEM ? this.answers.draft : undefined;
    const out = f ? f() : "NONE";
    if (out instanceof Error) return { text: "", costUsd: 0.001, error: out.message };
    return { text: out, costUsd: 0.002 };
  }
}

/** A worker that edits a file and reports at length (so the draft has something to read). */
const works =
  (report = "I changed src/a.ts. The harness tests only passed after I ran `npm run build -w engine` first, because the harness imports engine/dist."): FakeScript =>
  async (c) => {
    writeFileSync(join(c.spec.cwd, "src/a.ts"), `export const a = ${Math.random()};\n`);
    c.result("success", 0.01, report);
    await c.nextMessage();
  };

async function setup(scripts: FakeScript[], opts: { oneShot?: OneShotModel; lessons?: string; gates?: string } = {}) {
  const wf = `---\nland: bookmark\nmax_attempts: 2\n${opts.gates ?? ""}${opts.lessons ?? ""}---\n`;
  const repoPath = await makeRepo({ "src/a.ts": "export const a = 1;\n", ".acutis/workflow.md": wf });
  const runner = new FakeRunner(scripts);
  const app = createApp({ home: tempDir("acutis-home-"), port: 0 }, { runner, oneShot: opts.oneShot });
  app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
  const run = async (title: string, body = "") => {
    const r = await app.runs.start(app.tickets.create({ repo: "demo", title, body }).id);
    await waitFor(() => app.store.getRun(r.id)!.state === "awaiting_review", 10000);
    await app.runs.lessonDraftsIdle();
    return r;
  };
  return { app, runner, run };
}

describe("lessons: parsing", () => {
  test("workflow setting: on by default, false turns it off, bad values are refused", () => {
    expect(parseWorkflow("---\n---\n", "t").lessons).toEqual({ draft: true, budget_chars: 1500 });
    expect(parseWorkflow("---\nlessons: false\n---\n", "t").lessons).toBe(false);
    expect(parseWorkflow("---\nlessons:\n  draft: false\n  budget_chars: 600\n---\n", "t").lessons).toEqual({ draft: false, budget_chars: 600 });
    expect(() => parseWorkflow("---\nlessons:\n  budget_chars: 10\n---\n", "t")).toThrow(/budget_chars/);
    expect(() => parseWorkflow("---\nlessons:\n  drafts: true\n---\n", "t")).toThrow(/unknown lessons setting/);
  });

  test("draft and pick replies", () => {
    expect(parseDraft("NONE")).toBeNull();
    expect(parseDraft("LESSON: Build the engine before the harness tests.\nEVIDENCE: 'only passed after build'")).toEqual({
      lesson: "Build the engine before the harness tests.",
      evidence: "'only passed after build'",
    });
    expect(parseDraft("LESSON: short")).toBeNull();
    expect(parsePick("L5, L99, L5, L2", [2, 5, 7])).toEqual([5, 2]);
    expect(lessonKey("Build the Engine first!")).toBe(lessonKey("build the engine   first"));
  });

  test("scouts get approved lessons in their prompt too", () => {
    const p = scoutSystemPrompt({ type: "infrastructure", repo: "r", cwd: "/x", commit: "abc", focus: "", budget: 1, autoTickets: "never", sandboxed: true, library: false, decisions: [], lessons: [{ id: 4, text: "Use pnpm, not npm." }], trunkResults: "" });
    expect(p).toContain("- L4: Use pnpm, not npm.");
  });
});

describe("lessons in runs", () => {
  test("a worker's proposal stays out of prompts until approved; approved, it reaches the next run; rejected, it isn't proposed again", async () => {
    let reply = "";
    const proposes: FakeScript = async (c) => {
      reply = (await tool(c, "propose_lesson").handler({ lesson: "Build packages/engine before running the harness tests.", evidence: "harness failed: cannot find engine/dist" })).text;
      c.result();
      await c.nextMessage();
    };
    const prompts: string[] = [];
    const looks: FakeScript = async (c) => {
      prompts.push(c.spec.systemAppend);
      c.result();
      await c.nextMessage();
    };
    let again = "";
    const reproposes: FakeScript = async (c) => {
      again = (await tool(c, "propose_lesson").handler({ lesson: "Use tabs in Makefiles, never spaces at all.", evidence: "make: missing separator" })).text;
      c.result();
      await c.nextMessage();
    };
    const { app, run } = await setup([proposes, looks, looks, reproposes, looks]);
    const r1 = await run("first");
    expect(reply).toMatch(/Proposed as lesson L(\d+)/);
    const [l] = app.runs.listLessons("demo");
    expect(l).toMatchObject({ status: "proposed", source: "worker", run_id: r1.id });
    expect(app.store.events(r1.id).some((e) => e.kind === "lesson.proposed")).toBe(true);

    await run("second");
    expect(prompts[0]).toContain("propose_lesson");
    expect(prompts[0]).not.toContain("Build packages/engine"); // proposed only

    app.runs.approveLesson(l!.id, "Build packages/engine before the harness tests: the harness imports engine/dist.");
    const r3 = await run("third");
    expect(prompts[1]).toContain(`- L${l!.id}: Build packages/engine before the harness tests: the harness imports engine/dist.`);
    expect(app.store.events(r3.id).find((e) => e.kind === "lessons.given")!.data).toMatchObject({ of: 1, by: "all" });
    expect(app.store.getLesson(l!.id)!.uses).toBe(1);

    const rejected = app.store.addLesson({ repo: "demo", text: "Use tabs in Makefiles, never spaces at all.", text_key: lessonKey("Use tabs in Makefiles, never spaces at all."), status: "proposed", source: "worker" });
    app.runs.rejectLesson(rejected.id);
    await run("fourth");
    expect(again).toContain("the operator rejected it");
    expect(app.runs.listLessons("demo", "proposed")).toEqual([]);

    app.runs.retireLesson(l!.id);
    await run("fifth");
    expect(prompts[2]).not.toContain("Build packages/engine"); // retired
  });

  test("a resumed session keeps the lesson text its run started with", async () => {
    const systems: string[] = [];
    const sees: FakeScript = async (c) => {
      systems.push(c.spec.systemAppend);
      c.result();
      await c.nextMessage();
    };
    const { app, run } = await setup([sees, sees]);
    const l = app.runs.addLesson("demo", "Run the linter with --fix before committing anything.");
    const r = await run("t");
    app.runs.editLesson(l.id, "Never run the linter with --fix; report what it finds instead.");
    await app.runs.message(r.id, "one more thing");
    await waitFor(() => systems.length === 2, 10000);
    expect(systems[1]).toContain("Run the linter with --fix before committing anything.");
    expect(systems[1]).not.toContain("Never run the linter");
  });

  test("over the budget: the model picks among keyword matches (ids it invents are dropped); if it fails, keywords decide", async () => {
    const lessonsWf = "lessons:\n  budget_chars: 200\n";
    const texts = [
      "The harness tests need packages/engine built first (npm run build -w engine).",
      "Web UI snapshots are updated with npm run snap -w web, never by hand.",
      "Database migrations live in db/migrations and are numbered by date.",
      "The AI package's minimax tests are slow; run them with --bail locally.",
    ];
    const systems: string[] = [];
    const sees: FakeScript = async (c) => {
      systems.push(c.spec.systemAppend);
      c.result();
      await c.nextMessage();
    };
    let ids: number[] = [];
    const picker = new FakeOneShot({ pick: () => `L${ids[1]}, L999` });
    const a = await setup([sees], { oneShot: picker, lessons: lessonsWf });
    ids = texts.map((t) => a.app.runs.addLesson("demo", t).id);
    const r = await a.run("Fix web snapshot test", "The web snapshots are stale.");
    expect(a.app.store.events(r.id).find((e) => e.kind === "lessons.given")!.data).toMatchObject({ by: "model", lessons: [{ id: ids[1] }] });
    expect(systems[0]).toContain("Web UI snapshots");
    expect(systems[0]).not.toContain("harness tests need");

    const garbled = new FakeOneShot({ pick: () => "I think the second and fourth ones." });
    const g = await setup([sees], { oneShot: garbled, lessons: lessonsWf });
    texts.forEach((t) => g.app.runs.addLesson("demo", t));
    const rg = await g.run("Harness tests fail", "the harness can't find the engine build");
    expect((g.app.store.events(rg.id).find((e) => e.kind === "lessons.given")!.data as any).by).toBe("keywords");

    const failing = new FakeOneShot({ pick: () => new Error("overloaded") });
    const b = await setup([sees], { oneShot: failing, lessons: lessonsWf });
    texts.forEach((t) => b.app.runs.addLesson("demo", t));
    const r2 = await b.run("Harness tests fail", "the harness can't find the engine build");
    const given = b.app.store.events(r2.id).find((e) => e.kind === "lessons.given")!.data as any;
    expect(given.by).toBe("keywords");
    expect(given.lessons[0].text).toContain("harness tests need packages/engine");
  });

  test("after review, the draft model reads the report (and earlier check failures) and proposes one lesson", async () => {
    const drafter = new FakeOneShot({ draft: () => "LESSON: Build packages/engine before running the harness tests.\nEVIDENCE: 'only passed after I ran npm run build -w engine first'" });
    let attempt = 0;
    const flaky: FakeScript = async (c) => {
      writeFileSync(join(c.spec.cwd, "src/a.ts"), "export const a = 2;\n");
      c.result("success", 0.01, "first try");
      await c.nextMessage(); // the check failure
      attempt++;
      writeFileSync(join(c.spec.cwd, "ok"), "1");
      c.result("success", 0.02, "I changed src/a.ts. The harness tests only passed after I ran `npm run build -w engine` first, because the harness imports engine/dist.");
      await c.nextMessage();
    };
    const { app, run } = await setup([flaky], { oneShot: drafter, gates: "gates:\n  - name: needs ok\n    run: test -f ok\n" });
    const r = await run("feature");
    expect(attempt).toBe(1);
    const draft = drafter.calls.find((c) => c.system === DRAFT_SYSTEM)!;
    expect(draft.prompt).toContain("only passed after I ran");
    expect(draft.prompt).toContain("test -f ok"); // the earlier failure
    const [l] = app.runs.listLessons("demo");
    expect(l).toMatchObject({ status: "proposed", source: "draft", run_id: r.id, text: "Build packages/engine before running the harness tests." });
    expect(app.store.getRun(r.id)!.state).toBe("awaiting_review");
  });

  test("drafted once per run (a send-back returning to review doesn't draft again), and not while checks still fail", async () => {
    const drafter = new FakeOneShot({ draft: () => "NONE" });
    const resumed: FakeScript = async (c) => {
      c.result("success", 0.02, "Addressed the note; same report again, long enough to be worth reading for a lesson.");
      await c.nextMessage();
    };
    const a = await setup([works(), resumed], { oneShot: drafter });
    const r = await a.run("t");
    await a.app.runs.message(r.id, "one more thing");
    await waitFor(() => a.app.store.events(r.id).filter((e) => e.kind === "agent.result").length === 2, 10000);
    await waitFor(() => a.app.store.getRun(r.id)!.state === "awaiting_review", 10000);
    await a.app.runs.lessonDraftsIdle();
    expect(drafter.calls.filter((c) => c.system === DRAFT_SYSTEM).length).toBe(1);

    const failing = new FakeOneShot({ draft: () => "NONE" });
    const stubborn: FakeScript = async (c) => {
      writeFileSync(join(c.spec.cwd, "src/a.ts"), "export const a = 4;\n");
      c.result("success", 0.01, "Tried once; a long enough report for the drafter to have something to read here.");
      await c.nextMessage(); // the check failure
      c.result("success", 0.02, "Tried again; the check still fails, and this report is long enough to read too.");
      await c.nextMessage();
    };
    const b = await setup([stubborn], { oneShot: failing, gates: "gates:\n  - \"false\"\n" });
    const rb = await b.run("t");
    expect(b.app.store.getRun(rb.id)!.gates_ok).toBe(0);
    expect(failing.calls).toEqual([]);
  }, 30000);

  test("NONE, a failing model, or draft: false leave the run alone and propose nothing", async () => {
    const none = new FakeOneShot({ draft: () => "NONE" });
    const a = await setup([works()], { oneShot: none });
    await a.run("t");
    expect(none.calls.filter((c) => c.system === DRAFT_SYSTEM).length).toBe(1);
    expect(a.app.runs.listLessons("demo")).toEqual([]);

    const broken = new FakeOneShot({ draft: () => new Error("boom") });
    const b = await setup([works()], { oneShot: broken });
    const r = await b.run("t");
    expect(b.app.store.getRun(r.id)!.state).toBe("awaiting_review");
    expect(b.app.store.events(r.id).some((e) => e.kind === "system.log" && String((e.data as any).msg).includes("Lesson draft skipped"))).toBe(true);

    const off = new FakeOneShot({ draft: () => "LESSON: should never be asked for at all here.\nEVIDENCE: x" });
    const c = await setup([works()], { oneShot: off, lessons: "lessons:\n  draft: false\n" });
    await c.run("t");
    expect(off.calls).toEqual([]);
  });

  test("lessons: false offers no tool and adds nothing to the prompt", async () => {
    let tools: string[] = [];
    let sys = "";
    const sees: FakeScript = async (c) => {
      tools = c.spec.tools!.map((t) => t.name);
      sys = c.spec.systemAppend;
      c.result();
      await c.nextMessage();
    };
    const { app, run } = await setup([sees], { lessons: "lessons: false\n" });
    app.runs.addLesson("demo", "This lesson is approved but lessons are off for the repo.");
    await run("t");
    expect(tools).not.toContain("propose_lesson");
    expect(sys).not.toContain("Lessons from earlier runs");
    expect(sys).not.toContain("propose_lesson");
  });

  test("operator side: duplicates, rewording clashes, wrong states", async () => {
    const { app } = await setup([]);
    const a = app.runs.addLesson("demo", "Use pnpm for installs in this repo, never npm.");
    expect(app.runs.addLesson("demo", "use PNPM for installs in this repo — never npm!").id).toBe(a.id);
    const p = app.store.addLesson({ repo: "demo", text: "Something proposed by an agent here.", text_key: lessonKey("Something proposed by an agent here."), status: "proposed", source: "worker" });
    expect(() => app.runs.approveLesson(p.id, "Use pnpm for installs in this repo, never npm.")).toThrow(/already lesson L/);
    expect(() => app.runs.retireLesson(p.id)).toThrow(/not approved/);
    expect(() => app.runs.approveLesson(a.id)).toThrow(/not proposed/);
    expect(() => app.runs.addLesson("nope", "A lesson for a repo that isn't there.")).toThrow(/not registered/);
  });
});

test("proposed lessons are batched into the operator's notification", async () => {
  const sent: string[] = [];
  const n = makeNotifier({ port: 1, batchQuietMs: 40, batchMaxMs: 200, sender: (title) => sent.push(title) });
  const ev = (kind: string, data: Record<string, unknown>) => ({ type: "event", event: { id: 0, run_id: 1, ts: "", kind, data } }) as unknown as HubMessage;
  n.handle(ev("lesson.proposed", { id: 1, text: "x", status: "proposed" }));
  n.handle(ev("scout.decision", { id: 2, question: "Which?" }));
  n.handle(ev("scout.ticket", { id: 3, status: "proposed" }));
  await waitFor(() => sent.length > 0, 2000);
  expect(sent).toEqual(["Acutis: 1 question, 1 proposed ticket and 1 proposed lesson waiting for you"]);
});

describe("lessons expire when their files change", () => {
  test("paths are pulled from the lesson's words: exact files, path suffixes, directories; not versions or URLs", async () => {
    const { extractLessonPaths } = await import("../src/core/lessons");
    const files = ["packages/harness/package.json", "packages/harness/tests/smoke.ts", "packages/engine/src/index.ts", "README.md"];
    expect(
      extractLessonPaths("Run `node --import tsx tests/smoke.ts`; packages/harness/package.json lacks tsx; see packages/engine, v1.2.3 and https://x.io/a/b", files).sort(),
    ).toEqual(["packages/engine/**", "packages/harness/package.json", "packages/harness/tests/smoke.ts"]);
    expect(extractLessonPaths("Use pnpm, never npm.", files)).toEqual([]);
  });

  async function trunkSetup(scripts: FakeScript[]) {
    const { $ } = await import("bun");
    const repoPath = await makeRepo({
      "packages/harness/package.json": '{"name": "harness"}\n',
      "src/a.ts": "export const a = 1;\n",
      ".acutis/workflow.md": "---\nland: bookmark\nmax_attempts: 1\n---\n",
    });
    const app = createApp({ home: tempDir("acutis-home-"), port: 0 }, { runner: new FakeRunner(scripts) });
    app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
    const commit = async (file: string, text: string) => {
      await Bun.write(join(repoPath, file), text);
      await $`jj commit -m ${file} && jj bookmark set main -r @-`.cwd(repoPath).quiet();
    };
    const run = async () => {
      const r = await app.runs.start(app.tickets.create({ repo: "demo", title: "t", body: "" }).id);
      await waitFor(() => app.store.getRun(r.id)!.state === "awaiting_review", 10000);
      return r;
    };
    return { app, commit, run };
  }

  test("trunk changes a lesson's file: it's flagged, held back from prompts, and given again once confirmed", async () => {
    const systems: string[] = [];
    const sees: FakeScript = async (c) => {
      systems.push(c.spec.systemAppend);
      c.result();
      await c.nextMessage();
    };
    const { app, commit, run } = await trunkSetup([sees, sees, sees, sees]);
    const l = app.runs.addLesson("demo", "packages/harness/package.json doesn't declare tsx; use the hoisted one from packages/ai.");
    await run();
    expect(systems[0]).toContain(`- L${l.id}:`);
    expect(app.store.getLesson(l.id)).toMatchObject({ paths: "packages/harness/package.json", stale: null });
    expect(app.store.getLesson(l.id)!.seen_commit).toBeTruthy();

    await commit("src/a.ts", "export const a = 2;\n"); // not the lesson's file
    await run();
    expect(systems[1]).toContain(`- L${l.id}:`);

    await commit("packages/harness/package.json", '{"name": "harness", "devDependencies": {"tsx": "^4"}}\n');
    const r3 = await run();
    expect(systems[2]).not.toContain(`- L${l.id}:`);
    expect(JSON.parse(app.store.getLesson(l.id)!.stale!).paths).toEqual(["packages/harness/package.json"]);
    expect(app.store.events(r3.id).find((e) => e.kind === "lesson.stale")!.data).toMatchObject({ id: l.id });

    app.runs.confirmLesson(l.id);
    await run();
    expect(systems[3]).toContain(`- L${l.id}:`);
    expect(app.store.getLesson(l.id)!.stale).toBeNull();
  });

  test("proposers can name paths; the operator can set them, or clear them so a lesson never expires", async () => {
    const proposes: FakeScript = async (c) => {
      await tool(c, "propose_lesson").handler({ lesson: "The harness manifest needs a tsconfig before it builds.", evidence: "tsc prints help", paths: "packages/harness/package.json, ./packages/harness/tsconfig.json, ../etc/passwd" });
      c.result();
      await c.nextMessage();
    };
    const sees: FakeScript = async (c) => {
      c.result();
      await c.nextMessage();
    };
    const { app, commit, run } = await trunkSetup([proposes, sees, sees]);
    await run();
    const [p] = app.runs.listLessons("demo", "proposed");
    expect(p!.paths).toBe("packages/harness/package.json,packages/harness/tsconfig.json");
    app.runs.approveLesson(p!.id);
    app.runs.setLessonPaths(p!.id, "");
    await run();
    await commit("packages/harness/package.json", "{}\n");
    await run();
    expect(app.store.getLesson(p!.id)!.stale).toBeNull();
  });
});

test("lessons to recheck are batched into the operator's notification", async () => {
  const sent: string[] = [];
  const n = makeNotifier({ port: 1, batchQuietMs: 30, batchMaxMs: 200, sender: (title) => sent.push(title) });
  n.handle({ type: "event", event: { id: 0, run_id: 1, ts: "", kind: "lesson.stale", data: { id: 1, paths: ["a"] } } } as unknown as HubMessage);
  await waitFor(() => sent.length > 0, 2000);
  expect(sent).toEqual(["Acutis: 1 lesson to recheck waiting for you"]);
});
