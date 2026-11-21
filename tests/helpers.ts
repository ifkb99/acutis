import { $ } from "bun";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRunner, AgentSession, AgentSpec } from "../src/core/types";

export function tempDir(prefix = "acutis-test-"): string {
  return mkdtempSync(join(process.env.ACUTIS_TEST_TMP ?? tmpdir(), prefix));
}

/** A colocated jj repo with one commit on `main`. */
export async function makeRepo(files: Record<string, string> = { "README.md": "hello\n" }): Promise<string> {
  const dir = tempDir("acutis-repo-");
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  await $`git init -q -b main && git add -A && git commit -q -m init`.cwd(dir).env(env).quiet();
  await $`jj git init --colocate`.cwd(dir).quiet();
  return dir;
}

/** Controls handed to a scripted fake agent. */
export interface FakeControls {
  spec: AgentSpec;
  emit(e: AgentEvent): void;
  /** Wait for the next operator/Acutis message. */
  nextMessage(): Promise<string>;
  /** Resolves when interrupt() is called. */
  interrupted(): Promise<void>;
  closed: boolean;
  /** End the turn. `cost` is the session's running total, like the real SDK reports. */
  result(subtype?: string, cost?: number): void;
  /** Set the running total that totalCost() reports mid-turn (undefined: report nothing). */
  setTotal(total: number | undefined): void;
  /** While set, totalCost() waits for it before answering (to simulate a slow poll). */
  holdTotal: Promise<void> | null;
}

export type FakeScript = (c: FakeControls) => Promise<void>;

class FakeSession implements AgentSession {
  private queue: AgentEvent[] = [];
  private wake: (() => void) | null = null;
  private done = false;
  private messages: string[] = [];
  private msgWake: (() => void) | null = null;
  private intWake: (() => void) | null = null;
  readonly sent: string[] = [];
  total: number | undefined;
  holdTotal: Promise<void> | null = null;
  totalCalls = 0;
  readonly events: AsyncIterable<AgentEvent>;
  closed = false;

  constructor(readonly spec: AgentSpec, script: FakeScript) {
    const self = this;
    this.events = {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const e = self.queue.shift();
          if (e) {
            yield e;
            if (e.kind === "agent.exit") return;
          } else if (self.done) return;
          else await new Promise<void>((r) => (self.wake = r));
        }
      },
    };
    const controls: FakeControls = {
      spec,
      emit: (e) => this.push(e),
      nextMessage: async () => {
        while (!this.messages.length) await new Promise<void>((r) => (this.msgWake = r));
        return this.messages.shift()!;
      },
      interrupted: () => new Promise<void>((r) => (this.intWake = r)),
      get closed() {
        return self.closed;
      },
      setTotal: (t) => (this.total = t),
      get holdTotal() {
        return self.holdTotal;
      },
      set holdTotal(p) {
        self.holdTotal = p;
      },
      result: (subtype = "success", cost = 0.01) =>
        this.push({ kind: "agent.result", subtype, result: "", is_error: subtype !== "success", cost_usd: cost, turns: 1, duration_ms: 5 }),
    };
    queueMicrotask(async () => {
      this.push({ kind: "agent.init", session_id: spec.resumeSessionId ?? crypto.randomUUID(), model: "fake", sandboxed: false });
      try {
        await script(controls);
      } catch (e) {
        if (!this.closed) this.push({ kind: "agent.exit", error: String(e) });
      }
    });
  }

  private push(e: AgentEvent) {
    if (this.closed && e.kind !== "agent.exit") return;
    this.queue.push(e);
    this.wake?.();
  }

  send(text: string) {
    this.sent.push(text);
    this.messages.push(text);
    this.msgWake?.();
  }
  async interrupt() {
    this.intWake?.();
  }
  close() {
    this.closed = true;
    this.push({ kind: "agent.exit" });
  }
  async totalCost(): Promise<number | null> {
    this.totalCalls++;
    const total = this.total; // read when asked, like a real poll; answered after any hold
    if (this.holdTotal) await this.holdTotal;
    return total ?? null;
  }
}

export class FakeRunner implements AgentRunner {
  readonly name = "fake";
  sessions: FakeSession[] = [];
  constructor(private scripts: FakeScript[]) {}
  start(spec: AgentSpec): AgentSession {
    const script = this.scripts.shift();
    if (!script) throw new Error("FakeRunner: no script left for this session");
    const s = new FakeSession(spec, script);
    this.sessions.push(s);
    return s;
  }
}

export async function waitFor<T>(fn: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await Bun.sleep(10);
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}
