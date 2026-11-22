import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createApp } from "../src/app";
import { isRunnerTicket } from "../src/core/scouts";
import type { AcutisTool } from "../src/core/types";
import { answersMessage, draftView } from "../src/core/writer";
import { makeNotifier } from "../src/server/notify";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeControls, type FakeScript } from "./helpers";

const tool = (c: FakeControls, name: string): AcutisTool => {
  const t = c.spec.tools?.find((x) => x.name === name);
  if (!t) throw new Error(`no ${name} tool (have ${(c.spec.tools ?? []).map((x) => x.name).join(", ")})`);
  return t;
};
const call = async (c: FakeControls, name: string, args: Record<string, string | number | undefined>) => (await tool(c, name).handler(args)).text;

// Setup steps and checks the writer must not run (it only reads, and the operator is waiting).
const WF = "---\nland: bookmark\nsetup:\n  - echo setup-ran > setup.txt\ngates:\n  - name: tests\n    run: \"true\"\n---\n";

async function setup(scripts: FakeScript[], opts: { home?: string; costPollMs?: number; maxRuns?: number } = {}) {
  const repoPath = await makeRepo({ "src/app.ts": "export const app = 1;\n", ".acutis/workflow.md": WF });
  const runner = new FakeRunner(scripts);
  const home = opts.home ?? tempDir("acutis-home-");
  const app = createApp({ home, port: 0, maxRuns: opts.maxRuns }, { runner, costPollMs: opts.costPollMs });
  app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
  return { app, runner, home, repoPath };
}
const state = (app: ReturnType<typeof createApp>, id: number) => app.store.getRun(id)!.state;
const until = (app: ReturnType<typeof createApp>, id: number, s: string) => waitFor(() => state(app, id) === s, 10000);
const visibleTickets = (app: ReturnType<typeof createApp>) => app.tickets.list({ repo: "demo" }).filter((t) => !isRunnerTicket(t));

const BODY = "## Context\nsrc/app.ts\n\n## Acceptance criteria\n- [ ] it works";

describe("ticket writer", () => {
  test("reads, asks and drafts; runs no setup or checks; answers continue the same session; save makes one ticket", async () => {
    let first!: FakeControls;
    let firstSession = "";
    const writes: FakeScript = async (c) => {
      first = c;
      expect(await call(c, "ask_user", { question: "Group by repo or by state?", options: "repo | state", why: "decides the layout" })).toContain("Q1");
      await call(c, "ask_user", { question: "Keep the old list?" });
      expect(await call(c, "write_draft", { title: "Group runs by state", body: BODY })).toContain("v1");
      c.result();
      await c.nextMessage();
    };
    let resumedWith: string | undefined;
    let answer = "";
    const revises: FakeScript = async (c) => {
      resumedWith = c.spec.resumeSessionId;
      answer = c.spec.prompt;
      await call(c, "write_draft", { title: "Group runs by state, newest first", body: `${BODY}\n- [ ] newest first` });
      c.result();
      await c.nextMessage();
    };
    const { app } = await setup([writes, revises]);
    const run = await app.runs.startDraft("demo", "the run list is hard to scan; group it");
    expect(run.kind).toBe("writer");
    await until(app, run.id, "paused");
    firstSession = app.store.getRun(run.id)!.session_id!;

    // What the writer was given: a reading role, the request, the repo's checks as text; no edit tools.
    expect(first.spec.systemAppend).toContain("Acutis ticket writer");
    expect(first.spec.systemAppend).toContain("`true`");
    expect(first.spec.prompt).toContain("the run list is hard to scan; group it");
    expect(first.spec.deny).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit"]));
    const names = first.spec.tools!.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["ask_user", "write_draft", "list_work"]));
    expect(names).not.toContain("run_checks");
    expect(names).not.toContain("propose_ticket");

    const kinds = app.store.events(run.id).map((e) => e.kind);
    expect(kinds).not.toContain("setup.start");
    expect(kinds).not.toContain("gate.result");
    expect(kinds).toContain("writer.ready");
    expect(existsSync(`${app.store.getRun(run.id)!.workspace_path}/setup.txt`)).toBe(false);

    let view = app.runs.draft(run.id);
    expect(view.prompt).toBe("the run list is hard to scan; group it");
    expect(view.draft).toMatchObject({ title: "Group runs by state", version: 1 });
    expect(view.questions.map((q) => [q.n, q.options])).toEqual([[1, ["repo", "state"]], [2, []]]);

    // The draft's own ticket is hidden and can't be started; the run can't be approved.
    expect(visibleTickets(app)).toEqual([]);
    await expect(app.runs.start(run.ticket_id)).rejects.toThrow(/draft's own ticket/);
    await expect(app.runs.approve(run.id)).rejects.toThrow(/lands nothing/);

    // Answers: one kept as a repo decision; the unanswered one is flagged; the same session continues.
    await expect(app.runs.answerDraft(run.id, {})).rejects.toThrow(/answer a question or write a note/);
    await app.runs.answerDraft(run.id, { answers: [{ n: 1, answer: "By state.", decide: true }], note: "Newest first, please." });
    await waitFor(() => app.runs.draft(run.id).draft?.version === 2, 10000);
    await until(app, run.id, "paused");
    expect(resumedWith).toBe(firstSession);
    expect(answer).toContain("Q1: Group by repo or by state?\nA: By state.");
    expect(answer).toContain("Q2: Keep the old list?\nA: (not answered");
    expect(answer).toContain("Newest first, please.");
    expect(app.runs.listDecisions("demo", "decided").map((d) => d.decision)).toEqual(["Group by repo or by state? By state."]);
    view = app.runs.draft(run.id);
    expect(view.questions).toEqual([]);
    expect(view.rounds).toBe(1);

    // Save: the operator's edit wins, once only; the writer ends and its workspace goes.
    const ws = app.store.getRun(run.id)!.workspace_path!;
    const [a, b] = await Promise.allSettled([
      app.runs.saveDraft(run.id, { title: "Group the run list by state" }),
      app.runs.saveDraft(run.id, { title: "again" }),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    const saved = visibleTickets(app);
    expect(saved.map((t) => [t.title, t.status, t.source])).toEqual([["Group the run list by state", "todo", "writer"]]);
    expect(saved[0]!.body).toContain("- [ ] newest first");
    expect(state(app, run.id)).toBe("done");
    expect(app.runs.draft(run.id).saved).toEqual({ ticket_id: saved[0]!.id });
    expect(app.runs.listDrafts()).toEqual([]);
    await waitFor(() => !existsSync(ws), 10000);
    await expect(app.runs.answerDraft(run.id, { note: "more" })).rejects.toThrow();
  });

  test("a turn that saves no draft is reminded once; over the round's budget it stops and keeps the draft", async () => {
    const forgets: FakeScript = async (c) => {
      c.result();
      const nudge = await c.nextMessage();
      expect(nudge).toContain("write_draft");
      await call(c, "write_draft", { title: "T", body: "B" });
      c.result();
      await c.nextMessage();
    };
    const spends: FakeScript = async (c) => {
      await call(c, "write_draft", { title: "T2", body: "B2" });
      c.setTotal((c.spec.maxBudgetUsd ?? 0) + 0.1);
      c.emit({ kind: "agent.text", text: "still reading" });
      await c.nextMessage();
    };
    const { app } = await setup([forgets, spends], { costPollMs: 0 });
    const run = await app.runs.startDraft("demo", "add a dark mode");
    await until(app, run.id, "paused");
    expect(app.runs.draft(run.id).draft?.title).toBe("T");
    expect(app.store.events(run.id).filter((e) => e.kind === "user.message").length).toBe(1);

    await app.runs.answerDraft(run.id, { note: "Also the diff view." });
    await waitFor(() => app.store.events(run.id).some((e) => e.kind === "run.state" && /budget/.test((e.data as any).reason ?? "")), 10000);
    expect(state(app, run.id)).toBe("paused");
    expect(app.runs.draft(run.id).draft?.title).toBe("T2");
    expect(app.store.events(run.id).filter((e) => e.kind === "writer.ready").at(-1)!.data).toMatchObject({ budget: true, draft: true });
  });

  test("Stop pauses mid-turn and the draft can still be saved and started; Discard ends a draft for good", async () => {
    const slow: FakeScript = async (c) => {
      await call(c, "write_draft", { title: "Slow", body: "B" });
      await c.interrupted();
      c.result("error_during_execution");
      await c.nextMessage();
    };
    const worker: FakeScript = async (c) => {
      c.result();
      await c.nextMessage();
    };
    const other: FakeScript = async (c) => {
      await call(c, "write_draft", { title: "Other", body: "B" });
      c.result();
      await c.nextMessage();
    };
    const { app } = await setup([slow, worker, other]);
    const run = await app.runs.startDraft("demo", "slow one");
    await waitFor(() => app.runs.draft(run.id).draft, 10000);
    await expect(app.runs.saveDraft(run.id, {})).rejects.toThrow(/wait for the writer/);
    await app.runs.pause(run.id);
    await until(app, run.id, "paused");
    const { ticket, run: started } = await app.runs.saveDraft(run.id, { start: true });
    expect(started!.kind).toBe("work");
    expect(started!.ticket_id).toBe(ticket.id);
    await until(app, started!.id, "awaiting_review");

    const run2 = await app.runs.startDraft("demo", "another");
    await until(app, run2.id, "paused");
    const ws = app.store.getRun(run2.id)!.workspace_path!;
    await app.runs.closeDraft(run2.id);
    expect(state(app, run2.id)).toBe("cancelled");
    await waitFor(() => !existsSync(ws), 10000);
    await expect(app.runs.saveDraft(run2.id, {})).rejects.toThrow(/discarded/);
    expect(app.runs.listDrafts()).toEqual([]);
    expect(visibleTickets(app).map((t) => t.title)).toEqual(["Slow"]);
  });

  test("after a daemon restart, an answer resumes the writer's session where it left off", async () => {
    const asks: FakeScript = async (c) => {
      await call(c, "ask_user", { question: "Which page?" });
      await call(c, "write_draft", { title: "T", body: "B" });
      c.result();
      await c.nextMessage();
    };
    const { app, home, repoPath } = await setup([asks]);
    const run = await app.runs.startDraft("demo", "fix the page");
    await until(app, run.id, "paused");
    const session = app.store.getRun(run.id)!.session_id;
    app.runs.shutdown();

    let resumed: string | undefined;
    let prompt = "";
    const app2 = createApp(
      { home, port: 0 },
      {
        runner: new FakeRunner([
          async (c) => {
            resumed = c.spec.resumeSessionId;
            prompt = c.spec.prompt;
            await call(c, "write_draft", { title: "T", body: "B, for the runs page" });
            c.result();
            await c.nextMessage();
          },
        ]),
      },
    );
    app2.runs.recover();
    expect(app2.store.getRepo("demo")!.path).toBe(repoPath);
    expect(app2.runs.listDrafts().map((d) => [d.run.id, d.questions.length])).toEqual([[run.id, 1]]);
    await app2.runs.answerDraft(run.id, { answers: [{ n: 1, answer: "The runs page." }] });
    await waitFor(() => app2.runs.draft(run.id).draft?.version === 2, 10000);
    expect(resumed).toBe(session!);
    expect(prompt).toContain("A: The runs page.");
  });

  test("a writer that never drafts is reminded only once, then rests", async () => {
    const never: FakeScript = async (c) => {
      c.result();
      await c.nextMessage();
      c.result();
      await c.nextMessage();
    };
    const { app } = await setup([never]);
    const run = await app.runs.startDraft("demo", "something vague");
    await until(app, run.id, "paused");
    await Bun.sleep(100);
    expect(app.store.events(run.id).filter((e) => e.kind === "user.message").length).toBe(1);
    const why = app.store.events(run.id).filter((e) => e.kind === "run.state").at(-1)!.data as any;
    expect(why.reason).toBe("finished without a draft");
  });

  test("answering after Stop (the session still open) starts a new round: a fresh question limit", async () => {
    const replies: string[] = [];
    const asks: FakeScript = async (c) => {
      for (let i = 0; i < 6; i++) await call(c, "ask_user", { question: `q${i}?` });
      replies.push(await call(c, "ask_user", { question: "one too many?" }));
      await call(c, "write_draft", { title: "T", body: "B" });
      await c.interrupted();
      c.result("error_during_execution");
      await c.nextMessage();
      replies.push(await call(c, "ask_user", { question: "round two?" }));
      c.result();
      await c.nextMessage();
    };
    const { app, runner } = await setup([asks]);
    const run = await app.runs.startDraft("demo", "many questions");
    await waitFor(() => app.runs.draft(run.id).draft, 10000);
    await app.runs.pause(run.id);
    await until(app, run.id, "paused");
    await app.runs.answerDraft(run.id, { answers: [{ n: 1, answer: "yes" }] });
    await waitFor(() => replies.length === 2, 10000);
    expect(runner.sessions.length).toBe(1); // the same, still-open session
    expect(replies[0]).toContain("the limit");
    expect(replies[1]).toContain("Recorded as Q1");
  });

  test("a draft waits for a run slot like any run", async () => {
    let release!: () => void;
    const held: FakeScript = async (c) => {
      await new Promise<void>((r) => (release = r));
      c.result();
      await c.nextMessage();
    };
    const drafts: FakeScript = async (c) => {
      await call(c, "write_draft", { title: "T", body: "B" });
      c.result();
      await c.nextMessage();
    };
    const { app } = await setup([held, drafts], { maxRuns: 1 });
    const t = app.tickets.create({ repo: "demo", title: "busy", body: "" });
    const w = await app.runs.start(t.id);
    await until(app, w.id, "running");
    const run = await app.runs.startDraft("demo", "queued draft");
    expect(state(app, run.id)).toBe("queued");
    release();
    await until(app, run.id, "paused");
    expect(app.runs.draft(run.id).draft?.title).toBe("T");
  });
});

describe("ticket writer: pieces", () => {
  test("draftView rebuilds the draft, this round's questions and the save from events", () => {
    const ev = (kind: string, data: Record<string, unknown>) => ({ id: 0, run_id: 1, ts: "", kind, data });
    const v = draftView(1, "demo", [
      ev("writer.started", { prompt: "p" }),
      ev("writer.question", { n: 1, question: "old?", options: [] }),
      ev("writer.draft", { title: "a", body: "b", version: 1 }),
      ev("writer.answered", { answers: [] }),
      ev("writer.question", { n: 1, question: "new?", options: ["x", "y"], why: "w" }),
      ev("writer.draft", { title: "a2", body: "b2", version: 2 }),
    ] as any);
    expect(v).toMatchObject({ prompt: "p", rounds: 1, saved: null, draft: { title: "a2", version: 2 }, questions: [{ n: 1, question: "new?", options: ["x", "y"] }] });
  });

  test("answersMessage: answers, unanswered questions and the note", () => {
    const m = answersMessage([{ n: 1, question: "A?", options: [], why: "" }, { n: 2, question: "B?", options: [], why: "" }], new Map([[2, "yes"]]), "tighter");
    expect(m).toContain("Q1: A?\nA: (not answered");
    expect(m).toContain("Q2: B?\nA: yes");
    expect(m).toContain("note on the draft:\ntighter");
    expect(answersMessage([], new Map(), "just a note")).not.toContain("answered your questions");
  });

  test("a ready draft is notified at once", () => {
    const sent: string[] = [];
    const n = makeNotifier({ port: 1, sender: (title) => sent.push(title) });
    n.handle({ type: "event", event: { id: 1, run_id: 3, ts: "", kind: "writer.ready", data: { questions: 2, draft: true } } } as any);
    expect(sent).toEqual(["Acutis: ticket draft ready with 2 questions"]);
  });
});
