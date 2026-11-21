import { homedir } from "node:os";
import { Store } from "./core/db";
import { Hub } from "./core/hub";
import { RunManager } from "./core/runs";
import type { AgentRunner, BrowserProvider } from "./core/types";
import { ClaudeSdkRunner, probeSandbox } from "./providers/agent/claude-sdk";
import { ChromeBrowser } from "./providers/browser/chrome";
import { LocalTicketSource } from "./providers/tickets/local";
import { JjWorkspaceProvider } from "./providers/workspace/jj";

export interface Config {
  home: string;
  port: number;
}

export function loadConfig(): Config {
  return {
    home: process.env.ACUTIS_HOME ?? `${process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`}/acutis`,
    port: Number(process.env.ACUTIS_PORT ?? 7777),
  };
}

export function createApp(cfg: Config, opts: { runner?: AgentRunner; browser?: BrowserProvider } = {}) {
  const store = new Store(`${cfg.home}/acutis.db`);
  const hub = new Hub(store);
  const tickets = new LocalTicketSource(store);
  const workspaces = new JjWorkspaceProvider(`${cfg.home}/workspaces`);
  const sandboxStatus = opts.runner ? { ok: false, reason: "test runner" } : probeSandbox();
  const sandbox = sandboxStatus.ok;
  const runner = opts.runner ?? new ClaudeSdkRunner({ sandbox });
  const browser = opts.browser ?? new ChromeBrowser();
  const runs = new RunManager({ store, hub, tickets, workspaces, runner, browser, artifactsDir: `${cfg.home}/artifacts` });
  return { cfg, store, hub, tickets, workspaces, runner, runs, browser, sandbox, sandboxStatus };
}

export type App = ReturnType<typeof createApp>;
