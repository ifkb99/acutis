import { afterAll, describe, expect, test } from "bun:test";
import { ChromeBrowser, findChrome, parseSteps } from "../src/providers/browser/chrome";

const chrome = findChrome();

test("step language parses and rejects junk", () => {
  expect(parseSteps("press ArrowLeft\n# comment\nclick #undo\ntype hello world\nwait 50\nswipe up .board")).toEqual([
    { op: "press", key: "ArrowLeft" },
    { op: "click", selector: "#undo" },
    { op: "type", text: "hello world" },
    { op: "wait", ms: 50 },
    { op: "swipe", dir: "up", selector: ".board" },
  ]);
  expect(() => parseSteps("rm -rf /")).toThrow(/unknown step/);
  expect(() => parseSteps("swipe sideways")).toThrow(/swipe/);
  expect(parseSteps("wait 999999")[0]).toEqual({ op: "wait", ms: 10_000 });
  expect(parseSteps("waitfor #board .tile")[0]).toEqual({ op: "waitfor", selector: "#board .tile" });
});

describe.skipIf(!chrome)("ChromeBrowser (real headless Chrome)", () => {
  // Stands in for the Acutis dashboard on another local port: it must never be reachable.
  let dashboardHits = 0;
  const hitPaths: string[] = [];
  const dashboard = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      dashboardHits++;
      hitPaths.push(new URL(req.url).pathname);
      return new Response("approved!");
    },
  });
  const page = () => `<!doctype html><html><head><title>t</title></head><body>
    <button id="pop" onclick="window.open('http://127.0.0.1:${dashboard.port}/popup')">pop</button>
    <div id="n">0</div><button id="b" onclick="document.getElementById('n').textContent = Number(document.getElementById('n').textContent) + 1">+</button>
    <script>
      window.keys = [];
      addEventListener('keydown', e => keys.push(e.key + (e.isTrusted ? '' : '?')));
      console.log('hello from page');
    </script></body></html>`;
  const app = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/boom") return new Response(`<script>throw new Error("kaboom")</script>`, { headers: { "content-type": "text/html" } });
      return new Response(page(), { headers: { "content-type": "text/html" } });
    },
  });
  afterAll(() => {
    dashboard.stop(true);
    app.stop(true);
  });
  const browser = new ChromeBrowser(chrome);
  const origin = `http://127.0.0.1:${app.port}`;

  test("runs trusted key presses and clicks, evaluates a script, returns a screenshot", async () => {
    const r = await browser.check({ url: `${origin}/`, steps: "press ArrowLeft\npress a\nclick #b\nclick #b", script: "JSON.stringify({ keys, n: document.getElementById('n').textContent })", width: 390, height: 600 });
    expect(r.failure).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.scriptResult!)).toEqual({ keys: ["ArrowLeft", "a"], n: "2" });
    expect(r.console).toContain("log: hello from page");
    expect(Buffer.from(r.screenshot!, "base64").subarray(1, 4).toString()).toBe("PNG");
  }, 60000);

  test("page errors and falsy scripts fail the check", async () => {
    const boom = await browser.check({ url: `${origin}/boom` });
    expect(boom.ok).toBe(false);
    expect(boom.errors.join("\n")).toContain("kaboom");
    const falsy = await browser.check({ url: `${origin}/`, script: "document.title === 'nope'" });
    expect(falsy.ok).toBe(false);
  }, 60000);

  test("requests to any other origin are blocked (a worker can't drive the dashboard)", async () => {
    const dash = `http://127.0.0.1:${dashboard.port}`;
    const r = await browser.check({
      url: `${origin}/`,
      script: `(async () => {
        const out = [];
        try { await fetch(${JSON.stringify(dash + "/api/runs/1/approve")}, { method: "POST", headers: { "x-acutis": "1" } }); out.push("fetch ok"); } catch { out.push("fetch blocked"); }
        try { const i = new Image(); i.src = ${JSON.stringify(dash + "/x.png")}; await new Promise(r => { i.onerror = r; i.onload = r; }); } catch {}
        const src = "fetch(" + ${JSON.stringify(JSON.stringify(dash + "/from-worker"))} + ").then(() => postMessage('worker fetch ok'), () => postMessage('worker fetch blocked'))";
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
        out.push(await new Promise(r => { w.onmessage = e => r(e.data); setTimeout(() => r("worker timeout"), 3000); }));
        return out.join(",");
      })()`,
      // A popup opened by a trusted click (script-only window.open is stopped by Chrome's popup blocker).
      steps: "click #pop\nwait 500",
    });
    expect(r.scriptResult).toBe("fetch blocked,worker fetch blocked");
    expect(r.blocked.some((b) => b.includes(`:${dashboard.port}/api/runs/1/approve`))).toBe(true);
    expect(r.blocked.some((b) => b.includes(`:${dashboard.port}/from-worker`))).toBe(true);
    expect(r.blocked.some((b) => b.startsWith("popup"))).toBe(true);
    await Bun.sleep(300);
    expect(hitPaths).toEqual([]);
    expect(dashboardHits).toBe(0);
  }, 60000);

  test("WebSockets are NOT intercepted (documented limit; the Acutis server refuses foreign-origin sockets)", async () => {
    const before = dashboardHits;
    await browser.check({
      url: `${origin}/`,
      script: `new Promise(r => { const ws = new WebSocket(${JSON.stringify(`ws://127.0.0.1:${dashboard.port}/ws`)}); ws.onerror = ws.onclose = () => r(true); setTimeout(() => r(true), 1500); })`,
    });
    // The handshake reaches the other server; the real dashboard's /ws checks Origin and refuses it
    // (tests/server.test.ts), and its socket is receive-only anyway.
    expect(dashboardHits).toBe(before + 1);
  }, 60000);

  test("navigating the page itself away is blocked too", async () => {
    const r = await browser.check({ url: `http://127.0.0.1:${dashboard.port}/` });
    // Even when asked directly, only the check's own origin is allowed — here that's the dashboard
    // origin itself, so this documents that callers must pass the preview URL (RunManager does).
    expect(r.ok).toBe(true);
    const before = dashboardHits;
    const r2 = await browser.check({ url: `${origin}/`, script: `(location.href = ${JSON.stringify(`http://127.0.0.1:${dashboard.port}/`)}, true)` });
    await Bun.sleep(300);
    expect(r2.blocked.some((b) => b.includes(`:${dashboard.port}`))).toBe(true);
    expect(dashboardHits).toBe(before);
  }, 60000);
});
