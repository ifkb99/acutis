/**
 * The dashboard with demo data, for previews (`preview:` in .acutis/workflow.md) and for looking
 * at UI changes by hand: `PORT=7800 bun scripts/preview.ts`, then open the printed link.
 *
 * Everything is throwaway: a temp ACUTIS_HOME, a small demo repo, and scripted agents (no model
 * calls), so runs, drafts, scouts, decisions, lessons and noticed reports are real records made
 * through the real run manager, in every state the dashboard shows. The API token is fixed
 * ("preview"), so a preview link is always `/#token=preview`. Actions in the dashboard work:
 * a run you start or message gets a short scripted reply.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import { tokenPath } from "../src/core/token";
import type { AgentRunner, AgentSession, AgentSpec } from "../src/core/types";
import { startServer } from "../src/server/server";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeControls, type FakeScript } from "../tests/helpers";

export const PREVIEW_TOKEN = "preview";

/** Scripted sessions in start order; past the end, any session gets a short scripted reply. */
export class DemoRunner implements AgentRunner {
  readonly name = "demo";
  constructor(private queue: FakeScript[]) {}
  start(spec: AgentSpec): AgentSession {
    return new FakeRunner([this.queue.shift() ?? reply]).start(spec);
  }
}

const call = async (c: FakeControls, name: string, args: Record<string, string | number | undefined>) => {
  const t = c.spec.tools?.find((x) => x.name === name);
  if (!t) throw new Error(`demo: no ${name} tool`);
  const id = crypto.randomUUID();
  c.emit({ kind: "agent.tool_use", id, name: `mcp__acutis__${name}`, input: args });
  const out = await t.handler(args);
  c.emit({ kind: "agent.tool_result", tool_use_id: id, content: out.text, is_error: Boolean(out.isError) });
  return out.text;
};
/** A shell command the "agent" ran, shown in the timeline (nothing is executed). */
const shell = (c: FakeControls, command: string, output: string) => {
  const id = crypto.randomUUID();
  c.emit({ kind: "agent.tool_use", id, name: "Bash", input: { command } });
  c.emit({ kind: "agent.tool_result", tool_use_id: id, content: output, is_error: false });
};
const write = (c: FakeControls, file: string, text: string) => {
  const id = crypto.randomUUID();
  c.emit({ kind: "agent.tool_use", id, name: "Write", input: { file_path: join(c.spec.cwd, file), content: text } });
  writeFileSync(join(c.spec.cwd, file), text);
  c.emit({ kind: "agent.tool_result", tool_use_id: id, content: `File created: ${file}`, is_error: false });
};
const reply: FakeScript = async (c) => {
  c.emit({ kind: "agent.text", text: "(demo agent) Done; nothing was changed." });
  c.result("success", 0.01, "Demo reply: this preview's agents are scripted.");
  await c.nextMessage();
};

export const REPO_FILES: Record<string, string> = {
  "README.md": "# shop\n\nA small demo web shop.\n",
  "src/cart.ts": "export function total(items: { price: number; qty: number }[]) {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n",
  "src/checkout.ts": "import { total } from './cart';\nexport const checkout = (items: { price: number; qty: number }[]) => ({ due: total(items) });\n",
  "docs/architecture.md": "# Architecture\n\nCart totals live in src/cart.ts; checkout in src/checkout.ts.\n",
  ".acutis/workflow.md": "---\nland: bookmark\nmax_attempts: 1\ngates:\n  - name: tests\n    run: \"true\"\n  - name: lint\n    run: \"true\"\n---\n",
};

const LONG_BODY = `## Context
Cart totals are computed in \`src/cart.ts:1\` with floating-point prices, so \`0.1 + 0.2\` style errors reach the checkout total (\`src/checkout.ts:2\`).

## What to change
- Store prices as integer cents in \`total()\`.
- Format to two decimals only at display time.

## Acceptance criteria
- [ ] \`total([{ price: 0.1, qty: 1 }, { price: 0.2, qty: 1 }])\` is exactly 0.3 when formatted.
- [ ] A test covers rounding with quantities above 1.

## Out of scope
- Currency conversion.

## Notes
Assumption (Q1): prices arrive as decimals from the catalogue API.`;

export async function seed(app: ReturnType<typeof createApp>, repo: string) {
  const { runs, tickets, store } = app;
  const state = (id: number) => store.getRun(id)!.state;
  const until = (id: number, s: string) => waitFor(() => state(id) === s, 20000);

  // Decisions and lessons first, so the runs' prompts carry them like real runs do.
  runs.addDecision(repo, "Prices are integer cents everywhere; format only for display.", "data");
  runs.addLesson(repo, "Run the cart tests with `bun test src/cart.test.ts` before the full suite; they are the fast signal.");
  const stale = runs.addLesson(repo, "Checkout reads totals through `src/cart.ts`; change both together.");
  store.setLessonWatch(stale.id, { paths: "src/cart.ts", stale: JSON.stringify({ paths: ["src/cart.ts"], commit: "0123456789ab" }) });

  tickets.create({ repo, title: "Add keyboard shortcuts to the product list", body: "j/k to move, Enter to open." });
  tickets.create({ repo, title: "Show stock levels on product cards", body: "" });

  // Awaiting review, with a diff, a noticed report and a proposed lesson.
  const review = await runs.start(
    tickets.create({ repo, title: "Free shipping over $50", body: "Orders whose total is $50 or more ship free. Show it at checkout." }).id,
  );
  // (each script is consumed when its session starts, so runs start one at a time)
  await until(review.id, "awaiting_review");

  // Landed.
  const landed = await runs.start(tickets.create({ repo, title: "Fix typo in README", body: "" }).id);
  await until(landed.id, "awaiting_review");
  await runs.approve(landed.id);

  // Failed.
  const failed = await runs.start(tickets.create({ repo, title: "Upgrade the payment SDK", body: "Move to v4." }).id);
  await until(failed.id, "failed");

  // Paused by the operator.
  const paused = await runs.start(tickets.create({ repo, title: "Refactor checkout into steps", body: "" }).id);
  await until(paused.id, "running");
  await runs.pause(paused.id);
  await until(paused.id, "paused");

  // Running, waiting on a permission request.
  const live = await runs.start(tickets.create({ repo, title: "Add an order history page", body: "List past orders, newest first." }).id);
  await waitFor(() => runs.pendingPermissions(live.id).length > 0, 20000);

  // A scout that filed a ticket and a question.
  const scout = await runs.startScout(repo, "tests");
  await until(scout.id, "done");

  // Drafts: one with questions, one ready, one still writing.
  const d1 = await runs.startDraft(repo, "checkout totals are sometimes off by a cent");
  await until(d1.id, "paused");
  const d2 = await runs.startDraft(repo, "dark mode for the storefront");
  await until(d2.id, "paused");
  const d3 = await runs.startDraft(repo, "speed up the product search");
  await until(d3.id, "running");
}

export function demoScripts(): FakeScript[] {
  return [
    // review
    async (c) => {
      c.emit({ kind: "agent.text", text: "I'll add the free-shipping rule to checkout and cover it with a test." });
      shell(c, "grep -rn total src", "src/cart.ts:1:export function total(...)\nsrc/checkout.ts:2:export const checkout = ...");
      write(c, "src/shipping.ts", "export const FREE_SHIPPING_CENTS = 5000;\nexport const shipping = (totalCents: number) => (totalCents >= FREE_SHIPPING_CENTS ? 0 : 499);\n");
      write(c, "src/shipping.test.ts", "import { expect, test } from 'bun:test';\nimport { shipping } from './shipping';\ntest('free over $50', () => expect(shipping(5000)).toBe(0));\n");
      await call(c, "report_noticed", { title: "checkout.ts ignores quantities of 0", detail: "Items with qty 0 still appear on the receipt.", evidence: "src/checkout.ts:2", kind: "bug" });
      await call(c, "propose_lesson", { lesson: "Shipping thresholds are in integer cents (src/shipping.ts); compare cents, never dollars.", evidence: "The checkout test failed until totals were compared in cents.", paths: "src/shipping.ts" });
      c.result("success", 0.42, "Added `src/shipping.ts` with a $50 free-shipping threshold (in cents) and a test. Checkout doesn't show it yet: that needs the checkout UI, which isn't in this repo.");
      await c.nextMessage();
    },
    // landed
    async (c) => {
      write(c, "README.md", "# shop\n\nA small demo web shop. Run `bun test` to check it.\n");
      c.result("success", 0.05, "Fixed the README.");
      await c.nextMessage();
    },
    // failed
    async (c) => {
      shell(c, "bun add payment-sdk@4", "error: network access is not allowed in the sandbox");
      c.result("error_during_execution", 0.11, "");
      await c.nextMessage();
    },
    // paused
    async (c) => {
      c.emit({ kind: "agent.text", text: "Splitting checkout into address, payment and review steps." });
      shell(c, "ls src", "cart.ts\ncheckout.ts");
      await c.interrupted();
      c.result("error_during_execution", 0.07);
      await c.nextMessage();
    },
    // live, asking permission
    async (c) => {
      c.emit({ kind: "agent.text", text: "Looking at how orders are stored before adding the page." });
      shell(c, "grep -rn order src", "(no matches)");
      void c.spec.onPermission({ id: crypto.randomUUID(), tool: "Bash", input: { command: "curl -s https://api.example.com/orders" }, reason: "network access", canAlwaysAllow: false });
      for (let i = 0; i < 100 && !c.closed; i++) {
        await Bun.sleep(20_000);
        c.emit({ kind: "agent.text", text: "(still waiting for the permission decision)" });
      }
      await c.nextMessage();
    },
    // tests scout
    async (c) => {
      await call(c, "propose_ticket", { title: "Test checkout with an empty cart", body: "checkout([]) is untested; it should return due 0.", evidence: "src/checkout.ts:2 has no test", confidence: "medium" });
      await call(c, "ask_decision", { question: "Should checkout reject carts with zero-quantity items, or drop them?", context: "src/checkout.ts:2 passes them through.", options: "Reject with an error\nDrop them silently" });
      c.result("success", 0.6, "Looked at cart and checkout tests; filed one ticket and one question.");
      await c.nextMessage();
    },
    // draft with questions
    async (c) => {
      await call(c, "ask_user", { question: "Do prices arrive from the catalogue as decimals or as cents?", options: "Decimals | Cents | Both, depending on the source", why: "Decides whether conversion happens at the edge or in total()." });
      await call(c, "ask_user", { question: "Should totals round half up or half to even?", options: "Half up | Half to even" });
      await call(c, "write_draft", { title: "Compute cart totals in integer cents", body: LONG_BODY });
      c.result("success", 0.21);
      await c.nextMessage();
    },
    // draft ready
    async (c) => {
      await call(c, "write_draft", { title: "Add a dark theme to the storefront", body: "## Context\nThe storefront has one light theme.\n\n## Acceptance criteria\n- [ ] A toggle in the header switches themes and is remembered." });
      c.result("success", 0.12);
      await c.nextMessage();
    },
    // draft still writing
    async (c) => {
      shell(c, "grep -rn search src", "(no matches)");
      await c.interrupted();
      c.result("error_during_execution", 0.03);
      await c.nextMessage();
    },
  ];
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 7800);
  const home = tempDir("acutis-preview-");
  writeFileSync(tokenPath(home), `${PREVIEW_TOKEN}\n`, { mode: 0o600 });
  const repoPath = await makeRepo(REPO_FILES);
  const app = createApp({ home, port, maxRuns: 0 }, { runner: new DemoRunner(demoScripts()) });
  app.store.addRepo({ name: "shop", path: repoPath, base: "main" });
  await seed(app, "shop");
  // Serve only once the data is in, so the first page a preview check opens is complete.
  startServer(app, { hostname: process.env.HOST ?? "127.0.0.1" });
  console.log(`Acutis preview with demo data: http://127.0.0.1:${port}/#token=${PREVIEW_TOKEN}`);
  const cleanup = () => {
    app.runs.shutdown();
    rmSync(home, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
}
