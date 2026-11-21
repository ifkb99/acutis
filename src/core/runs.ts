import type { Subprocess } from "bun";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { Store } from "./db";
import type { Hub } from "./hub";
import { PreviewManager } from "./preview";
import type {
  AcutisTool,
  AgentRunner,
  AgentSession,
  BrowserGate,
  BrowserProvider,
  CommandGate,
  Gate,
  PermissionDecision,
  PermissionRequest,
  Repo,
  Run,
  RunState,
  Ticket,
  TicketSource,
  ToolOutput,
  Workflow,
  Workspace,
  WorkspaceProvider,
} from "./types";
import { ACTIVE_STATES, TERMINAL_STATES } from "./types";
import { WORKFLOW_PATH, defaultWorkflow, describeGate, parseWorkflow, renderTemplate, workerSystemPrompt } from "./workflow";

export class RunError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

interface PendingPermission {
  req: PermissionRequest;
  resolve: (d: PermissionDecision) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface Active {
  repo: Repo;
  ticket: Ticket;
  workflow: Workflow;
  ws: Workspace;
  session: AgentSession | null;
  /** Set right before we interrupt or close, so the resulting agent events aren't treated as failures. */
  intent: "pause" | "redirect" | "kill" | "close" | null;
  permissions: Map<string, PendingPermission>;
  /** The check process currently running, if any. */
  gate: Subprocess | null;
  /** Last cumulative cost the live session reported (the SDK reports running totals, not deltas). */
  costSeen: number | null;
  /** Whether the live session was resumed from an earlier one. */
  resumed: boolean;
}

function killGroup(proc: Subprocess) {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
}

const GATE_OUTPUT_CHARS = 8000;
const MAX_NOTE_IMAGE_BYTES = 8 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "change";
}

function tail(s: string, n: number): string {
  return s.length > n ? `… [${s.length - n} chars omitted]\n` + s.slice(-n) : s;
}

/**
 * Cost to add for one result. `total` is the session's running total; a resumed session usually
 * continues from the total saved in its transcript, but may restart from zero.
 */
export function costDelta(total: number, lastSeen: number | null, resumed: boolean, runCost: number): number {
  if (lastSeen === null) {
    if (!resumed) return total;
    return total >= runCost ? total - runCost : total;
  }
  return total >= lastSeen ? total - lastSeen : total;
}

const unavailableBrowser: BrowserProvider = {
  available: false,
  check: async () => ({ ok: false, console: [], errors: [], blocked: [], failure: "no browser available" }),
};

export class RunManager {
  private active = new Map<number, Active>();
  private landing = new Map<string, Promise<unknown>>();
  readonly previews = new PreviewManager();
  private browser: BrowserProvider;

  constructor(
    private deps: {
      store: Store;
      hub: Hub;
      tickets: TicketSource;
      workspaces: WorkspaceProvider;
      runner: AgentRunner;
      browser?: BrowserProvider;
      /** Where screenshots and note images are stored. */
      artifactsDir?: string;
    },
  ) {
    this.browser = deps.browser ?? unavailableBrowser;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Called once at daemon start: detach runs whose agent process died with the old daemon. */
  recover() {
    for (const run of this.deps.store.listRuns(1000)) {
      if (run.state === "preparing") this.setState(run.id, "failed", "daemon restarted during preparation");
      else if (run.state === "running" || run.state === "verifying") {
        this.setState(run.id, "paused", "daemon restarted; press Resume to continue the session");
      } else if (run.state === "landing") {
        this.setState(run.id, "awaiting_review", "daemon restarted while landing; approve again");
      }
    }
  }

  /** Stop everything this manager started (daemon shutdown). */
  shutdown() {
    this.previews.stopAll();
    for (const a of this.active.values()) {
      if (a.gate) killGroup(a.gate);
      if (a.session) {
        a.intent = "close";
        a.session.close();
      }
    }
  }

  pendingPermissions(runId: number): PermissionRequest[] {
    return [...(this.active.get(runId)?.permissions.values() ?? [])].map((p) => p.req);
  }

  /** Every pending permission request across runs (for the CLI and notifications). */
  allPendingPermissions(): { runId: number; req: PermissionRequest }[] {
    const out: { runId: number; req: PermissionRequest }[] = [];
    for (const [runId, a] of this.active) for (const p of a.permissions.values()) out.push({ runId, req: p.req });
    return out;
  }

  isLive(runId: number): boolean {
    return Boolean(this.active.get(runId)?.session);
  }

  async start(ticketId: number): Promise<Run> {
    const { store, tickets, hub } = this.deps;
    const ticket = tickets.get(ticketId);
    if (!ticket) throw new RunError(`ticket #${ticketId} not found`, 404);
    const repo = store.getRepo(ticket.repo);
    if (!repo) throw new RunError(`repo "${ticket.repo}" is not registered`, 404);
    if (!tickets.claim(ticketId)) throw new RunError(`ticket #${ticketId} is not in "todo"`, 409);
    hub.ticket(tickets.get(ticketId)!);

    const run = store.createRun({ ticket_id: ticketId, repo: repo.name, state: "preparing" });
    hub.run(run);
    hub.emit(run.id, "run.state", { from: null, to: "preparing" });
    this.prepare(run, repo, ticket).catch((e) => this.fail(run.id, e));
    return run;
  }

  private async loadWorkflow(repo: Repo, commit: string): Promise<Workflow> {
    const text = await this.deps.workspaces.readAt(repo, commit, WORKFLOW_PATH);
    return text ? parseWorkflow(text, `${WORKFLOW_PATH}@${commit.slice(0, 12)}`) : defaultWorkflow();
  }

  private async prepare(run: Run, repo: Repo, ticket: Ticket) {
    const { workspaces, hub, store } = this.deps;
    const base = await workspaces.resolve(repo, repo.base);
    // Policy always comes from trunk, never from the workspace the agent can edit.
    const workflow = await this.loadWorkflow(repo, base);
    hub.emit(run.id, "system.log", {
      msg: `Workflow from ${workflow.source}; base ${repo.base} = ${base.slice(0, 12)}`,
      gates: workflow.gates.map(describeGate),
    });
    const ws = await workspaces.create(repo, `acutis-t${ticket.id}-r${run.id}`, base);
    hub.run(
      store.updateRun(run.id, {
        workspace_name: ws.name,
        workspace_path: ws.path,
        base_commit: base,
        model: workflow.model ?? null,
      }),
    );
    hub.emit(run.id, "system.log", { msg: `Workspace ${ws.name} at ${ws.path}` });
    if (this.mustGet(run.id).state !== "preparing") return; // killed while preparing; workspace kept for discard
    const a: Active = {
      repo,
      ticket,
      workflow,
      ws,
      session: null,
      intent: null,
      permissions: new Map(),
      gate: null,
      costSeen: null,
      resumed: false,
    };
    this.active.set(run.id, a);

    for (const step of workflow.setup) {
      const r = await this.runCommand(run.id, a, step, "setup", () => this.mustGet(run.id).state === "preparing");
      if (this.mustGet(run.id).state !== "preparing") return;
      if (!r.ok) throw new Error(`setup step failed: ${step.run} (exit ${r.code})`);
    }
    this.launch(run.id, renderTemplate(workflow.template, ticket));
  }

  /** Rebuild in-memory state for a run whose session is not live (after restart, review, or failure). */
  private async rehydrate(runId: number): Promise<Active> {
    const existing = this.active.get(runId);
    if (existing) return existing;
    const run = this.mustGet(runId);
    const repo = this.deps.store.getRepo(run.repo);
    const ticket = this.deps.tickets.get(run.ticket_id);
    if (!repo || !ticket || !run.workspace_path || !run.workspace_name || !run.base_commit) {
      throw new RunError(`run ${runId} has no workspace to continue in`, 409);
    }
    const workflow = await this.loadWorkflow(repo, run.base_commit);
    const a: Active = {
      repo,
      ticket,
      workflow,
      ws: { name: run.workspace_name, path: run.workspace_path, baseCommit: run.base_commit },
      session: null,
      intent: null,
      permissions: new Map(),
      gate: null,
      costSeen: null,
      resumed: false,
    };
    this.active.set(runId, a);
    return a;
  }

  private launch(runId: number, prompt: string, resumeSessionId?: string) {
    const a = this.active.get(runId)!;
    const run = this.mustGet(runId);
    // Re-read the repo so operator notes edited since the run started reach the next session.
    a.repo = this.deps.store.getRepo(a.repo.name) ?? a.repo;
    const session = this.deps.runner.start({
      cwd: a.ws.path,
      prompt,
      systemAppend: workerSystemPrompt({ ticket: a.ticket, cwd: a.ws.path, workflow: a.workflow, repo: a.repo }),
      model: a.workflow.model,
      effort: a.workflow.effort,
      allow: a.workflow.allow,
      deny: a.workflow.deny,
      resumeSessionId,
      tools: this.agentTools(runId),
      onPermission: (req) => this.requestPermission(runId, req),
    });
    a.session = session;
    a.intent = null;
    a.costSeen = null;
    a.resumed = Boolean(resumeSessionId);
    if (this.deps.tickets.get(run.ticket_id)?.status !== "in_progress") {
      this.deps.hub.ticket(this.deps.tickets.setStatus(run.ticket_id, "in_progress"));
    }
    this.setState(runId, "running", resumeSessionId ? "session resumed" : undefined);
    this.consume(runId, session).catch((e) => this.fail(runId, e));
  }

  private async consume(runId: number, session: AgentSession) {
    const { hub, store } = this.deps;
    for await (const ev of session.events) {
      const a = this.active.get(runId);
      if (!a || a.session !== session) return; // superseded or killed
      switch (ev.kind) {
        case "agent.init":
          hub.run(store.updateRun(runId, { session_id: ev.session_id, model: ev.model }));
          hub.emit(runId, ev.kind, { ...ev });
          break;
        case "agent.result": {
          const run = this.mustGet(runId);
          const delta = costDelta(ev.cost_usd, a.costSeen, a.resumed, run.cost_usd);
          a.costSeen = ev.cost_usd;
          // cost_usd stays the SDK's running total; turn_cost_usd is what this turn added.
          hub.emit(runId, ev.kind, { ...ev, turn_cost_usd: delta });
          hub.run(store.updateRun(runId, { cost_usd: run.cost_usd + delta }));
          const intent = a.intent;
          if (intent === "pause") {
            a.intent = null;
            this.setState(runId, "paused", "paused by operator");
          } else if (intent === "redirect") {
            a.intent = null; // the redirect message is queued and starts the next turn
          } else if (intent === "kill" || intent === "close") {
            // ignore
          } else if (ev.subtype === "success") {
            await this.verify(runId);
          } else {
            this.closeSession(a);
            this.fail(runId, new Error(`agent ended with "${ev.subtype}"${ev.errors?.length ? `: ${ev.errors.join("; ")}` : ""}`));
          }
          break;
        }
        case "agent.exit": {
          const intended = a.intent === "kill" || a.intent === "close";
          a.session = null;
          if (!intended && ACTIVE_STATES.includes(this.mustGet(runId).state)) {
            this.fail(runId, new Error(ev.error ?? "agent process exited unexpectedly"));
          } else if (ev.error && !intended) {
            hub.emit(runId, "system.log", { level: "warn", msg: `agent exited: ${ev.error}` });
          }
          return;
        }
        default:
          hub.emit(runId, ev.kind, { ...ev });
      }
    }
  }

  private closeSession(a: Active) {
    if (!a.session) return;
    a.intent = "close";
    a.session.close();
    a.session = null;
    this.denyPending(a, "session closed");
  }

  /** Interrupting a turn abandons any tool call waiting for approval. */
  private denyPending(a: Active, message: string) {
    for (const [id, p] of a.permissions) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve({ behavior: "deny", message });
      this.deps.hub.emit(this.runIdOf(a), "permission.decision", { id, tool: p.req.tool, behavior: "deny", message });
    }
    a.permissions.clear();
  }

  private runIdOf(a: Active): number {
    for (const [id, v] of this.active) if (v === a) return id;
    return -1;
  }

  // ------------------------------------------------------------- checks

  /** Run one shell command in the workspace (a setup step or a gate), emitting events. */
  private async runCommand(
    runId: number,
    a: Active,
    step: CommandGate,
    phase: "setup" | "gate",
    /** If this turns false while the command runs (e.g. the run was killed), its result isn't reported. */
    alive: () => boolean = () => true,
  ): Promise<{ ok: boolean; code: number; output: string }> {
    const { hub } = this.deps;
    hub.emit(runId, `${phase}.start`, { name: step.name, run: step.run });
    const t0 = Date.now();
    // setsid makes the command its own process group so a kill or timeout takes its children too.
    const proc = Bun.spawn(["setsid", "sh", "-c", step.run], {
      cwd: a.ws.path,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CI: "1" },
    });
    a.gate = proc;
    const timer = setTimeout(() => killGroup(proc), (step.timeout_s ?? 600) * 1000);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    clearTimeout(timer);
    a.gate = null;
    const output = tail(`${out}${err ? `\n${err}` : ""}`.trim(), GATE_OUTPUT_CHARS);
    const ok = code === 0;
    if (alive()) {
      hub.emit(runId, `${phase}.result`, { name: step.name, run: step.run, ok, exit_code: code, duration_ms: Date.now() - t0, output });
    }
    return { ok, code, output };
  }

  private async runBrowserGate(runId: number, a: Active, gate: BrowserGate): Promise<{ ok: boolean; output: string }> {
    const { hub } = this.deps;
    const label = describeGate(gate);
    hub.emit(runId, "gate.start", { name: gate.name, run: label });
    const t0 = Date.now();
    let ok = false;
    let output = "";
    let artifact: string | undefined;
    try {
      const { origin } = await this.previews.ensure(runId, a.ws.path, a.workflow.preview!);
      const r = await this.browser.check({ url: origin + gate.path, steps: gate.steps, script: gate.script, width: gate.width, height: gate.height });
      if (r.screenshot) artifact = this.saveArtifact(runId, r.screenshot, `check: ${gate.name}`, "gate");
      ok = r.ok;
      output = formatBrowserResult(r);
    } catch (e) {
      output = (e as Error).message;
    }
    hub.emit(runId, "gate.result", { name: gate.name, run: label, ok, exit_code: ok ? 0 : 1, duration_ms: Date.now() - t0, output, artifact });
    return { ok, output };
  }

  /** Run every gate; returns failure descriptions, or null if the run left `state` meanwhile. */
  private async runGates(runId: number, a: Active, state: RunState): Promise<string[] | null> {
    const still = () => this.mustGet(runId).state === state;
    const failures: string[] = [];
    for (const gate of a.workflow.gates) {
      if (!still()) return null;
      const r = gate.kind === "cmd" ? await this.runCommand(runId, a, gate, "gate", still) : await this.runBrowserGate(runId, a, gate);
      if (!still()) return null;
      if (!r.ok) failures.push(`$ ${describeGate(gate)}${"code" in r ? `  (exit ${r.code})` : ""}\n${r.output}`);
    }
    return failures;
  }

  private async verify(runId: number) {
    const a = this.active.get(runId)!;
    const { hub, store, workspaces } = this.deps;
    this.setState(runId, "verifying");

    const changed = await workspaces.changedFiles(a.repo, a.ws);
    if (changed.length === 0) hub.emit(runId, "system.log", { level: "warn", msg: "The agent made no changes." });
    // .acutis/ is Acutis policy; .claude/ is loaded by resumed sessions (settingSources: project).
    const policyFiles = changed.filter((f) => f.startsWith(".acutis/") || f.startsWith(".claude/"));
    if (policyFiles.length) {
      hub.emit(runId, "policy.flag", { msg: "This change edits agent policy files (.acutis/ or .claude/). Review them carefully.", files: policyFiles });
    }

    const failures = await this.runGates(runId, a, "verifying");
    if (failures === null) return;
    const run = this.mustGet(runId);
    if (failures.length && run.attempt < a.workflow.max_attempts && a.session) {
      hub.run(store.updateRun(runId, { attempt: run.attempt + 1, gates_ok: 0 }));
      const feedback = `Acutis ran the checks and ${failures.length} failed. Fix the cause (don't weaken the checks), then summarize again.\n\n${failures.join("\n\n")}`;
      hub.emit(runId, "user.message", { text: feedback, mode: "gate-feedback", by: "acutis" });
      this.setState(runId, "running", `checks failed; attempt ${run.attempt + 1} of ${a.workflow.max_attempts}`);
      a.session.send(feedback);
      return;
    }

    hub.run(store.updateRun(runId, { gates_ok: a.workflow.gates.length ? (failures.length ? 0 : 1) : null }));
    this.closeSession(a);
    this.setState(runId, "awaiting_review", failures.length ? "checks still failing after max attempts" : undefined);
    hub.ticket(this.deps.tickets.setStatus(run.ticket_id, "review"));
  }

  // ------------------------------------------------------------ agent tools

  private agentTools(runId: number): AcutisTool[] {
    const tools: AcutisTool[] = [];
    const a = () => {
      const x = this.active.get(runId);
      if (!x) throw new Error("run is not active");
      return x;
    };
    const wf = this.active.get(runId)?.workflow;
    if (!wf?.preview) return tools;
    tools.push({
      name: "preview",
      description:
        "Start (if needed) the repo's preview/dev server that Acutis runs for this workspace, and return its URL and recent server logs. Don't start servers yourself.",
      params: {},
      handler: async (): Promise<ToolOutput> => {
        const x = a();
        const { url } = await this.previews.ensure(runId, x.ws.path, x.workflow.preview!);
        const logs = this.previews.info(runId)?.logs.slice(-40).join("\n") ?? "";
        return { text: `Preview is running at ${url}\n\nRecent server output:\n${logs || "(none)"}` };
      },
    });
    if (this.browser.available) {
      tools.push({
        name: "browser",
        description:
          "Open a page of this workspace's preview in headless Chrome and return a screenshot, console output and page errors. " +
          "Optional `steps`, one per line: `press <Key>` (e.g. ArrowLeft, Enter, a), `click <css selector>`, `type <text>`, `wait <ms>`, `waitfor <css selector>`, `swipe left|right|up|down [selector]`. " +
          "Optional `script`: a JS expression evaluated in the page after the steps (may be async); its value is returned. Only the preview's own origin is reachable.",
        params: {
          path: { type: "string", description: 'Path on the preview, e.g. "/" or "/settings". Defaults to the preview path.', optional: true },
          steps: { type: "string", description: "Actions to perform, one per line.", optional: true },
          script: { type: "string", description: "JS expression to evaluate after the steps.", optional: true },
          width: { type: "number", description: "Viewport width in px (default 1024; use ~390 for phone).", optional: true },
          height: { type: "number", description: "Viewport height in px (default 768).", optional: true },
        },
        handler: async (args): Promise<ToolOutput> => {
          const x = a();
          const { origin } = await this.previews.ensure(runId, x.ws.path, x.workflow.preview!);
          const path = typeof args.path === "string" && args.path ? args.path : x.workflow.preview!.path;
          const url = previewUrl(origin, path);
          if (!url) return { text: `path must be a path on the preview (like "/" or "/page"), got ${JSON.stringify(path)}`, isError: true };
          const r = await this.browser.check({
            url,
            steps: typeof args.steps === "string" ? args.steps : undefined,
            script: typeof args.script === "string" ? args.script : undefined,
            width: typeof args.width === "number" ? args.width : undefined,
            height: typeof args.height === "number" ? args.height : undefined,
          });
          if (r.screenshot) this.saveArtifact(runId, r.screenshot, `agent: browser ${path}`, "agent");
          return {
            text: formatBrowserResult(r),
            images: r.screenshot ? [{ data: r.screenshot, mimeType: "image/png" }] : undefined,
            isError: !r.ok && !r.screenshot,
          };
        },
      });
    }
    return tools;
  }

  /** Start the run's preview for a human reviewer. */
  async preview(runId: number): Promise<{ url: string }> {
    const run = this.mustGet(runId);
    if (TERMINAL_STATES.includes(run.state)) throw new RunError(`run is ${run.state}`, 409);
    const a = await this.rehydrate(runId);
    if (!a.workflow.preview) throw new RunError(`repo has no "preview" command in ${WORKFLOW_PATH}`, 409);
    try {
      const { url } = await this.previews.ensure(runId, a.ws.path, a.workflow.preview);
      return { url };
    } catch (e) {
      throw new RunError((e as Error).message, 500);
    }
  }

  // ------------------------------------------------------------ artifacts & notes

  private artifactDir(runId: number): string | null {
    return this.deps.artifactsDir ? `${this.deps.artifactsDir}/run-${runId}` : null;
  }

  /** Store a PNG (base64) for the run and announce it. Returns the artifact name. */
  saveArtifact(runId: number, pngBase64: string, caption: string, source: "gate" | "agent" | "operator"): string | undefined {
    const dir = this.artifactDir(runId);
    if (!dir) return undefined;
    mkdirSync(dir, { recursive: true });
    const name = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.png`;
    writeFileSync(`${dir}/${name}`, Buffer.from(pngBase64, "base64"));
    this.deps.hub.emit(runId, "artifact", { name, caption, source });
    return name;
  }

  /** Path of a stored artifact, or null. Names are server-generated; anything else is refused. */
  artifactPath(runId: number, name: string): string | null {
    const dir = this.artifactDir(runId);
    if (!dir || !/^[a-z0-9]+-[a-f0-9]{8}\.png$/.test(name)) return null;
    const p = `${dir}/${name}`;
    return existsSync(p) ? p : null;
  }

  /** A reviewer's note on a run, optionally with a PNG. Not sent to the agent. */
  addNote(runId: number, text: string, imageBase64?: string, by = "operator") {
    this.mustGet(runId);
    if (!text.trim() && !imageBase64) throw new RunError("note is empty");
    let artifact: string | undefined;
    if (imageBase64) {
      const bytes = Buffer.from(imageBase64, "base64");
      if (bytes.length > MAX_NOTE_IMAGE_BYTES) throw new RunError("image is too large (max 8 MB)", 413);
      if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) throw new RunError("image must be a PNG", 415);
      artifact = this.saveArtifact(runId, imageBase64, text.trim().slice(0, 80) || "note", "operator");
    }
    return this.deps.hub.emit(runId, "review.note", { text: text.trim(), artifact, by });
  }

  // ------------------------------------------------------------ permissions

  private requestPermission(runId: number, req: PermissionRequest): Promise<PermissionDecision> {
    const a = this.active.get(runId);
    if (!a) return Promise.resolve({ behavior: "deny", message: "run not active" });
    return new Promise((resolve) => {
      const p: PendingPermission = { req, resolve };
      const t = a.workflow.permission_timeout_s;
      if (t) {
        p.timer = setTimeout(() => {
          if (!a.permissions.has(req.id)) return;
          a.permissions.delete(req.id);
          const message = `No operator answered within ${Math.round(t / 60) || 1} min, so Acutis denied this. Work around it if you can; otherwise say in your summary what you needed.`;
          this.deps.hub.emit(runId, "permission.decision", { id: req.id, tool: req.tool, behavior: "deny", message, by: "timeout" });
          resolve({ behavior: "deny", message });
        }, t * 1000);
      }
      a.permissions.set(req.id, p);
      this.deps.hub.emit(runId, "permission.request", { ...req });
    });
  }

  decidePermission(runId: number, reqId: string, decision: PermissionDecision) {
    const a = this.active.get(runId);
    const p = a?.permissions.get(reqId);
    if (!a || !p) throw new RunError("no such pending permission request", 404);
    if (p.timer) clearTimeout(p.timer);
    a.permissions.delete(reqId);
    this.deps.hub.emit(runId, "permission.decision", { id: reqId, tool: p.req.tool, ...decision });
    p.resolve(decision);
  }

  // ---------------------------------------------------------- operator actions

  async pause(runId: number) {
    const a = this.active.get(runId);
    const run = this.mustGet(runId);
    if (run.state !== "running" || !a?.session) throw new RunError(`can't pause a run that is ${run.state}`, 409);
    a.intent = "pause";
    this.denyPending(a, "paused by operator");
    await a.session.interrupt();
  }

  async resume(runId: number) {
    const run = this.mustGet(runId);
    if (run.state !== "paused") throw new RunError(`can't resume a run that is ${run.state}`, 409);
    await this.message(runId, "Continue working on the ticket.");
  }

  /** Queue a message. If the session is not live, resume it with this message. */
  async message(runId: number, text: string, mode: "message" | "redirect" = "message") {
    if (!text.trim()) throw new RunError("message is empty");
    const run = this.mustGet(runId);
    if (run.state === "verifying" || run.state === "landing" || run.state === "preparing") {
      throw new RunError(`wait: run is ${run.state}`, 409);
    }
    if (run.state === "done" || run.state === "cancelled") throw new RunError(`run is ${run.state}`, 409);

    const a = this.active.get(runId);
    this.deps.hub.emit(runId, "user.message", { text, mode, by: "operator" });

    if (a?.session) {
      if (mode === "redirect" && run.state === "running") {
        a.intent = "redirect";
        this.denyPending(a, "operator redirected the agent");
        await a.session.interrupt();
      }
      a.session.send(text);
      if (run.state === "paused") this.setState(runId, "running", "resumed by message");
      return;
    }

    // No live session: paused after restart, failed, or awaiting review ("send back with a note").
    if (!run.session_id) throw new RunError("run has no session to resume", 409);
    await this.rehydrate(runId);
    if (run.state === "awaiting_review" || run.state === "failed") {
      this.deps.store.updateRun(runId, { attempt: 1, error: null });
    }
    this.launch(runId, text, run.session_id);
  }

  async redirect(runId: number, text: string) {
    return this.message(runId, text, "redirect");
  }

  async kill(runId: number) {
    const run = this.mustGet(runId);
    if (!ACTIVE_STATES.includes(run.state) && run.state !== "awaiting_review") {
      throw new RunError(`run is already ${run.state}`, 409);
    }
    if (run.state === "landing") throw new RunError("run is landing; wait for it to finish", 409);
    const a = this.active.get(runId);
    if (a) {
      if (a.session) {
        a.intent = "kill";
        a.session.close();
        a.session = null;
      }
      this.denyPending(a, "run killed");
      if (a.gate) killGroup(a.gate);
    }
    this.setState(runId, "cancelled", "killed by operator; workspace kept until discarded");
    this.releaseTicket(run.ticket_id);
  }

  async approve(runId: number) {
    const run = this.mustGet(runId);
    if (run.state !== "awaiting_review") throw new RunError(`can't approve a run that is ${run.state}`, 409);
    const a = await this.rehydrate(runId);
    this.setState(runId, "landing");
    // Landings in one repo are serialised: each trunk landing must see the previous one.
    const prev = this.landing.get(a.repo.name) ?? Promise.resolve();
    const mine = prev.catch(() => {}).then(() => this.land(runId, a));
    this.landing.set(a.repo.name, mine);
    try {
      await mine;
    } finally {
      if (this.landing.get(a.repo.name) === mine) this.landing.delete(a.repo.name);
    }
  }

  private async land(runId: number, a: Active) {
    const { workspaces, hub, store } = this.deps;
    const message = `${a.ticket.title}\n\nAcutis-Ticket: #${a.ticket.id}\nAcutis-Run: ${runId}\n`;
    const back = (reason: string, status = 409): never => {
      hub.emit(runId, "system.log", { level: "error", msg: `landing stopped: ${reason}` });
      this.previews.stop(runId);
      this.setState(runId, "awaiting_review", "landing stopped");
      throw new RunError(`landing stopped: ${reason}`, status);
    };
    let bookmark: string;
    try {
      if (a.workflow.land === "trunk") {
        if (!(await workspaces.isBookmark(a.repo, a.repo.base))) {
          return back(`land: trunk needs the repo's base ("${a.repo.base}") to be a bookmark`);
        }
        await workspaces.land(a.repo, a.ws, { message, bookmark: null, push: false });
        const trunk = await workspaces.resolve(a.repo, a.repo.base);
        const { moved, conflicts } = await workspaces.rebase(a.repo, a.ws, trunk);
        if (moved) {
          // The change now sits on the new trunk: diffs, changed-file checks and policy loading
          // must be relative to it, or other tickets' work shows up as this run's.
          a.ws = { ...a.ws, baseCommit: trunk };
          hub.run(store.updateRun(runId, { base_commit: trunk }));
          // Re-check under the policy on the new trunk, which is where policy always comes from.
          a.workflow = await this.loadWorkflow(a.repo, trunk);
        }
        if (conflicts.length) {
          return back(
            `rebasing onto ${a.repo.base} (${trunk.slice(0, 12)}) left conflicts in: ${conflicts.join(", ")}. Send it back to the agent to resolve them, then approve again.`,
          );
        }
        if (moved) {
          hub.emit(runId, "system.log", { msg: `Rebased onto ${a.repo.base} (${trunk.slice(0, 12)}); re-running checks on the combined result` });
          this.previews.stop(runId); // the next browser check restarts it on the rebased tree
          const failures = await this.runGates(runId, a, "landing");
          if (failures === null) return back("run changed state during the re-check");
          hub.run(store.updateRun(runId, { gates_ok: a.workflow.gates.length ? (failures.length ? 0 : 1) : null }));
          if (failures.length) {
            return back(`checks fail after rebasing onto ${a.repo.base}. Send it back to the agent with the failures, then approve again.`);
          }
        }
        await workspaces.advance(a.repo, a.ws, a.repo.base);
        bookmark = a.repo.base;
        hub.emit(runId, "system.log", {
          msg: `${a.repo.base} now includes this change. Your own checkout of ${a.repo.path} still sits on the old ${a.repo.base}; update it with \`jj new ${a.repo.base}\` (or \`git checkout ${a.repo.base}\`).`,
        });
      } else {
        bookmark = `acutis/${a.ticket.id}-${slug(a.ticket.title)}`;
        await workspaces.land(a.repo, a.ws, { message, bookmark, push: a.workflow.land === "push" });
      }
      this.previews.stop(runId);
      await workspaces.destroy(a.repo, a.ws, { abandon: false });
    } catch (e) {
      if (e instanceof RunError) throw e;
      return back((e as Error).message, 500);
    }
    hub.run(store.updateRun(runId, { bookmark, workspace_path: null }));
    this.active.delete(runId);
    this.setState(runId, "done", a.workflow.land === "trunk" ? `landed on ${bookmark}` : `landed as bookmark ${bookmark}`);
    hub.ticket(this.deps.tickets.setStatus(a.ticket.id, "done"));
  }

  /** Throw the work away: abandon the change and delete the workspace. */
  async discard(runId: number) {
    const run = this.mustGet(runId);
    if (run.state === "done") throw new RunError("run already landed", 409);
    if (ACTIVE_STATES.includes(run.state) && run.state !== "paused") {
      throw new RunError(`kill the run before discarding it (it is ${run.state})`, 409);
    }
    const a = this.active.get(runId);
    if (a) this.closeSession(a);
    this.previews.stop(runId);
    const repo = this.deps.store.getRepo(run.repo);
    if (repo && run.workspace_name && run.workspace_path && run.base_commit) {
      await this.deps.workspaces.destroy(
        repo,
        { name: run.workspace_name, path: run.workspace_path, baseCommit: run.base_commit },
        { abandon: true },
      );
    }
    this.active.delete(runId);
    this.deps.hub.run(this.deps.store.updateRun(runId, { workspace_path: null }));
    if (run.state !== "cancelled" && run.state !== "failed") this.setState(runId, "cancelled", "discarded");
    else this.deps.hub.emit(runId, "system.log", { msg: "workspace discarded" });
    this.releaseTicket(run.ticket_id);
  }

  async diff(runId: number): Promise<string> {
    const run = this.mustGet(runId);
    const repo = this.deps.store.getRepo(run.repo);
    if (!repo || !run.workspace_name || !run.workspace_path || !run.base_commit) return "";
    return this.deps.workspaces.diff(repo, {
      name: run.workspace_name,
      path: run.workspace_path,
      baseCommit: run.base_commit,
    });
  }

  // ----------------------------------------------------------------- helpers

  private releaseTicket(ticketId: number) {
    const others = this.deps.store
      .runsForTicket(ticketId)
      .some((r) => ACTIVE_STATES.includes(r.state) || r.state === "awaiting_review");
    if (!others) this.deps.hub.ticket(this.deps.tickets.setStatus(ticketId, "todo"));
  }

  private fail(runId: number, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const a = this.active.get(runId);
    if (a) this.closeSession(a);
    this.deps.hub.run(this.deps.store.updateRun(runId, { error: msg }));
    this.deps.hub.emit(runId, "system.log", { level: "error", msg });
    const run = this.mustGet(runId);
    if (run.state !== "failed") this.setState(runId, "failed", msg);
    this.releaseTicket(run.ticket_id);
  }

  private setState(runId: number, to: RunState, reason?: string) {
    const from = this.mustGet(runId).state;
    const run = this.deps.store.updateRun(runId, { state: to });
    if (TERMINAL_STATES.includes(to)) this.previews.stop(runId);
    this.deps.hub.emit(runId, "run.state", { from, to, reason });
    this.deps.hub.run(run);
  }

  private mustGet(runId: number): Run {
    const run = this.deps.store.getRun(runId);
    if (!run) throw new RunError(`run ${runId} not found`, 404);
    return run;
  }
}

/** Build a URL on the preview's origin from a worker-supplied path; null if it would leave the origin. */
export function previewUrl(origin: string, path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  try {
    const u = new URL(path, origin);
    return u.origin === origin ? u.href : null;
  } catch {
    return null;
  }
}

function formatBrowserResult(r: import("./types").BrowserResult): string {
  const parts = [r.ok ? "Result: OK" : `Result: FAILED${r.failure ? ` (${r.failure})` : ""}`];
  if (r.scriptResult !== undefined) parts.push(`Script result: ${r.scriptResult}`);
  if (r.errors.length) parts.push(`Page errors:\n${r.errors.slice(0, 20).join("\n")}`);
  if (r.console.length) parts.push(`Console (last ${Math.min(30, r.console.length)}):\n${r.console.slice(-30).join("\n")}`);
  if (r.blocked.length) parts.push(`Blocked requests to other origins:\n${r.blocked.slice(0, 10).join("\n")}`);
  if (!r.screenshot) parts.push("(no screenshot)");
  return parts.join("\n\n");
}
