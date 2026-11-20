import type { Gate, Ticket, Workflow } from "./types";

export const WORKFLOW_PATH = ".acutis/workflow.md";

export const DEFAULT_TEMPLATE = `Work on ticket #{{ticket.id}}: {{ticket.title}}

{{ticket.body}}`;

/**
 * Low-risk commands every worker may run without asking. Claude Code still asks when one of
 * these touches a path outside the workspace. Read/Grep/Glob are deliberately absent: a bare
 * "Read" rule would auto-approve reads anywhere on the machine (found by the 2026-11-19 probe).
 * Inside the workspace they are already allowed.
 */
export const DEFAULT_ALLOW = [
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(grep:*)",
  "Bash(rg:*)",
  "Bash(find:*)",
  "Bash(jj diff:*)",
  "Bash(jj status:*)",
  "Bash(jj log:*)",
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(git log:*)",
];

/** Things workers must never do, whatever a repo's workflow says. */
export const HARD_DENY = [
  "Bash(git push:*)",
  "Bash(git commit:*)",
  "Bash(git checkout:*)",
  "Bash(git reset:*)",
  "Bash(jj git push:*)",
  "Bash(jj bookmark:*)",
  "Bash(jj workspace:*)",
  "Bash(jj abandon:*)",
  "Bash(jj op:*)",
  "Bash(sudo:*)",
  // Credentials: never readable by workers, even with operator approval.
  "Read(~/.ssh/**)",
  "Read(~/.aws/**)",
  "Read(~/.gnupg/**)",
  "Read(~/.config/gh/**)",
  "Read(~/.claude/.credentials.json)",
  "Read(~/.netrc)",
  "Read(~/.npmrc)",
];

export function defaultWorkflow(): Workflow {
  return {
    gates: [],
    allow: [...DEFAULT_ALLOW],
    deny: [...HARD_DENY],
    max_attempts: 2,
    land: "bookmark",
    template: DEFAULT_TEMPLATE,
    source: "(default)",
  };
}

function splitFrontMatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = (Bun.YAML.parse(m[1]!) ?? {}) as Record<string, unknown>;
  return { meta, body: m[2] ?? "" };
}

function asStringArray(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new Error(`workflow: "${field}" must be a list of strings`);
  }
  return v;
}

function parseGates(v: unknown): Gate[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('workflow: "gates" must be a list');
  return v.map((g, i) => {
    if (typeof g === "string") return { name: g, run: g };
    if (g && typeof g === "object" && typeof (g as any).run === "string") {
      const run = (g as any).run as string;
      return { name: (g as any).name ?? run, run, timeout_s: (g as any).timeout_s };
    }
    throw new Error(`workflow: gate ${i + 1} must be a string or {run: "..."}`);
  });
}

/** Parse `.acutis/workflow.md` (YAML front matter + prompt template). */
export function parseWorkflow(text: string, source: string): Workflow {
  const { meta, body } = splitFrontMatter(text);
  const wf = defaultWorkflow();
  wf.source = source;
  if (typeof meta.model === "string") wf.model = meta.model;
  if (typeof meta.effort === "string") wf.effort = meta.effort as Workflow["effort"];
  wf.gates = parseGates(meta.gates);
  const perms = (meta.permissions ?? {}) as Record<string, unknown>;
  wf.allow = [...DEFAULT_ALLOW, ...asStringArray(perms.allow, "permissions.allow")];
  wf.deny = [...HARD_DENY, ...asStringArray(perms.deny, "permissions.deny")];
  if (typeof meta.max_attempts === "number") wf.max_attempts = Math.max(1, Math.floor(meta.max_attempts));
  if (meta.land === "push" || meta.land === "bookmark") wf.land = meta.land;
  if (body.trim()) wf.template = body.trim();
  return wf;
}

export function renderTemplate(template: string, ticket: Ticket): string {
  const vars: Record<string, string> = {
    "ticket.id": String(ticket.id),
    "ticket.title": ticket.title,
    "ticket.body": ticket.body || "(no description)",
    "ticket.repo": ticket.repo,
  };
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, key) => vars[key] ?? all);
}

export function workerSystemPrompt(opts: { ticket: Ticket; cwd: string; workflow: Workflow }): string {
  const gates = opts.workflow.gates.length
    ? opts.workflow.gates.map((g) => `- \`${g.run}\``).join("\n")
    : "- (none configured)";
  return `# Acutis worker

You are an Acutis worker assigned to ticket #${opts.ticket.id} in repository "${opts.ticket.repo}".
You are working in an isolated workspace at ${opts.cwd}. Other agents may be working on other tickets in parallel workspaces.

Rules:
- Only create or modify files inside ${opts.cwd}.
- Do not commit, push, create branches/bookmarks, or rewrite history. Acutis records your changes from the working copy and lands them after human review.
- Do not start long-running servers, watchers, or background processes. Acutis owns those.
- Do not edit files under .acutis/ unless the ticket explicitly asks for it.
- If a tool call is denied, do not try to get around the denial. Find another approach or explain what you need.
- If the ticket is ambiguous or you are blocked, stop and say exactly what you need instead of guessing.

When you finish, Acutis runs these checks in the workspace:
${gates}
Run them yourself first where you can.

End with a short summary: what you changed, why, and how you verified it.`;
}
