import type { Subprocess } from "bun";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserCheck, BrowserProvider, BrowserResult } from "../../core/types";

const MAX_STEPS = 200;
const MAX_WAIT_MS = 10_000;
const CHECK_TIMEOUT_MS = 60_000;

/** Find a Chrome/Chromium binary: $ACUTIS_CHROME, then PATH, then Playwright's headless shell. */
export function findChrome(): string | null {
  const env = process.env.ACUTIS_CHROME;
  if (env) return existsSync(env) ? env : null;
  for (const b of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
    const p = Bun.which(b);
    if (p) return p;
  }
  const pw = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(pw)) {
    for (const d of readdirSync(pw).filter((d) => d.startsWith("chromium")).sort().reverse()) {
      for (const rel of ["chrome-linux/headless_shell", "chrome-linux/chrome", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
        const p = join(pw, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

const KEYS: Record<string, { code: string; keyCode: number }> = {
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Enter: { code: "Enter", keyCode: 13 },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  " ": { code: "Space", keyCode: 32 },
  Space: { code: "Space", keyCode: 32 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
};

export type Step =
  | { op: "press"; key: string }
  | { op: "click"; selector: string }
  | { op: "type"; text: string }
  | { op: "wait"; ms: number }
  | { op: "waitfor"; selector: string }
  | { op: "swipe"; dir: "left" | "right" | "up" | "down"; selector: string };

/** Parse the one-action-per-line step language. Throws on anything it doesn't understand. */
export function parseSteps(src: string | undefined): Step[] {
  if (!src?.trim()) return [];
  const steps: Step[] = [];
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [op, ...rest] = line.split(/\s+/);
    const arg = line.slice(op!.length).trim();
    switch (op) {
      case "press":
        if (!arg) throw new Error(`step "${line}": press needs a key`);
        steps.push({ op: "press", key: arg === "Space" ? " " : arg });
        break;
      case "click":
        if (!arg) throw new Error(`step "${line}": click needs a CSS selector`);
        steps.push({ op: "click", selector: arg });
        break;
      case "type":
        steps.push({ op: "type", text: arg });
        break;
      case "waitfor":
        if (!arg) throw new Error(`step "${line}": waitfor needs a CSS selector`);
        steps.push({ op: "waitfor", selector: arg });
        break;
      case "wait": {
        const ms = Number(arg);
        if (!Number.isFinite(ms) || ms < 0) throw new Error(`step "${line}": wait needs milliseconds`);
        steps.push({ op: "wait", ms: Math.min(ms, MAX_WAIT_MS) });
        break;
      }
      case "swipe": {
        const dir = rest[0] ?? "";
        if (dir !== "left" && dir !== "right" && dir !== "up" && dir !== "down") {
          throw new Error(`step "${line}": swipe left|right|up|down [selector]`);
        }
        steps.push({ op: "swipe", dir, selector: rest.slice(1).join(" ") || "body" });
        break;
      }
      default:
        throw new Error(`unknown step "${line}" (use press, click, type, wait, waitfor or swipe)`);
    }
    if (steps.length > MAX_STEPS) throw new Error(`too many steps (max ${MAX_STEPS})`);
  }
  return steps;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** Minimal Chrome DevTools Protocol client over Bun's built-in WebSocket. */
class Cdp {
  private id = 0;
  private pending = new Map<number, Pending>();
  private listeners: ((method: string, params: any, sessionId?: string) => void)[] = [];
  private constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`${m.error.message}${m.error.data ? `: ${m.error.data}` : ""}`));
        else p.resolve(m.result);
      } else {
        for (const l of this.listeners) l(m.method, m.params, m.sessionId);
      }
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error("browser connection closed"));
      this.pending.clear();
    };
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = () => reject(new Error("could not connect to Chrome DevTools"));
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(fn: (method: string, params: any, sessionId?: string) => void) {
    this.listeners.push(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/** Browsers currently running, so they die with this process even if a check is interrupted. */
const live = new Set<Subprocess>();
let exitHook = false;

/** Kill every headless Chrome this process started (daemon shutdown). */
export function killAllBrowsers() {
  for (const p of live) killTree(p);
  live.clear();
}

async function launch(bin: string): Promise<{ proc: Subprocess; wsUrl: string; profile: string }> {
  if (!exitHook) {
    exitHook = true;
    process.on("exit", killAllBrowsers);
  }
  const profile = mkdtempSync(join(tmpdir(), "acutis-chrome-"));
  const proc = Bun.spawn(
    [
      "setsid",
      bin,
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--mute-audio",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  live.add(proc);
  proc.exited.then(() => live.delete(proc));
  const reader = proc.stderr.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      Bun.sleep(deadline - Date.now()).then(() => ({ value: undefined, done: true })),
    ]);
    if (done) break;
    buf += dec.decode(value);
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      reader.releaseLock();
      // Keep draining stderr so Chrome never blocks on a full pipe.
      (async () => {
        for await (const _ of proc.stderr as any) {
        }
      })().catch(() => {});
      return { proc, wsUrl: m[1]!, profile };
    }
  }
  killTree(proc);
  rmSync(profile, { recursive: true, force: true });
  throw new Error(`Chrome did not start: ${buf.trim().split("\n").slice(-3).join(" | ") || "no output"}`);
}

function killTree(proc: Subprocess) {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
}

function fmtRemote(o: any): string {
  if (!o) return "";
  if (o.type === "string") return o.value;
  if ("value" in o) return JSON.stringify(o.value);
  return o.description ?? o.type;
}

export class ChromeBrowser implements BrowserProvider {
  readonly available: boolean;
  constructor(private bin: string | null = findChrome()) {
    this.available = Boolean(bin);
  }

  async check(c: BrowserCheck): Promise<BrowserResult> {
    const result: BrowserResult = { ok: false, console: [], errors: [], blocked: [] };
    if (!this.bin) return { ...result, failure: "no Chrome/Chromium found (set ACUTIS_CHROME)" };
    let steps: Step[];
    try {
      steps = parseSteps(c.steps);
    } catch (e) {
      return { ...result, failure: (e as Error).message };
    }
    const origin = new URL(c.url).origin;
    let chrome: Awaited<ReturnType<typeof launch>> | null = null;
    let cdp: Cdp | null = null;
    const timeout = setTimeout(() => chrome && killTree(chrome.proc), CHECK_TIMEOUT_MS);
    try {
      chrome = await launch(this.bin);
      cdp = await Cdp.connect(chrome.wsUrl);
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const s = (m: string, p: Record<string, unknown> = {}) => cdp!.send(m, p, sessionId);
      let loaded: (() => void) | null = null;
      let navStarted = false;

      /** Sessions whose network requests we intercept: the page plus its workers and iframes. */
      const guarded = new Set<string>([sessionId]);
      const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

      cdp.on((method, params, sid) => {
        // Every new target is auto-attached paused (waitForDebuggerOnStart) before it can make a
        // request: at browser level (popups, service workers) and under our page (workers, iframes).
        if (method === "Target.attachedToTarget" && (!sid || guarded.has(sid)) && params.targetInfo.targetId !== targetId) {
          const child: string = params.sessionId;
          const info = params.targetInfo;
          const popup = info.type === "page";
          if (popup && !navStarted) {
            // Chrome's own start tab, not something the page opened.
            cdp!.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
            return;
          }
          // Popups are caught before they navigate, so their URL comes from Page.windowOpen instead.
          if (popup && info.url && info.url !== "about:blank") result.blocked.push(`popup ${info.url}`);
          // Same origin lock before it runs. Workers and out-of-process iframes then carry on; a popup
          // must be resumed too (the opener's window.open waits on it), and is closed straight after.
          guarded.add(child);
          (async () => {
            // Dedicated workers have no Fetch domain of their own; their requests go through the
            // page's interception (tests/browser.test.ts proves a worker's fetch is blocked).
            await cdp!.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, child).catch(() => {});
            await cdp!.send("Target.setAutoAttach", autoAttach, child).catch(() => {});
            await cdp!.send("Runtime.runIfWaitingForDebugger", {}, child);
            if (popup) await cdp!.send("Target.closeTarget", { targetId: info.targetId });
          })().catch(() => cdp!.send("Target.closeTarget", { targetId: info.targetId }).catch(() => {}));
          return;
        }
        if (method === "Fetch.requestPaused" && (!sid || guarded.has(sid))) {
          const url: string = params.request.url;
          let allowed = url.startsWith("data:") || url.startsWith("blob:");
          try {
            allowed ||= new URL(url).origin === origin;
          } catch {}
          if (allowed) cdp!.send("Fetch.continueRequest", { requestId: params.requestId }, sid).catch(() => {});
          else {
            if (!result.blocked.includes(url.slice(0, 200))) result.blocked.push(url.slice(0, 200));
            cdp!.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, sid).catch(() => {});
          }
          return;
        }
        if (sid !== sessionId) return;
        if (method === "Runtime.consoleAPICalled") {
          const text = (params.args ?? []).map(fmtRemote).join(" ");
          result.console.push(`${params.type}: ${text}`.slice(0, 500));
        } else if (method === "Runtime.exceptionThrown") {
          const d = params.exceptionDetails;
          result.errors.push(`uncaught: ${d.exception?.description ?? d.text}`.slice(0, 1000));
        } else if (method === "Log.entryAdded" && params.entry.level === "error") {
          const e = params.entry;
          if (!(e.url && result.blocked.some((b) => e.url.startsWith(b)))) {
            result.errors.push(`${e.source}: ${e.text}${e.url ? ` (${e.url})` : ""}`.slice(0, 500));
          }
        } else if (method === "Page.windowOpen") {
          result.blocked.push(`popup ${params.url || "(blank)"}`);
        } else if (method === "Page.loadEventFired") {
          loaded?.();
        }
      });

      // Browser-level interception covers every target, including a popup's first navigation, which
      // the browser process starts before the popup's own session could intercept anything.
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await s("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await s("Target.setAutoAttach", autoAttach);
      await cdp.send("Target.setAutoAttach", autoAttach); // browser level: popups and other new pages
      await s("Runtime.enable");
      await s("Log.enable");
      await s("Page.enable");
      const width = c.width ?? 1024;
      const height = c.height ?? 768;
      await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      if (steps.some((st) => st.op === "swipe")) await s("Emulation.setTouchEmulationEnabled", { enabled: true });

      const loadedP = new Promise<void>((r) => (loaded = r));
      navStarted = true;
      const nav = await s("Page.navigate", { url: c.url });
      if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
      await Promise.race([loadedP, Bun.sleep(15_000).then(() => { throw new Error("page did not finish loading in 15s"); })]);
      await Bun.sleep(300);

      for (const st of steps) {
        if (st.op === "wait") await Bun.sleep(st.ms);
        else if (st.op === "waitfor") {
          const deadline = Date.now() + MAX_WAIT_MS;
          for (;;) {
            const r = await s("Runtime.evaluate", { expression: `!!document.querySelector(${JSON.stringify(st.selector)})`, returnByValue: true });
            if (r.result?.value) break;
            if (Date.now() > deadline) throw new Error(`step waitfor: "${st.selector}" did not appear within ${MAX_WAIT_MS / 1000}s`);
            await Bun.sleep(100);
          }
        }
        else if (st.op === "type") await s("Input.insertText", { text: st.text });
        else if (st.op === "press") {
          const k = KEYS[st.key] ?? { code: st.key.length === 1 ? `Key${st.key.toUpperCase()}` : st.key, keyCode: st.key.length === 1 ? st.key.toUpperCase().charCodeAt(0) : 0 };
          const text = st.key.length === 1 ? st.key : undefined;
          await s("Input.dispatchKeyEvent", { type: "keyDown", key: st.key, code: k.code, windowsVirtualKeyCode: k.keyCode, text });
          await s("Input.dispatchKeyEvent", { type: "keyUp", key: st.key, code: k.code, windowsVirtualKeyCode: k.keyCode });
        } else {
          const sel = st.selector;
          const r = await s("Runtime.evaluate", {
            expression: `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({block:"center"}); const b = el.getBoundingClientRect(); return {x: b.x + b.width/2, y: b.y + b.height/2, w: b.width, h: b.height}; })()`,
            returnByValue: true,
          });
          const box = r.result?.value;
          if (!box) throw new Error(`step ${st.op}: no element matches "${sel}"`);
          if (st.op === "click") {
            for (const type of ["mousePressed", "mouseReleased"]) {
              await s("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
            }
          } else {
            const d = Math.max(60, Math.min(box.w, box.h) / 3);
            const [dx, dy] = { left: [-d, 0], right: [d, 0], up: [0, -d], down: [0, d] }[st.dir];
            await s("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x, y: box.y }] });
            for (let i = 1; i <= 4; i++) {
              await s("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + (dx! * i) / 4, y: box.y + (dy! * i) / 4 }] });
            }
            await s("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          }
        }
        await Bun.sleep(60);
      }

      let scriptOk = true;
      if (c.script?.trim()) {
        const r = await s("Runtime.evaluate", {
          expression: `(async () => (${c.script}\n))()`,
          awaitPromise: true,
          returnByValue: true,
          timeout: 10_000,
        });
        if (r.exceptionDetails) {
          scriptOk = false;
          result.scriptResult = `threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`;
        } else {
          const v = r.result?.value;
          result.scriptResult = (typeof v === "string" ? v : JSON.stringify(v) ?? String(v)).slice(0, 2000);
          scriptOk = Boolean(v);
        }
      }
      await Bun.sleep(100);
      await s("Page.bringToFront").catch(() => {});
      const shot = await Promise.race([
        s("Page.captureScreenshot", { format: "png" }),
        Bun.sleep(15_000).then(() => {
          throw new Error("screenshot timed out");
        }),
      ]);
      result.screenshot = shot.data;
      result.ok = scriptOk && result.errors.length === 0;
      if (!scriptOk) result.failure = `script returned a falsy value or threw: ${result.scriptResult}`;
      else if (result.errors.length) result.failure = `${result.errors.length} page error(s)`;
      return result;
    } catch (e) {
      return { ...result, ok: false, failure: (e as Error).message };
    } finally {
      clearTimeout(timeout);
      cdp?.close();
      if (chrome) {
        killTree(chrome.proc);
        await chrome.proc.exited.catch(() => {});
        rmSync(chrome.profile, { recursive: true, force: true });
      }
    }
  }
}
