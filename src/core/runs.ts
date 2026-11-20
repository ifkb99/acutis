import type { Subprocess } from "bun";
import type { Store } from "./db";
import type { Hub } from "./hub";
import type {
  AgentRunner,
  AgentSession,
  PermissionDecision,
  PermissionRequest,
  Repo,
  Run,
  RunState,
  Ticket,
  TicketSource,
  Workflow,
  Workspace,
  WorkspaceProvider,
} from "./types";
import { ACTIVE_STATES } from "./types";
import { WORKFLOW_PATH, defaultWorkflow, parseWorkflow, renderTemplate, workerSystemPrompt } from "./workflow";

export class RunError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

interface PendingPermission {
  req: PermissionRequest;
  resolve: (d: PermissionDecision) => void;
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
}

function killGroup(proc: Subprocess) {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.kill("SIGKILL");
  }
}

const GATE_OUTPUT_CHARS = 8000;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "change";
}

function tail(s: string, n: number): string {
  return s.length > n ? `… [${s.length - n} chars omitted]\n` + s.slice(-n) : s;
}

export class RunManager {
  private active = new Map<number, Active>();

  constructor(
    private deps: {
      store: Store;
      hub: Hub;
      tickets: TicketSource;
      workspaces: WorkspaceProvider;
      runner: AgentRunner;
    },
  ) {}

  // ---------------------------------------------------------------- lifecycle

  /** Called once at daemon start: detach runs whose agent process died with the old daemon. */
  recover() {
    for (const run of this.deps.store.listRuns(1000)) {
      if (run.state === "preparing") this.setState(run.id, "failed", "daemon restarted during preparation");
      else if (run.state === "running" || run.state === "verifying" || run.state === "landing") {
        this.setState(run.id, "paused", "daemon restarted; press Resume to continue the session");
      }
    }
  }

  pendingPermissions(runId: number): PermissionRequest[] {
    return [...(this.active.get(runId)?.permissions.values() ?? [])].map((p) => p.req);
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
      gates: workflow.gates.map((g) => g.run),
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
    this.active.set(run.id, { repo, ticket, workflow, ws, session: null, intent: null, permissions: new Map(), gate: null });
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
    };
    this.active.set(runId, a);
    return a;
  }

  private launch(runId: number, prompt: string, resumeSessionId?: string) {
    const a = this.active.get(runId)!;
    const run = this.mustGet(runId);
    const session = this.deps.runner.start({
      cwd: a.ws.path,
      prompt,
      systemAppend: workerSystemPrompt({ ticket: a.ticket, cwd: a.ws.path, workflow: a.workflow }),
      model: a.workflow.model,
      effort: a.workflow.effort,
      allow: a.workflow.allow,
      deny: a.workflow.deny,
      resumeSessionId,
      onPermission: (req) => this.requestPermission(runId, req),
    });
    a.session = session;
    a.intent = null;
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
          hub.emit(runId, ev.kind, { ...ev });
          const run = this.mustGet(runId);
          hub.run(store.updateRun(runId, { cost_usd: run.cost_usd + ev.cost_usd }));
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
      p.resolve({ behavior: "deny", message });
      this.deps.hub.emit(this.runIdOf(a), "permission.decision", { id, tool: p.req.tool, behavior: "deny", message });
    }
    a.permissions.clear();
  }

  private runIdOf(a: Active): number {
    for (const [id, v] of this.active) if (v === a) return id;
    return -1;
  }

  // ------------------------------------------------------------- verification

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

    const stillVerifying = () => this.mustGet(runId).state === "verifying";
    const failures: string[] = [];
    for (const gate of a.workflow.gates) {
      if (!stillVerifying()) return;
      hub.emit(runId, "gate.start", { name: gate.name, run: gate.run });
      const t0 = Date.now();
      // setsid makes the gate its own process group so a kill or timeout takes its children too.
      const proc = Bun.spawn(["setsid", "sh", "-c", gate.run], {
        cwd: a.ws.path,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CI: "1" },
      });
      a.gate = proc;
      const timer = setTimeout(() => killGroup(proc), (gate.timeout_s ?? 600) * 1000);
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code = await proc.exited;
      clearTimeout(timer);
      a.gate = null;
      if (!stillVerifying()) return;
      const output = tail(`${out}${err ? `\n${err}` : ""}`.trim(), GATE_OUTPUT_CHARS);
      const ok = code === 0;
      hub.emit(runId, "gate.result", { name: gate.name, run: gate.run, ok, exit_code: code, duration_ms: Date.now() - t0, output });
      if (!ok) failures.push(`$ ${gate.run}  (exit ${code})\n${output}`);
    }

    if (!stillVerifying()) return;
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

  // ------------------------------------------------------------ permissions

  private requestPermission(runId: number, req: PermissionRequest): Promise<PermissionDecision> {
    const a = this.active.get(runId);
    if (!a) return Promise.resolve({ behavior: "deny", message: "run not active" });
    return new Promise((resolve) => {
      a.permissions.set(req.id, { req, resolve });
      this.deps.hub.emit(runId, "permission.request", { ...req });
    });
  }

  decidePermission(runId: number, reqId: string, decision: PermissionDecision) {
    const a = this.active.get(runId);
    const p = a?.permissions.get(reqId);
    if (!a || !p) throw new RunError("no such pending permission request", 404);
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
    const bookmark = `acutis/${a.ticket.id}-${slug(a.ticket.title)}`;
    try {
      await this.deps.workspaces.land(a.repo, a.ws, {
        message: `${a.ticket.title}\n\nAcutis-Ticket: #${a.ticket.id}\nAcutis-Run: ${runId}\n`,
        bookmark,
        push: a.workflow.land === "push",
      });
      await this.deps.workspaces.destroy(a.repo, a.ws, { abandon: false });
    } catch (e) {
      this.deps.hub.emit(runId, "system.log", { level: "error", msg: `landing failed: ${(e as Error).message}` });
      this.setState(runId, "awaiting_review", "landing failed");
      throw new RunError(`landing failed: ${(e as Error).message}`, 500);
    }
    this.deps.hub.run(this.deps.store.updateRun(runId, { bookmark }));
    this.active.delete(runId);
    this.setState(runId, "done", `landed as bookmark ${bookmark}`);
    this.deps.hub.ticket(this.deps.tickets.setStatus(run.ticket_id, "done"));
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
    this.deps.hub.emit(runId, "run.state", { from, to, reason });
    this.deps.hub.run(run);
  }

  private mustGet(runId: number): Run {
    const run = this.deps.store.getRun(runId);
    if (!run) throw new RunError(`run ${runId} not found`, 404);
    return run;
  }
}
