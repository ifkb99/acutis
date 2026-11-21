import { afterAll, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { startServer } from "../src/server/server";
import { FakeRunner, tempDir } from "./helpers";

const port = 17000 + Math.floor(Math.random() * 1000);
const app = createApp({ home: tempDir(), port }, { runner: new FakeRunner([]) });
const server = startServer(app);
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${port}`;

test("GET state works from localhost", async () => {
  const res = await fetch(`${base}/api/state`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ repos: [], tickets: [] });
});

test("POST without the x-acutis header is refused", async () => {
  const res = await fetch(`${base}/api/tickets`, { method: "POST", body: "{}" });
  expect(res.status).toBe(403);
});

test("foreign Host header is refused (DNS rebinding)", async () => {
  const res = await fetch(`${base}/api/state`, { headers: { host: "evil.example:7777" } });
  expect(res.status).toBe(403);
});

test("cross-origin POST is refused even with the header", async () => {
  const res = await fetch(`${base}/api/tickets`, {
    method: "POST",
    headers: { "x-acutis": "1", origin: "http://evil.example" },
    body: "{}",
  });
  expect(res.status).toBe(403);
});

test("dashboard HTML is served", async () => {
  const res = await fetch(`${base}/`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('<div id="root">');
});

test("WebSocket from a foreign origin is refused", async () => {
  const res = await fetch(`${base}/ws`, {
    headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", origin: "http://evil.example" },
  });
  expect(res.status).toBe(403);
});

test("WebSocket from the dashboard origin connects", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } } as any);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws failed"));
  });
  ws.close();
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const h = { "content-type": "application/json", "x-acutis": "1" };

test("artifacts are served as PNG with nosniff; unknown names are 404", async () => {
  app.store.addRepo({ name: "srv", path: "/nonexistent", base: "main" });
  const t = app.tickets.create({ repo: "srv", title: "x", body: "" });
  const run = app.store.createRun({ ticket_id: t.id, repo: "srv", state: "awaiting_review" });
  const name = app.runs.saveArtifact(run.id, PNG, "shot", "gate")!;
  const res = await fetch(`${base}/api/runs/${run.id}/artifacts/${name}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect((await fetch(`${base}/api/runs/${run.id}/artifacts/..%2F..%2Facutis.db`)).status).toBe(404);

  const note = await fetch(`${base}/api/runs/${run.id}/notes`, { method: "POST", headers: h, body: JSON.stringify({ text: "hi", image: PNG }) });
  expect(note.status).toBe(200);
  expect(((await note.json()) as any).data.artifact).toMatch(/\.png$/);
  const bad = await fetch(`${base}/api/runs/${run.id}/notes`, { method: "POST", headers: h, body: JSON.stringify({ text: "x", image: btoa("<svg onload=alert(1)>") }) });
  expect(bad.status).toBe(415);
});

test("repo notes can be read and set", async () => {
  const put = await fetch(`${base}/api/repos/srv/notes`, { method: "PUT", headers: h, body: JSON.stringify({ notes: "Use Edit." }) });
  expect(put.status).toBe(200);
  expect(((await (await fetch(`${base}/api/repos/srv`)).json()) as any).notes).toBe("Use Edit.");
  expect((await fetch(`${base}/api/repos/srv/notes`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
});
