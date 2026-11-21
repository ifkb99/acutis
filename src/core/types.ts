// Core types and provider interfaces. core/ must not import providers/ or packs/.

export type TicketStatus = "todo" | "in_progress" | "review" | "done" | "cancelled";

export interface Repo {
  name: string;
  path: string;
  /** jj revset naming the trunk to branch from, e.g. "main". */
  base: string;
  /** Operator guidance for workers on this repo. Lives in Acutis's DB, outside any worker's reach. */
  notes: string;
  created_at: string;
}

export interface Ticket {
  id: number;
  repo: string;
  title: string;
  body: string;
  status: TicketStatus;
  source: string;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export type RunState =
  | "preparing"
  | "running"
  | "paused"
  | "verifying"
  | "awaiting_review"
  | "landing"
  | "done"
  | "failed"
  | "cancelled";

export const ACTIVE_STATES: RunState[] = ["preparing", "running", "paused", "verifying", "landing"];
export const TERMINAL_STATES: RunState[] = ["done", "failed", "cancelled"];

export interface Run {
  id: number;
  ticket_id: number;
  repo: string;
  state: RunState;
  workspace_name: string | null;
  workspace_path: string | null;
  base_commit: string | null;
  session_id: string | null;
  model: string | null;
  attempt: number;
  gates_ok: number | null; // 1 pass, 0 fail, null not run
  cost_usd: number;
  error: string | null;
  bookmark: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunEvent {
  id: number;
  run_id: number;
  ts: string;
  kind: string;
  data: Record<string, unknown>;
}

// ---- Ticket source ---------------------------------------------------------

export interface TicketSource {
  readonly name: string;
  list(filter?: { repo?: string; status?: TicketStatus }): Ticket[];
  get(id: number): Ticket | null;
  create(input: { repo: string; title: string; body: string }): Ticket;
  /** Transactional claim: returns false if the ticket is not claimable. */
  claim(id: number): boolean;
  setStatus(id: number, status: TicketStatus): Ticket;
}

// ---- Workspaces -------------------------------------------------------------

export interface Workspace {
  name: string;
  path: string;
  baseCommit: string;
}

export interface WorkspaceProvider {
  /** Resolve a revset to a single commit id in the repo. */
  resolve(repo: Repo, revset: string): Promise<string>;
  /** Read a file at a given commit, or null if it doesn't exist. */
  readAt(repo: Repo, commit: string, file: string): Promise<string | null>;
  create(repo: Repo, name: string, baseCommit: string): Promise<Workspace>;
  diff(repo: Repo, ws: Workspace): Promise<string>;
  changedFiles(repo: Repo, ws: Workspace): Promise<string[]>;
  /** Describe the workspace's change and, if given, point a bookmark at it (and push it). */
  land(repo: Repo, ws: Workspace, opts: { message: string; bookmark: string | null; push: boolean }): Promise<void>;
  /**
   * Rebase the workspace's change onto the current trunk commit. Returns the files left in
   * conflict (empty on success) and whether the change actually moved.
   */
  rebase(repo: Repo, ws: Workspace, onto: string): Promise<{ moved: boolean; conflicts: string[] }>;
  /** Move a trunk bookmark forward to the workspace's change. Fails if that isn't a fast-forward. */
  advance(repo: Repo, ws: Workspace, bookmark: string): Promise<void>;
  /** True if `name` is a local bookmark in the repo. */
  isBookmark(repo: Repo, name: string): Promise<boolean>;
  /** Forget the workspace and delete its directory. Keeps the change unless abandon=true. */
  destroy(repo: Repo, ws: Workspace, opts: { abandon: boolean }): Promise<void>;
}

// ---- Agents -----------------------------------------------------------------

export type AgentEvent =
  | { kind: "agent.init"; session_id: string; model: string; sandboxed: boolean }
  | { kind: "agent.text"; text: string }
  | { kind: "agent.tool_use"; id: string; name: string; input: unknown }
  | { kind: "agent.tool_result"; tool_use_id: string; content: string; is_error: boolean }
  | {
      kind: "agent.result";
      subtype: string;
      result: string;
      is_error: boolean;
      cost_usd: number;
      turns: number;
      duration_ms: number;
      errors?: string[];
    }
  | { kind: "agent.exit"; error?: string };

export interface PermissionRequest {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  blockedPath?: string;
  /** Why the runner asked (e.g. "names paths outside the workspace: /tmp/x"). */
  reason?: string;
  canAlwaysAllow: boolean;
}

export type PermissionDecision =
  | { behavior: "allow"; always?: boolean }
  | { behavior: "deny"; message?: string };

/** What a factory-owned tool returns to the agent. */
export interface ToolOutput {
  text: string;
  images?: { data: string; mimeType: string }[];
  isError?: boolean;
}

/**
 * A tool Acutis gives the worker (served in-process, never an external MCP server).
 * Parameters are flat and string/number only so any runner can expose them.
 */
export interface AcutisTool {
  name: string;
  description: string;
  params: Record<string, { type: "string" | "number"; description: string; optional?: boolean }>;
  handler: (args: Record<string, string | number | undefined>) => Promise<ToolOutput>;
}

export interface AgentSpec {
  cwd: string;
  prompt: string;
  systemAppend: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  allow: string[];
  deny: string[];
  resumeSessionId?: string;
  /** Factory-owned tools (preview, browser) offered to the worker. */
  tools?: AcutisTool[];
  /** Called when a tool call needs a human decision. */
  onPermission: (req: PermissionRequest) => Promise<PermissionDecision>;
}

export interface AgentSession {
  readonly events: AsyncIterable<AgentEvent>;
  /** Queue a user message; it reaches the agent after in-flight tool calls finish. */
  send(text: string): void;
  /** Stop the current response; the session stays open. */
  interrupt(): Promise<void>;
  /** End the session and its process. */
  close(): void;
}

export interface AgentRunner {
  readonly name: string;
  start(spec: AgentSpec): AgentSession;
}

// ---- Browser ---------------------------------------------------------------

export interface BrowserCheck {
  /** Absolute URL to open. Requests to any other origin are blocked. */
  url: string;
  steps?: string;
  script?: string;
  width?: number;
  height?: number;
}

export interface BrowserResult {
  ok: boolean;
  /** PNG, base64. */
  screenshot?: string;
  console: string[];
  errors: string[];
  blocked: string[];
  scriptResult?: string;
  failure?: string;
}

export interface BrowserProvider {
  readonly available: boolean;
  check(c: BrowserCheck): Promise<BrowserResult>;
}

/**
 * Confines commands that execute worker-written code (gates, the preview server) the way the
 * agent's own Bash is confined: the workspace is the only writable path, Acutis's own data is
 * hidden, and the command gets an empty network namespace, so it can reach neither the internet
 * nor anything on the host's localhost (the Acutis API included).
 */
export interface CommandSandbox {
  /**
   * argv that runs `command` (a `sh -c` string) in `cwd`, confined. With `expose`, connections to
   * the Unix socket `expose.socket` (created by the sandbox) reach 127.0.0.1:`expose.port` inside
   * it. That is how the preview server is served to the host without sharing its network.
   */
  wrap(command: string, cwd: string, opts?: { expose?: { port: number; socket: string } }): string[];
}

// ---- Workflow / policy -------------------------------------------------------

export interface CommandGate {
  kind: "cmd";
  name: string;
  run: string;
  timeout_s?: number;
}

/** Load a page of the run's preview in headless Chrome; fails on page errors or a failing script. */
export interface BrowserGate {
  kind: "browser";
  name: string;
  path: string;
  /** One action per line: "press ArrowLeft", "click #id", "type text", "wait 200", "waitfor #id". */
  steps?: string;
  /** JS expression evaluated in the page after the steps; a falsy result or a throw fails the gate. */
  script?: string;
  width?: number;
  height?: number;
}

export type Gate = CommandGate | BrowserGate;

/** A dev server Acutis starts for a run (it owns the process, the agent gets a URL). */
export interface PreviewSpec {
  /** Shell command; Acutis sets $PORT (and $BUN_PORT) to a free port. */
  run: string;
  /** Path to open by default, e.g. "/". */
  path: string;
  ready_timeout_s: number;
}

export interface Workflow {
  model?: string;
  effort?: AgentSpec["effort"];
  /** Commands run in a fresh workspace before the agent starts (e.g. "bun install"). */
  setup: CommandGate[];
  gates: Gate[];
  preview?: PreviewSpec;
  allow: string[];
  deny: string[];
  max_attempts: number;
  /** Auto-deny a permission request nobody answered within this many seconds (unset: wait forever). */
  permission_timeout_s?: number;
  /** bookmark: set acutis/<id>-<slug>. push: also push it. trunk: rebase onto trunk, re-check, advance trunk. */
  land: "bookmark" | "push" | "trunk";
  template: string;
  /** Where the workflow came from, for display. */
  source: string;
}
