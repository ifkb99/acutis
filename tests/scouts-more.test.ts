import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { redactSecrets, SCOUT_TYPES } from "../src/core/scouts";
import type { AcutisTool, AgentEvent } from "../src/core/types";
import { parseWorkflow } from "../src/core/workflow";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeControls, type FakeScript } from "./helpers";

const tool = (c: FakeControls, name: string): AcutisTool => c.spec.tools!.find((x) => x.name === name)!;
const finalReport = (c: FakeControls) =>
  c.emit({ kind: "agent.result", subtype: "success", result: "done", is_error: false, cost_usd: 0.01, turns: 1, duration_ms: 5 } as AgentEvent);

async function setup(scripts: FakeScript[], files: Record<string, string> = { "README.md": "# Demo\n" }) {
  const repoPath = await makeRepo(files);
  const app = createApp({ home: tempDir("acutis-home-"), port: 0 }, { runner: new FakeRunner(scripts) });
  app.store.addRepo({ name: "demo", path: repoPath, base: "main" });
  return { app };
}
const until = (app: ReturnType<typeof createApp>, id: number, s: string) => waitFor(() => app.store.getRun(id)!.state === s, 10000);

describe("redaction", () => {
  test("credential-shaped strings are redacted; ordinary code and prose are left alone", () => {
    const planted = [
      "AKIAIOSFODNN7EXAMPLE",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX12",
      "sk_live_51HabcdefghijklmnopQRST",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "xoxb-1234567890-abcdefghij",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    ];
    for (const p of planted) expect(redactSecrets(`found ${p} in config.ts:3`)).not.toContain(p.slice(8, 20));
    expect(redactSecrets('API_KEY="9f8e7d6c5b4a3210" and password: hunter2hunter2')).toBe('API_KEY="[redacted]" and password: [redacted]');
    const fine = "pk_user_id, skip-to-content-link-in-header, task-force-ids, src/sk-render-pipeline.ts:40, token: string;";
    expect(redactSecrets(fine)).toBe(fine);
  });
});

describe("the phase 3 scouts", () => {
  test("all seven scouts exist and the workflow accepts each name", () => {
    expect(Object.keys(SCOUT_TYPES).sort()).toEqual(["architecture", "docs", "domain", "infrastructure", "security", "tests", "ui"]);
    const wf = parseWorkflow("---\nscouts:\n  security: { focus: auth }\n  ui: false\n  docs: true\n---\n", "t");
    expect(wf.scouts && wf.scouts.types.security).toMatchObject({ enabled: true, focus: "auth" });
    expect(wf.scouts && wf.scouts.types.ui).toMatchObject({ enabled: false });
  });

  test("what a security scout files is redacted, in the ticket and in the run's event log", async () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    const script: FakeScript = async (c) => {
      await tool(c, "propose_ticket").handler({ title: "Remove the committed AWS key", body: `config/prod.env:4 holds ${key}`, evidence: `grep shows ${key}`, confidence: "high" });
      finalReport(c);
      await c.nextMessage();
    };
    const { app } = await setup([script]);
    const run = await app.runs.startScout("demo", "security");
    await until(app, run.id, "done");
    const t = app.tickets.list({ repo: "demo" }).find((x) => x.title === "Remove the committed AWS key")!;
    expect(t.body).not.toContain(key);
    expect(t.body).toContain("[redacted AWS key]");
  });

  test("the UI/UX scout needs a preview; with one it gets the preview and browser tools", async () => {
    const { app } = await setup([]);
    const bad = await app.runs.startScout("demo", "ui");
    await until(app, bad.id, "failed");
    expect(app.store.getRun(bad.id)!.error).toContain("needs a preview command");

    let names: string[] = [];
    const script: FakeScript = async (c) => {
      names = (c.spec.tools ?? []).map((t) => t.name);
      finalReport(c);
      await c.nextMessage();
    };
    const preview = `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response("ok") });`;
    const { app: app2 } = await setup([script], { "README.md": "# Demo\n", "serve.js": preview, ".acutis/workflow.md": "---\npreview: bun serve.js\n---\n" });
    const run = await app2.runs.startScout("demo", "ui");
    await until(app2, run.id, "done");
    expect(names).toContain("preview");
    expect(names).toContain("propose_ticket");
    app2.runs.shutdown();
  });

  test("each new scout gets its own lens in its prompt", async () => {
    const prompts: Record<string, string> = {};
    const scripts = ["architecture", "domain", "docs", "security"].map((type): FakeScript => async (c) => {
      prompts[type] = c.spec.systemAppend;
      finalReport(c);
      await c.nextMessage();
    });
    const { app } = await setup(scripts);
    for (const type of ["architecture", "domain", "docs", "security"]) {
      const r = await app.runs.startScout("demo", type);
      await until(app, r.id, "done");
    }
    expect(prompts.architecture).toContain("# Acutis scout: Architecture");
    expect(prompts.domain).toContain("Quote the rule");
    expect(prompts.docs).toContain("library gaps");
    expect(prompts.security).toContain("NEVER copy a secret's value");
  });
});
