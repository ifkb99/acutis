import { homedir } from "node:os";
import { Store } from "./core/db";
import { Hub } from "./core/hub";
import { RunManager } from "./core/runs";
import { ensureToken, tokenPath } from "./core/token";
import type { AgentRunner, BrowserProvider, CommandSandbox } from "./core/types";
import { ClaudeSdkRunner, probeSandbox } from "./providers/agent/claude-sdk";
import { ChromeBrowser } from "./providers/browser/chrome";
import { BwrapSandbox } from "./providers/sandbox/bwrap";
import { LocalTicketSource } from "./providers/tickets/local";
import { JjWorkspaceProvider } from "./providers/workspace/jj";

export interface Config {
  home: string;
  port: number;
  /** Runs that may be preparing, running, verifying or landing at once; 0 means no limit. */
  maxRuns?: number;
}

export function loadConfig(): Config {
  return {
    home: process.env.ACUTIS_HOME ?? `${process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`}/acutis`,
    port: Number(process.env.ACUTIS_PORT ?? 7777),
    maxRuns: Math.max(0, Math.floor(Number(process.env.ACUTIS_MAX_RUNS ?? 3)) || 0),
  };
}

export function createApp(
  cfg: Config,
  opts: { runner?: AgentRunner; browser?: BrowserProvider; commandSandbox?: CommandSandbox; costPollMs?: number } = {},
) {
  const store = new Store(`${cfg.home}/acutis.db`);
  const hub = new Hub(store);
  const tickets = new LocalTicketSource(store);
  const workspaces = new JjWorkspaceProvider(`${cfg.home}/workspaces`);
  const sandboxStatus = opts.runner ? { ok: false, reason: "test runner" } : probeSandbox();
  const sandbox = sandboxStatus.ok;
  const token = ensureToken(cfg.home);
  const runner = opts.runner ?? new ClaudeSdkRunner({ sandbox, denyRead: [tokenPath(cfg.home)] });
  const browser = opts.browser ?? new ChromeBrowser();
  // Gates and previews run worker-written code: confine them whenever the agent itself is sandboxed.
  const commandSandbox = opts.commandSandbox ?? (sandbox ? new BwrapSandbox({ hide: [cfg.home] }) : undefined);
  const runs = new RunManager({
    store,
    hub,
    tickets,
    workspaces,
    runner,
    browser,
    artifactsDir: `${cfg.home}/artifacts`,
    commandSandbox,
    agentSandboxed: sandbox,
    maxRuns: cfg.maxRuns ?? 0,
    costPollMs: opts.costPollMs,
  });
  return { cfg, store, hub, tickets, workspaces, runner, runs, browser, sandbox, sandboxStatus, token };
}

export type App = ReturnType<typeof createApp>;
