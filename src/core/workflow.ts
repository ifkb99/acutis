import { DEFAULT_LIBRARY_EXCLUDE, DEFAULT_LIBRARY_INCLUDE } from "./library";
import type { BrowserGate, CommandGate, Gate, PreviewSpec, Repo, Ticket, Workflow } from "./types";

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
  "Bash(git show:*)",
  "Bash(git ls-files:*)",
  "Bash(git rev-parse:*)",
  "Bash(jj file list:*)",
  "Bash(jj file show:*)",
  "Bash(pwd)",
  "Bash(which:*)",
  "Bash(tree:*)",
  "Bash(sort:*)",
  "Bash(uniq:*)",
  "Bash(diff:*)",
  "Bash(file:*)",
  "Bash(stat:*)",
  "Bash(du:*)",
  "Bash(bun --version)",
  "Bash(node --version)",
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
    setup: [],
    gates: [],
    allow: [...DEFAULT_ALLOW],
    deny: [...HARD_DENY],
    max_attempts: 2,
    land: "bookmark",
    template: DEFAULT_TEMPLATE,
    source: "(default)",
    library: { include: [...DEFAULT_LIBRARY_INCLUDE], exclude: [...DEFAULT_LIBRARY_EXCLUDE] },
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

function parseCommand(g: unknown, field: string, i: number): CommandGate {
  if (typeof g === "string") return { kind: "cmd", name: g, run: g };
  if (g && typeof g === "object" && typeof (g as any).run === "string") {
    const run = (g as any).run as string;
    return { kind: "cmd", name: (g as any).name ?? run, run, timeout_s: (g as any).timeout_s };
  }
  throw new Error(`workflow: ${field} ${i + 1} must be a string or {run: "..."}`);
}

function parseBrowserGate(g: Record<string, unknown>, i: number): BrowserGate {
  const b = g.browser as Record<string, unknown>;
  if (!b || typeof b !== "object") throw new Error(`workflow: gate ${i + 1}: "browser" must be a mapping`);
  const path = typeof b.path === "string" ? b.path : "/";
  if (!path.startsWith("/")) throw new Error(`workflow: gate ${i + 1}: browser.path must start with "/"`);
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? Math.floor(v) : undefined);
  return {
    kind: "browser",
    name: typeof g.name === "string" ? g.name : `browser ${path}`,
    path,
    steps: typeof b.steps === "string" ? b.steps : undefined,
    script: typeof b.script === "string" ? b.script : undefined,
    width: num(b.width),
    height: num(b.height),
  };
}

function parseGates(v: unknown): Gate[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('workflow: "gates" must be a list');
  return v.map((g, i) =>
    g && typeof g === "object" && "browser" in g ? parseBrowserGate(g as Record<string, unknown>, i) : parseCommand(g, "gate", i),
  );
}

function parseSetup(v: unknown): CommandGate[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('workflow: "setup" must be a list');
  return v.map((g, i) => parseCommand(g, "setup step", i));
}

/** `library: false`, or `library: { include: [globs], exclude: [globs] }` (each replaces its default). */
function parseLibrary(v: unknown): Workflow["library"] {
  if (v === false) return false;
  const defaults = { include: [...DEFAULT_LIBRARY_INCLUDE], exclude: [...DEFAULT_LIBRARY_EXCLUDE] };
  if (v === undefined || v === null || v === true) return defaults;
  if (typeof v !== "object" || Array.isArray(v)) throw new Error('workflow: "library" must be false or { include, exclude }');
  const l = v as Record<string, unknown>;
  return {
    include: l.include === undefined ? defaults.include : asStringArray(l.include, "library.include"),
    exclude: l.exclude === undefined ? defaults.exclude : asStringArray(l.exclude, "library.exclude"),
  };
}

function parsePreview(v: unknown): PreviewSpec | undefined {
  if (v === undefined || v === null) return undefined;
  const p = (typeof v === "string" ? { run: v } : v) as Record<string, unknown>;
  if (typeof p.run !== "string" || !p.run.trim()) throw new Error('workflow: "preview.run" must be a command');
  const path = typeof p.path === "string" ? p.path : "/";
  if (!path.startsWith("/")) throw new Error('workflow: "preview.path" must start with "/"');
  const t = typeof p.ready_timeout_s === "number" && p.ready_timeout_s > 0 ? p.ready_timeout_s : 30;
  return { run: p.run, path, ready_timeout_s: t };
}

/** Parse `.acutis/workflow.md` (YAML front matter + prompt template). */
export function parseWorkflow(text: string, source: string): Workflow {
  const { meta, body } = splitFrontMatter(text);
  const wf = defaultWorkflow();
  wf.source = source;
  if (typeof meta.model === "string") wf.model = meta.model;
  if (typeof meta.effort === "string") wf.effort = meta.effort as Workflow["effort"];
  wf.setup = parseSetup(meta.setup);
  wf.gates = parseGates(meta.gates);
  wf.preview = parsePreview(meta.preview);
  if (wf.gates.some((g) => g.kind === "browser") && !wf.preview) {
    throw new Error('workflow: browser gates need a "preview" command to serve the app');
  }
  if (typeof meta.permission_timeout_s === "number" && meta.permission_timeout_s > 0) {
    wf.permission_timeout_s = meta.permission_timeout_s;
  }
  const perms = (meta.permissions ?? {}) as Record<string, unknown>;
  wf.allow = [...DEFAULT_ALLOW, ...asStringArray(perms.allow, "permissions.allow")];
  wf.deny = [...HARD_DENY, ...asStringArray(perms.deny, "permissions.deny")];
  if (typeof meta.max_attempts === "number") wf.max_attempts = Math.max(1, Math.floor(meta.max_attempts));
  if (meta.land === "push" || meta.land === "bookmark" || meta.land === "trunk") wf.land = meta.land;
  else if (meta.land !== undefined) throw new Error('workflow: "land" must be bookmark, push or trunk');
  if (body.trim()) wf.template = body.trim();
  wf.library = parseLibrary(meta.library);
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

export function describeGate(g: Gate): string {
  return g.kind === "cmd" ? g.run : `browser check of ${g.path}${g.script ? ` (script: ${g.script})` : ""}`;
}

export function workerSystemPrompt(opts: { ticket: Ticket; cwd: string; workflow: Workflow; repo?: Repo; sandboxed?: boolean }): string {
  const gates = opts.workflow.gates.length
    ? opts.workflow.gates.map((g) => `- \`${describeGate(g)}\``).join("\n")
    : "- (none configured)";
  const preview = opts.workflow.preview
    ? `

Seeing your work: Acutis runs this repo's preview server for you (\`${opts.workflow.preview.run}\`), so don't start one yourself.
- \`mcp__acutis__preview\` starts it if needed and returns its URL and recent logs.
- \`mcp__acutis__browser\` opens a path of the preview in headless Chrome, runs optional steps (one per line: \`press ArrowLeft\`, \`click #selector\`, \`type text\`, \`wait 200\`, \`waitfor #selector\`) and an optional JS expression, then returns a screenshot, console output and page errors.
Use them to check UI changes before you finish. Only the preview's own origin is reachable from that browser.`
    : "";
  const notes = opts.repo?.notes?.trim()
    ? `

Operator notes for this repo (from the human operator; follow them):
${opts.repo.notes.trim()}`
    : "";
  return `# Acutis worker

You are an Acutis worker assigned to ticket #${opts.ticket.id} in repository "${opts.ticket.repo}".
You are working in an isolated workspace at ${opts.cwd}. Other agents may be working on other tickets in parallel workspaces.

Rules:
- Only create or modify files inside ${opts.cwd}.
- Do not commit, push, create branches/bookmarks, or rewrite history. Acutis records your changes from the working copy and lands them after human review.
- Do not start long-running servers, watchers, or background processes. Acutis owns those.
- Do not edit files under .acutis/ unless the ticket explicitly asks for it.
- If a tool call is denied, do not try to get around the denial. Find another approach or explain what you need.
- If the ticket is ambiguous or you are blocked, stop and say exactly what you need instead of guessing.${
    opts.sandboxed
      ? `
- Your shell is sandboxed. It can't create or connect to Unix sockets (EPERM), so tools that use socket IPC fail: run TypeScript with \`node --import tsx file.ts\` rather than \`tsx file.ts\`. Reaching a new network host asks the operator. The checks below run in a separate sandbox that allows Unix sockets but has no network at all.`
      : ""
  }

When you finish, Acutis runs these checks in the workspace:
${gates}
Run them yourself first where you can.${
    opts.workflow.library
      ? `

Project knowledge: \`mcp__acutis__search_project\` searches this repo's docs (as of trunk) and summaries of earlier landed runs, returning short excerpts with path:line. Use it before reading many files to find where something is explained; open a result with \`mcp__acutis__read_project_entry\`.`
      : ""
  }

Outside your ticket: if you notice a problem that isn't part of this ticket (a check already failing on the base, a bug elsewhere, stale docs, a security issue), don't fix it here. Record it with \`mcp__acutis__report_noticed\`, with evidence (file:line, a command and its output), then carry on with the ticket.${preview}${notes}

End with a short summary: what you changed, why, and how you verified it.`;
}
