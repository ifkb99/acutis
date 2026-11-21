import { expect, test } from "bun:test";
import { HARD_DENY, parseWorkflow, renderTemplate } from "../src/core/workflow";
import type { Ticket } from "../src/core/types";

const ticket: Ticket = {
  id: 7, repo: "web", title: "Fix nav", body: "The nav overlaps on mobile.", status: "todo",
  source: "local", external_id: null, created_at: "", updated_at: "",
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
