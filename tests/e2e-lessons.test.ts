import { afterAll, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { lessonKey } from "../src/core/lessons";
import { ChromeBrowser, findChrome } from "../src/providers/browser/chrome";
import { startServer } from "../src/server/server";
import { FakeRunner, makeRepo, tempDir } from "./helpers";

const chrome = findChrome();
const port = 19300 + Math.floor(Math.random() * 400);
const app = createApp({ home: tempDir("acutis-e2e-lessons-"), port }, { runner: new FakeRunner([]) });
const server = startServer(app);
afterAll(() => {
  app.runs.shutdown();
  server.stop(true);
});

test.skipIf(!chrome)("the Lessons panel shows a proposed lesson with its evidence, and Approve approves it (headless Chrome)", async () => {
  app.store.addRepo({ name: "l", path: await makeRepo({ "a.txt": "a\n" }), base: "main" });
  const text = "Build packages/engine before the harness tests: the harness imports engine/dist.";
  const l = app.store.addLesson({ repo: "l", text, text_key: lessonKey(text), evidence: "harness: cannot find module engine/dist", status: "proposed", source: "draft" });
  app.runs.addLesson("l", "Use pnpm for installs in this repo, never npm.");
  const r = await new ChromeBrowser(chrome).check({
    url: `http://127.0.0.1:${port}/#token=${app.token}`,
    steps: "waitfor .lesson-item\nclick .lesson-item .btn.primary\nwait 800",
    script: `JSON.stringify({ heading: document.querySelector('.lessons h2')?.textContent, approved: document.querySelector('.lessons .approved summary')?.textContent, items: document.querySelectorAll('.lesson-item').length })`,
    width: 1300,
    height: 900,
  });
  expect(r.errors).toEqual([]);
  expect(app.store.getLesson(l.id)!.status).toBe("approved");
  const out = JSON.parse(r.scriptResult!);
  expect(out).toEqual({ heading: "Lessons · 0 proposed", approved: "Approved · 2", items: 0 });
}, 60000);
