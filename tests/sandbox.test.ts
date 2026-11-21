import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { workerEnv } from "../src/core/env";
import { probeSandbox } from "../src/providers/agent/claude-sdk";
import { BwrapSandbox } from "../src/providers/sandbox/bwrap";
import { tempDir } from "./helpers";

test("worker commands get the daemon's environment minus credentials", () => {
  const env = workerEnv(
    { CI: "1" },
    { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", GITHUB_TOKEN: "t", SSH_AUTH_SOCK: "/s", MY_SECRET: "x", AWS_PROFILE: "p", XAUTHORITY: "/x", LANG: "C" },
  );
  expect(env).toEqual({ PATH: "/bin", HOME: "/h", XAUTHORITY: "/x", LANG: "C", CI: "1" });
});

const usable = probeSandbox().ok;

describe.skipIf(!usable)("BwrapSandbox (real bubblewrap)", () => {
  const home = tempDir("acutis-sbx-home-");
  const acutisHome = `${home}/acutis`;
  const ws = `${acutisHome}/workspaces/repo/ws1`;
  mkdirSync(ws, { recursive: true });
  mkdirSync(`${home}/.ssh`);
  writeFileSync(`${home}/.ssh/id_test`, "PRIVATE");
  writeFileSync(`${acutisHome}/acutis.db`, "DB");
  writeFileSync(`${ws}/hello.txt`, "hi\n");
  const sb = new BwrapSandbox({ hide: [acutisHome], home });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("api") });
  afterAll(() => server.stop(true));

  async function run(cmd: string, network: "none" | "host" = "none") {
    const p = Bun.spawn(sb.wrap(cmd, ws, { network }), { cwd: ws, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: out.trim(), err: err.trim() };
  }

  test("the workspace is readable and writable; its parent data dir and credentials are hidden", async () => {
    const r = await run(`cat hello.txt; echo new > made.txt; ls ${acutisHome}; ls ${home}/.ssh | wc -l; cat ${acutisHome}/acutis.db 2>&1 | head -c 0; test -e ${acutisHome}/acutis.db && echo db-visible || echo db-hidden`);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual(["hi", "workspaces", "0", "db-hidden"]);
    expect(await Bun.file(`${ws}/made.txt`).text()).toBe("new\n");
  });

  test("writes outside the workspace fail; /tmp is private", async () => {
    const marker = `/tmp/acutis-sbx-test-${process.pid}`;
    // A real host path (the temp "home" above lives under /tmp, which is private and writable inside).
    const outside = `${import.meta.dir}/escaped-${process.pid}`;
    const r = await run(`touch ${outside} 2>&1; touch ${marker} && echo tmp-ok`);
    expect(r.out).toContain("Read-only file system");
    expect(r.out).toContain("tmp-ok");
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  test('network "none" cannot reach localhost services (e.g. the Acutis API); "host" can', async () => {
    const url = `http://127.0.0.1:${server.port}/`;
    const fetchCmd = `bun -e 'fetch(${JSON.stringify(url)}).then(r => r.text()).then(t => console.log(t), () => console.log("unreachable"))'`;
    expect((await run(fetchCmd, "none")).out).toBe("unreachable");
    expect((await run(fetchCmd, "host")).out).toBe("api");
  });

  test("killing the process group takes everything inside the sandbox", async () => {
    const tag = `30${process.pid % 1000}.5`; // a sleep duration unique to this test, to find it on the host
    const p = Bun.spawn(sb.wrap(`sleep ${tag} & sleep ${tag} & wait`, ws, { network: "none" }), { cwd: ws });
    const alive = () => Bun.spawnSync(["pgrep", "-f", `^sleep ${tag}$`]).stdout.toString().trim().split("\n").filter(Boolean).length;
    for (let i = 0; i < 20 && alive() < 2; i++) await Bun.sleep(100);
    expect(alive()).toBe(2);
    process.kill(-p.pid, "SIGKILL");
    await p.exited;
    for (let i = 0; i < 20 && alive() > 0; i++) await Bun.sleep(100);
    expect(alive()).toBe(0);
  });
});

describe.skipIf(!usable)("gates run worker-written code inside the sandbox", () => {
  test("a test file the worker wrote can't reach the API, write outside, or see credentials", async () => {
    const { createApp } = await import("../src/app");
    const { FakeRunner, makeRepo, waitFor } = await import("./helpers");
    let apiHits = 0;
    const api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => (apiHits++, new Response("approved")) });
    const outside = `${import.meta.dir}/escaped-gate-${process.pid}`;
    const evil = `
      const out = [];
      try { await fetch("http://127.0.0.1:${api.port}/api/runs/1/approve", { method: "POST", headers: { "x-acutis": "1" } }); out.push("api reached"); } catch { out.push("api unreachable"); }
      try { await Bun.write(${JSON.stringify(outside)}, "x"); out.push("wrote outside"); } catch { out.push("write refused"); }
      out.push("key=" + (process.env.ANTHROPIC_API_KEY ?? "none"));
      console.log(out.join(","));
      process.exit(out.join(",") === "api unreachable,write refused,key=none" ? 0 : 1);
    `;
    const repoPath = await makeRepo({ ".acutis/workflow.md": "---\ngates:\n  - bun evil.ts\nmax_attempts: 1\n---\n" });
    const home = tempDir("acutis-home-");
    const runner = new FakeRunner([
      async (c) => {
        writeFileSync(`${c.spec.cwd}/evil.ts`, evil);
        c.result("success");
        await c.nextMessage();
      },
    ]);
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    try {
      const app = createApp({ home, port: 0 }, { runner, commandSandbox: new BwrapSandbox({ hide: [home] }) });
      app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
      const t = app.tickets.create({ repo: "demo", title: "t", body: "b" });
      const run = await app.runs.start(t.id);
      await waitFor(() => app.store.getRun(run.id)!.state === "awaiting_review", 20000);
      const gate = app.store.events(run.id).find((e) => e.kind === "gate.result")!.data as any;
      expect(gate.output).toContain("api unreachable,write refused,key=none");
      expect(gate.ok).toBe(true);
      expect(apiHits).toBe(0);
      expect(existsSync(outside)).toBe(false);
      app.runs.shutdown();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
      api.stop(true);
    }
  }, 30000);
});

test("sandbox placeholder files never reach the diff, but tracked empty read-only files stay", async () => {
  const { chmodSync } = await import("node:fs");
  const { JjWorkspaceProvider } = await import("../src/providers/workspace/jj");
  const { makeRepo } = await import("./helpers");
  const repoPath = await makeRepo({ "README.md": "hi\n", ".keep-me": "" });
  const provider = new JjWorkspaceProvider(tempDir("acutis-ws-"));
  const repo = { name: "demo", path: repoPath, base: "main", notes: "" } as any;
  const base = await provider.resolve(repo, "main");
  const ws = await provider.create(repo, "w1", base);
  chmodSync(`${ws.path}/.keep-me`, 0o444); // tracked: must survive even though it looks like a placeholder
  mkdirSync(`${ws.path}/.claude`, { recursive: true });
  for (const f of [".bashrc", ".gitmodules", ".mcp.json", ".claude/settings.json"]) {
    writeFileSync(`${ws.path}/${f}`, "");
    chmodSync(`${ws.path}/${f}`, 0o444);
  }
  writeFileSync(`${ws.path}/real.txt`, "work\n");
  writeFileSync(`${ws.path}/.empty-but-writable`, ""); // an ordinary new empty file is the worker's
  expect((await provider.changedFiles(repo, ws)).sort()).toEqual([".empty-but-writable", "real.txt"]);
  expect(existsSync(`${ws.path}/.keep-me`)).toBe(true);
  expect(existsSync(`${ws.path}/.bashrc`)).toBe(false);
});
