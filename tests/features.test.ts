import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import { outsidePaths } from "../src/core/paths";
import { costDelta, previewUrl } from "../src/core/runs";
import type { BrowserCheck, BrowserProvider, BrowserResult, RunState } from "../src/core/types";
import { parseWorkflow } from "../src/core/workflow";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeScript } from "./helpers";

// 1x1 transparent PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

class FakeBrowser implements BrowserProvider {
  readonly available = true;
  checks: BrowserCheck[] = [];
  constructor(private respond: (c: BrowserCheck) => Partial<BrowserResult> = () => ({ ok: true })) {}
  async check(c: BrowserCheck): Promise<BrowserResult> {
    this.checks.push(c);
    return { ok: true, console: [], errors: [], blocked: [], screenshot: PNG, ...this.respond(c) };
  }
}

async function setup(scripts: FakeScript[], files?: Record<string, string>, opts: { browser?: BrowserProvider } = {}) {
  const repoPath = await makeRepo(files);
  const runner = new FakeRunner(scripts);
  const app = createApp({ home: tempDir("acutis-home-"), port: 0 }, { runner, browser: opts.browser ?? new FakeBrowser() });
  app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
  const ticket = app.tickets.create({ repo: "demo", title: "Add greeting", body: "Create greeting.txt" });
  return { app, runner, repoPath, ticket };
}

const state = (app: ReturnType<typeof createApp>, id: number) => app.store.getRun(id)!.state;
const until = (app: ReturnType<typeof createApp>, id: number, s: RunState) => waitFor(() => state(app, id) === s, 15000);

const writes =
  (file: string, content: string, cost?: number): FakeScript =>
  async (c) => {
    writeFileSync(join(c.spec.cwd, file), content);
    c.result("success", cost);
    await c.nextMessage();
  };

// ------------------------------------------------------------------ cost

describe("cost accounting", () => {
  test("costDelta treats SDK totals as running totals", () => {
    expect(costDelta(0.5, null, false, 0)).toBe(0.5); // first result of a fresh session
    expect(costDelta(0.8, 0.5, false, 0.5)).toBeCloseTo(0.3); // same process, later turn
    expect(costDelta(1.2, null, true, 0.8)).toBeCloseTo(0.4); // resumed, continues from saved total
    expect(costDelta(0.1, null, true, 0.8)).toBeCloseTo(0.1); // resumed, total restarted from zero
    expect(costDelta(0.05, 0.9, false, 0.9)).toBeCloseTo(0.05); // total reset mid-session (/clear)
  });

  test("gate retries and resumes don't double-count", async () => {
    const workflow = `---\ngates:\n  - test -f fixed.txt\nmax_attempts: 2\n---\n`;
    const first: FakeScript = async (c) => {
      c.result("success", 0.5); // fails the gate
      await c.nextMessage();
      writeFileSync(join(c.spec.cwd, "fixed.txt"), "ok");
      c.result("success", 0.8); // running total, so +0.3
      await c.nextMessage();
    };
    const resumed: FakeScript = async (c) => {
      writeFileSync(join(c.spec.cwd, "more.txt"), "x");
      c.result("success", 1.0); // resumed session continues from 0.8, so +0.2
      await c.nextMessage();
    };
    const { app, ticket } = await setup([first, resumed], { ".acutis/workflow.md": workflow });
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "awaiting_review");
    expect(app.store.getRun(run.id)!.cost_usd).toBeCloseTo(0.8);
    await app.runs.message(run.id, "one more thing");
    await waitFor(() => app.store.getRun(run.id)!.cost_usd > 0.85);
    await until(app, run.id, "awaiting_review");
    expect(app.store.getRun(run.id)!.cost_usd).toBeCloseTo(1.0);
  }, 30000);
});

// ------------------------------------------------------------------ identity, setup, trunk

describe("landing", () => {
  test("landed commits carry an author even when jj has no identity configured", async () => {
    const { app, repoPath, ticket } = await setup([writes("greeting.txt", "hi\n")]);
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "awaiting_review");
    await app.runs.approve(run.id);
    const author = (await $`jj log --no-graph -r acutis/${ticket.id}-add-greeting -T 'author.email()'`.cwd(repoPath).text()).trim();
    const gitEmail = (await $`git config user.email`.cwd(repoPath).nothrow().text()).trim();
    if (gitEmail) expect(author).toBe(gitEmail);
    else expect(author).not.toBe("");
    expect(app.store.getRun(run.id)!.workspace_path).toBeNull();
  });

  test("setup steps run before the agent; a failing step fails the run", async () => {
    let sawSetup = false;
    const script: FakeScript = async (c) => {
      sawSetup = existsSync(join(c.spec.cwd, "node_modules/.installed"));
      c.result();
      await c.nextMessage();
    };
    const ok = await setup([script], { ".acutis/workflow.md": `---\nsetup:\n  - mkdir -p node_modules && touch node_modules/.installed\n---\n` });
    const run = await ok.app.runs.start(ok.ticket.id);
    await until(ok.app, run.id, "awaiting_review");
    expect(sawSetup).toBe(true);
    expect(ok.app.store.events(run.id).some((e) => e.kind === "setup.result" && (e.data as any).ok)).toBe(true);

    const bad = await setup([script], { ".acutis/workflow.md": `---\nsetup:\n  - exit 3\n---\n` });
    const run2 = await bad.app.runs.start(bad.ticket.id);
    await until(bad.app, run2.id, "failed");
    expect(bad.runner.sessions.length).toBe(0);
    expect(bad.app.store.getRun(run2.id)!.error).toContain("setup step failed");
  });

  test("land: trunk rebases onto trunk, re-checks, and advances it", async () => {
    const wf = `---\nland: trunk\nmax_attempts: 1\ngates:\n  - test -f a.txt\n---\n`;
    const { app, repoPath, ticket } = await setup([writes("a.txt", "A\n"), writes("b.txt", "B\n")], { ".acutis/workflow.md": wf });
    const t2 = app.tickets.create({ repo: "demo", title: "Second", body: "" });
    const r1 = await app.runs.start(ticket.id);
    await until(app, r1.id, "awaiting_review");
    const r2 = await app.runs.start(t2.id); // branches from the old trunk, without a.txt
    await until(app, r2.id, "awaiting_review");
    expect(app.store.getRun(r2.id)!.gates_ok).toBe(0); // a.txt missing in r2's workspace

    await app.runs.approve(r1.id);
    expect(state(app, r1.id)).toBe("done");
    expect(app.store.getRun(r1.id)!.bookmark).toBe("main");
    expect(await $`jj file show -r main a.txt`.cwd(repoPath).text()).toBe("A\n");

    // r2 is rebased onto the new main (which has a.txt), its checks re-run and now pass.
    await app.runs.approve(r2.id);
    expect(state(app, r2.id)).toBe("done");
    expect(app.store.getRun(r2.id)!.gates_ok).toBe(1);
    expect(await $`jj file show -r main b.txt`.cwd(repoPath).text()).toBe("B\n");
    expect(await $`jj file show -r main a.txt`.cwd(repoPath).text()).toBe("A\n");
    expect(app.store.events(r2.id).some((e) => (e.data as any).msg?.startsWith("Rebased onto main"))).toBe(true);
    const branches = await $`jj bookmark list -T 'name ++ "\\n"'`.cwd(repoPath).text();
    expect(branches).not.toContain("acutis/");
  }, 30000);

  test("land: trunk stops on conflicts and keeps the run reviewable", async () => {
    const wf = `---\nland: trunk\n---\n`;
    const { app, repoPath, ticket } = await setup([writes("README.md", "one\n"), writes("README.md", "two\n")], { ".acutis/workflow.md": wf });
    const t2 = app.tickets.create({ repo: "demo", title: "Second", body: "" });
    // Start r2 only once r1 is in review: fake scripts are handed out in launch order. Both still
    // branch from the same trunk, since nothing lands until approve.
    const r1 = await app.runs.start(ticket.id);
    await until(app, r1.id, "awaiting_review");
    const r2 = await app.runs.start(t2.id);
    await until(app, r2.id, "awaiting_review");
    await app.runs.approve(r1.id);
    await expect(app.runs.approve(r2.id)).rejects.toThrow(/conflicts in: README.md/);
    expect(state(app, r2.id)).toBe("awaiting_review");
    expect(await $`jj file show -r main README.md`.cwd(repoPath).text()).toBe("one\n");
    // The stopped landing left r2 rebased onto the new trunk: its base moved with it, so the diff
    // is still just r2's own change, not r1's work.
    const trunk = (await $`jj log --no-graph -r main -T commit_id`.cwd(repoPath).text()).trim();
    expect(app.store.getRun(r2.id)!.base_commit).toBe(trunk);
    const d = await app.runs.diff(r2.id);
    expect(d).toContain("\n-one\n"); // relative to the new trunk (README = "one")…
    expect(d).not.toContain("\n-hello\n"); // …not the stale base (README = "hello")
    // Approving again must not land the conflicted commit (it already sits on trunk now).
    await expect(app.runs.approve(r2.id)).rejects.toThrow(/conflicts in: README.md/);
    expect(await $`jj file show -r main README.md`.cwd(repoPath).text()).toBe("one\n");
    expect(state(app, r2.id)).toBe("awaiting_review");
  }, 30000);

  test("land: trunk refuses a base that isn't a bookmark", async () => {
    const { app, ticket } = await setup([writes("a.txt", "A")], { ".acutis/workflow.md": `---\nland: trunk\n---\n` });
    app.store.db.query("UPDATE repos SET base = 'main@git' WHERE name = 'demo'").run();
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "awaiting_review");
    await expect(app.runs.approve(run.id)).rejects.toThrow(/needs the repo's base/);
  });
});

// ------------------------------------------------------------------ permissions, notes, tools

describe("operator features", () => {
  test("permission requests time out into a deny with an explanation", async () => {
    let decision: any;
    const script: FakeScript = async (c) => {
      decision = await c.spec.onPermission({ id: "p1", tool: "Bash", input: { command: "curl x" }, canAlwaysAllow: false });
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([script], { ".acutis/workflow.md": `---\npermission_timeout_s: 0.3\n---\n` });
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "awaiting_review");
    expect(decision.behavior).toBe("deny");
    expect(decision.message).toContain("No operator answered");
    expect(app.store.events(run.id).some((e) => e.kind === "permission.decision" && (e.data as any).by === "timeout")).toBe(true);
  });

  test("notes attach text and PNGs; artifact names are validated", async () => {
    const { app, ticket } = await setup([writes("a.txt", "A")]);
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "awaiting_review");
    const ev = app.runs.addNote(run.id, "looks off on mobile", PNG);
    const name = (ev.data as any).artifact as string;
    expect(app.runs.artifactPath(run.id, name)).toBeTruthy();
    expect(app.runs.artifactPath(run.id, "../../acutis.db")).toBeNull();
    expect(app.runs.artifactPath(run.id, "x.svg")).toBeNull();
    expect(() => app.runs.addNote(run.id, "x", Buffer.from("<svg/>").toString("base64"))).toThrow(/PNG/);
  });

  test("operator notes reach the worker's system prompt", async () => {
    let prompt = "";
    const script: FakeScript = async (c) => {
      prompt = c.spec.systemAppend;
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([script]);
    app.store.setRepoNotes("demo", "Prefer the Edit tool over python scripts.");
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "awaiting_review");
    expect(prompt).toContain("Prefer the Edit tool over python scripts.");
  });

  test("preview + browser tool: Acutis runs the server, the agent gets a screenshot, paths stay on origin", async () => {
    const browser = new FakeBrowser();
    const server = `const s = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response("<h1>hi</h1>", { headers: { "content-type": "text/html" } }) });`;
    const wf = `---\npreview:\n  run: bun serve.js\n  path: /\ngates:\n  - browser: { path: /, script: "document.title !== undefined" }\n---\n`;
    let toolOut: any;
    let badOut: any;
    let toolNames: string[] = [];
    const script: FakeScript = async (c) => {
      toolNames = (c.spec.tools ?? []).map((t) => t.name);
      const browserTool = c.spec.tools!.find((t) => t.name === "browser")!;
      toolOut = await browserTool.handler({ path: "/?x=1", steps: "press ArrowLeft" });
      badOut = await browserTool.handler({ path: "//evil.example/" });
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([script], { ".acutis/workflow.md": wf, "serve.js": server }, { browser });
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "awaiting_review");
    expect(toolNames).toEqual(["preview", "browser"]);
    expect(toolOut.images[0].data).toBe(PNG);
    expect(badOut.isError).toBe(true);
    const origin = new URL(browser.checks[0]!.url).origin;
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(browser.checks.every((c) => new URL(c.url).origin === origin)).toBe(true);
    expect(browser.checks[0]!.url).toBe(`${origin}/?x=1`);
    // gate ran in the browser and passed; screenshots from both were stored as artifacts
    expect(app.store.getRun(run.id)!.gates_ok).toBe(1);
    expect(app.store.events(run.id).filter((e) => e.kind === "artifact").length).toBe(2);
    // the preview server is still up for the reviewer, and goes away when the run ends
    const res = await fetch(origin);
    expect(await res.text()).toContain("hi");
    await app.runs.kill(run.id);
    await waitFor(async () => !(await fetch(origin).then(() => true, () => false)) || undefined, 3000).catch(() => {});
    expect(await fetch(origin).then(() => "up", () => "down")).toBe("down");
  }, 30000);

  test("a failing browser gate goes back to the agent", async () => {
    const browser = new FakeBrowser((c) => (c.script ? { ok: false, errors: ["uncaught: boom"], failure: "1 page error(s)" } : {}));
    const wf = `---\npreview: "bun -e 'Bun.serve({hostname:\\"127.0.0.1\\",port:Number(process.env.PORT),fetch:()=>new Response(\\"ok\\")})'"\ngates:\n  - browser: { path: /, script: "1" }\nmax_attempts: 2\n---\n`;
    let feedback = "";
    const script: FakeScript = async (c) => {
      c.result();
      feedback = await c.nextMessage();
      c.result();
      await c.nextMessage();
    };
    const { app, ticket } = await setup([script], { ".acutis/workflow.md": wf }, { browser });
    const run = await app.runs.start(ticket.id);
    await until(app, run.id, "awaiting_review");
    expect(feedback).toContain("uncaught: boom");
    expect(app.store.getRun(run.id)!.gates_ok).toBe(0);
  }, 30000);
});

describe("previews", () => {
  test("concurrent starts share one server, and stop kills it", async () => {
    const { PreviewManager } = await import("../src/core/preview");
    const dir = tempDir("acutis-preview-");
    writeFileSync(join(dir, "serve.js"), `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response(String(process.pid)) });`);
    const pm = new PreviewManager();
    const spec = { run: "bun serve.js", path: "/", ready_timeout_s: 20 };
    const [a, b] = await Promise.all([pm.ensure(1, dir, spec), pm.ensure(1, dir, spec)]);
    expect(a.origin).toBe(b.origin);
    const pid = await (await fetch(a.origin)).text();
    expect(Number(pid)).toBeGreaterThan(0);
    pm.stop(1);
    await Bun.sleep(300);
    expect(await fetch(a.origin).then(() => "up", () => "down")).toBe("down");
    let alive = true;
    try {
      process.kill(Number(pid), 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 30000);
});

// ------------------------------------------------------------------ pure helpers

describe("helpers", () => {
  const ws = "/home/u/.local/share/acutis/workspaces/r/acutis-t1-r1";
  test("outsidePaths flags user-writable paths outside the workspace (run 1 fixtures)", () => {
    // event #29: an allowlisted bun build writing to /tmp
    expect(outsidePaths("printf 'dist/\\n' >> .gitignore && cat .gitignore && bun test 2>&1 | tail -4 && bun build ./index.html --outdir dist && bun build ./src/main.ts --target browser --outdir /tmp/tm-check >/dev/null && echo ok", ws, "/home/u")).toEqual(["/tmp/tm-check"]);
    // event #31
    expect(outsidePaths(`rm -rf /tmp/tm-check; cd ${ws} && rm -rf dist && git status --short`, ws, "/home/u")).toEqual(["/tmp/tm-check"]);
    // events #18, #108, and redirects to /dev/null: nothing outside
    expect(outsidePaths("bun test 2>&1 | tail -30", ws, "/home/u")).toEqual([]);
    expect(outsidePaths("bun test 2>&1 | tail -4 && bun build ./index.html --outdir dist && rm -rf dist && git status --short", ws, "/home/u")).toEqual([]);
    expect(outsidePaths("git ls-files && cat .gitignore 2>/dev/null; cat CLAUDE.md README.md 2>/dev/null | head -50", ws, "/home/u")).toEqual([]);
    // flags, home, parent escapes, quoting
    expect(outsidePaths("bun build x --outdir=/tmp/y", ws, "/home/u")).toEqual(["/tmp/y"]);
    expect(outsidePaths("cp a ~/x", ws, "/home/u")).toEqual(["/home/u/x"]);
    expect(outsidePaths('echo hi > "../../other/file"', ws, "/home/u")).toEqual(["/home/u/.local/share/acutis/workspaces/other/file"]);
    // patterns and root-owned paths are not flagged
    expect(outsidePaths('grep -rn "/api/" src', ws, "/home/u")).toEqual([]);
    expect(outsidePaths("/usr/bin/env node -v && curl https://example.com/tmp/x", ws, "/home/u")).toEqual([]);
  });

  test("previewUrl keeps worker-supplied paths on the preview origin", () => {
    const o = "http://127.0.0.1:4321";
    expect(previewUrl(o, "/")).toBe(`${o}/`);
    expect(previewUrl(o, "/a?b=1#c")).toBe(`${o}/a?b=1#c`);
    expect(previewUrl(o, "//evil.example/")).toBeNull();
    expect(previewUrl(o, "http://127.0.0.1:7777/")).toBeNull();
    expect(previewUrl(o, "/\\evil.example")).toBeNull();
    expect(previewUrl(o, "javascript:alert(1)")).toBeNull();
  });

  test("workflow parses setup, preview, browser gates, timeouts and land: trunk", () => {
    const wf = parseWorkflow(
      `---\nsetup:\n  - bun install\npreview:\n  run: bun --port=$PORT ./index.html\ngates:\n  - bun test\n  - name: home\n    browser: { path: /, steps: "press ArrowLeft", script: "true", width: 390 }\npermission_timeout_s: 600\nland: trunk\n---\n`,
      "t",
    );
    expect(wf.setup).toEqual([{ kind: "cmd", name: "bun install", run: "bun install", timeout_s: undefined }]);
    expect(wf.preview).toEqual({ run: "bun --port=$PORT ./index.html", path: "/", ready_timeout_s: 30 });
    expect(wf.gates[1]).toEqual({ kind: "browser", name: "home", path: "/", steps: "press ArrowLeft", script: "true", width: 390, height: undefined });
    expect(wf.permission_timeout_s).toBe(600);
    expect(wf.land).toBe("trunk");
    expect(() => parseWorkflow(`---\ngates:\n  - browser: { path: / }\n---\n`, "t")).toThrow(/need a "preview"/);
    expect(() => parseWorkflow(`---\nland: merge\n---\n`, "t")).toThrow(/land/);
  });
});
