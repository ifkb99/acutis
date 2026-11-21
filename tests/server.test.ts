import { afterAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { createApp } from "../src/app";
import { tokenPath } from "../src/core/token";
import { startServer } from "../src/server/server";
import { FakeRunner, tempDir } from "./helpers";

const port = 17000 + Math.floor(Math.random() * 1000);
const home = tempDir();
const app = createApp({ home, port }, { runner: new FakeRunner([]) });
const server = startServer(app);
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${port}`;
const auth = { authorization: `Bearer ${app.token}` };

test("GET state works from localhost with the token", async () => {
  const res = await fetch(`${base}/api/state`, { headers: auth });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ repos: [], tickets: [] });
});

test("the API refuses requests without the right token, GETs included", async () => {
  // What a worker's preview server could send: it can reach this port, but not read $ACUTIS_HOME.
  expect((await fetch(`${base}/api/state`)).status).toBe(401);
  expect((await fetch(`${base}/api/state`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  expect((await fetch(`${base}/api/state?token=${app.token}`)).status).toBe(401); // the query only counts for /ws
  const post = await fetch(`${base}/api/tickets`, { method: "POST", headers: { "x-acutis": "1", "content-type": "application/json" }, body: "{}" });
  expect(post.status).toBe(401);
});

test("the token is persisted 0600 in ACUTIS_HOME and survives a restart", () => {
  expect(statSync(tokenPath(home)).mode & 0o777).toBe(0o600);
  expect(app.token.length).toBeGreaterThanOrEqual(40);
  expect(createApp({ home, port: port + 1 }, { runner: new FakeRunner([]) }).token).toBe(app.token);
});

test("POST without the x-acutis header is refused", async () => {
  const res = await fetch(`${base}/api/tickets`, { method: "POST", headers: auth, body: "{}" });
  expect(res.status).toBe(403);
});

test("foreign Host header is refused (DNS rebinding)", async () => {
  const res = await fetch(`${base}/api/state`, { headers: { ...auth, host: "evil.example:7777" } });
  expect(res.status).toBe(403);
});

test("cross-origin POST is refused even with the header", async () => {
  const res = await fetch(`${base}/api/tickets`, {
    method: "POST",
    headers: { ...auth, "x-acutis": "1", origin: "http://evil.example" },
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
  const res = await fetch(`${base}/ws?token=${app.token}`, {
    headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", origin: "http://evil.example" },
  });
  expect(res.status).toBe(403);
});

test("WebSocket without the token is refused", async () => {
  const res = await fetch(`${base}/ws`, {
    headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", origin: base },
  });
  expect(res.status).toBe(401);
});

test("WebSocket from the dashboard origin with the token connects", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${app.token}`, { headers: { origin: `http://127.0.0.1:${port}` } } as any);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("ws failed"));
  });
  ws.close();
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const h = { "content-type": "application/json", "x-acutis": "1", ...auth };

test("artifacts are served as PNG with nosniff; unknown names are 404", async () => {
  app.store.addRepo({ name: "srv", path: "/nonexistent", base: "main" });
  const t = app.tickets.create({ repo: "srv", title: "x", body: "" });
  const run = app.store.createRun({ ticket_id: t.id, repo: "srv", state: "awaiting_review" });
  const name = app.runs.saveArtifact(run.id, PNG, "shot", "gate")!;
  const res = await fetch(`${base}/api/runs/${run.id}/artifacts/${name}`, { headers: auth });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect((await fetch(`${base}/api/runs/${run.id}/artifacts/..%2F..%2Facutis.db`, { headers: auth })).status).toBe(404);

  const note = await fetch(`${base}/api/runs/${run.id}/notes`, { method: "POST", headers: h, body: JSON.stringify({ text: "hi", image: PNG }) });
  expect(note.status).toBe(200);
  expect(((await note.json()) as any).data.artifact).toMatch(/\.png$/);
  const bad = await fetch(`${base}/api/runs/${run.id}/notes`, { method: "POST", headers: h, body: JSON.stringify({ text: "x", image: btoa("<svg onload=alert(1)>") }) });
  expect(bad.status).toBe(415);
});

test("repo notes can be read and set", async () => {
  const put = await fetch(`${base}/api/repos/srv/notes`, { method: "PUT", headers: h, body: JSON.stringify({ notes: "Use Edit." }) });
  expect(put.status).toBe(200);
  expect(((await (await fetch(`${base}/api/repos/srv`, { headers: auth })).json()) as any).notes).toBe("Use Edit.");
  expect((await fetch(`${base}/api/repos/srv/notes`, { method: "PUT", headers: { "content-type": "application/json", ...auth }, body: "{}" })).status).toBe(403);
});
