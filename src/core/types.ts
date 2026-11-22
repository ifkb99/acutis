// Core types and provider interfaces. core/ must not import providers/ or packs/.

/** proposed: filed by a scout, waiting for the operator. held: waiting on an open decision. */
export type TicketStatus = "proposed" | "held" | "todo" | "in_progress" | "review" | "done" | "cancelled";

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
  /** "local"; "scout:<type>" for a ticket a scout filed; "scout-run:<type>" for a scout's own (hidden) runner ticket; "writer" for a ticket saved from the ticket writer; "writer-run" for a draft's own (hidden) ticket. */
  source: string;
  /** A scout's confidence in a ticket it filed. */
  confidence: "high" | "medium" | "low" | null;
  /** The open decision a held ticket waits on. */
  decision_id: number | null;
  /** The noticed report a scout turned into this ticket (marked ticketed once the ticket is accepted). */
  noticed_id: number | null;
  /**
   * The ticket this one builds on. Its run starts from that ticket's landed work, even before that
   * work is merged into trunk (land: bookmark or push), so a follow-up sees what came before it.
   */
  builds_on: number | null;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export type RunState =
  | "queued"
  | "preparing"
  | "running"
  | "paused"
  | "verifying"
  | "awaiting_review"
  | "landing"
  | "done"
  | "failed"
  | "cancelled";

export const ACTIVE_STATES: RunState[] = ["queued", "preparing", "running", "paused", "verifying", "landing"];
/** States that take one of the daemon's run slots (`maxRuns`). Paused and in-review runs don't. */
export const SLOT_STATES: RunState[] = ["preparing", "running", "verifying", "landing"];
export const TERMINAL_STATES: RunState[] = ["done", "failed", "cancelled"];

export interface Run {
  id: number;
  ticket_id: number;
  repo: string;
  /** work: a worker on a ticket (lands after review). scout: finds work, files tickets and decisions, lands nothing. writer: drafts a ticket from the operator's request, lands nothing. */
  kind: "work" | "scout" | "writer";
  /** The scout type, for scout runs. */
  scout: string | null;
  /** For a scout woken by a trunk change: JSON { from, to, paths }. */
  woken_by: string | null;
  state: RunState;
  workspace_name: string | null;
  workspace_path: string | null;
  /** Where the workspace started: trunk, or the landed work of the ticket this one builds on. */
  base_commit: string | null;
  /**
   * Trunk when the run started. Policy (.acutis/workflow.md) and contract changes are judged from
   * it, never from base_commit, which can be worker-written work not yet on trunk. Null on runs
   * from before it was recorded: base_commit was trunk then.
   */
  trunk_commit: string | null;
  session_id: string | null;
  model: string | null;
  attempt: number;
  gates_ok: number | null; // 1 pass, 0 fail, null not run
  cost_usd: number;
  /**
   * Last running total seen from the run's agent session (the SDK reports totals, not deltas).
   * Kept across restarts, so a resumed session's total is compared with what was already counted.
   */
  session_cost: number | null;
  error: string | null;
  bookmark: string | null;
  /** The commit that landed (what was approved), so tickets building on this one start from it even if the bookmark goes away. */
  landed_commit: string | null;
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
  create(input: {
    repo: string;
    title: string;
    body: string;
    source?: string;
    status?: TicketStatus;
    confidence?: Ticket["confidence"];
    decision_id?: number | null;
    noticed_id?: number | null;
    builds_on?: number | null;
  }): Ticket;
  /** Set or clear the ticket this one builds on (validated by the caller). */
  setBuildsOn(id: number, buildsOn: number | null): Ticket;
  /** Transactional claim: returns false if the ticket is not claimable. */
  claim(id: number): boolean;
  setStatus(id: number, status: TicketStatus): Ticket;
  /** Move tickets held on one decision to another (merged questions), or back to proposed (null). */
  moveHeld(fromDecision: number, toDecision: number | null): number[];
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
  /** Paths of the files tracked at a commit, relative to the repo root. */
  listFiles(repo: Repo, commit: string): Promise<string[]>;
  /** Paths matching `globs` that differ between two commits (added, changed or deleted). */
  changedBetween(repo: Repo, from: string, to: string, globs: string[]): Promise<string[]>;
  /** A git-style diff of the paths matching `globs` between two commits. */
  diffBetween(repo: Repo, from: string, to: string, globs: string[]): Promise<string>;
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
  /** True if `ancestor` is `descendant` or one of its ancestors. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): Promise<boolean>;
  /** Pick up trunk moves made outside the provider (e.g. a git pull in a colocated repo). Never fetches. */
  refresh?(repo: Repo): Promise<void>;
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
      /** Per-model running token totals for the session (main loop and subagents), when the runner reports them. */
      model_usage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>;
    }
  /** The session's background tasks changed (e.g. a subagent the agent started in the background). */
  | { kind: "agent.background"; running: number; tasks: { type: string; description: string }[] }
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
  params: Record<string, { type: "string" | "number" | "boolean"; description: string; optional?: boolean }>;
  handler: (args: Record<string, string | number | boolean | undefined>) => Promise<ToolOutput>;
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
  /** Hard spend cap for this session (scouts): the runner ends the turn with "error_max_budget_usd". */
  maxBudgetUsd?: number;
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
  /** The session's running cost total so far, mid-turn included; null if unavailable. */
  totalCost?(): Promise<number | null>;
}

export interface AgentRunner {
  readonly name: string;
  start(spec: AgentSpec): AgentSession;
}

/**
 * A short, synchronous call to a cheap model for Acutis's own work (describing docs, the
 * librarian). The session has no built-in tools, no settings or MCP servers of its own, runs in
 * an empty directory, and gets only the Acutis tools passed here: it reads untrusted repo text.
 */
export interface OneShotModel {
  ask(opts: {
    system: string;
    prompt: string;
    tools?: AcutisTool[];
    maxTurns: number;
    maxBudgetUsd: number;
    model?: string;
  }): Promise<{ text: string; costUsd: number; error?: string }>;
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
  /** Which tracked files the project library indexes; false turns the library off for the repo. */
  library:
    | {
        include: string[];
        exclude: string[];
        /** Have a cheap model write descriptions of doc sections for search (off until the A/B says otherwise). */
        describe: boolean;
        /** Spend cap for describing one commit's docs, in USD. */
        describe_budget_usd: number;
        /** Offer workers and scouts ask_librarian (a cheap model that answers from the docs, with citations). */
        librarian: boolean;
      }
    | false;
  /**
   * Contracts: files one part of the project promises to the others. `files` are the contract
   * itself, `consumers` the paths that depend on it (omitted: every change depends on it), and
   * `check` an optional command run as an extra check when a run touches either.
   */
  contracts: Record<string, Contract>;
  /**
   * Lessons: short operator-approved how-tos for this repo, put in worker and scout prompts.
   * `draft`: after a run reaches review, a cheap model may propose one from its report.
   * `budget_chars`: how much lesson text one prompt gets. false turns lessons off for the repo.
   */
  lessons: { draft: boolean; budget_chars: number } | false;
  /** Scouts the repo allows, with a focus and budget each; false turns scouts off. */
  scouts:
    | {
        /** high: high-confidence scout tickets go straight to todo. never: all wait in proposed. */
        auto_tickets: "high" | "never";
        budget_usd: number;
        types: Record<string, { enabled: boolean; focus: string; budget_usd?: number; triggers?: string[] }>;
        /** Wait this long after a trigger before waking the scout, so a burst of landings wakes it once. */
        trigger_debounce_min: number;
        /** Most trigger-woken scout runs per repo in 24 hours. */
        trigger_daily_cap: number;
      }
    | false;
}

/**
 * The decision register: a question a scout asked (open) and the operator's answer (decided) are
 * one row. A decided row is never edited; a new decision supersedes it. Decided text is always
 * written or confirmed by the operator, since it goes into every worker's prompt with their authority.
 */
export interface Decision {
  id: number;
  repo: string;
  /** Scout type or topic ("infrastructure", "tests", "general"). */
  area: string;
  question: string;
  context: string;
  /** Suggested answers, one per line. */
  options: string;
  status: "open" | "decided" | "withdrawn" | "superseded";
  /** The operator's decision text (decided/superseded rows). */
  decision: string;
  /** Who asked: a scout type, or "operator" for decisions the operator wrote directly. */
  asked_by: string;
  run_id: number | null;
  /** Bumped on every edit of an open question; an answer names the version it answers. */
  version: number;
  superseded_by: number | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

/** A question a worker searched the project's docs for and couldn't answer. */
export interface LibraryGap {
  id: number;
  repo: string;
  question: string;
  /** What the reporter searched or read before giving up. */
  tried: string;
  status: "open" | "ticketed" | "dismissed";
  count: number;
  run_ids: string;
  /** The ticket meant to close it: pending while that ticket is proposed, ticketed once accepted. */
  ticket_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface Contract {
  files: string[];
  consumers: string[] | null;
  check?: string;
}

export type NoticedKind = "bug" | "failing-check" | "tech-debt" | "docs" | "security" | "idea" | "other";
export const NOTICED_KINDS: NoticedKind[] = ["bug", "failing-check", "tech-debt", "docs", "security", "idea", "other"];

/**
 * A lesson: a short, repo-level how-to ("the harness needs the engine built first"). Agents and the
 * report-drafting model propose them; only approved ones (or operator-written ones) reach a prompt.
 */
export interface Lesson {
  id: number;
  repo: string;
  text: string;
  /** Normalised text, for dedupe across every status. */
  text_key: string;
  evidence: string;
  tags: string;
  status: "proposed" | "approved" | "rejected" | "retired";
  /** "worker", "scout:<type>", "draft" (from a run's report) or "operator". */
  source: string;
  run_id: number | null;
  /** How many runs were given it. */
  uses: number;
  /** Comma-separated paths/globs the lesson is about; null until derived from its text, "" if none. */
  paths: string | null;
  /** The trunk commit it was last checked against (approved lessons with paths). */
  seen_commit: string | null;
  /** JSON { paths, commit } once trunk changed its paths: it waits for the operator to recheck it. */
  stale: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

/** Something a worker noticed outside its ticket. Reports with the same title in a repo are merged. */
export interface Noticed {
  id: number;
  repo: string;
  kind: NoticedKind;
  title: string;
  detail: string;
  evidence: string;
  status: "open" | "dismissed" | "ticketed";
  /** How many reports were merged into this one, and from which runs (comma-separated ids). */
  count: number;
  run_ids: string;
  ticket_id: number | null;
  created_at: string;
  updated_at: string;
}
