import { expect, test } from "bun:test";
import { HARD_DENY, defaultWorkflow, parseWorkflow, renderTemplate, workerSystemPrompt } from "../src/core/workflow";
import type { Ticket } from "../src/core/types";

const ticket: Ticket = {
  id: 7, repo: "web", title: "Fix nav", body: "The nav overlaps on mobile.", status: "todo",
  source: "local", external_id: null, confidence: null, decision_id: null, noticed_id: null, builds_on: null, origin_run_id: null, created_at: "", updated_at: "",
};

test("parses front matter and template", () => {
  const wf = parseWorkflow(
    `---\nmodel: opus\neffort: high\ngates:\n  - bun test\n  - { name: types, run: bun run typecheck, timeout_s: 60 }\npermissions:\n  allow: ["Bash(bun *)"]\n  deny: ["WebFetch"]\nland: push\n---\nFix: {{ticket.title}}\n\n{{ ticket.body }}`,
    "test",
  );
  expect(wf.model).toBe("opus");
  expect(wf.gates).toEqual([
    { kind: "cmd", name: "bun test", run: "bun test" },
    { kind: "cmd", name: "types", run: "bun run typecheck", timeout_s: 60 },
  ]);
  expect(wf.allow).toContain("Bash(bun *)");
  expect(wf.deny).toContain("WebFetch");
  for (const d of HARD_DENY) expect(wf.deny).toContain(d); // repos can't remove hard denies
  expect(wf.land).toBe("push");
  expect(renderTemplate(wf.template, ticket)).toBe("Fix: Fix nav\n\nThe nav overlaps on mobile.");
});

test("no front matter means the whole file is the template", () => {
  const wf = parseWorkflow("Just do {{ticket.title}}", "t");
  expect(wf.gates).toEqual([]);
  expect(renderTemplate(wf.template, ticket)).toBe("Just do Fix nav");
});

test("rejects malformed gates", () => {
  expect(() => parseWorkflow("---\ngates: nope\n---\n", "t")).toThrow(/gates/);
});

test("default allowlist never auto-approves Read/Grep/Glob everywhere", () => {
  const wf = parseWorkflow("", "t");
  for (const bare of ["Read", "Grep", "Glob"]) expect(wf.allow).not.toContain(bare);
  expect(wf.deny).toContain("Read(~/.ssh/**)");
});

test("the worker prompt explains the sandboxed shell's socket limit only when it applies", () => {
  const ticket = { id: 1, repo: "r", title: "t", body: "" } as Ticket;
  const opts = { ticket, cwd: "/w", workflow: defaultWorkflow() };
  expect(workerSystemPrompt({ ...opts, sandboxed: true })).toContain("node --import tsx");
  expect(workerSystemPrompt({ ...opts, sandboxed: false })).not.toContain("Unix sockets");
  // A preview whose start page isn't "/" (e.g. it carries a token) is named, so the worker opens it.
  const withPreview = (path: string) => workerSystemPrompt({ ...opts, workflow: { ...opts.workflow, preview: { run: "bun dev", path, ready_timeout_s: 30 } } });
  expect(withPreview("/#token=preview")).toContain("Its start page is `/#token=preview`");
  expect(withPreview("/")).not.toContain("Its start page");
});

test("an acutis.db from before session_cost opens and gains the column", async () => {
  const { Database } = await import("bun:sqlite");
  const { Store } = await import("../src/core/db");
  const { tempDir } = await import("./helpers");
  const path = `${tempDir("acutis-db-")}/acutis.db`;
  const old = new Database(path, { create: true });
  old.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, repo TEXT NOT NULL, state TEXT NOT NULL,
    workspace_name TEXT, workspace_path TEXT, base_commit TEXT, session_id TEXT, model TEXT, attempt INTEGER NOT NULL DEFAULT 1,
    gates_ok INTEGER, cost_usd REAL NOT NULL DEFAULT 0, error TEXT, bookmark TEXT,
    created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '');
    INSERT INTO runs (ticket_id, repo, state, cost_usd) VALUES (1, 'r', 'paused', 0.4);`);
  old.close();
  const store = new Store(path);
  expect(store.getRun(1)).toMatchObject({ state: "paused", cost_usd: 0.4, session_cost: null, kind: "work", scout: null });
  expect(store.updateRun(1, { state: "queued", session_cost: 0.4 })).toMatchObject({ state: "queued", session_cost: 0.4 });
});
