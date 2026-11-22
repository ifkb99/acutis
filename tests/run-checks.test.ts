import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import { probeSandbox } from "../src/providers/agent/claude-sdk";
import { BwrapSandbox } from "../src/providers/sandbox/bwrap";
import type { AcutisTool } from "../src/core/types";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeControls, type FakeScript } from "./helpers";

const tool = (c: FakeControls, name: string): AcutisTool | undefined => c.spec.tools!.find((t) => t.name === name);

async function setup(scripts: FakeScript[], gates: string, sandboxed = false) {
  const home = tempDir("acutis-home-");
  const repoPath = await makeRepo({ "src/a.ts": "export const a = 1;\n", ".acutis/workflow.md": `---\nland: bookmark\nmax_attempts: 1\n${gates}---\n` });
  const app = createApp({ home, port: 0 }, { runner: new FakeRunner(scripts), commandSandbox: sandboxed ? new BwrapSandbox({ hide: [home] }) : undefined });
  app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
  const run = async () => {
    const r = await app.runs.start(app.tickets.create({ repo: "demo", title: "t", body: "" }).id);
    await waitFor(() => app.store.getRun(r.id)!.state === "awaiting_review", 20000);
    return r;
  };
  return { app, run };
}

describe("run_checks", () => {
  test("runs the declared checks (all, or by name) as the worker's own results; verification still runs after", async () => {
    const outs: string[] = [];
    let prompt = "";
    const checks: FakeScript = async (c) => {
      prompt = c.spec.systemAppend;
      const t = tool(c, "run_checks")!;
      outs.push((await t.handler({})).text);
      writeFileSync(join(c.spec.cwd, "ok"), "1");
      outs.push((await t.handler({ names: "needs ok" })).text);
      outs.push((await t.handler({ names: "nothing-like-this" })).text);
      c.result();
      await c.nextMessage();
    };
    const { app, run } = await setup([checks], 'gates:\n  - name: needs ok\n    run: test -f ok\n  - echo fine\n');
    const r = await run();
    expect(prompt).toContain("mcp__acutis__run_checks");
    expect(outs[0]).toContain("FAIL (exit 1)  needs ok");
    expect(outs[0]).toContain("PASS  echo fine");
    expect(outs[1]).toMatch(/^PASS {2}needs ok/);
    expect(outs[1]).not.toContain("echo fine");
    expect(outs[2]).toContain("No check matches");
    const ev = app.store.events(r.id);
    expect(ev.filter((e) => e.kind === "worker-check.result").length).toBe(3);
    // Acutis's own verification is separate: both checks again, as gate results, and they pass.
    expect(ev.filter((e) => e.kind === "gate.result").length).toBe(2);
    expect(app.store.getRun(r.id)!.gates_ok).toBe(1);
  });

  test("not offered when the repo has no command checks; capped per run", async () => {
    let names: string[] = [];
    const looks: FakeScript = async (c) => {
      names = c.spec.tools!.map((t) => t.name);
      c.result();
      await c.nextMessage();
    };
    const a = await setup([looks], "");
    await a.run();
    expect(names).not.toContain("run_checks");

    const outs: string[] = [];
    const many: FakeScript = async (c) => {
      for (let i = 0; i < 12; i++) outs.push((await tool(c, "run_checks")!.handler({})).text);
      c.result();
      await c.nextMessage();
    };
    const b = await setup([many], "gates:\n  - \"true\"\n  - echo two\n");
    await b.run();
    expect(outs[9]).toContain("PASS");
    expect(outs[10]).toContain("limit 20");
  }, 30000);

  test.skipIf(!probeSandbox().ok)("in Acutis's check sandbox, a check that opens a Unix socket works", async () => {
    let out = "";
    const checks: FakeScript = async (c) => {
      out = (await tool(c, "run_checks")!.handler({})).text;
      c.result();
      await c.nextMessage();
    };
    const sock = `python3 -c "import socket,os; s=socket.socket(socket.AF_UNIX); s.bind('/tmp/t.sock'); s.listen(1); print('socket ok')"`;
    const { run } = await setup([checks], `gates:\n  - name: socket\n    run: ${JSON.stringify(sock)}\n`, true);
    await run();
    expect(out).toMatch(/^PASS {2}socket/);
  }, 30000);
});
