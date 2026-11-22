import { expect, test } from "bun:test";
import { createApp } from "../src/app";
import { DemoRunner, REPO_FILES, demoScripts, seed } from "../scripts/preview";
import { makeRepo, tempDir } from "./helpers";

// The dashboard preview (scripts/preview.ts) seeds through the real run manager, so a renamed tool
// or a changed state machine would quietly leave the preview half-empty. This keeps it honest.
test("the preview's demo data puts every panel in the states it is meant to show", async () => {
  const app = createApp({ home: tempDir("acutis-home-"), port: 0, maxRuns: 0 }, { runner: new DemoRunner(demoScripts()) });
  app.store.addRepo({ name: "shop", path: await makeRepo(REPO_FILES), base: "main" });
  await seed(app, "shop");
  const states = app.store.listRuns().map((r) => `${r.kind}:${r.state}`).sort();
  expect(states).toEqual(
    ["scout:done", "work:awaiting_review", "work:done", "work:failed", "work:paused", "work:running", "writer:paused", "writer:paused", "writer:running"].sort(),
  );
  expect(app.runs.allPendingPermissions().length).toBe(1);
  expect(app.runs.listDrafts().map((d) => [d.questions.length, Boolean(d.draft)])).toEqual([[0, false], [0, true], [2, true]]);
  expect(app.runs.listNoticed("open").length).toBe(1);
  expect(app.runs.rankedDecisions("shop").length).toBe(1);
  expect(app.runs.listLessons("shop", "proposed").length).toBe(1);
  expect(app.runs.listLessons("shop", "approved").some((l) => l.stale)).toBe(true);
  expect(app.tickets.list({ repo: "shop", status: "proposed" }).length).toBe(1);
  app.runs.shutdown();
}, 60000);
