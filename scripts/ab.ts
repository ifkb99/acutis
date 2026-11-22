#!/usr/bin/env bun
/**
 * A/B harness: run the same tickets under different library settings and compare the runs.
 *
 *   bun scripts/ab.ts <config.json>
 *
 * Config: { source, workdir, budgetUsd, maxRuns?, permissionTimeoutS?, arms: [{ name, library }],
 *           tickets: [{ id, title, body, base }], runs: [{ arm, ticket }] }
 * - source: a git repo holding every ticket's base commit (cloned, never modified).
 * - Each arm gets its own ACUTIS_HOME and its own clone per ticket, pinned to the ticket's base
 *   commit plus one commit that sets the arm's `library:` settings (and a permission timeout, so an
 *   unattended run doesn't wait forever on a prompt) in .acutis/workflow.md.
 * - Arms that describe docs are indexed and described before their runs start.
 * - Runs go to review (or fail) and are then discarded; nothing lands. A spend cap kills the rest.
 * Results: <workdir>/results.json and results.md.
 */
import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { parseWorkflow } from "../src/core/workflow";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { Run } from "../src/core/types";

interface Config {
  source: string;
  workdir: string;
  budgetUsd: number;
  /** Wall-clock limit for the runs, in minutes; what's still running then is killed. */
  maxMinutes?: number;
  maxRuns?: number;
  permissionTimeoutS?: number;
  arms: { name: string; library: Record<string, unknown> }[];
  tickets: { id: string; title: string; body: string; base: string }[];
  runs: { arm: string; ticket: string }[];
}

const cfg = (await Bun.file(process.argv[2]!).json()) as Config;
if (process.env.ANTHROPIC_API_KEY) throw new Error("unset ANTHROPIC_API_KEY: runs should use the Claude login");
// Never reuse a workdir: it holds paid-for run records.
if (existsSync(cfg.workdir)) throw new Error(`${cfg.workdir} exists; pick a new workdir`);
mkdirSync(cfg.workdir, { recursive: true });
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

/** Replace (or add) top-level keys in the workflow's YAML front matter. */
function patchFrontMatter(text: string, keys: Record<string, string>): string {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const head = m ? m[1]! : "";
  const body = m ? text.slice(m[0].length) : text;
  const lines = head.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const key = /^([A-Za-z_]+):/.exec(lines[i]!)?.[1];
    if (key && key in keys) {
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1]!)) i++; // drop the old value's nested lines
      continue;
    }
    out.push(lines[i]!);
  }
  for (const [k, v] of Object.entries(keys)) out.push(`${k}: ${v}`);
  return `---\n${out.join("\n")}\n---\n${body}`;
}

const yaml = (v: unknown): string => JSON.stringify(v); // JSON is valid YAML flow style

interface Arm {
  name: string;
  app: ReturnType<typeof createApp>;
  repos: Map<string, string>; // ticket id -> repo name
}

const arms: Arm[] = [];
for (const arm of cfg.arms) {
  const dir = join(cfg.workdir, arm.name);
  mkdirSync(dir, { recursive: true });
  const app = createApp({ home: join(dir, "home"), port: 0, maxRuns: cfg.maxRuns ?? 4 });
  const repos = new Map<string, string>();
  for (const t of cfg.tickets) {
    const path = join(dir, t.id);
    await $`git clone -q ${cfg.source} ${path}`.quiet();
    await $`git checkout -q -B ab-base ${t.base}`.cwd(path).quiet();
    const wfPath = join(path, ".acutis/workflow.md");
    const wf = patchFrontMatter(await Bun.file(wfPath).text(), {
      library: yaml(arm.library),
      permission_timeout_s: String(cfg.permissionTimeoutS ?? 120),
    });
    await Bun.write(wfPath, wf);
    await $`git -c user.name=ab -c user.email=ab@example.invalid commit -qam ${`A/B: ${arm.name} library settings`}`.cwd(path).quiet();
    // Prove the arm is what we think: read the workflow back from the commit runs will use.
    const parsed = parseWorkflow(await $`git show ab-base:.acutis/workflow.md`.cwd(path).text(), "ab");
    const want = { librarian: arm.library.librarian ?? true, describe: arm.library.describe ?? false };
    const got = parsed.library ? { librarian: parsed.library.librarian, describe: parsed.library.describe } : null;
    if (!got || got.librarian !== want.librarian || got.describe !== want.describe || parsed.permission_timeout_s !== (cfg.permissionTimeoutS ?? 120)) {
      throw new Error(`${arm.name}/${t.id}: workflow reads back as ${JSON.stringify({ ...got, permission_timeout_s: parsed.permission_timeout_s })}, wanted ${JSON.stringify(want)}`);
    }
    await $`jj git init --colocate`.cwd(path).quiet();
    const name = `${t.id}-${arm.name}`;
    app.store.addRepo({ name, path, base: "ab-base" });
    repos.set(t.id, name);
    // Describe before any run starts, so the arm's first run already searches with descriptions.
    if (arm.library.describe === true) {
      const commit = (await $`git rev-parse HEAD`.cwd(path).text()).trim();
      const files = (await $`jj file list -r ${commit}`.cwd(path).text()).split("\n").filter(Boolean);
      const lib = app.runs.library;
      if (!lib.isIndexed(name, commit)) {
        lib.index(name, commit, path, files, parsed.library as any);
        (app.runs as any).scheduleDescribe(name, commit, (parsed.library as any).describe_budget_usd);
      }
    }
  }
  arms.push({ name: arm.name, app, repos });
  log(`arm ${arm.name}: ${repos.size} repos ready`);
}
for (const a of arms) await a.app.runs.describeIdle();
for (const a of arms) {
  for (const [, repo] of a.repos) {
    const job = a.app.runs.library.status(repo)[0];
    if (job?.describe_status) log(`${repo}: descriptions ${job.describe_status}, ${job.described} written, ${job.cached} reused, $${Number(job.cost_usd).toFixed(3)}`);
  }
}

// Start every run; each arm's own run limit queues the rest.
const started: { arm: Arm; ticket: string; run: Run }[] = [];
for (const r of cfg.runs) {
  const arm = arms.find((a) => a.name === r.arm)!;
  const t = cfg.tickets.find((x) => x.id === r.ticket)!;
  const ticket = arm.app.tickets.create({ repo: arm.repos.get(t.id)!, title: t.title, body: t.body });
  const run = await arm.app.runs.start(ticket.id);
  started.push({ arm, ticket: t.id, run });
  log(`started ${arm.name}/${t.id} as run ${run.id}`);
}

const DONE = new Set(["awaiting_review", "failed", "cancelled", "done"]);
const spent = () => started.reduce((s, x) => s + x.arm.app.store.getRun(x.run.id)!.cost_usd, 0);
let capped = false;
const deadline = Date.now() + (cfg.maxMinutes ?? 75) * 60_000;
while (started.some((x) => !DONE.has(x.arm.app.store.getRun(x.run.id)!.state))) {
  await Bun.sleep(10_000);
  if (Date.now() > deadline) {
    log(`past the ${cfg.maxMinutes ?? 75}-minute limit; killing what's left`);
    for (const x of started) if (!DONE.has(x.arm.app.store.getRun(x.run.id)!.state)) await x.arm.app.runs.kill(x.run.id).catch(() => {});
    break;
  }
  if (!capped && spent() > cfg.budgetUsd) {
    capped = true;
    log(`spend $${spent().toFixed(2)} passed the cap ($${cfg.budgetUsd}); killing what's left`);
    for (const x of started) if (!DONE.has(x.arm.app.store.getRun(x.run.id)!.state)) await x.arm.app.runs.kill(x.run.id).catch(() => {});
  }
}

// Metrics from each run's record.
const results = started.map(({ arm, ticket, run }) => {
  const store = arm.app.store;
  const r = store.getRun(run.id)!;
  const ev = store.events(run.id);
  const of = (k: string) => ev.filter((e) => e.kind === k).map((e) => e.data as any);
  const results = of("agent.result");
  const usage = results.at(-1)?.model_usage ?? {};
  const tokens = Object.fromEntries(
    Object.entries(usage).map(([m, u]: [string, any]) => [m, { in: u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, out: u.outputTokens }]),
  );
  const lib = (k: string, by: string) => of(k).filter((d) => (d.by ?? "worker") === by);
  const sumChars = (xs: any[]) => xs.reduce((s, d) => s + (d.chars ?? 0), 0);
  const librarian = of("library.librarian");
  const gates = of("gate.result");
  const t0 = Date.parse(ev[0]?.ts ?? r.created_at);
  const t1 = Date.parse(ev.at(-1)?.ts ?? r.updated_at);
  return {
    arm: arm.name,
    ticket,
    run: run.id,
    state: r.state,
    attempts: r.attempt,
    checks_passed: r.gates_ok === 1,
    first_try_pass: r.gates_ok === 1 && r.attempt === 1,
    gate_failures: gates.filter((g) => !g.ok).length,
    cost_usd: Number(r.cost_usd.toFixed(4)),
    librarian_cost_usd: Number(librarian.reduce((s, d) => s + (d.cost_usd ?? 0), 0).toFixed(4)),
    turns_last: results.at(-1)?.turns ?? 0,
    turns_sum: results.reduce((s, d) => s + (d.turns ?? 0), 0),
    minutes: Number(((t1 - t0) / 60000).toFixed(1)),
    tool_calls: of("agent.tool_use").length,
    worker_searches: lib("library.search", "worker").length,
    worker_reads: lib("library.read", "worker").length,
    worker_library_chars: sumChars([...lib("library.search", "worker"), ...lib("library.read", "worker"), ...lib("library.overview", "worker")]),
    librarian_calls: librarian.length,
    librarian_unsourced: librarian.reduce((s, d) => s + (d.unverified ?? 0), 0),
    permission_requests: of("permission.request").length,
    tokens,
    error: r.error,
  };
});
await Bun.write(join(cfg.workdir, "results.json"), JSON.stringify(results, null, 2));

const cols = ["arm", "ticket", "state", "attempts", "first_try_pass", "gate_failures", "cost_usd", "librarian_cost_usd", "turns_last", "turns_sum", "minutes", "tool_calls", "worker_searches", "worker_library_chars", "librarian_calls", "permission_requests"] as const;
const md = [
  `| ${cols.join(" | ")} |`,
  `| ${cols.map(() => "---").join(" | ")} |`,
  ...results.map((r) => `| ${cols.map((c) => String((r as any)[c])).join(" | ")} |`),
  "",
  `Total spend: $${spent().toFixed(2)}${capped ? " (cap reached)" : ""}`,
].join("\n");
await Bun.write(join(cfg.workdir, "results.md"), md);
console.log(md);

// Keep each run's work (diff and final report) for reading side by side, then discard the workspace.
for (const { arm, ticket, run } of started) {
  const base = join(cfg.workdir, `${arm.name}-${ticket}-run${run.id}`);
  await Bun.write(`${base}.diff`, await arm.app.runs.diff(run.id).catch((e) => `(no diff: ${(e as Error).message})`));
  const final = arm.app.store.events(run.id).filter((e) => e.kind === "agent.result").at(-1)?.data as any;
  await Bun.write(`${base}.md`, String(final?.result ?? "(no final report)"));
}
for (const { arm, run } of started) {
  const r = arm.app.store.getRun(run.id)!;
  if (r.state !== "done" && r.workspace_path) await arm.app.runs.discard(run.id).catch(() => {});
  arm.app.runs.shutdown();
}
process.exit(0);
