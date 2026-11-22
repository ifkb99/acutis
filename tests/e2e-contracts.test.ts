import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import { ChromeBrowser, findChrome } from "../src/providers/browser/chrome";
import { startServer } from "../src/server/server";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeScript } from "./helpers";

const chrome = findChrome();
const port = 18500 + Math.floor(Math.random() * 400);
const editsContract: FakeScript = async (c) => {
  writeFileSync(join(c.spec.cwd, "src/api.ts"), "export const hello = 1;\n");
  c.result();
  await c.nextMessage();
};
const home = tempDir("acutis-e2e-contracts-");
const app = createApp({ home, port }, { runner: new FakeRunner([editsContract]) });
const server = startServer(app);
afterAll(() => {
  app.runs.shutdown();
  server.stop(true);
});

test.skipIf(!chrome)("the dashboard needs the contract box ticked before Approve lands a contract change (headless Chrome)", async () => {
  const repoPath = await makeRepo({
    "src/api.ts": "export const greet = 1;\n",
    ".acutis/workflow.md": '---\nland: bookmark\ncontracts:\n  api:\n    files: ["src/api.ts"]\n---\n',
  });
  app.store.addRepo({ name: "c", path: repoPath, base: "main" });
  const run = await app.runs.start(app.tickets.create({ repo: "c", title: "Rename", body: "" }).id);
  await waitFor(() => app.store.getRun(run.id)!.state === "awaiting_review", 10000);
  const browser = new ChromeBrowser(chrome);
  const dash = `http://127.0.0.1:${port}/#run-${run.id}&token=${app.token}`;
  // Without the box: refused (an error toast), still in review.
  const first = await browser.check({ url: dash, steps: "waitfor .contract-accept input\nclick .runhead .btn.primary\nwait 800", script: `!!document.querySelector('.error-toast')`, width: 1300, height: 900 });
  // The refusal is the point: the page shows the error toast, and the only page error is the 409.
  expect(first.scriptResult).toBe("true");
  expect(first.errors.length).toBe(1);
  expect(first.errors[0]).toContain("409");
  expect(app.store.getRun(run.id)!.state).toBe("awaiting_review");
  // With the box ticked: it lands.
  const second = await browser.check({ url: dash, steps: "waitfor .contract-accept input\nclick .contract-accept input\nclick .runhead .btn.primary\nwait 1200", script: "true", width: 1300, height: 900 });
  expect(second.failure).toBeUndefined();
  await waitFor(() => app.store.getRun(run.id)!.state === "done", 10000);
}, 60000);
