import type { Decision, Ticket, Workflow } from "./types";

/**
 * Scouts find and file work in one area of a repo; they land nothing. Their lenses live here, in
 * Acutis, never in the repo: a repo's workflow can only turn a scout on or off and give it a focus
 * and a budget (principle 2: agents never edit the factory, and repo text is untrusted).
 */
export interface ScoutType {
  title: string;
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
${decided.map((d) => `- #${d.id}${d.question ? ` (${d.question.slice(0, 120)})` : ""}: ${d.decision}`).join("\n")}`;
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
