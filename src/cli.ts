#!/usr/bin/env bun
import { $ } from "bun";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createApp, loadConfig } from "./app";
import { startServer } from "./server/server";

const USAGE = `acutis — local software factory

Usage:
  acutis serve [--dev] [--allow-api-billing]   Start the daemon and dashboard
  acutis repo add <path> [--name N] [--base REV] [--init-jj]
  acutis repo ls
  acutis ticket add <repo> <title> [--body TEXT]
  acutis ticket ls
  acutis start <ticket-id>                      Start a run for a ticket

Env: ACUTIS_HOME (default ~/.local/share/acutis), ACUTIS_PORT (default 7777)`;

const cfg = loadConfig();
const [cmd, sub, ...rest] = process.argv.slice(2);

function die(msg: string): never {
  console.error(`acutis: ${msg}`);
  process.exit(1);
}

async function api(path: string, init?: { method?: string; body?: unknown }) {
  const res = await fetch(`http://127.0.0.1:${cfg.port}${path}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json", "x-acutis": "1" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  }).catch(() => die(`daemon not reachable on port ${cfg.port}; run "acutis serve" first`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die((data as any).error ?? `HTTP ${res.status}`);
  return data as any;
}

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
  console.log(`Acutis dashboard: http://127.0.0.1:${cfg.port}`);
  console.log(`Data: ${cfg.home}`);
  console.log(
    app.sandbox
      ? "Sandbox: on (bubblewrap + socat)"
      : `Sandbox: OFF (${app.sandboxStatus.reason}).\n  Workers run with a command allowlist; any other command asks you in the dashboard.`,
  );
}

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
  const probe = { name, path, base: "", created_at: "" };
  let base = values.base;
  if (!base) {
    for (const cand of ["main", "master", "trunk()"]) {
      try {
        const id = await app.workspaces.resolve(probe, cand);
        if (!/^0+$/.test(id)) {
          base = cand;
          break;
        }
      } catch {}
    }
    if (!base) die("couldn't find a trunk (main/master). Pass --base <revset>.");
  } else {
    await app.workspaces.resolve(probe, base).catch((e) => die(e.message));
  }
  const repo = app.store.addRepo({ name, path, base });
  console.log(`Registered ${repo.name} → ${repo.path} (base: ${repo.base})`);
}

switch (cmd) {
  case "serve":
    await serve([sub, ...rest].filter((x): x is string => x !== undefined));
    break;
  case "repo":
    if (sub === "add") await repoAdd(rest);
    else if (sub === "ls") {
      for (const r of createApp(cfg).store.listRepos()) console.log(`${r.name}\t${r.base}\t${r.path}`);
    } else die(USAGE);
    break;
  case "ticket":
    if (sub === "add") {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { body: { type: "string" } } });
      const [repo, ...title] = positionals;
      if (!repo || !title.length) die("usage: acutis ticket add <repo> <title> [--body TEXT]");
      const t = await api("/api/tickets", { method: "POST", body: { repo, title: title.join(" "), body: values.body ?? "" } });
      console.log(`#${t.id} ${t.title}`);
    } else if (sub === "ls") {
      const s = await api("/api/state");
      for (const t of s.tickets) console.log(`#${t.id}\t${t.status}\t${t.repo}\t${t.title}`);
    } else die(USAGE);
    break;
  case "start": {
    if (!sub) die("usage: acutis start <ticket-id>");
    const run = await api(`/api/tickets/${sub}/start`, { method: "POST" });
    console.log(`Run ${run.id} started for ticket #${sub}. Watch it at http://127.0.0.1:${cfg.port}/#run-${run.id}`);
    break;
  }
  default:
    console.log(USAGE);
}
