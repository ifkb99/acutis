import type { Decision, Ticket, Workflow } from "./types";

/**
 * Scouts find and file work in one area of a repo; they land nothing. Their lenses live here, in
 * Acutis, never in the repo: a repo's workflow can only turn a scout on or off and give it a focus
 * and a budget (principle 2: agents never edit the factory, and repo text is untrusted).
 */
export interface ScoutType {
  title: string;
  /** Extra tools this scout gets: "preview" adds the preview server and checking browser (and needs one). */
  needs?: "preview";
  /** What this scout looks for. */
  lens: string;
  /** What counts as evidence for its findings. */
  evidence: string;
}

export const SCOUT_TYPES: Record<string, ScoutType> = {
  infrastructure: {
    title: "Infrastructure",
    lens:
      "builds, setup steps and the declared checks; dependency and lockfile health (outdated, unpinned, duplicated, " +
      "or risky dependencies); CI configuration; developer tooling that is broken, slow or works by accident. " +
      "Look first at what fails on trunk, then at what is fragile.",
    evidence:
      "Reproduce every failure you report and quote the exact command and the key lines of its output. " +
      "Keep 'fails on trunk' apart from 'fails only in my shell': the results Acutis gives you below come from the real check path, which can differ from your shell.",
  },
  tests: {
    title: "Tests",
    lens:
      "whether the test suite would catch bugs: important code paths with no tests, tests that can't fail " +
      "(they assert nothing, or still pass with the code under test broken), flaky or order-dependent tests, " +
      "very slow tests, and test names that don't say what is checked. You may break code in your scratch workspace " +
      "to see whether a test notices.",
    evidence:
      "For an untested path, name the function (file:line) and the bug that would slip through. For a weak test, " +
      "show the change you made to the code and the test run that still passed.",
  },
};

Object.assign(SCOUT_TYPES, {
  architecture: {
    title: "Architecture",
    lens:
      "how the code is put together: modules that know too much about each other, layering the repo's own docs say " +
      "it has but the imports break, duplicated abstractions or near-copies that drifted apart, god files and functions " +
      "that every change has to touch, and dead code. Prefer problems that make the next likely change hard over taste.",
    evidence:
      "Name the files and the specific imports, calls or duplicated blocks (file:line for each side), and say which " +
      "kind of change they make harder. Measure where you can (how many files import X, how long a function is).",
  },
  security: {
    title: "Security",
    lens:
      "secrets committed to the repo, untrusted input reaching a shell, SQL, the filesystem, HTML or eval without " +
      "checks, missing or wrong authentication and authorization, unsafe defaults (debug on, permissive CORS, " +
      "world-writable files), and dependencies with known problems. Think about who controls each input.",
    evidence:
      "Cite the exact file:line and the path an attacker's input takes to get there. NEVER copy a secret's value " +
      "into anything you file: say which file and line holds it and what kind of secret it looks like. Acutis also " +
      "redacts anything that looks like a key in what you file, but don't rely on that.",
  },
  ui: {
    title: "UI/UX",
    needs: "preview",
    lens:
      "what a person using the app runs into: layouts that break at phone width (390px) or large screens, text that " +
      "overflows or is cut off, controls that are hard to hit or reach by keyboard, missing focus states and labels, " +
      "low contrast, console errors, flows that dead-end or lose input, and inconsistent styles between pages.",
    evidence:
      "Use `mcp__acutis__browser` to see each problem and say the path, viewport width and steps that show it. Your " +
      "screenshots are kept with this run, so say \"see the screenshot of <path> at <width>px in run N\" in the ticket.",
  },
  domain: {
    title: "Domain logic",
    lens:
      "places where the code disagrees with what the project says it should do: its docs, specs, comments, tests and " +
      "names. Edge cases the rules imply but the code doesn't handle (empty, zero, boundaries, ordering, time zones, " +
      "concurrency), invariants that can be broken, and behaviour that two parts of the code implement differently.",
    evidence:
      "Quote the rule (doc or spec file:line) next to the code that breaks it (file:line), and give a concrete input " +
      "and the result it produces. Where you can, prove it with a small throwaway test in your scratch workspace.",
  },
  docs: {
    title: "Docs",
    lens:
      "documentation that no longer matches the code (commands, flags, file paths, APIs, setup steps), missing " +
      "explanations a newcomer or a worker would need, and the library gaps workers reported: questions they " +
      "searched the docs for and couldn't answer. Prefer gaps that cost workers time over polish.",
    evidence:
      "For drift, quote the doc (file:line) and show what the code or a command actually does. For a missing " +
      "explanation, say who needs it and what they would otherwise have to read.",
  },
} satisfies Record<string, ScoutType>);

/**
 * Remove things that look like credentials from text a scout or worker files: it ends up in
 * tickets and other agents' prompts. Best effort; the scout is also told never to copy secrets.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted private key]")
    .replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted AWS key]")
    // sk-…, sk-proj-…, sk-ant-…, and Stripe-style sk_live_/pk_test_ (not snake_case identifiers like pk_user_id).
    .replace(/\b(?:sk|rk|pk)-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}|\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "[redacted key]")
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, "[redacted GitHub token]")
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted Slack token]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted JWT]")
    // key = value only when the value looks like a literal: a quoted string, or a bare token with a digit
    // (so `password = request.form["password"]` and `auth_token: authToken,` in code are left alone).
    .replace(/\b((?:api|secret|access|auth|private)[_-]?(?:key|token|secret)|password|passwd)(\s*[:=]\s*)(["'])([^"'\s]{8,})\3/gi, "$1$2$3[redacted]$3")
    .replace(/\b((?:api|secret|access|auth|private)[_-]?(?:key|token|secret)|password|passwd)(\s*[:=]\s*)(?=[A-Za-z0-9+/_-]*\d)([A-Za-z0-9+/_-]{8,})(?![\w.(\[])/gi, "$1$2[redacted]");
}

export const runnerSource = (type: string) => `scout-run:${type}`;
export const scoutSource = (type: string) => `scout:${type}`;
/** A scout's own runner ticket: an implementation detail, never shown as work. */
export const isRunnerTicket = (t: Pick<Ticket, "source">) => t.source.startsWith("scout-run:");
export const runnerType = (t: Pick<Ticket, "source">) => (isRunnerTicket(t) ? t.source.slice("scout-run:".length) : null);

export const MAX_SCOUT_TICKETS = 5;
export const MAX_SCOUT_DECISIONS = 5;
export const DEFAULT_SCOUT_BUDGET_USD = 2;

export type ScoutsConfig = Exclude<Workflow["scouts"], false>;

/** The settings for one scout type, or null if the repo doesn't allow it. */
export function scoutSettings(wf: Workflow, type: string): { focus: string; budget_usd: number; auto_tickets: "high" | "never" } | null {
  if (!wf.scouts || !SCOUT_TYPES[type]) return null;
  const t = wf.scouts.types[type];
  if (t && !t.enabled) return null;
  return { focus: t?.focus ?? "", budget_usd: t?.budget_usd ?? wf.scouts.budget_usd, auto_tickets: wf.scouts.auto_tickets };
}

/** Operator decisions, for worker and scout prompts. Only decided rows: their text is the operator's. */
export function decisionsSection(decisions: Decision[]): string {
  const decided = decisions.filter((d) => d.status === "decided").slice(0, 40);
  if (!decided.length) return "";
  return `

Operator decisions for this repo (written by the human operator; follow them):
${decided.map((d) => `- #${d.id}: ${d.decision}`).join("\n")}`;
}

export function scoutSystemPrompt(opts: {
  type: string;
  repo: string;
  cwd: string;
  commit: string;
  focus: string;
  budget: number;
  autoTickets: "high" | "never";
  sandboxed: boolean;
  library: boolean;
  decisions: Decision[];
  trunkResults: string;
}): string {
  const s = SCOUT_TYPES[opts.type]!;
  const ticketRule =
    opts.autoTickets === "high"
      ? "High-confidence tickets go straight to the todo list, so use high only when the evidence shows the problem directly and the fix is clearly wanted; everything else waits for the operator to accept it."
      : "Every ticket waits for the operator to accept it.";
  return `# Acutis scout: ${s.title}

You are an Acutis scout for repository "${opts.repo}". Your job is to find work worth doing in your area and file it, not to do it.
Your area: ${s.lens}${opts.focus ? `\nThe operator's focus for this repo: ${opts.focus}` : ""}

Your workspace at ${opts.cwd} is a scratch checkout of trunk (${opts.commit.slice(0, 12)}). You may build, run tests and make throwaway edits there, for example to see whether a test can fail. Nothing in it lands, and it is deleted when you finish. Don't start long-running servers or background processes.

What you can file (each is recorded the moment you call it):
- \`mcp__acutis__propose_ticket\`: a concrete piece of work, with evidence. ${ticketRule} If the work only makes sense depending on what the operator wants, ask a decision first and pass its id as depends_on: the ticket then waits on that decision. To turn a noticed report into a ticket, pass its id as from_noticed.
- \`mcp__acutis__ask_decision\`: a question only the operator can answer (what they want, priorities, trade-offs). Never ask for facts you can find out yourself. Give the context and a few suggested answers.
- \`mcp__acutis__update_decision\`, \`mcp__acutis__withdraw_decision\`, \`mcp__acutis__merge_decision\`: keep the open questions ${s.title.toLowerCase()} scouts asked tidy: sharpen one, withdraw one that went stale, or merge a duplicate into another open question.
Limits for this run: ${MAX_SCOUT_TICKETS} tickets, ${MAX_SCOUT_DECISIONS} questions, about $${opts.budget.toFixed(2)} of spend.

Before filing, check the existing work in your first message and with \`mcp__acutis__list_work\`. Don't file duplicates. Tickets the operator rejected were rejected on purpose. Follow the operator's decisions below.${
    opts.library ? "\nUse `mcp__acutis__search_project` to find what the repo's docs already say." : ""
  }

Evidence: ${s.evidence}${
    opts.sandboxed
      ? `

Your shell is sandboxed. It can't create or connect to Unix sockets (EPERM), so tools that use socket IPC fail there (e.g. run TypeScript with \`node --import tsx\` rather than \`tsx\`); that is your shell, not a bug in the repo. Reaching a new network host asks the operator. The real checks run in a different sandbox that allows Unix sockets but has no network.`
      : ""
  }${decisionsSection(opts.decisions)}

Setup and checks on trunk, run by Acutis before you started in the same sandbox the real checks use (trust these over your own shell for "fails on trunk"):
${opts.trunkResults || "(none configured)"}

End with a short summary: what you looked at, what you filed, and what you checked and found fine.`;
}
