import { DEFAULT_LIBRARY_EXCLUDE, DEFAULT_LIBRARY_INCLUDE } from "./library";
import { DEFAULT_SCOUT_BUDGET_USD, SCOUT_TYPES, decisionsSection } from "./scouts";
import { type GivenLesson, lessonsSection } from "./lessons";
import type { BrowserGate, CommandGate, Decision, Gate, PreviewSpec, Repo, Ticket, Workflow } from "./types";

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
    library: { include: [...DEFAULT_LIBRARY_INCLUDE], exclude: [...DEFAULT_LIBRARY_EXCLUDE], describe: false, describe_budget_usd: 0.5, librarian: true },
    scouts: { auto_tickets: "high", budget_usd: DEFAULT_SCOUT_BUDGET_USD, types: {}, trigger_debounce_min: 10, trigger_daily_cap: 3 },
    contracts: {},
    lessons: { draft: true, budget_chars: 1500 },
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

/** `contracts: { name: { files: [globs], consumers?: [globs], check?: command } }`. */
function parseContracts(v: unknown): Workflow["contracts"] {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new Error('workflow: "contracts" must be a map of name to { files, consumers, check }');
  const out: Workflow["contracts"] = {};
  for (const [name, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.-]{1,60}$/.test(name)) throw new Error(`workflow: contract name "${name}" must be letters, digits, . _ -`);
    const c = (raw ?? {}) as Record<string, unknown>;
    const files = asStringArray(c.files, `contracts.${name}.files`);
    if (!files.length) throw new Error(`workflow: "contracts.${name}.files" must list the contract's files`);
    if (c.check !== undefined && (typeof c.check !== "string" || !c.check.trim())) throw new Error(`workflow: "contracts.${name}.check" must be a command`);
    out[name] = {
      files,
      consumers: c.consumers === undefined ? null : asStringArray(c.consumers, `contracts.${name}.consumers`),
      check: typeof c.check === "string" ? c.check : undefined,
    };
  }
  return out;
}

/**
 * `scouts: false`, or `scouts: { auto_tickets: high|never, budget_usd: N, trigger_debounce_min: N, trigger_daily_cap: N,
 *   <type>: true | false | { focus, budget_usd, triggers: [globs] } }`. A scout with `triggers` wakes
 *   when trunk changes a matching path.
 * Every built-in scout is allowed unless turned off; the repo can't define new ones.
 */
function parseScouts(v: unknown): Workflow["scouts"] {
  const out = {
    auto_tickets: "high" as "high" | "never",
    budget_usd: DEFAULT_SCOUT_BUDGET_USD,
    types: {} as Record<string, { enabled: boolean; focus: string; budget_usd?: number; triggers?: string[] }>,
    trigger_debounce_min: 10,
    trigger_daily_cap: 3,
  };
  if (v === false) return false;
  if (v === undefined || v === null || v === true) return out;
  if (typeof v !== "object" || Array.isArray(v)) throw new Error('workflow: "scouts" must be false or a map');
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === "auto_tickets") {
      if (val !== "high" && val !== "never") throw new Error('workflow: "scouts.auto_tickets" must be high or never');
      out.auto_tickets = val;
    } else if (k === "budget_usd") {
      if (typeof val !== "number" || !(val > 0)) throw new Error('workflow: "scouts.budget_usd" must be a positive number');
      out.budget_usd = val;
    } else if (k === "trigger_debounce_min") {
      if (typeof val !== "number" || !(val >= 0) || val > 1440) throw new Error('workflow: "scouts.trigger_debounce_min" must be a number of minutes from 0 to 1440');
      out.trigger_debounce_min = val;
    } else if (k === "trigger_daily_cap") {
      if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 50) throw new Error('workflow: "scouts.trigger_daily_cap" must be a whole number from 0 to 50');
      out.trigger_daily_cap = val;
    } else if (SCOUT_TYPES[k]) {
      if (typeof val === "boolean") out.types[k] = { enabled: val, focus: "" };
      else if (val && typeof val === "object") {
        const t = val as Record<string, unknown>;
        if (t.triggers !== undefined && (!Array.isArray(t.triggers) || !t.triggers.every((g) => typeof g === "string" && g.length > 0))) {
          throw new Error(`workflow: "scouts.${k}.triggers" must be a list of path globs`);
        }
        out.types[k] = {
          enabled: t.enabled !== false,
          focus: typeof t.focus === "string" ? t.focus.slice(0, 1000) : "",
          budget_usd: typeof t.budget_usd === "number" && t.budget_usd > 0 ? t.budget_usd : undefined,
          triggers: (t.triggers as string[] | undefined)?.slice(0, 50),
        };
      } else throw new Error(`workflow: "scouts.${k}" must be true, false or { focus, budget_usd, triggers }`);
    } else {
      throw new Error(`workflow: unknown scout "${k}" (known: ${Object.keys(SCOUT_TYPES).join(", ")})`);
    }
  }
  return out;
}

/** `lessons: false`, or `lessons: { draft: bool, budget_chars: N }`. On by default. */
function parseLessons(v: unknown): Workflow["lessons"] {
  if (v === false) return false;
  const out = { draft: true, budget_chars: 1500 };
  if (v === undefined || v === null || v === true) return out;
  if (typeof v !== "object" || Array.isArray(v)) throw new Error('workflow: "lessons" must be false or a map');
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === "draft") {
      if (typeof val !== "boolean") throw new Error('workflow: "lessons.draft" must be true or false');
      out.draft = val;
    } else if (k === "budget_chars") {
      if (typeof val !== "number" || !(val >= 200) || val > 8000) throw new Error('workflow: "lessons.budget_chars" must be a number from 200 to 8000');
      out.budget_chars = Math.floor(val);
    } else throw new Error(`workflow: unknown lessons setting "${k}" (known: draft, budget_chars)`);
  }
  return out;
}

/** `library: false`, or `library: { include: [globs], exclude: [globs] }` (each replaces its default). */
function parseLibrary(v: unknown): Workflow["library"] {
  if (v === false) return false;
  // The librarian is on unless turned off (it costs nothing until a worker asks); describing spends up front, so it's opt-in.
  const defaults = { include: [...DEFAULT_LIBRARY_INCLUDE], exclude: [...DEFAULT_LIBRARY_EXCLUDE], describe: false, describe_budget_usd: 0.5, librarian: true };
  if (v === undefined || v === null || v === true) return defaults;
  if (typeof v !== "object" || Array.isArray(v)) throw new Error('workflow: "library" must be false or a map');
  const l = v as Record<string, unknown>;
  const bool = (k: "describe" | "librarian") => {
    if (l[k] !== undefined && typeof l[k] !== "boolean") throw new Error(`workflow: "library.${k}" must be true or false`);
    return l[k] === undefined ? defaults[k] : l[k] === true;
  };
  return {
    include: l.include === undefined ? defaults.include : asStringArray(l.include, "library.include"),
    exclude: l.exclude === undefined ? defaults.exclude : asStringArray(l.exclude, "library.exclude"),
    describe: bool("describe"),
    describe_budget_usd: typeof l.describe_budget_usd === "number" && l.describe_budget_usd > 0 ? l.describe_budget_usd : defaults.describe_budget_usd,
    librarian: bool("librarian"),
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
  wf.scouts = parseScouts(meta.scouts);
  wf.contracts = parseContracts(meta.contracts);
  wf.lessons = parseLessons(meta.lessons);
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

/** The repo's contracts, for the worker prompt (names and paths only; the agent reads the files). */
function contractsSection(wf: Workflow): string {
  const entries = Object.entries(wf.contracts);
  if (!entries.length) return "";
  const lines = entries.map(
    ([name, c]) => `- ${name}: ${c.files.join(", ")}${c.consumers ? ` (relied on by ${c.consumers.join(", ")})` : " (everything relies on it)"}`,
  );
  return `Contracts: interfaces other parts of this repo rely on. Don't change a contract's files unless your ticket asks for it; if your work needs a contract changed, use \`mcp__acutis__request_contract_change\` and carry on against the current contract. If a contract changes on trunk while you work, Acutis rebases you and shows you the change before landing.
${lines.join("\n")}

`;
}

export function describeGate(g: Gate): string {
  return g.kind === "cmd" ? g.run : `browser check of ${g.path}${g.script ? ` (script: ${g.script})` : ""}`;
}

export function workerSystemPrompt(opts: {
  ticket: Ticket;
  cwd: string;
  workflow: Workflow;
  repo?: Repo;
  sandboxed?: boolean;
  decisions?: Decision[];
  /** Approved lessons chosen for this run (operator-approved text). */
  lessons?: GivenLesson[];
  /** Whether ask_librarian is actually offered (the setting, and a model to run it). */
  librarian?: boolean;
}): string {
  const gates = opts.workflow.gates.length
    ? opts.workflow.gates.map((g) => `- \`${describeGate(g)}\``).join("\n")
    : "- (none configured)";
  const preview = opts.workflow.preview
    ? `

Seeing your work: Acutis runs this repo's preview server for you (\`${opts.workflow.preview.run}\`), so don't start one yourself.${
        opts.workflow.preview.path !== "/" ? ` Its start page is \`${opts.workflow.preview.path}\`: open that path.` : ""
      }
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
Run them yourself first${opts.workflow.gates.some((g) => g.kind === "cmd") ? ` with \`mcp__acutis__run_checks\`, which runs them exactly as Acutis will (in your own shell, a check that uses Unix sockets fails for sandbox reasons, not because of your change)` : " where you can"}.${
    opts.workflow.library
      ? `

Project knowledge: \`mcp__acutis__search_project\` searches this repo's docs (as of trunk) and summaries of earlier landed runs, returning short excerpts with path:line. Use it before reading many files to find where something is explained; open a result with \`mcp__acutis__read_project_entry\`, and see what docs exist with \`mcp__acutis__project_overview\`.${
          opts.librarian
            ? " For a broad question about how the project works, \`mcp__acutis__ask_librarian\` has a cheaper model read the docs and answer with citations, which keeps that reading out of your context."
            : ""
        } If the docs should explain something and don't, record it with \`mcp__acutis__report_library_gap\`.`
      : ""
  }

${contractsSection(opts.workflow)}Outside your ticket: if you notice a problem that isn't part of this ticket (a check already failing on the base, a bug elsewhere, stale docs, a security issue), don't fix it here. Record it with \`mcp__acutis__report_noticed\`, with evidence (file:line, a command and its output), then carry on with the ticket. If your ticket can't be complete without work that belongs elsewhere (another package, a missing API), ask for it with \`mcp__acutis__request_work\` instead of doing it here.${opts.workflow.lessons ? " If you learn something about this repo that would save the next agent time (a build order, a quirk, a workaround the checks needed), propose it with `mcp__acutis__propose_lesson`." : ""}${preview}${notes}${decisionsSection(opts.decisions ?? [])}${lessonsSection(opts.lessons ?? [])}

End with a short summary: what you changed, why, and how you verified it.`;
}
