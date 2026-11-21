import { createSdkMcpServer, query, tool, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "node:path";
import { z } from "zod";
import { isInside, outsidePaths } from "../../core/paths";
import type { AcutisTool, AgentEvent, AgentRunner, AgentSession, AgentSpec } from "../../core/types";

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

/** Serve Acutis's own tools in-process (never an external MCP server). */
function acutisServer(tools: AcutisTool[]) {
  return createSdkMcpServer({
    name: "acutis",
    version: "1.0.0",
    tools: tools.map((t) => {
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [k, p] of Object.entries(t.params)) {
        const base = p.type === "number" ? z.number() : z.string();
        shape[k] = (p.optional ? base.optional() : base).describe(p.description);
      }
      return tool(
        t.name,
        t.description,
        shape,
        async (args) => {
          try {
            const out = await t.handler(args as Record<string, string | number | undefined>);
            return {
              content: [
                ...(out.images ?? []).map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })),
                { type: "text" as const, text: out.text },
              ],
              isError: out.isError,
            };
          } catch (e) {
            return { content: [{ type: "text" as const, text: `Acutis tool error: ${(e as Error).message}` }], isError: true };
          }
        },
        { alwaysLoad: true },
      );
    }),
  });
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

  constructor(spec: AgentSpec, sandbox: boolean, denyRead: string[]) {
    this.pending.push(userMessage(spec.prompt));
    const cwd = resolve(spec.cwd);

    const tools = spec.tools ?? [];
    const toolNames = new Set(tools.map((t) => `mcp__acutis__${t.name}`));
    const options: Options = {
      cwd,
      model: spec.model,
      effort: spec.effort,
      resume: spec.resumeSessionId,
      permissionMode: "acceptEdits",
      allowedTools: spec.allow,
      // Workers report questions in their final message instead of blocking on a prompt.
      // "//abs/path" is Claude Code's rule syntax for an absolute path.
      disallowedTools: [...spec.deny, ...denyRead.map((p) => `Read(/${p})`), "AskUserQuestion"],
      settingSources: ["project"],
      // Workers get no external MCP servers: not your claude.ai connectors (mail, Drive…), not a repo's
      // .mcp.json. The only server is Acutis's own, in-process.
      strictMcpConfig: true,
      mcpServers: tools.length ? { acutis: acutisServer(tools) } : {},
      settings: { disableClaudeAiConnectors: true },
      systemPrompt: { type: "preset", preset: "claude_code", append: spec.systemAppend },
      env: { ...process.env, ACUTIS_WORKER: "1" },
      canUseTool: async (toolName, input, { signal, suggestions, blockedPath, decisionReason, mcpServer }) => {
        // Acutis's own tools are approved here rather than via allowedTools, keyed on the server
        // really being our in-process one (source "sdk"), not on the tool-name prefix.
        if (mcpServer?.source === "sdk" && mcpServer.name === "acutis" && toolNames.has(toolName)) {
          return { behavior: "allow", updatedInput: input };
        }
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
          const secret = (p: string) => abs === p || abs.startsWith(`${p}/`);
          if ((home && SECRET_PATHS.some((p) => secret(`${home}/${p}`))) || denyRead.some(secret)) {
            return { behavior: "deny", message: `Acutis: credential paths are off-limits (${target}).` };
          }
        }
        // After the credential check above. Under the sandbox every Bash command runs inside bubblewrap (unsandboxed retries are off), so
        // the prompts Claude Code still raises for commands it can't statically check (heredocs,
        // subshells, variables) guard nothing. Network access is a separate request and still asks.
        if (sandbox && toolName === "Bash" && !input.dangerouslyDisableSandbox) {
          return { behavior: "allow", updatedInput: input };
        }
        if (signal.aborted) return { behavior: "deny", message: "aborted" };
        const decision = await spec.onPermission({
          id: crypto.randomUUID(),
          tool: toolName,
          input,
          blockedPath,
          reason: decisionReason,
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
    if (!sandbox) {
      // Without bubblewrap, allowlisted commands could reach outside the workspace unnoticed
      // (e.g. `bun build --outdir /tmp/x`). Send any Bash command that names such a path to the operator.
      options.hooks = {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              async (input: any) => {
                const outside = outsidePaths(String(input?.tool_input?.command ?? ""), cwd);
                if (!outside.length) return {};
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "ask" as const,
                    permissionDecisionReason: `names paths outside the workspace: ${outside.slice(0, 5).join(", ")}`,
                  },
                };
              },
            ],
          },
        ],
      };
    } else {
      options.sandbox = {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        ...(denyRead.length ? { filesystem: { denyRead } } : {}),
      };
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
  /** `denyRead`: absolute paths no worker may read, e.g. the Acutis API token. */
  constructor(private opts: { sandbox: boolean; denyRead?: string[] }) {}
  start(spec: AgentSpec): AgentSession {
    return new ClaudeSdkSession(spec, this.opts.sandbox, this.opts.denyRead ?? []);
  }
}
