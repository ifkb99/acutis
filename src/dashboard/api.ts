import { useEffect, useRef, useState } from "react";
import type { Run, RunEvent, Ticket } from "../core/types";

/**
 * The API needs the daemon's token. It arrives once in the link `acutis serve` prints
 * (`#token=…`) and is kept in localStorage, which is per origin (port included), so a preview
 * on another port can't read it. A cookie wouldn't do: cookies ignore the port, so the browser
 * would send it to the worker-written preview server too.
 */
const TOKEN_KEY = "acutis-token";

/** Take a `#token=…` out of the URL (so it isn't left in history or a copied link) and keep it. */
export function tokenFromHash(): string | null {
  const m = location.hash.match(/(?:^#|&)token=([^&]+)/);
  if (!m) return null;
  const t = decodeURIComponent(m[1]!);
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {}
  const rest = location.hash.replace(/(^#|&)token=[^&]+/, "$1").replace(/^#&/, "#").replace(/&$/, "");
  history.replaceState(null, "", location.pathname + location.search + (rest === "#" ? "" : rest));
  return t;
}

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let token = tokenFromHash() ?? storedToken();
export const getToken = () => token;
export const setToken = (t: string) => void (token = t);
export const authHeaders = (): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

export class AuthError extends Error {}

export async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-acutis": "1", ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError("The dashboard needs a fresh token.");
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data as any)?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export type HubMessage =
  | { type: "event"; event: RunEvent }
  | { type: "run"; run: Run }
  | { type: "ticket"; ticket: Ticket };

export function useHub(onMessage: (m: HubMessage) => void, enabled: boolean) {
  const ref = useRef(onMessage);
  ref.current = onMessage;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let stop = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      if (!token) return;
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(token)}`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => ref.current(JSON.parse(e.data));
      ws.onclose = () => {
        setConnected(false);
        if (!stop) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      stop = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [enabled]);
  return connected;
}
