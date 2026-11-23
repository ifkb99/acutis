import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { lessonKey } from "../src/core/lessons";
import { ChromeBrowser, findChrome } from "../src/providers/browser/chrome";
import { startServer } from "../src/server/server";
import { FakeRunner, makeRepo, tempDir, waitFor, type FakeScript } from "./helpers";

/**
 * The Rose's mind-map web in real headless Chrome: a petal grows into a web, a node expands one
 * ring further and opens in the drawer, the breadcrumb, Back and Esc step back, quick actions work
 * on nodes, destructive actions wait for a confirm in the drawer, and done items hide behind a
 * remembered toggle.
 */
const chrome = findChrome();
const port = 19800 + Math.floor(Math.random() * 400);

const asks: FakeScript = async (c) => {
  await c.spec.onPermission({ id: "perm-web-1", tool: "Bash", input: { command: "curl example.com" }, reason: "not in the allowlist", canAlwaysAllow: false });
  c.emit({ kind: "agent.text", text: "Done." });
  c.result();
  await c.nextMessage();
};
const quick: FakeScript = async (c) => {
  c.result();
  await c.nextMessage();
};
const app = createApp({ home: tempDir("acutis-e2e-web-"), port }, { runner: new FakeRunner([asks, quick]) });
const server = startServer(app);
afterAll(() => {
  app.runs.shutdown();
  server.stop(true);
});

const ids = { review: 0, todo: 0, done: 0, run: 0, lesson: 0 };
beforeAll(async () => {
  app.store.addRepo({ name: "w", path: await makeRepo({ "a.txt": "a\n", ".acutis/workflow.md": "---\nland: bookmark\n---\n" }), base: "main" });
  ids.review = app.tickets.create({ repo: "w", title: "Web review", body: "Body of the **review** ticket." }).id;
  ids.todo = app.tickets.create({ repo: "w", title: "Web todo", body: "" }).id;
  ids.done = app.tickets.create({ repo: "w", title: "Web done", body: "" }).id;
  app.tickets.setStatus(ids.done, "done");
  ids.run = (await app.runs.start(ids.review)).id;
  const text = "Run the web tests in headless Chrome before landing.";
  ids.lesson = app.store.addLesson({ repo: "w", text, text_key: lessonKey(text), status: "proposed", source: "worker", run_id: ids.run }).id;
  await waitFor(() => app.runs.pendingPermissions(ids.run).length > 0, 10000);
});

const browser = new ChromeBrowser(chrome);
const url = () => `http://127.0.0.1:${port}/#token=${app.token}`;
const node = (key: string) => `.web-node[data-key='${key}']`;
const toRun = () =>
  [
    "waitfor .petal.tint-aqua",
    "click .petal.tint-aqua",
    `waitfor ${node(`ticket:${ids.review}`)}`,
    "wait 500",
    `click ${node(`ticket:${ids.review}`)} .wn-title`,
    `waitfor ${node(`run:${ids.run}`)}`,
    "wait 500",
    `click ${node(`run:${ids.run}`)} .wn-title`,
    "waitfor .drawer .open-full",
    "wait 300",
  ].join("\n");
const crumbs = `[...document.querySelectorAll('.crumb')].map((c) => c.textContent)`;

describe.skipIf(!chrome)("the Rose web (headless Chrome)", () => {
  test("a petal grows a web; a node expands one ring further and opens in the drawer (2 clicks from the rose)", async () => {
    const r = await browser.check({
      url: url(),
      steps: toRun(),
      script: `JSON.stringify({
        crumbs: ${crumbs},
        drawer: document.querySelector('.drawer')?.dataset.key,
        open: !!document.querySelector('.drawer .open-full'),
        lesson: !!document.querySelector("${node(`lesson:${ids.lesson}`)}"),
        todo: !!document.querySelector("${node(`ticket:${ids.todo}`)}"),
        done: !!document.querySelector("${node(`ticket:${ids.done}`)}"),
        hidden: document.querySelector('.web-node.kind-hidden')?.textContent ?? null,
        rings: ['ticket:${ids.review}', 'run:${ids.run}', 'lesson:${ids.lesson}'].map((k) => { const n = document.querySelector("[data-key='" + k + "']"); return Math.round(Math.hypot(parseFloat(n.style.left), parseFloat(n.style.top))); }),
        pathEdges: document.querySelectorAll('.web-edges line.on').length,
        killOnNode: [...document.querySelectorAll('.web-node')].some((n) => /Kill|Discard|Deny|Approve & land/.test(n.textContent)),
      })`,
      width: 1400,
      height: 900,
    });
    expect(r.failure).toBeUndefined();
    expect(r.errors).toEqual([]);
    const out = JSON.parse(r.scriptResult!);
    expect(out).toMatchObject({ crumbs: ["Rose", "Board", `#${ids.review}`, `run ${ids.run}`], drawer: `run:${ids.run}`, open: true, lesson: true, todo: true, done: false, pathEdges: 2, killOnNode: false });
    expect(out.hidden).toContain("1 done or cancelled");
    // Each expansion is one ring further out.
    expect(out.rings[0]).toBeLessThan(out.rings[1]);
    expect(out.rings[1]).toBeLessThan(out.rings[2]);
  }, 60000);

  test("Esc and Back step back along the breadcrumb, then to the rose", async () => {
    const r = await browser.check({
      url: url(),
      steps: `${toRun()}\npress Escape\nwait 200\nclick .web-back\nwait 300`,
      script: `JSON.stringify({ crumbs: ${crumbs}, drawer: document.querySelector('.drawer')?.dataset.key, title: document.querySelector('.drawer h2')?.textContent })`,
      width: 1400,
      height: 900,
    });
    expect(r.failure).toBeUndefined();
    expect(JSON.parse(r.scriptResult!)).toEqual({ crumbs: ["Rose", "Board"], drawer: "petal:board", title: "Board" });
    const hub = await browser.check({ url: url(), steps: "waitfor .petal.tint-aqua\nclick .petal.tint-aqua\nwaitfor .web-root\npress Escape\nwait 300", script: `!!document.querySelector('.rose-hub') && !document.querySelector('.rose-web')`, width: 1400, height: 900 });
    expect(hub.scriptResult).toBe("true");
  }, 60000);

  test("the ticket's drawer shows its body and runs; the run's drawer shows the pending request and recent activity", async () => {
    const r = await browser.check({
      url: url(),
      steps: toRun(),
      script: `JSON.stringify({ perm: document.querySelector('.drawer .perm pre')?.textContent, activity: document.querySelector('.drawer-activity')?.textContent.includes('permission requested') })`,
      width: 1400,
      height: 900,
    });
    expect(r.failure).toBeUndefined();
    expect(JSON.parse(r.scriptResult!)).toEqual({ perm: "curl example.com", activity: true });
    const t = await browser.check({
      url: url(),
      steps: `waitfor .petal.tint-aqua\nclick .petal.tint-aqua\nwaitfor ${node(`ticket:${ids.review}`)}\nwait 500\nclick ${node(`ticket:${ids.review}`)} .wn-title\nwaitfor .drawer .ticketbody strong`,
      script: `JSON.stringify({ body: document.querySelector('.drawer .ticketbody strong')?.textContent, runs: document.querySelectorAll('.drawer .drawer-runs li').length })`,
      width: 1400,
      height: 900,
    });
    expect(t.failure).toBeUndefined();
    expect(JSON.parse(t.scriptResult!)).toEqual({ body: "review", runs: 1 });
  }, 60000);

  test("quick actions on nodes: Allow once on a waiting run, Start on a todo ticket", async () => {
    const r = await browser.check({
      url: url(),
      steps: [
        "waitfor .petal.tint-rose",
        "click .petal.tint-rose",
        `waitfor ${node(`run:${ids.run}`)} .allow-once`,
        "wait 500",
        `click ${node(`run:${ids.run}`)} .allow-once`,
        "wait 800",
        // The other petals recede to the corner; one click switches the web to another.
        "click .mini-petal.tint-aqua",
        `waitfor ${node(`ticket:${ids.todo}`)} .btn.primary`,
        "wait 500",
        `click ${node(`ticket:${ids.todo}`)} .btn.primary`,
        "wait 1200",
      ].join("\n"),
      script: "true",
      width: 1400,
      height: 900,
    });
    expect(r.failure).toBeUndefined();
    expect(app.store.events(ids.run).some((e) => e.kind === "permission.decision" && (e.data as any).id === "perm-web-1")).toBe(true);
    await waitFor(() => app.store.listRuns().some((x) => x.ticket_id === ids.todo), 8000);
  }, 60000);

  test("Kill is only in the drawer, and only after a confirm", async () => {
    await waitFor(() => app.store.getRun(ids.run)!.state === "awaiting_review", 10000);
    const ask = await browser.check({
      url: url(),
      steps: `${toRun()}\nclick .drawer .act-kill\nwait 300`,
      script: `JSON.stringify({ confirm: document.querySelector('.drawer .confirm')?.textContent ?? null })`,
      width: 1400,
      height: 900,
    });
    expect(ask.failure).toBeUndefined();
    expect(JSON.parse(ask.scriptResult!).confirm).toContain("Kill this run?");
    expect(app.store.getRun(ids.run)!.state).toBe("awaiting_review");
    const yes = await browser.check({ url: url(), steps: `${toRun()}\nclick .drawer .act-kill\nclick .drawer .confirm-yes\nwait 1000`, script: "true", width: 1400, height: 900 });
    expect(yes.failure).toBeUndefined();
    await waitFor(() => app.store.getRun(ids.run)!.state === "cancelled", 8000);
  }, 60000);

  test("Show done reveals done tickets and is remembered", async () => {
    const r = await browser.check({
      url: url(),
      steps: "waitfor .petal.tint-aqua\nclick .petal.tint-aqua\nwaitfor .web-node.kind-hidden\nclick .web-ended input\nwait 400",
      script: `JSON.stringify({ done: !!document.querySelector("${node(`ticket:${ids.done}`)}"), hidden: !!document.querySelector('.web-node.kind-hidden'), stored: localStorage.getItem('acutis-web-show-ended') })`,
      width: 1400,
      height: 900,
    });
    expect(r.failure).toBeUndefined();
    expect(JSON.parse(r.scriptResult!)).toEqual({ done: true, hidden: false, stored: "1" });
  }, 60000);

  test("on a phone, a petal opens its list as a sheet instead of the web", async () => {
    const r = await browser.check({
      url: url(),
      steps: "waitfor .petal.tint-aqua\nclick .petal.tint-aqua\nwaitfor .drawer",
      script: `JSON.stringify({ canvas: getComputedStyle(document.querySelector('.web-canvas')).display, wide: document.querySelector('.drawer').getBoundingClientRect().width >= 380, cards: document.querySelectorAll('.drawer .card').length > 0 })`,
      width: 390,
      height: 800,
    });
    expect(r.failure).toBeUndefined();
    expect(JSON.parse(r.scriptResult!)).toEqual({ canvas: "none", wide: true, cards: true });
  }, 60000);
});
