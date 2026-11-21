import type { Subprocess } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerEnv } from "./env";
import type { CommandSandbox, PreviewSpec } from "./types";

const LOG_LINES = 200;

interface Preview {
  proc: Subprocess;
  /** Host side of a sandboxed preview: socat from 127.0.0.1:port to the sandbox's socket. */
  relay?: Subprocess;
  socketDir?: string;
  port: number;
  origin: string;
  cwd: string;
  logs: string[];
  ready: Promise<void>;
  exited: boolean;
}

function killGroup(proc: Subprocess) {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
}

async function freePort(): Promise<number> {
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = l.port;
  l.stop(true);
  return port;
}

/**
 * Dev servers Acutis runs on behalf of workers (principle 4: the factory owns long-running
 * processes). One per run, on a free port bound to 127.0.0.1, killed with its whole process group.
 */
export class PreviewManager {
  private previews = new Map<number, Preview>();
  /** Starts in flight, so concurrent callers (e.g. two browser checks at once) share one server. */
  private starting = new Map<number, Promise<Preview>>();

  /**
   * With a sandbox, the dev server (worker-written code) can only write its workspace and has
   * its own network namespace: it can't reach the host's localhost (the Acutis API, your other
   * dev servers) or the internet. Acutis relays its port to the host.
   */
  constructor(private sandbox?: CommandSandbox) {}

  /** Start the run's preview if it isn't running, and wait until it answers HTTP. */
  async ensure(runId: number, cwd: string, spec: PreviewSpec): Promise<{ origin: string; url: string }> {
    const inflight = this.starting.get(runId);
    if (inflight) {
      const p = await inflight;
      return { origin: p.origin, url: p.origin + spec.path };
    }
    let p = this.previews.get(runId);
    if (p && (p.exited || p.cwd !== cwd)) {
      this.stop(runId);
      p = undefined;
    }
    if (!p) {
      const start = this.start(runId, cwd, spec);
      this.starting.set(runId, start);
      try {
        p = await start;
      } finally {
        if (this.starting.get(runId) === start) this.starting.delete(runId);
      }
    }
    await p.ready;
    return { origin: p.origin, url: p.origin + spec.path };
  }

  private async start(runId: number, cwd: string, spec: PreviewSpec): Promise<Preview> {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    let relay: Subprocess | undefined;
    let socketDir: string | undefined;
    let argv = ["setsid", "sh", "-c", spec.run];
    if (this.sandbox) {
      // Unix socket paths are capped at ~108 bytes, so keep this short (not under $ACUTIS_HOME).
      socketDir = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "acutis-pv-"));
      const socket = join(socketDir, "s");
      argv = this.sandbox.wrap(spec.run, cwd, { expose: { port, socket } });
      relay = Bun.spawn(
        ["setsid", "socat", `TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr`, `UNIX-CONNECT:${socket}`],
        { stdout: "ignore", stderr: "ignore" },
      );
    }
    const proc = Bun.spawn(argv, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: workerEnv({ PORT: String(port), BUN_PORT: String(port), HOST: "127.0.0.1", HOSTNAME: "127.0.0.1", BROWSER: "none" }),
    });
    const logs: string[] = [];
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      let rest = "";
      for await (const chunk of stream as any) {
        rest += dec.decode(chunk);
        const lines = rest.split("\n");
        rest = lines.pop() ?? "";
        logs.push(...lines);
        if (logs.length > LOG_LINES) logs.splice(0, logs.length - LOG_LINES);
      }
      if (rest) logs.push(rest);
    };
    pump(proc.stdout).catch(() => {});
    pump(proc.stderr).catch(() => {});
    const p: Preview = { proc, relay, socketDir, port, origin, cwd, logs, exited: false, ready: Promise.resolve() };
    proc.exited.then(() => (p.exited = true));
    p.ready = (async () => {
      const deadline = Date.now() + spec.ready_timeout_s * 1000;
      while (Date.now() < deadline) {
        if (p.exited) throw new Error(`preview command exited (code ${proc.exitCode}):\n${logs.slice(-20).join("\n")}`);
        try {
          const res = await fetch(origin + spec.path, { signal: AbortSignal.timeout(2000) });
          await res.body?.cancel();
          return;
        } catch {}
        await Bun.sleep(250);
      }
      throw new Error(`preview did not answer on ${origin} within ${spec.ready_timeout_s}s:\n${logs.slice(-20).join("\n")}`);
    })();
    p.ready.catch(() => {});
    this.previews.set(runId, p);
    try {
      await p.ready;
    } catch (e) {
      this.stop(runId);
      throw e;
    }
    return p;
  }

  info(runId: number): { origin: string; running: boolean; logs: string[] } | null {
    const p = this.previews.get(runId);
    return p ? { origin: p.origin, running: !p.exited, logs: [...p.logs] } : null;
  }

  stop(runId: number) {
    const p = this.previews.get(runId);
    if (!p) return;
    this.previews.delete(runId);
    if (!p.exited) killGroup(p.proc);
    if (p.relay) killGroup(p.relay);
    if (p.socketDir) rmSync(p.socketDir, { recursive: true, force: true });
  }

  stopAll() {
    for (const id of [...this.previews.keys()]) this.stop(id);
  }
}
