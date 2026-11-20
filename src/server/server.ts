import type { ServerWebSocket } from "bun";
import type { App } from "../app";
import { RunError } from "../core/runs";
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

  /**
   * The API can make an agent run commands, so it only answers same-machine requests:
   * the Host check blocks DNS rebinding and the custom header blocks cross-site form posts.
   */
  function guard(req: Request): Response | null {
    const host = req.headers.get("host") ?? "";
    if (!allowedHosts.has(host)) return json({ error: "bad host" }, 403);
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
        })),
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
          if (t.status !== "todo") throw new RunError(`ticket is ${t.status}`, 409);
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
        const blocked = guard(req);
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
