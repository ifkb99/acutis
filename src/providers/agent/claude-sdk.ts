import { query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { resolve, sep } from "node:path";
import type { AgentEvent, AgentRunner, AgentSession, AgentSpec } from "../../core/types";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SECRET_PATHS = [".ssh", ".aws", ".gnupg", ".config/gh", ".claude/.credentials.json", ".netrc", ".npmrc"];
const MAX_RESULT_CHARS = 6000;

export interface SandboxStatus {
  ok: boolean;
  reason?: string;
}

/** Check that bubblewrap can actually create namespaces here, not just that it is installed. */
export function probeSandbox(): SandboxStatus {
  const missing = ["bwrap", "socat"].filter((b) => !Bun.which(b));
  if (missing.length) return { ok: false, reason: `missing ${missing.join(", ")}` };
  const p = Bun.spawnSync(["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-net", "true"], {
    stderr: "pipe",
  });
  if (p.exitCode === 0) return { ok: true };
  const err = p.stderr.toString().trim();
  const apparmor = Bun.spawnSync(["sysctl", "-n", "kernel.apparmor_restrict_unprivileged_userns"]).stdout.toString().trim();
  return {
    ok: false,
    reason:
      apparmor === "1"
        ? `Ubuntu AppArmor blocks bubblewrap's user namespaces (${err}). Add the bubblewrap AppArmor profile (see code.claude.com/docs/en/sandboxing)`
        : `bubblewrap can't start: ${err}`,
  };
}

function isInside(root: string, p: string): boolean {
  const abs = resolve(root, p);
  const r = resolve(root);
  return abs === r || abs.startsWith(r + sep);
}

function stringifyToolResult(content: unknown): string {
  let s: string;
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) {
    s = content
      .map((b: any) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : JSON.stringify(b)))
      .join("\n");
  } else s = JSON.stringify(content ?? "");
  return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + `\n… [${s.length - MAX_RESULT_CHARS} more chars]` : s;
}

function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

class ClaudeSdkSession implements AgentSession {
  private pending: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private q: ReturnType<typeof query>;
  readonly events: AsyncIterable<AgentEvent>;

  constructor(spec: AgentSpec, sandbox: boolean) {
    this.pending.push(userMessage(spec.prompt));
    const cwd = resolve(spec.cwd);

    const options: Options = {
      cwd,
      model: spec.model,
      effort: spec.effort,
      resume: spec.resumeSessionId,
      permissionMode: "acceptEdits",
      allowedTools: spec.allow,
      // Workers report questions in their final message instead of blocking on a prompt.
      disallowedTools: [...spec.deny, "AskUserQuestion"],
      settingSources: ["project"],
      // Workers get no MCP servers: not your claude.ai connectors (mail, Drive…), not a repo's .mcp.json.
      strictMcpConfig: true,
      mcpServers: {},
      settings: { disableClaudeAiConnectors: true },
      systemPrompt: { type: "preset", preset: "claude_code", append: spec.systemAppend },
      env: { ...process.env, ACUTIS_WORKER: "1" },
      canUseTool: async (toolName, input, { signal, suggestions, blockedPath }) => {
        if (FILE_TOOLS.has(toolName)) {
          const p = (input.file_path ?? input.notebook_path) as string | undefined;
          if (p && !isInside(cwd, p)) {
            return { behavior: "deny", message: `Acutis: ${toolName} outside the workspace (${p}) is not allowed.` };
          }
        }
        // Belt and braces for the Read(...) deny rules: never even ask about credential files.
        const target = String(input.file_path ?? input.path ?? input.notebook_path ?? blockedPath ?? "");
        if (target) {
          const abs = resolve(cwd, target.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
          const home = process.env.HOME ?? "";
          if (home && SECRET_PATHS.some((p) => abs === `${home}/${p}` || abs.startsWith(`${home}/${p}/`))) {
            return { behavior: "deny", message: `Acutis: credential paths are off-limits (${target}).` };
          }
        }
        if (signal.aborted) return { behavior: "deny", message: "aborted" };
        const decision = await spec.onPermission({
          id: crypto.randomUUID(),
          tool: toolName,
          input,
          blockedPath,
          canAlwaysAllow: Boolean(suggestions?.length),
        });
        if (decision.behavior === "allow") {
          return {
            behavior: "allow",
            updatedInput: input,
            updatedPermissions: decision.always && suggestions ? suggestions : undefined,
          };
        }
        return { behavior: "deny", message: decision.message || "Denied by the Acutis operator." };
      },
    };
    if (sandbox) {
      options.sandbox = {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
      } as Options["sandbox"];
    }

    this.q = query({ prompt: this.input(), options });
    this.events = this.translate(sandbox);
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = this.pending.shift();
      if (next) yield next;
      else if (this.closed) return;
      else {
        await new Promise<void>((r) => (this.wake = r));
        this.wake = null;
      }
    }
  }

  private async *translate(sandbox: boolean): AsyncGenerator<AgentEvent> {
    try {
      for await (const m of this.q as AsyncIterable<SDKMessage>) {
        yield* this.map(m, sandbox);
      }
      yield { kind: "agent.exit" };
    } catch (e) {
      yield { kind: "agent.exit", error: e instanceof Error ? e.message : String(e) };
    }
  }

  private *map(m: SDKMessage, sandbox: boolean): Generator<AgentEvent> {
    const msg = m as any;
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          yield { kind: "agent.init", session_id: msg.session_id, model: msg.model, sandboxed: sandbox };
        }
        return;
      case "assistant":
        for (const b of msg.message?.content ?? []) {
          if (b.type === "text" && b.text?.trim()) yield { kind: "agent.text", text: b.text };
          else if (b.type === "tool_use") yield { kind: "agent.tool_use", id: b.id, name: b.name, input: b.input };
        }
        return;
      case "user":
        if (Array.isArray(msg.message?.content)) {
          for (const b of msg.message.content) {
            if (b.type === "tool_result") {
              yield {
                kind: "agent.tool_result",
                tool_use_id: b.tool_use_id,
                content: stringifyToolResult(b.content),
                is_error: Boolean(b.is_error),
              };
            }
          }
        }
        return;
      case "result":
        yield {
          kind: "agent.result",
          subtype: msg.subtype,
          result: typeof msg.result === "string" ? msg.result : "",
          is_error: Boolean(msg.is_error),
          cost_usd: Number(msg.total_cost_usd ?? 0),
          turns: Number(msg.num_turns ?? 0),
          duration_ms: Number(msg.duration_ms ?? 0),
          errors: Array.isArray(msg.errors) ? msg.errors.map(String) : undefined,
        };
        return;
    }
  }

  send(text: string): void {
    if (this.closed) throw new Error("session is closed");
    this.pending.push(userMessage(text));
    this.wake?.();
  }

  async interrupt(): Promise<void> {
    await this.q.interrupt();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    try {
      this.q.close();
    } catch {}
  }
}

export class ClaudeSdkRunner implements AgentRunner {
  readonly name = "claude-sdk";
  constructor(private opts: { sandbox: boolean }) {}
  start(spec: AgentSpec): AgentSession {
    return new ClaudeSdkSession(spec, this.opts.sandbox);
  }
}
