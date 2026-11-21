import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { ChromeBrowser, findChrome } from "../src/providers/browser/chrome";
import { startServer } from "../src/server/server";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeScript } from "./helpers";

/**
 * End to end against a live server with a scripted agent: the CLI's watch, and the dashboard's
 * permission card, notes editor, "Add note" and "Open preview", driven in real headless Chrome.
 */
const chrome = findChrome();
const port = 18000 + Math.floor(Math.random() * 1000);
const preview = `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response("preview ok") });`;

const asksPermission: FakeScript = async (c) => {
  await c.spec.onPermission({ id: "perm-e2e-1", tool: "Bash", input: { command: "curl example.com" }, reason: "not in the allowlist", canAlwaysAllow: false });
  c.emit({ kind: "agent.text", text: "**Done.** Changed `nothing`." });
  c.result();
  await c.nextMessage();
};

const home = tempDir("acutis-e2e-");
const app = createApp({ home, port }, { runner: new FakeRunner([asksPermission]) });
const server = startServer(app);
afterAll(() => {
  app.runs.shutdown();
  server.stop(true);
});

async function cli(args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, ACUTIS_PORT: String(port), ACUTIS_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: out + err };
}

let runId = 0;
beforeAll(async () => {
  const repoPath = await makeRepo({ "README.md": "hi\n", "serve.js": preview, ".acutis/workflow.md": "---\npreview: bun serve.js\n---\n" });
  app.store.addRepo({ name: "e2e", path: repoPath, base: "main" });
  const t = app.tickets.create({ repo: "e2e", title: "E2E", body: "- one\n- two" });
  runId = (await app.runs.start(t.id)).id;
  await waitFor(() => app.runs.pendingPermissions(runId).length > 0, 10000);
});

// Order matters (the permission is answered in the browser test), so everything is in one describe.
describe("end to end", () => {
  test("watch exits 2 with an allow hint when the run asks for permission", async () => {
    const r = await cli(["watch", String(runId)]);
    expect(r.code).toBe(2);
    expect(r.out).toContain(`acutis allow ${runId} perm-e2e`);
    expect(r.out).toContain("[not in the allowlist]");
    expect(r.out).not.toContain("lost connection");
  }, 30000);

  const browser = new ChromeBrowser(chrome);
  const dash = `http://127.0.0.1:${port}`;
  {
    test.skipIf(!chrome)("the permission card's Allow once unblocks the run (headless Chrome)", async () => {
      const r = await browser.check({
        url: `${dash}/#run-${runId}&token=${app.token}`,
        steps: "waitfor .perm .btn.ok\nclick .perm .btn.ok\nwait 800",
        script: `document.querySelector('.perm') === null && document.body.innerText.includes('not in the allowlist')`,
        width: 1300,
        height: 900,
      });
      expect(r.failure).toBeUndefined();
      await waitFor(() => app.store.getRun(runId)!.state === "awaiting_review", 8000);
      // watch now reports review and exits 0
      const w = await cli(["watch", String(runId)]);
      expect(w.code).toBe(0);
      expect(w.out).toContain("ready for review");
    }, 60000);

    test.skipIf(!chrome)("markdown renders; notes editor and Add note save; Open preview opens the preview (headless Chrome)", async () => {
      const r = await browser.check({
        url: `${dash}/#run-${runId}&token=${app.token}`,
        steps: [
          "waitfor .reponotes summary",
          "waitfor .ev.text strong",
          "click .reponotes summary",
          "click .reponotes textarea",
          "type Prefer the Edit tool.",
          "click .reponotes .btn",
          "click .composer textarea",
          "type Checked on mobile.",
          "click .composer button[title^='Save a review note']",
          "click button[title^='Start this run']",
          "wait 2500",
        ].join("\n"),
        script: `JSON.stringify({ strong: !!document.querySelector('.ev.text strong'), code: document.querySelector('.ev.text code')?.textContent, li: document.querySelectorAll('.ticketbody li').length, note: document.body.innerText.includes('Checked on mobile.'), tokenInUrl: location.href.includes('token') })`,
        width: 1300,
        height: 900,
      });
      expect(r.failure).toBeUndefined();
      expect(JSON.parse(r.scriptResult!)).toEqual({ strong: true, code: "nothing", li: 2, note: true, tokenInUrl: false });
      expect(app.store.getRepo("e2e")!.notes).toBe("Prefer the Edit tool.");
      expect(app.store.events(runId).some((e) => e.kind === "review.note" && (e.data as any).text === "Checked on mobile.")).toBe(true);
      // window.open of the preview is a popup, which the checking browser closes and records.
      const info = app.runs.previews.info(runId);
      expect(info?.running).toBe(true);
      expect(r.blocked.some((b) => b.startsWith(`popup ${info!.origin}`))).toBe(true);
    }, 60000);

    test.skipIf(!chrome)("the Noticed panel shows a worker's report and Make ticket turns it into a ticket (headless Chrome)", async () => {
      const { noticed } = app.store.addNoticed({ repo: "e2e", runId, kind: "bug", title: "E2E noticed thing", detail: "Found while testing.", evidence: "" });
      const r = await browser.check({
        url: `${dash}/#token=${app.token}`,
        steps: "waitfor .noticed-item\nclick .noticed-item .btn\nwait 1200",
        script: `JSON.stringify({ panel: !!document.querySelector('.noticed-item'), ticket: [...document.querySelectorAll('.card')].some((c) => c.textContent.includes('E2E noticed thing')) })`,
        width: 1300,
        height: 900,
      });
      expect(r.failure).toBeUndefined();
      expect(JSON.parse(r.scriptResult!)).toEqual({ panel: false, ticket: true });
      expect(app.store.getNoticed(noticed.id)).toMatchObject({ status: "ticketed" });
    }, 60000);

    test.skipIf(!chrome)("without the token the dashboard asks for the link; pasting it into the open tab signs in (headless Chrome)", async () => {
      // Each check is a fresh Chrome profile, so nothing is in localStorage yet.
      const r = await browser.check({
        url: `${dash}/`,
        steps: "waitfor .placeholder",
        script: `(async () => {
          const asked = document.body.innerText.includes("acutis dashboard");
          location.hash = "token=${app.token}";
          for (let i = 0; i < 50 && !document.querySelector(".layout .side"); i++) await new Promise((r) => setTimeout(r, 100));
          for (let i = 0; i < 50 && !document.body.innerText.includes("E2E"); i++) await new Promise((r) => setTimeout(r, 100));
          return JSON.stringify({ asked, signedIn: document.body.innerText.includes("E2E"), tokenInUrl: location.href.includes("token"), stored: localStorage.getItem("acutis-token") === "${app.token}" });
        })()`,
        width: 1300,
        height: 900,
      });
      expect(r.failure).toBeUndefined();
      expect(JSON.parse(r.scriptResult!)).toEqual({ asked: true, signedIn: true, tokenInUrl: false, stored: true });
    }, 60000);
  }
});
