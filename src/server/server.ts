import type { ServerWebSocket } from "bun";
import type { App } from "../app";
import { RunError } from "../core/runs";
import { SCOUT_TYPES, isRunnerTicket } from "../core/scouts";
import { tokenMatches } from "../core/token";
import dashboard from "../dashboard/index.html";

const json = (data: unknown, status = 200) => Response.json(data, { status });

function errorResponse(e: unknown): Response {
  if (e instanceof RunError) return json({ error: e.message }, e.status);
  console.error(e);
  return json({ error: e instanceof Error ? e.message : String(e) }, 500);
}

export function startServer(app: App, opts: { hostname?: string; development?: boolean } = {}) {
  const { runs, tickets, store, hub, cfg } = app;
  const hostname = opts.hostname ?? "127.0.0.1";
  const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);
  const sockets = new Set<ServerWebSocket<unknown>>();

  hub.subscribe((m) => {
    const msg = JSON.stringify(m);
    for (const ws of sockets) ws.send(msg);
  });

  const bearer = (req: Request) => req.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? null;

  /**
   * The API can make an agent run commands. Every /api and /ws request needs the daemon's token
   * ($ACUTIS_HOME/token), because any local process can reach this port, including a worker's
   * preview server. The Host check blocks DNS rebinding, and the custom header and Origin check
   * block cross-site requests from pages in the operator's browser.
   */
  function guard(req: Request, given = bearer(req)): Response | null {
    const host = req.headers.get("host") ?? "";
    if (!allowedHosts.has(host)) return json({ error: "bad host" }, 403);
    if (!tokenMatches(app.token, given)) return json({ error: "missing or wrong token" }, 401);
    if (req.method !== "GET") {
      if (req.headers.get("x-acutis") !== "1") return json({ error: "missing x-acutis header" }, 403);
      const origin = req.headers.get("origin");
      if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) {
        return json({ error: "bad origin" }, 403);
      }
    }
    return null;
  }

  const api =
    (fn: (req: Request & { params: Record<string, string> }) => unknown | Promise<unknown>) =>
    async (req: Request & { params: Record<string, string> }) => {
      const blocked = guard(req);
      if (blocked) return blocked;
      try {
        const out = await fn(req);
        return out instanceof Response ? out : json(out ?? { ok: true });
      } catch (e) {
        return errorResponse(e);
      }
    };

  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, any>;
  const runId = (req: { params: Record<string, string> }) => Number(req.params.id);

  const server = Bun.serve({
    hostname,
    port: cfg.port,
    development: opts.development ?? false,
    routes: {
      "/": dashboard,
      "/api/state": {
        GET: api(() => ({
          repos: store.listRepos(),
          tickets: tickets.list(),
          runs: store.listRuns(),
          sandbox: app.sandbox,
          sandboxReason: app.sandboxStatus.reason ?? null,
          runner: app.runner.name,
          maxRuns: cfg.maxRuns ?? 0,
          scoutTypes: Object.entries(SCOUT_TYPES).map(([id, s]) => ({ id, title: s.title })),
          browser: app.browser.available,
          permissions: runs.allPendingPermissions(),
        })),
      },
      "/api/permissions": { GET: api(() => runs.allPendingPermissions()) },
      "/api/noticed": {
        GET: api((req) => {
          const status = new URL(req.url).searchParams.get("status");
          return runs.listNoticed(status === "all" ? undefined : status === "dismissed" || status === "ticketed" ? status : "open");
        }),
      },
      "/api/repos/:name/scouts/:type": { POST: api((req) => runs.startScout(req.params.name!, req.params.type!)) },
      "/api/decisions": {
        GET: api((req) => {
          const q = new URL(req.url).searchParams;
          const repo = q.get("repo") ?? undefined;
          const status = q.get("status");
          // Open questions come ranked (most held work first) with their held tickets.
          if (!status || status === "open") return runs.rankedDecisions(repo);
          return runs.listDecisions(repo, status === "all" ? undefined : (status as any));
        }),
        POST: api(async (req) => {
          const b = await body(req);
          return runs.addDecision(String(b.repo ?? ""), String(b.decision ?? ""), b.area ? String(b.area) : undefined);
        }),
      },
      "/api/decisions/:id/decide": {
        POST: api(async (req) => {
          const b = await body(req);
          return runs.decide(Number(req.params.id), { decision: String(b.decision ?? ""), version: Number(b.version), keep: Array.isArray(b.keep) ? b.keep : [] });
        }),
      },
      "/api/decisions/:id/withdraw": { POST: api((req) => runs.withdrawDecision(Number(req.params.id))) },
      "/api/decisions/:id/supersede": {
        POST: api(async (req) => runs.supersedeDecision(Number(req.params.id), String((await body(req)).decision ?? ""))),
      },
      "/api/tickets/:id/accept": { POST: api((req) => runs.acceptTicket(Number(req.params.id))) },
      "/api/tickets/:id/reject": { POST: api((req) => runs.rejectTicket(Number(req.params.id))) },
      "/api/noticed/:id/dismiss": { POST: api((req) => runs.dismissNoticed(Number(req.params.id))) },
      "/api/noticed/:id/ticket": { POST: api((req) => runs.ticketFromNoticed(Number(req.params.id))) },
      "/api/repos/:name": {
        GET: api((req) => {
          const repo = store.getRepo(req.params.name!);
          if (!repo) throw new RunError("not found", 404);
          return repo;
        }),
      },
      "/api/repos/:name/notes": {
        PUT: api(async (req) => {
          if (!store.getRepo(req.params.name!)) throw new RunError("not found", 404);
          const b = await body(req);
          if (typeof b.notes !== "string") throw new RunError("notes must be a string", 400);
          if (b.notes.length > 20_000) throw new RunError("notes are too long (max 20000 chars)", 413);
          return store.setRepoNotes(req.params.name!, b.notes);
        }),
      },
      "/api/tickets": {
        POST: api(async (req) => {
          const b = await body(req);
          if (!b.repo || !store.getRepo(b.repo)) throw new RunError(`unknown repo "${b.repo}"`, 400);
          if (!b.title?.trim()) throw new RunError("title is required", 400);
          const t = tickets.create({ repo: b.repo, title: b.title.trim(), body: (b.body ?? "").trim() });
          hub.ticket(t);
          return t;
        }),
      },
      "/api/tickets/:id/start": { POST: api((req) => runs.start(Number(req.params.id))) },
      "/api/tickets/:id/cancel": {
        POST: api((req) => {
          const t = tickets.get(Number(req.params.id));
          if (!t) throw new RunError("not found", 404);
          if (isRunnerTicket(t)) throw new RunError("that's a scout's own ticket; turn the scout off in the workflow instead", 409);
          if (t.status !== "todo" && t.status !== "proposed" && t.status !== "held") throw new RunError(`ticket is ${t.status}`, 409);
          const out = tickets.setStatus(t.id, "cancelled");
          hub.ticket(out);
          return out;
        }),
      },
      "/api/runs/:id": {
        GET: api((req) => {
          const run = store.getRun(runId(req));
          if (!run) throw new RunError("not found", 404);
          return {
            run,
            ticket: tickets.get(run.ticket_id),
            events: store.events(run.id),
            permissions: runs.pendingPermissions(run.id),
            live: runs.isLive(run.id),
          };
        }),
      },
      "/api/runs/:id/diff": { GET: api(async (req) => new Response(await runs.diff(runId(req)))) },
      "/api/runs/:id/notes": {
        POST: api(async (req) => {
          const b = await body(req);
          return runs.addNote(runId(req), String(b.text ?? ""), typeof b.image === "string" ? b.image : undefined);
        }),
      },
      "/api/runs/:id/artifacts/:name": {
        GET: api((req) => {
          const p = runs.artifactPath(runId(req), req.params.name!);
          if (!p) throw new RunError("not found", 404);
          // Fixed type + nosniff: artifacts are images only, never rendered as HTML or SVG.
          return new Response(Bun.file(p), {
            headers: {
              "content-type": "image/png",
              "x-content-type-options": "nosniff",
              "content-security-policy": "default-src 'none'",
              "cache-control": "private, max-age=31536000, immutable",
            },
          });
        }),
      },
      "/api/runs/:id/preview": { POST: api((req) => runs.preview(runId(req))) },
      "/api/runs/:id/message": { POST: api(async (req) => runs.message(runId(req), (await body(req)).text ?? "")) },
      "/api/runs/:id/redirect": { POST: api(async (req) => runs.redirect(runId(req), (await body(req)).text ?? "")) },
      "/api/runs/:id/pause": { POST: api((req) => runs.pause(runId(req))) },
      "/api/runs/:id/resume": { POST: api((req) => runs.resume(runId(req))) },
      "/api/runs/:id/kill": { POST: api((req) => runs.kill(runId(req))) },
      "/api/runs/:id/approve": { POST: api((req) => runs.approve(runId(req))) },
      "/api/runs/:id/discard": { POST: api((req) => runs.discard(runId(req))) },
      "/api/runs/:id/permissions/:req": {
        POST: api(async (req) => {
          const b = await body(req);
          const decision =
            b.behavior === "allow"
              ? { behavior: "allow" as const, always: Boolean(b.always) }
              : { behavior: "deny" as const, message: b.message || undefined };
          runs.decidePermission(runId(req), req.params.req!, decision);
        }),
      },
    },
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        // Browsers can't set headers on a WebSocket, so the dashboard passes the token in the query.
        const blocked = guard(req, url.searchParams.get("token") ?? bearer(req));
        if (blocked) return blocked;
        // Browsers let any page open a WebSocket to localhost, so require our own origin.
        const origin = req.headers.get("origin");
        if (!origin || !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) {
          return json({ error: "bad origin" }, 403);
        }
        if (server.upgrade(req)) return;
        return new Response("upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message() {},
    },
  });
  return server;
}
