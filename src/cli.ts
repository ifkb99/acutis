#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createApp, loadConfig } from "./app";
import { readToken } from "./core/token";
import { killAllBrowsers } from "./providers/browser/chrome";
import { makeNotifier } from "./server/notify";
import { startServer } from "./server/server";

const USAGE = `acutis — local software factory

Daemon
  acutis serve [--dev] [--allow-api-billing]   Start the daemon and dashboard
  acutis dashboard                             Print the dashboard login link (it carries the API token)

Repos and tickets
  acutis repo add <path> [--name N] [--base REV] [--init-jj]
  acutis repo ls
  acutis repo notes <repo> [--set TEXT | --file PATH]   Show or set operator notes for workers
  acutis ticket add <repo> <title> [--body TEXT | --body-file PATH]
  acutis ticket ls
  acutis ticket cancel <ticket-id>
  acutis proposed                              Tickets scouts filed that wait for you
  acutis accept|reject <ticket-id>             Accept a proposed ticket onto todo, or reject it
  acutis library <repo>                        Indexed doc commits, and how far describing got (with its cost)
  acutis gaps [--all] | gaps dismiss <id>      Questions workers couldn't answer from the docs (the Docs scout reads these)
  acutis noticed [--all]                       Problems workers noticed outside their tickets
  acutis noticed ticket|dismiss <id>           Turn one into a ticket, or dismiss it

Scouts and decisions
  acutis scout <repo> <type>                   Start a scout (infrastructure, tests); it files tickets and questions
  acutis decisions [--repo R] [--all]          Open questions, most held work first (--all: every decision)
  acutis decide <id> --version N <text> [--keep 3,4] [--drop 5]
                                               Answer a question with the decision workers will follow;
                                               held tickets in --keep go to todo, --drop are cancelled,
                                               any others go to proposed
  acutis decision add <repo> <text>            Record a decision directly
  acutis decision withdraw <id> | supersede <id> <text>

Lessons (short how-tos approved lessons put in every worker's and scout's prompt)
  acutis lessons [--repo R] [--all]            Proposed lessons waiting for you, then approved ones (--all: every status)
  acutis lesson approve <id> [text]            Approve a proposed lesson, optionally reworded
  acutis lesson reject|retire <id>             Reject a proposed lesson, or retire an approved one
  acutis lesson edit <id> <text>               Reword a lesson (runs already started keep their text)
  acutis lesson add <repo> <text>              Write a lesson yourself (approved as written)

Runs
  acutis start <ticket-id> [--watch]           Start a run for a ticket
  acutis runs                                  List runs
  acutis show <run>                            State, last agent message, pending permissions
  acutis watch <run> [--follow]                Stream events; exits when the run needs you
  acutis perms [<run>]                         Pending permission requests
  acutis allow <run> <request|all> [--always]  Allow a request (id prefix is enough)
  acutis deny <run> <request> [--message TEXT]
  acutis diff <run>
  acutis msg <run> <text>                      Message the agent (or send back from review)
  acutis redirect <run> <text>                 Interrupt the agent with new instructions
  acutis pause|resume|kill|approve|discard <run>   (approve --contracts: accept a contract change after reviewing it)
  acutis note <run> [text] [--image PNG]       Attach a reviewer note (not sent to the agent)
  acutis preview <run>                         Start the run's preview server and print its URL

Env: ACUTIS_HOME (default ~/.local/share/acutis), ACUTIS_PORT (default 7777),
     ACUTIS_MAX_RUNS (runs active at once, default 4; 0 = no limit; more queue),
     ACUTIS_NOTIFY=off (no desktop notifications), ACUTIS_NOTIFY_URL (POST notifications, e.g. ntfy),
     ACUTIS_CHROME (browser for previews/checks)`;

const cfg = loadConfig();
const [cmd, sub, ...rest] = process.argv.slice(2);
const base = `http://127.0.0.1:${cfg.port}`;

function die(msg: string, code = 1): never {
  console.error(`acutis: ${msg}`);
  process.exit(code);
}

/** The daemon writes $ACUTIS_HOME/token on first start; the API refuses requests without it. */
function token(): string {
  return readToken(cfg.home) ?? die(`no API token in ${cfg.home}; run "acutis serve" first`);
}

const dashboardLink = () => `${base}/#token=${token()}`;

async function api(path: string, init?: { method?: string; body?: unknown; raw?: boolean }) {
  const res = await fetch(`${base}${path}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json", "x-acutis": "1", authorization: `Bearer ${token()}` },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  }).catch(() => die(`daemon not reachable on port ${cfg.port}; run "acutis serve" first`));
  if (init?.raw) {
    if (!res.ok) die(`HTTP ${res.status}`);
    return res.text();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die((data as any).error ?? `HTTP ${res.status}`);
  return data as any;
}

const post = (path: string, body?: unknown) => api(path, { method: "POST", body: body ?? {} });

function runArg(v: string | undefined, usage: string): number {
  const n = Number(v);
  if (!v || !Number.isInteger(n) || n <= 0) die(`usage: ${usage}`);
  return n;
}

// ------------------------------------------------------------------ serve

async function serve(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { dev: { type: "boolean" }, "allow-api-billing": { type: "boolean" } },
  });
  if (process.env.ANTHROPIC_API_KEY && !values["allow-api-billing"]) {
    die(
      "ANTHROPIC_API_KEY is set, so workers would bill the API instead of your Claude login.\n" +
        "Unset it, or pass --allow-api-billing if that is what you want.",
    );
  }
  const app = createApp(cfg);
  app.runs.recover();
  startServer(app, { development: values.dev });
  const notifier = makeNotifier({
    port: cfg.port,
    desktop: process.env.ACUTIS_NOTIFY !== "off",
    webhook: process.env.ACUTIS_NOTIFY_URL || null,
  });
  app.hub.subscribe((m) => notifier.handle(m));
  // Scouts with triggers wake when trunk changes what they watch (checked after landings, and here
  // for trunk moves made outside Acutis, e.g. a pull in a colocated repo).
  app.runs.startTrunkWatch(Number(process.env.ACUTIS_TRUNK_CHECK_S ?? 300) * 1000);
  // Previews, checks and agent processes belong to the daemon: take them down with it.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    app.runs.shutdown();
    killAllBrowsers();
    await notifier.drain();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => app.runs.previews.stopAll());

  // The link carries the token, so it's only printed here and by `acutis dashboard`.
  console.log(`Acutis dashboard: ${dashboardLink()}`);
  console.log(`Data: ${cfg.home}`);
  console.log(
    app.sandbox
      ? "Sandbox: on (bubblewrap + socat)"
      : `Sandbox: OFF (${app.sandboxStatus.reason}).\n` +
          "  Commands outside the allowlist, and Bash commands that name paths outside the workspace, ask you\n" +
          "  in the dashboard. File-manipulating commands inside the workspace may run without asking, and\n" +
          "  allowlisted commands that run code (bun test, bun run…) can still touch anything: this is not a boundary.",
  );
  console.log(`Runs at once: ${cfg.maxRuns ? `${cfg.maxRuns} (ACUTIS_MAX_RUNS; more queue)` : "no limit (ACUTIS_MAX_RUNS=0)"}`);
  console.log(`Browser (previews, browser checks): ${app.browser.available ? "found" : "not found; set ACUTIS_CHROME"}`);
  console.log(`Notifications: ${notifier.describe()}`);
}

// ------------------------------------------------------------------ repos

async function repoAdd(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { name: { type: "string" }, base: { type: "string" }, "init-jj": { type: "boolean" } },
  });
  const path = positionals[0] ? resolve(positionals[0]) : die("repo add needs a path");
  if (!existsSync(path)) die(`no such directory: ${path}`);
  if (!existsSync(`${path}/.jj`)) {
    if (!existsSync(`${path}/.git`)) die(`${path} is neither a jj nor a git repository`);
    if (!values["init-jj"]) {
      die(`${path} is a git repo without jj. Re-run with --init-jj to run "jj git init --colocate" there (git keeps working).`);
    }
    const r = await $`jj git init --colocate`.cwd(path).nothrow();
    if (r.exitCode !== 0) die("jj git init --colocate failed");
  }
  const app = createApp(cfg);
  const name = values.name ?? basename(path);
  const probe = { name, path, base: "", notes: "", created_at: "" };
  let baseRev = values.base;
  if (!baseRev) {
    for (const cand of ["main", "master", "trunk()"]) {
      try {
        const id = await app.workspaces.resolve(probe, cand);
        if (!/^0+$/.test(id)) {
          baseRev = cand;
          break;
        }
      } catch {}
    }
    if (!baseRev) die("couldn't find a trunk (main/master). Pass --base <revset>.");
  } else {
    await app.workspaces.resolve(probe, baseRev).catch((e) => die(e.message));
  }
  const repo = app.store.addRepo({ name, path, base: baseRev });
  console.log(`Registered ${repo.name} → ${repo.path} (base: ${repo.base})`);
  if (!(await app.workspaces.isBookmark(repo, repo.base))) {
    console.log(`Note: base "${repo.base}" is not a bookmark, so "land: trunk" won't work for this repo.`);
  }
  const jjEmail = (await $`jj config get user.email`.cwd(path).nothrow().quiet()).stdout.toString().trim();
  if (!jjEmail) {
    const gitEmail = (await $`git config user.email`.cwd(path).nothrow().quiet()).stdout.toString().trim();
    console.log(
      gitEmail
        ? `Note: jj has no user.email here; Acutis will use git's identity (${gitEmail}) for landed commits.`
        : 'Warning: neither jj nor git has a user identity here; landed commits will have an empty author.\n  Fix: jj config set --user user.name "..." && jj config set --user user.email "..."',
    );
  }
}

async function repoNotes(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { set: { type: "string" }, file: { type: "string" } } });
  const name = positionals[0] ?? die("usage: acutis repo notes <repo> [--set TEXT | --file PATH]");
  if (values.set !== undefined || values.file) {
    const notes = values.file ? await Bun.file(values.file).text() : values.set!;
    await api(`/api/repos/${encodeURIComponent(name)}/notes`, { method: "PUT", body: { notes } });
    console.log(`Saved notes for ${name} (${notes.length} chars). They reach workers from their next session.`);
  } else {
    const r = await api(`/api/repos/${encodeURIComponent(name)}`);
    console.log(r.notes || "(no notes)");
  }
}

// ------------------------------------------------------------------ runs

const STOP_STATES = new Set(["awaiting_review", "done", "failed", "cancelled"]);

/** One line per interesting event; null for events not worth showing. */
function formatEvent(e: { id: number; kind: string; data: any }): string | null {
  const d = e.data;
  const arg = (i: any) => String(i?.command ?? i?.file_path ?? i?.path ?? JSON.stringify(i ?? {})).replace(/\s+/g, " ").slice(0, 140);
  switch (e.kind) {
    case "run.state":
      return `── ${d.to}${d.reason ? ` (${d.reason})` : ""}`;
    case "agent.text":
      return `agent: ${String(d.text).trim()}`;
    case "agent.tool_use":
      return `  ${d.name} ${arg(d.input)}`;
    case "agent.result":
      return `  turn ended: ${d.subtype}, ${d.turns} turns, ${Math.round(d.duration_ms / 1000)}s, +$${Number(d.turn_cost_usd ?? d.cost_usd).toFixed(3)}`;
    case "permission.request":
      return `? PERMISSION ${String(d.id).slice(0, 8)} ${d.tool}: ${arg(d.input)}${d.reason ? `  [${d.reason}]` : ""}`;
    case "permission.decision":
      return `  permission ${String(d.id).slice(0, 8)} ${d.behavior}${d.by === "timeout" ? " (timed out)" : ""}${d.message ? `: ${d.message}` : ""}`;
    case "setup.result":
    case "gate.result":
      return `${d.ok ? "✓" : "✗"} ${e.kind === "setup.result" ? "setup" : "check"} ${d.run} (${(d.duration_ms / 1000).toFixed(1)}s)${d.ok ? "" : `\n${String(d.output).split("\n").slice(-15).map((l) => `    ${l}`).join("\n")}`}`;
    case "user.message":
      return `${d.by === "acutis" ? "acutis" : "you"}${d.mode === "redirect" ? " (redirect)" : ""}: ${String(d.text).split("\n")[0]}`;
    case "artifact":
      return `  screenshot: ${d.caption} → ${base}/api/runs/${(e as any).run_id}/artifacts/${d.name}`;
    case "review.note":
      return `note: ${d.text}${d.artifact ? " [image]" : ""}`;
    case "noticed":
      return `  noticed #${d.id} [${d.kind}] ${d.title}${d.merged ? ` (merged, ×${d.count})` : ""}`;
    case "contract.changed":
    case "contract.stale":
      return `⚠ ${d.msg}`;
    case "lessons.given":
      return `  given ${(d.lessons ?? []).length} of ${d.of} approved lesson(s)${d.by === "all" ? "" : ` (chosen by ${d.by})`}`;
    case "lesson.proposed":
      return `  proposed lesson L${d.id}${d.source === "draft" ? " (drafted from the report)" : ""}: ${d.text}`;
    case "work.request":
      return `  requested work: ticket #${d.ticket} ${d.title}${d.existing ? " (already requested)" : " (proposed)"}`;
    case "scout.triggered":
      return `  woken by a trunk change (${String(d.from).slice(0, 8)}..${String(d.to).slice(0, 8)}): ${(d.paths ?? []).slice(0, 5).join(", ")}${(d.paths ?? []).length > 5 ? " …" : ""}`;
    case "contract.request":
      return `  requested a change to the ${d.contract} contract (decision #${d.decision}, ticket #${d.ticket}): ${d.change}`;
    case "scout.ticket":
      return `  filed ticket #${d.id} [${d.status}, ${d.confidence}] ${d.title}`;
    case "scout.decision":
      return `  asked decision #${d.id}: ${d.question}`;
    case "policy.flag":
      return `! ${d.msg} ${(d.files ?? []).join(", ")}`;
    case "system.log":
      return d.level === "error" || d.level === "warn" ? `! ${d.msg}` : `  ${d.msg}`;
    default:
      return null;
  }
}

async function watch(runId: number, follow: boolean): Promise<never> {
  const initial = await api(`/api/runs/${runId}`);
  const shown = new Set<number>();
  for (const e of initial.events.slice(-20)) {
    shown.add(e.id);
    const line = formatEvent(e);
    if (line) console.log(line);
  }
  const needsYou = (state: string, perms: number) => !follow && (STOP_STATES.has(state) || perms > 0);
  if (needsYou(initial.run.state, initial.permissions.length)) return finish(runId, initial.run.state, initial.permissions);

  const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws`, { headers: { Origin: base, authorization: `Bearer ${token()}` } } as any);
  let state = initial.run.state as string;
  let closing = false;
  return new Promise<never>((_, reject) => {
    ws.onmessage = async (msg) => {
      const m = JSON.parse(String(msg.data));
      if (m.type === "run" && m.run.id === runId) state = m.run.state;
      if (m.type !== "event" || m.event.run_id !== runId || shown.has(m.event.id)) return;
      shown.add(m.event.id);
      const line = formatEvent(m.event);
      if (line) console.log(line);
      if (m.event.kind === "run.state") state = m.event.data.to;
      if (!follow && (m.event.kind === "permission.request" || (m.event.kind === "run.state" && STOP_STATES.has(state)))) {
        closing = true; // our own close, not a lost connection
        ws.close();
        const s = await api(`/api/runs/${runId}`);
        finish(runId, s.run.state, s.permissions);
      }
    };
    ws.onclose = () => {
      if (!closing) reject(die("lost connection to the daemon"));
    };
    ws.onerror = () => reject(die("could not open the event stream"));
  });
}

function finish(runId: number, state: string, perms: any[]): never {
  if (perms.length) {
    console.log(`\nRun ${runId} is waiting for you:`);
    for (const p of perms) console.log(`  acutis allow ${runId} ${p.id.slice(0, 8)}    # or: acutis deny ${runId} ${p.id.slice(0, 8)} --message "..."`);
    process.exit(2);
  }
  if (state === "awaiting_review") console.log(`\nRun ${runId} is ready for review: acutis diff ${runId} · acutis approve ${runId} · acutis msg ${runId} "..."`);
  else console.log(`\nRun ${runId} is ${state}.`);
  process.exit(state === "failed" ? 1 : 0);
}

async function resolveReq(runId: number, prefix: string): Promise<string[]> {
  const s = await api(`/api/runs/${runId}`);
  const ids: string[] = s.permissions.map((p: any) => p.id);
  if (prefix === "all") return ids;
  const hits = ids.filter((id) => id.startsWith(prefix));
  if (hits.length === 0) die(`no pending request ${prefix} on run ${runId}`);
  if (hits.length > 1) die(`request prefix ${prefix} is ambiguous`);
  return hits;
}

async function show(runId: number) {
  const s = await api(`/api/runs/${runId}`);
  const r = s.run;
  console.log(`Run ${r.id} · ticket #${r.ticket_id} ${s.ticket?.title ?? ""}`);
  console.log(`  state ${r.state} · ${r.repo} · ${r.model ?? "?"} · attempt ${r.attempt} · ≈$${r.cost_usd.toFixed(2)}${r.gates_ok === null ? "" : r.gates_ok ? " · checks passed" : " · checks failed"}`);
  if (r.bookmark) console.log(`  landed: ${r.bookmark}`);
  if (r.workspace_path) console.log(`  workspace: ${r.workspace_path}`);
  if (r.error) console.log(`  error: ${r.error}`);
  const last = [...s.events].reverse().find((e: any) => e.kind === "agent.text");
  if (last) console.log(`\nLast agent message:\n${last.data.text}`);
  for (const p of s.permissions) console.log(`\n${formatEvent({ id: 0, kind: "permission.request", data: p })}`);
}

async function runsCmd(c: string, args: string[]) {
  const usage = `acutis ${c} <run>`;
  switch (c) {
    case "runs": {
      const s = await api("/api/state");
      const tickets = new Map(s.tickets.map((t: any) => [t.id, t]));
      for (const r of s.runs) console.log(`${r.id}\t${r.state}\t#${r.ticket_id} ${(tickets.get(r.ticket_id) as any)?.title ?? ""}\t≈$${r.cost_usd.toFixed(2)}`);
      return;
    }
    case "show":
      return show(runArg(args[0], usage));
    case "watch": {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { follow: { type: "boolean" } } });
      return watch(runArg(positionals[0], "acutis watch <run> [--follow]"), Boolean(values.follow));
    }
    case "perms": {
      const all = args[0] ? (await api(`/api/runs/${runArg(args[0], "acutis perms [<run>]")}`)).permissions.map((req: any) => ({ runId: Number(args[0]), req })) : await api("/api/permissions");
      if (!all.length) console.log("No pending permission requests.");
      for (const { runId, req } of all) console.log(`run ${runId}  ${formatEvent({ id: 0, kind: "permission.request", data: req })!.replace(/^\? /, "")}`);
      return;
    }
    case "allow": {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { always: { type: "boolean" } } });
      const runId = runArg(positionals[0], "acutis allow <run> <request|all> [--always]");
      for (const id of await resolveReq(runId, positionals[1] ?? die("which request? (id prefix or all)"))) {
        await post(`/api/runs/${runId}/permissions/${id}`, { behavior: "allow", always: Boolean(values.always) });
        console.log(`allowed ${id.slice(0, 8)}`);
      }
      return;
    }
    case "deny": {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { message: { type: "string" } } });
      const runId = runArg(positionals[0], "acutis deny <run> <request> [--message TEXT]");
      for (const id of await resolveReq(runId, positionals[1] ?? die("which request? (id prefix or all)"))) {
        await post(`/api/runs/${runId}/permissions/${id}`, { behavior: "deny", message: values.message });
        console.log(`denied ${id.slice(0, 8)}`);
      }
      return;
    }
    case "diff":
      process.stdout.write(await api(`/api/runs/${runArg(args[0], usage)}/diff`, { raw: true }));
      return;
    case "msg":
    case "redirect": {
      const runId = runArg(args[0], `acutis ${c} <run> <text>`);
      const text = args.slice(1).join(" ");
      if (!text.trim()) die(`usage: acutis ${c} <run> <text>`);
      await post(`/api/runs/${runId}/${c === "msg" ? "message" : "redirect"}`, { text });
      console.log(c === "msg" ? "sent" : "redirected");
      return;
    }
    case "pause":
    case "resume":
    case "kill":
    case "approve":
    case "discard": {
      const runId = runArg(args[0], usage);
      const out = await post(`/api/runs/${runId}/${c}`, c === "approve" ? { acceptContracts: args.includes("--contracts") } : {});
      if (c === "approve" && out?.landed === false) console.log(`not landed: ${out.reason}`);
      const s = await api(`/api/runs/${runId}`);
      console.log(`run ${runId}: ${s.run.state}${s.run.bookmark && c === "approve" ? ` (${s.run.bookmark})` : ""}`);
      return;
    }
    case "note": {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { image: { type: "string" } } });
      const runId = runArg(positionals[0], "acutis note <run> [text] [--image PNG]");
      const image = values.image ? Buffer.from(await Bun.file(values.image).arrayBuffer()).toString("base64") : undefined;
      await post(`/api/runs/${runId}/notes`, { text: positionals.slice(1).join(" "), image });
      console.log("note added");
      return;
    }
    case "preview": {
      const r = await post(`/api/runs/${runArg(args[0], usage)}/preview`);
      console.log(r.url);
      return;
    }
  }
}

switch (cmd) {
  case "serve":
    await serve([sub, ...rest].filter((x): x is string => x !== undefined));
    break;
  case "repo":
    if (sub === "add") await repoAdd(rest);
    else if (sub === "ls") {
      for (const r of createApp(cfg).store.listRepos()) console.log(`${r.name}\t${r.base}\t${r.path}`);
    } else if (sub === "notes") await repoNotes(rest);
    else die(USAGE);
    break;
  case "ticket":
    if (sub === "add") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { body: { type: "string" }, "body-file": { type: "string" } },
      });
      const [repo, ...title] = positionals;
      if (!repo || !title.length) die("usage: acutis ticket add <repo> <title> [--body TEXT | --body-file PATH]");
      const body = values["body-file"] ? await Bun.file(values["body-file"]).text() : values.body ?? "";
      const t = await post("/api/tickets", { repo, title: title.join(" "), body });
      console.log(`#${t.id} ${t.title}`);
    } else if (sub === "ls") {
      const s = await api("/api/state");
      for (const t of s.tickets) {
        if (String(t.source).startsWith("scout-run:")) continue; // a scout's own runner ticket
        console.log(`#${t.id}\t${t.status}\t${t.repo}\t${t.title}${t.source !== "local" ? `\t(${t.source}${t.confidence ? `, ${t.confidence}` : ""})` : ""}`);
      }
    } else if (sub === "cancel") {
      const id = runArg(rest[0], "acutis ticket cancel <ticket-id>");
      const t = await post(`/api/tickets/${id}/cancel`);
      console.log(`#${t.id} ${t.status}`);
    } else die(USAGE);
    break;
  case "dashboard":
    console.log(dashboardLink());
    break;
  case "scout": {
    if (!sub || !rest[0]) die("usage: acutis scout <repo> <type>");
    const run = await post(`/api/repos/${encodeURIComponent(sub)}/scouts/${encodeURIComponent(rest[0])}`);
    console.log(run.state === "queued" ? `Scout run ${run.id} queued (run limit reached).` : `Scout run ${run.id} started: acutis watch ${run.id}`);
    break;
  }
  case "library": {
    if (!sub) die("usage: acutis library <repo>");
    const rows = await api(`/api/repos/${encodeURIComponent(sub)}/library`);
    if (!rows.length) console.log("Nothing indexed yet (it happens when a run starts).");
    for (const r of rows) {
      const d = r.describe_status
        ? ` · descriptions ${r.describe_status}: ${r.described} written, ${r.cached} reused, ${r.thin} thin, ≈$${Number(r.cost_usd).toFixed(3)}${r.note ? ` (${r.note})` : ""}`
        : "";
      console.log(`${String(r.commit_id).slice(0, 12)}\t${r.files} docs, ${r.chunks} sections${d}`);
    }
    break;
  }
  case "gaps": {
    if (sub === "dismiss") {
      const id = runArg(rest[0], "acutis gaps dismiss <id>");
      await post(`/api/gaps/${id}/dismiss`);
      console.log(`Gap #${id} dismissed.`);
      break;
    }
    const list = await api(`/api/gaps${sub === "--all" ? "?status=all" : ""}`);
    if (!list.length) console.log("No open library gaps.");
    for (const g of list) {
      console.log(`#${g.id}\t×${g.count}\t${g.repo}\t${g.question}${g.status !== "open" ? `\t(${g.status}${g.ticket_id ? ` #${g.ticket_id}` : ""})` : g.ticket_id ? `\t(ticket #${g.ticket_id} pending)` : ""}`);
    }
    break;
  }
  case "proposed": {
    const s = await api("/api/state");
    const list = s.tickets.filter((t: any) => t.status === "proposed" || t.status === "held");
    if (!list.length) console.log("Nothing waiting.");
    for (const t of list) {
      console.log(`#${t.id}\t${t.status}${t.decision_id ? ` on decision #${t.decision_id}` : ""}\t${t.repo}\t${t.title}\t(${t.source}${t.confidence ? `, ${t.confidence}` : ""})`);
    }
    break;
  }
  case "accept":
  case "reject": {
    const id = runArg(sub, `acutis ${cmd} <ticket-id>`);
    const t = await post(`/api/tickets/${id}/${cmd}`);
    console.log(`#${t.id} ${t.status}: ${t.title}`);
    break;
  }
  case "decisions": {
    const { values } = parseArgs({ args: [sub, ...rest].filter((x): x is string => x !== undefined), options: { repo: { type: "string" }, all: { type: "boolean" } } });
    const q = new URLSearchParams();
    if (values.repo) q.set("repo", values.repo);
    if (values.all) q.set("status", "all");
    const list = await api(`/api/decisions?${q}`);
    if (!list.length) console.log(values.all ? "No decisions yet." : "No open questions.");
    for (const d of list) {
      if (d.status === "open") {
        console.log(`#${d.id} v${d.version}\t${d.repo} · ${d.area} · asked by ${d.asked_by}${d.held ? ` · holds ${d.held} ticket(s)` : ""}`);
        console.log(`\t${d.question}`);
        if (d.options) for (const o of String(d.options).split("\n").filter(Boolean)) console.log(`\t  - ${o}`);
        for (const t of d.held_tickets ?? []) console.log(`\t  holds #${t.id}: ${t.title}`);
        console.log(`\tanswer: acutis decide ${d.id} --version ${d.version} "<your decision, written to stand alone>"${d.held ? " [--keep <ids>] [--drop <ids>]" : ""}`);
      } else {
        console.log(`#${d.id}\t${d.status}\t${d.repo} · ${d.area}${d.question ? ` · ${d.question}` : ""}`);
        if (d.decision) console.log(`\t→ ${d.decision}${d.superseded_by ? ` (superseded by #${d.superseded_by})` : ""}`);
      }
    }
    break;
  }
  case "lessons": {
    const { values } = parseArgs({ args: [sub, ...rest].filter((x): x is string => x !== undefined), options: { repo: { type: "string" }, all: { type: "boolean" } } });
    const q = new URLSearchParams({ status: "all" });
    if (values.repo) q.set("repo", values.repo);
    const all: any[] = await api(`/api/lessons?${q}`);
    const shown = values.all ? all : all.filter((l) => l.status === "proposed" || l.status === "approved");
    if (!shown.length) console.log(values.all ? "No lessons yet." : "No proposed or approved lessons.");
    const order = ["proposed", "approved", "rejected", "retired"];
    for (const l of shown.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.id - a.id)) {
      console.log(`L${l.id}\t${l.status}\t${l.repo} · from ${l.source}${l.run_id ? ` (run ${l.run_id})` : ""}${l.status === "approved" ? ` · given to ${l.uses} run(s)` : ""}`);
      console.log(`\t${l.text}`);
      if (l.status === "proposed" && l.evidence) console.log(`\tevidence: ${String(l.evidence).replace(/\s+/g, " ").slice(0, 300)}`);
      if (l.status === "proposed") console.log(`\tacutis lesson approve ${l.id} ["reworded text"] | acutis lesson reject ${l.id}`);
    }
    break;
  }
  case "lesson": {
    const id = () => runArg(rest[0], `acutis lesson ${sub} <id>`);
    let l: any;
    if (sub === "approve") l = await post(`/api/lessons/${id()}/approve`, { text: rest.slice(1).join(" ") || undefined });
    else if (sub === "reject" || sub === "retire") l = await post(`/api/lessons/${id()}/${sub}`);
    else if (sub === "edit") l = await post(`/api/lessons/${id()}/edit`, { text: rest.slice(1).join(" ") });
    else if (sub === "add") {
      const [repo, ...words] = rest;
      if (!repo || !words.length) die("usage: acutis lesson add <repo> <text>");
      l = await post("/api/lessons", { repo, text: words.join(" ") });
    } else die(USAGE);
    console.log(`L${l.id} ${l.status}: ${l.text}`);
    break;
  }
  case "decide": {
    const { values, positionals } = parseArgs({
      args: [sub, ...rest].filter((x): x is string => x !== undefined),
      allowPositionals: true,
      options: { version: { type: "string" }, keep: { type: "string" }, drop: { type: "string" } },
    });
    const id = runArg(positionals[0], "acutis decide <id> --version N <text> [--keep 3,4]");
    const text = positionals.slice(1).join(" ");
    if (!values.version || !text) die("usage: acutis decide <id> --version N <text> [--keep 3,4]  (the version is shown by acutis decisions)");
    const list = (v?: string) => (v ?? "").split(",").filter(Boolean).map(Number);
    const d = await post(`/api/decisions/${id}/decide`, { decision: text, version: Number(values.version), keep: list(values.keep), drop: list(values.drop) });
    console.log(`Decision #${d.id} recorded: ${d.decision}`);
    break;
  }
  case "decision": {
    if (sub === "add") {
      const [repo, ...words] = rest;
      if (!repo || !words.length) die("usage: acutis decision add <repo> <text>");
      const d = await post("/api/decisions", { repo, decision: words.join(" ") });
      console.log(`Decision #${d.id} recorded for ${repo}.`);
    } else if (sub === "withdraw") {
      const id = runArg(rest[0], "acutis decision withdraw <id>");
      await post(`/api/decisions/${id}/withdraw`);
      console.log(`Decision #${id} withdrawn; its held tickets wait in proposed.`);
    } else if (sub === "supersede") {
      const id = runArg(rest[0], "acutis decision supersede <id> <text>");
      const d = await post(`/api/decisions/${id}/supersede`, { decision: rest.slice(1).join(" ") });
      console.log(`Decision #${d.id} replaces #${id}.`);
    } else die(USAGE);
    break;
  }
  case "noticed": {
    if (sub === "ticket" || sub === "dismiss") {
      const id = runArg(rest[0], `acutis noticed ${sub} <id>`);
      const out = await post(`/api/noticed/${id}/${sub}`);
      console.log(sub === "ticket" ? `Ticket #${out.id} created from noticed #${id}: ${out.title}` : `Noticed #${id} dismissed`);
      break;
    }
    const list = await api(`/api/noticed${sub === "--all" ? "?status=all" : ""}`);
    if (!list.length) console.log(sub === "--all" ? "Nothing noticed yet." : "No open reports.");
    for (const n of list) {
      const runs = String(n.run_ids).split(",").filter(Boolean).map((r: string) => `run ${r}`).join(", ");
      console.log(`#${n.id}\t[${n.kind}] ${n.title}\t${n.repo} · ${runs}${n.count > 1 ? ` · ×${n.count}` : ""}${n.status === "open" ? "" : ` · ${n.status}${n.ticket_id ? ` #${n.ticket_id}` : ""}`}`);
      if (n.detail) console.log(`\t${String(n.detail).split("\n")[0]!.slice(0, 160)}`);
    }
    break;
  }
  case "start": {
    const { values, positionals } = parseArgs({ args: [sub, ...rest].filter((x): x is string => x !== undefined), allowPositionals: true, options: { watch: { type: "boolean" } } });
    const id = runArg(positionals[0], "acutis start <ticket-id> [--watch]");
    const run = await post(`/api/tickets/${id}/start`);
    console.log(
      run.state === "queued"
        ? `Run ${run.id} queued for ticket #${id}: the daemon's run limit is reached (ACUTIS_MAX_RUNS). It starts when a slot frees up.`
        : `Run ${run.id} started for ticket #${id}. Dashboard: ${base}/#run-${run.id}`,
    );
    if (values.watch) await watch(run.id, false);
    break;
  }
  case "runs":
  case "show":
  case "watch":
  case "perms":
  case "allow":
  case "deny":
  case "diff":
  case "msg":
  case "redirect":
  case "pause":
  case "resume":
  case "kill":
  case "approve":
  case "discard":
  case "note":
  case "preview":
    await runsCmd(cmd, [sub, ...rest].filter((x): x is string => x !== undefined));
    break;
  default:
    console.log(USAGE);
}
