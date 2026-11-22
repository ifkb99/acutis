import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { AcutisTool } from "../src/core/types";
import { parseWorkflow } from "../src/core/workflow";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeControls, type FakeScript } from "./helpers";

const API = 'export function greet(name: string) {\n  return "hi " + name;\n}\n';
const APP = 'import { greet } from "./api";\nconsole.log(greet("x"));\n';
const workflow = (land: string, extra = "") =>
  `---\nland: ${land}\nmax_attempts: 1\ngates:\n  - test -f src/app.ts\ncontracts:\n  api:\n    files: ["src/api.ts"]\n    consumers: ["src/app.ts"]\n${extra}---\n`;

const tool = (c: FakeControls, name: string): AcutisTool => c.spec.tools!.find((t) => t.name === name)!;
const state = (app: ReturnType<typeof createApp>, id: number) => app.store.getRun(id)!.state;
const until = (app: ReturnType<typeof createApp>, id: number, s: string) => waitFor(() => state(app, id) === s, 10000);

/** Run A: renames the contract's function (B's ordinary check, `test -f src/app.ts`, can't see that). */
const renamesContract: FakeScript = async (c) => {
  writeFileSync(join(c.spec.cwd, "src/api.ts"), API.replace("greet", "hello"));
  c.result();
  await c.nextMessage();
};
/** Run B, first try: works on the consumer against the old contract. */
const usesOldContract: FakeScript = async (c) => {
  writeFileSync(join(c.spec.cwd, "src/app.ts"), `${APP}console.log(greet("y"));\n`);
  c.result();
  await c.nextMessage();
};

async function setup(scripts: FakeScript[], land = "trunk", extra = "", home = tempDir("acutis-home-")) {
  const repoPath = await makeRepo({ "src/api.ts": API, "src/app.ts": APP, ".acutis/workflow.md": workflow(land, extra) });
  const app = createApp({ home, port: 0 }, { runner: new FakeRunner(scripts) });
  app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
  return { app, repoPath, home, ticket: (t: string) => app.tickets.create({ repo: "demo", title: t, body: "" }) };
}

describe("contracts", () => {
  test("the workflow declares contracts; omitted consumers means everything depends on it", () => {
    const wf = parseWorkflow(workflow("trunk") + "", "t");
    expect(wf.contracts.api).toEqual({ files: ["src/api.ts"], consumers: ["src/app.ts"], check: undefined });
    const bare = parseWorkflow('---\ncontracts:\n  schema:\n    files: ["schema/**"]\n    check: "true"\n---\n', "t");
    expect(bare.contracts.schema).toMatchObject({ consumers: null, check: "true" });
    expect(() => parseWorkflow("---\ncontracts:\n  bad:\n    files: []\n---\n", "t")).toThrow(/files/);
  });

  test("the plan's scenario: A changes a contract B depends on; B is told, rebased, sent back to adapt and re-checked before it lands", async () => {
    let told = "";
    const adapts: FakeScript = async (c) => {
      told = c.spec.prompt;
      writeFileSync(join(c.spec.cwd, "src/app.ts"), 'import { hello } from "./api";\nconsole.log(hello("x"));\nconsole.log(hello("y"));\n');
      c.result();
      await c.nextMessage();
    };
    const { app, repoPath, ticket } = await setup([renamesContract, usesOldContract, adapts]);
    const a = await app.runs.start(ticket("Rename greet to hello").id);
    const b = await app.runs.start(ticket("Greet y too").id);
    await until(app, a.id, "awaiting_review");
    await until(app, b.id, "awaiting_review");
    expect(app.store.events(a.id).some((e) => e.kind === "contract.changed")).toBe(true);

    // A edits a contract: approving needs explicit acceptance.
    await expect(app.runs.approve(a.id)).rejects.toThrow(/changes the api contract/);
    expect(await app.runs.approve(a.id, { acceptContracts: true })).toEqual({ landed: true });
    expect(app.store.events(b.id).find((e) => e.kind === "contract.stale" && (e.data as any).phase === "notice")).toBeTruthy();

    // B depends on it: landing rebases B and hands it back to its agent with the contract's diff.
    const r = await app.runs.approve(b.id);
    expect(r.landed).toBe(false);
    expect(r.reason).toContain("api contract changed on main");
    await waitFor(() => told !== "", 10000);
    expect(told).toContain("Acutis rebased your workspace onto it");
    expect(told).toContain('+export function hello(name: string)');
    await until(app, b.id, "awaiting_review"); // adapted and checked again

    expect(await app.runs.approve(b.id)).toEqual({ landed: true });
    const trunkApp = await $`jj file show -r main src/app.ts`.cwd(repoPath).text();
    expect(trunkApp).toContain("hello(\"y\")");
    const trunkApi = await $`jj file show -r main src/api.ts`.cwd(repoPath).text();
    expect(trunkApi).toContain("function hello");
  });

  test("a run that doesn't touch the contract or its consumers lands without being sent back", async () => {
    const unrelated: FakeScript = async (c) => {
      writeFileSync(join(c.spec.cwd, "README.md"), "docs\n");
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([renamesContract, unrelated]);
    const a = await app.runs.start(ticket("rename").id);
    const b = await app.runs.start(ticket("readme").id);
    await until(app, a.id, "awaiting_review");
    await until(app, b.id, "awaiting_review");
    await app.runs.approve(a.id, { acceptContracts: true });
    expect(await app.runs.approve(b.id)).toEqual({ landed: true });
  });

  test("deleting a contract file counts as changing the contract", async () => {
    const deletes: FakeScript = async (c) => {
      rmSync(join(c.spec.cwd, "src/api.ts"));
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([deletes]);
    const a = await app.runs.start(ticket("drop api").id);
    await until(app, a.id, "awaiting_review");
    await expect(app.runs.approve(a.id)).rejects.toThrow(/changes the api contract/);
  });

  test("landing as a bookmark (no rebase), a contract that changed on trunk needs explicit acceptance", async () => {
    const { app, repoPath, ticket } = await setup([usesOldContract], "bookmark");
    const b = await app.runs.start(ticket("Greet y too").id);
    await until(app, b.id, "awaiting_review");
    // Someone changes the contract on trunk meanwhile.
    writeFileSync(join(repoPath, "src/api.ts"), API.replace("greet", "hello"));
    await $`jj commit -m rename && jj bookmark set main -r @-`.cwd(repoPath).quiet();
    await expect(app.runs.approve(b.id)).rejects.toThrow(/api contract changed on main since this run started.*bookmark/);
    expect((await app.runs.approve(b.id, { acceptContracts: true })).landed).toBe(true);
  });

  test("landing as a bookmark, a run that edits a contract still needs explicit acceptance", async () => {
    const { app, ticket } = await setup([renamesContract], "bookmark");
    const a = await app.runs.start(ticket("rename").id);
    await until(app, a.id, "awaiting_review");
    await expect(app.runs.approve(a.id)).rejects.toThrow(/changes the api contract/);
    expect((await app.runs.approve(a.id, { acceptContracts: true })).landed).toBe(true);
  });

  test("a daemon restart while B waits in review doesn't lose the send-back", async () => {
    let told = "";
    const adapts: FakeScript = async (c) => {
      told = c.spec.prompt;
      writeFileSync(join(c.spec.cwd, "src/app.ts"), 'import { hello } from "./api";\nconsole.log(hello("y"));\n');
      c.result();
      await c.nextMessage();
    };
    const { app, home, ticket } = await setup([renamesContract, usesOldContract]);
    const a = await app.runs.start(ticket("rename").id);
    const b = await app.runs.start(ticket("greet y").id);
    await until(app, a.id, "awaiting_review");
    await until(app, b.id, "awaiting_review");
    await app.runs.approve(a.id, { acceptContracts: true });
    app.runs.shutdown();
    const app2 = createApp({ home, port: 0 }, { runner: new FakeRunner([adapts]) });
    app2.runs.recover();
    expect((await app2.runs.approve(b.id)).landed).toBe(false);
    await waitFor(() => told.includes("The contract change"), 10000);
    await until(app2, b.id, "awaiting_review");
    expect((await app2.runs.approve(b.id)).landed).toBe(true);
    app2.runs.shutdown();
  });

  test("two approves fired together: one lands, the other is refused", async () => {
    const { app, ticket } = await setup([usesOldContract], "bookmark");
    const b = await app.runs.start(ticket("greet y").id);
    await until(app, b.id, "awaiting_review");
    const results = await Promise.allSettled([app.runs.approve(b.id), app.runs.approve(b.id)]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(results.find((r) => r.status === "rejected")!.reason.message).toMatch(/already being approved|can't approve/);
    expect(state(app, b.id)).toBe("done");
  });

  test("a contract trunk declares while the run waits: editing its files needs acceptance at landing", async () => {
    const editsFile: FakeScript = async (c) => {
      writeFileSync(join(c.spec.cwd, "src/util.ts"), "export const u = 2;\n");
      c.result();
      await c.nextMessage();
    };
    const { app, repoPath, ticket } = await setup([editsFile]);
    await Bun.write(join(repoPath, "src/util.ts"), "export const u = 1;\n");
    await $`jj commit -m util && jj bookmark set main -r @-`.cwd(repoPath).quiet();
    const r = await app.runs.start(ticket("util").id);
    await until(app, r.id, "awaiting_review");
    // Trunk now declares src/util.ts a contract.
    await Bun.write(join(repoPath, ".acutis/workflow.md"), workflow("trunk", '  util:\n    files: ["src/util.ts"]\n'));
    await $`jj commit -m declare && jj bookmark set main -r @-`.cwd(repoPath).quiet();
    await expect(app.runs.approve(r.id)).rejects.toThrow(/as declared on the new main/);
    expect(app.store.events(r.id).some((e) => e.kind === "contract.changed")).toBe(true); // the dashboard shows its box
    expect((await app.runs.approve(r.id, { acceptContracts: true })).landed).toBe(true);
  });

  test("a contract the run's base didn't have counts as changed when it touches its consumers", async () => {
    let told = "";
    const adapts: FakeScript = async (c) => {
      told = c.spec.prompt;
      c.result();
      await c.nextMessage();
    };
    const usesSchema: FakeScript = async (c) => {
      writeFileSync(join(c.spec.cwd, "src/app.ts"), `${APP}// uses the schema\n`);
      c.result();
      await c.nextMessage();
    };
    const { app, repoPath, ticket } = await setup([usesSchema, adapts]);
    const r = await app.runs.start(ticket("schema use").id);
    await until(app, r.id, "awaiting_review");
    await Bun.write(join(repoPath, "src/schema.ts"), "export type S = { a: number };\n");
    await Bun.write(join(repoPath, ".acutis/workflow.md"), workflow("trunk", '  schema:\n    files: ["src/schema.ts"]\n    consumers: ["src/app.ts"]\n'));
    await $`jj commit -m schema && jj bookmark set main -r @-`.cwd(repoPath).quiet();
    const out = await app.runs.approve(r.id);
    expect(out.landed).toBe(false);
    expect(out.reason).toContain("schema contract changed");
    await waitFor(() => told.includes("+export type S"), 10000);
  });

  test("the contract's check runs when a run touches its consumers", async () => {
    const { app, ticket } = await setup([usesOldContract], "bookmark", '    check: "grep -q greet src/app.ts && echo contract-ok"\n');
    const b = await app.runs.start(ticket("greet y").id);
    await until(app, b.id, "awaiting_review");
    const check = app.store.events(b.id).find((e) => e.kind === "gate.result" && (e.data as any).name === "contract api")!.data as any;
    expect(check).toMatchObject({ ok: true });
    expect(check.output).toContain("contract-ok");
  });

  test("request_contract_change files a decision with a held ticket; approving it is not standing policy", async () => {
    let out = "";
    let prompt = "";
    const requests: FakeScript = async (c) => {
      prompt = c.spec.systemAppend;
      out = (await tool(c, "request_contract_change").handler({ contract: "api", change: "greet takes a greeting word", why: "the ticket wants 'hello x'" })).text;
      c.result();
      await c.nextMessage();
    };
    let laterPrompt = "";
    const later: FakeScript = async (c) => {
      laterPrompt = c.spec.systemAppend;
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([requests, later], "bookmark");
    const r = await app.runs.start(ticket("greeting word").id);
    await until(app, r.id, "awaiting_review");
    expect(prompt).toContain("- api: src/api.ts (relied on by src/app.ts)");
    expect(prompt).toContain("request_contract_change");
    expect(out).toMatch(/Requested as decision #\d+, with ticket #\d+ waiting on it/);
    const [d] = app.runs.rankedDecisions("demo");
    expect(d).toMatchObject({ area: "contract", held: 1, question: "Change the api contract: greet takes a greeting word" });
    app.runs.decide(d!.id, { decision: "Approved: greet(word, name).", version: d!.version, keep: [d!.held_tickets[0]!.id] });
    expect(app.tickets.get(d!.held_tickets[0]!.id)!.status).toBe("todo");
    const r2 = await app.runs.start(ticket("something else").id);
    await until(app, r2.id, "awaiting_review");
    expect(laterPrompt).not.toContain("Approved: greet(word, name)."); // not a standing rule in every prompt
  });
});
