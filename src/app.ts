import { homedir } from "node:os";
import { Store } from "./core/db";
import { Hub } from "./core/hub";
import { RunManager } from "./core/runs";
import type { AgentRunner } from "./core/types";
import { ClaudeSdkRunner, probeSandbox } from "./providers/agent/claude-sdk";
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

export function createApp(cfg: Config, opts: { runner?: AgentRunner } = {}) {
  const store = new Store(`${cfg.home}/acutis.db`);
  const hub = new Hub(store);
  const tickets = new LocalTicketSource(store);
  const workspaces = new JjWorkspaceProvider(`${cfg.home}/workspaces`);
  const sandboxStatus = opts.runner ? { ok: false, reason: "test runner" } : probeSandbox();
  const sandbox = sandboxStatus.ok;
  const runner = opts.runner ?? new ClaudeSdkRunner({ sandbox });
  const runs = new RunManager({ store, hub, tickets, workspaces, runner });
  return { cfg, store, hub, tickets, workspaces, runner, runs, sandbox, sandboxStatus };
}

export type App = ReturnType<typeof createApp>;
