// Core types and provider interfaces. core/ must not import providers/ or packs/.

export type TicketStatus = "todo" | "in_progress" | "review" | "done" | "cancelled";

export interface Repo {
  name: string;
  path: string;
  /** jj revset naming the trunk to branch from, e.g. "main". */
  base: string;
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
  /** Describe the workspace's change and point a bookmark at it. */
  land(repo: Repo, ws: Workspace, opts: { message: string; bookmark: string; push: boolean }): Promise<void>;
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
  canAlwaysAllow: boolean;
}

export type PermissionDecision =
  | { behavior: "allow"; always?: boolean }
  | { behavior: "deny"; message?: string };

export interface AgentSpec {
  cwd: string;
  prompt: string;
  systemAppend: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  allow: string[];
  deny: string[];
  resumeSessionId?: string;
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

// ---- Workflow / policy -------------------------------------------------------

export interface Gate {
  name: string;
  run: string;
  timeout_s?: number;
}

export interface Workflow {
  model?: string;
  effort?: AgentSpec["effort"];
  gates: Gate[];
  allow: string[];
  deny: string[];
  max_attempts: number;
  land: "bookmark" | "push";
  template: string;
  /** Where the workflow came from, for display. */
  source: string;
}
