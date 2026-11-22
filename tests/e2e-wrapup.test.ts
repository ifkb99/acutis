import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { AcutisTool } from "../src/core/types";
import { ChromeBrowser, findChrome } from "../src/providers/browser/chrome";
import { startServer } from "../src/server/server";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeScript } from "./helpers";

const chrome = findChrome();
const port = 18900 + Math.floor(Math.random() * 400);
const asks: FakeScript = async (c) => {
  const t = c.spec.tools!.find((x) => x.name === "request_work") as AcutisTool;
  await t.handler({ title: "Engine: export getMoves(tile)", need: "a per-tile move list from the engine", why: "the AI eval needs it; stubbed for now" });
  writeFileSync(join(c.spec.cwd, "src/a.ts"), "export const a = 2;\n");
  c.result();
  await c.nextMessage();
};
const app = createApp({ home: tempDir("acutis-e2e-wrapup-"), port }, { runner: new FakeRunner([asks]) });
const server = startServer(app);
afterAll(() => {
  app.runs.shutdown();
  server.stop(true);
});

test.skipIf(!chrome)("the reviewer sees a run's work request, and the proposed ticket says a worker asked for it (headless Chrome)", async () => {
  const repoPath = await makeRepo({ "src/a.ts": "export const a = 1;\n", ".acutis/workflow.md": "---\nland: bookmark\nmax_attempts: 1\n---\n" });
  app.store.addRepo({ name: "w", path: repoPath, base: "main" });
  const run = await app.runs.start(app.tickets.create({ repo: "w", title: "AI per-tile eval", body: "" }).id);
  await waitFor(() => app.store.getRun(run.id)!.state === "awaiting_review", 10000);
  const r = await new ChromeBrowser(chrome).check({
    url: `http://127.0.0.1:${port}/#run-${run.id}&token=${app.token}`,
    steps: "waitfor .ev.flag\nwait 300",
    script: `JSON.stringify({
      flag: [...document.querySelectorAll('.ev.flag')].map((e) => e.textContent).join(' | '),
      why: [...document.querySelectorAll('.ticketbody summary')].map((e) => e.textContent),
      accept: [...document.querySelectorAll('.card')].some((c) => c.textContent.includes('Engine: export getMoves') && c.textContent.includes('Accept')),
    })`,
    width: 1300,
    height: 900,
  });
  expect(r.errors).toEqual([]);
  const out = JSON.parse(r.scriptResult!);
  expect(out.flag).toContain("This run asked for work outside its ticket: #2 Engine: export getMoves(tile) (proposed)");
  expect(out.why).toContain("Why a worker asked for it");
  expect(out.accept).toBe(true);
}, 60000);
