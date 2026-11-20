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
