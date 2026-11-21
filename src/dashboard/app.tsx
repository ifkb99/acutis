import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Repo, Run, RunEvent, Ticket, PermissionRequest } from "../core/types";
import { Markdown } from "./markdown";

// ------------------------------------------------------------------- api

/**
 * The API needs the daemon's token. It arrives once in the link `acutis serve` prints
 * (`#token=…`) and is kept in localStorage, which is per origin (port included), so a preview
 * on another port can't read it. A cookie wouldn't do: cookies ignore the port, so the browser
 * would send it to the worker-written preview server too.
 */
const TOKEN_KEY = "acutis-token";

/** Take a `#token=…` out of the URL (so it isn't left in history or a copied link) and keep it. */
function tokenFromHash(): string | null {
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
const authHeaders = (): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

class AuthError extends Error {}

async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
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

type HubMessage =
  | { type: "event"; event: RunEvent }
  | { type: "run"; run: Run }
  | { type: "ticket"; ticket: Ticket };

function useHub(onMessage: (m: HubMessage) => void, enabled: boolean) {
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

// ------------------------------------------------------------------- app

const COLUMNS: { key: Ticket["status"]; label: string; collapsed?: boolean }[] = [
  { key: "review", label: "Review" },
  { key: "in_progress", label: "In progress" },
  { key: "todo", label: "Todo" },
  { key: "done", label: "Done" },
  { key: "cancelled", label: "Cancelled", collapsed: true },
];

function App() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [tickets, setTickets] = useState<Map<number, Ticket>>(new Map());
  const [runs, setRuns] = useState<Map<number, Run>>(new Map());
  const [sandbox, setSandbox] = useState<boolean | null>(null);
  const [sandboxReason, setSandboxReason] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(() => {
    const m = location.hash.match(/run-(\d+)/);
    return m ? Number(m[1]) : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState(!token);
  const [pending, setPending] = useState<Map<string, number>>(new Map());
  const eventSink = useRef<((e: RunEvent) => void) | null>(null);

  const reload = useCallback(async () => {
    const s = await api("/api/state");
    setRepos(s.repos);
    setTickets(new Map(s.tickets.map((t: Ticket) => [t.id, t])));
    setRuns(new Map(s.runs.map((r: Run) => [r.id, r])));
    setSandbox(s.sandbox);
    setSandboxReason(s.sandboxReason);
    setPending(new Map((s.permissions ?? []).map((p: { runId: number; req: PermissionRequest }) => [p.req.id, p.runId])));
  }, []);

  useEffect(() => {
    if (!token) return; // nothing to ask with; the sign-in screen is already showing
    reload().catch((e) => (e instanceof AuthError ? setNeedsToken(true) : setError(e.message)));
  }, [reload]);

  // Pasting the login link into an open tab only changes the hash, which doesn't reload the page.
  useEffect(() => {
    const onHash = () => {
      const t = tokenFromHash();
      if (!t) return;
      token = t;
      setNeedsToken(false);
      reload().catch((e) => (e instanceof AuthError ? setNeedsToken(true) : setError(e.message)));
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, [reload]);

  useEffect(() => {
    if (selected) history.replaceState(null, "", `#run-${selected}`);
  }, [selected]);

  const connected = useHub((m) => {
    if (m.type === "ticket") setTickets((prev) => new Map(prev).set(m.ticket.id, m.ticket));
    else if (m.type === "run") setRuns((prev) => new Map(prev).set(m.run.id, m.run));
    else if (m.type === "event") {
      const e = m.event;
      if (e.kind === "permission.request") setPending((p) => new Map(p).set((e.data as any).id, e.run_id));
      else if (e.kind === "permission.decision") {
        setPending((p) => {
          const n = new Map(p);
          n.delete((e.data as any).id);
          return n;
        });
      }
      eventSink.current?.(e);
    }
  }, !needsToken);

  // Pending permission requests show in the tab title, so a waiting run is visible from other tabs.
  useEffect(() => {
    document.title = pending.size ? `(${pending.size}) Acutis — needs you` : "Acutis";
  }, [pending]);
  const pendingRuns = useMemo(() => new Set(pending.values()), [pending]);

  // Reload state after reconnecting so nothing missed while offline is lost.
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connected && wasConnected.current === false) reload().catch(() => {});
    wasConnected.current = connected;
  }, [connected, reload]);

  const latestRun = useMemo(() => {
    const m = new Map<number, Run>();
    for (const r of [...runs.values()].sort((a, b) => a.id - b.id)) m.set(r.ticket_id, r);
    return m;
  }, [runs]);

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      if (e instanceof AuthError) setNeedsToken(true);
      else setError((e as Error).message);
    }
  }, []);

  const startTicket = (id: number) =>
    act(async () => {
      const run = await api<Run>(`/api/tickets/${id}/start`, "POST");
      setRuns((prev) => new Map(prev).set(run.id, run));
      setSelected(run.id);
    });

  const run = selected ? runs.get(selected) ?? null : null;

  if (needsToken) {
    return (
      <div className="placeholder">
        <p>This dashboard needs the Acutis API token.</p>
        <p>
          Open the link that <code>acutis serve</code> printed, or get it again with <code>acutis dashboard</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="layout">
      <aside className="side">
        <div className="brand">
          <h1>Acutis</h1>
          <div className="row">
            {!connected && <span className="badge off">offline</span>}
            {sandbox !== null && (
              <span className={`badge ${sandbox ? "on" : "off"}`} title={sandbox ? "bubblewrap sandbox active" : `Sandbox off: ${sandboxReason ?? "unavailable"}. Commands outside the allowlist ask you first.`}>
                sandbox {sandbox ? "on" : "off"}
              </span>
            )}
          </div>
        </div>
        <NewTicket repos={repos} onCreate={(t) => setTickets((prev) => new Map(prev).set(t.id, t))} onError={setError} />
        <RepoNotes repos={repos} onSaved={(r) => setRepos((prev) => prev.map((x) => (x.name === r.name ? r : x)))} onError={setError} />
        {COLUMNS.map((col) => {
          const items = [...tickets.values()].filter((t) => t.status === col.key).sort((a, b) => b.id - a.id);
          if (col.collapsed && items.length === 0) return null;
          const cards = items.map((t) => {
                const r = latestRun.get(t.id);
                return (
                  <div
                    key={t.id}
                    className={`card ${r && r.id === selected ? "sel" : ""}`}
                    onClick={() => r && setSelected(r.id)}
                  >
                    <div className="t">
                      #{t.id} {t.title}
                    </div>
                    <div className="meta">
                      <span>{t.repo}</span>
                      {r && <span className={`chip ${r.state}`}>{r.state.replace("_", " ")}</span>}
                      {r && pendingRuns.has(r.id) && <span className="chip needs">needs you</span>}
                      <span style={{ flex: 1 }} />
                      {t.status === "todo" && (
                        <button
                          className="btn sm primary"
                          onClick={(e) => {
                            e.stopPropagation();
                            startTicket(t.id);
                          }}
                        >
                          Start
                        </button>
                      )}
                    </div>
                  </div>
                );
              });
          if (col.collapsed) {
            return (
              <details className="col" key={col.key}>
                <summary>
                  <h2>
                    {col.label} · {items.length}
                  </h2>
                </summary>
                {cards}
              </details>
            );
          }
          return (
            <section className="col" key={col.key}>
              <h2>
                {col.label} · {items.length}
              </h2>
              {items.length === 0 && <div className="empty">Nothing here.</div>}
              {cards}
            </section>
          );
        })}
      </aside>
      <main className="main">
        {run ? (
          <RunView
            key={run.id}
            run={run}
            ticket={tickets.get(run.ticket_id) ?? null}
            eventSink={eventSink}
            act={act}
          />
        ) : (
          <div className="placeholder">
            {repos.length === 0
              ? "No repos yet. Register one with: bun src/cli.ts repo add <path>"
              : "Create a ticket and press Start, or select a ticket to watch its run."}
          </div>
        )}
      </main>
      {error && (
        <div className="error-toast" onClick={() => setError(null)} title="Dismiss">
          {error}
        </div>
      )}
    </div>
  );
}

function NewTicket({ repos, onCreate, onError }: { repos: Repo[]; onCreate: (t: Ticket) => void; onError: (s: string) => void }) {
  const [repo, setRepo] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  useEffect(() => {
    if (!repo && repos[0]) setRepo(repos[0].name);
  }, [repos, repo]);
  if (repos.length === 0) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const t = await api<Ticket>("/api/tickets", "POST", { repo, title, body });
      onCreate(t);
      setTitle("");
      setBody("");
    } catch (err) {
      onError((err as Error).message);
    }
  };
  return (
    <form className="newticket" onSubmit={submit}>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <select value={repo} onChange={(e) => setRepo(e.target.value)} style={{ width: "auto", maxWidth: "50%", flex: "0 0 auto" }} title={repo}>
          {repos.map((r) => (
            <option key={r.name}>{r.name}</option>
          ))}
        </select>
        <input placeholder="New ticket title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <textarea placeholder="Description, acceptance criteria…" value={body} onChange={(e) => setBody(e.target.value)} />
      <button className="btn" disabled={!title.trim()}>
        Add ticket
      </button>
    </form>
  );
}

/** Operator guidance per repo. Stored in Acutis's DB (not the repo), appended to every worker's prompt. */
function RepoNotes({ repos, onSaved, onError }: { repos: Repo[]; onSaved: (r: Repo) => void; onError: (s: string) => void }) {
  const [repo, setRepo] = useState("");
  const [text, setText] = useState("");
  const current = repos.find((r) => r.name === repo);
  useEffect(() => {
    if (!repo && repos[0]) setRepo(repos[0].name);
  }, [repos, repo]);
  useEffect(() => setText(current?.notes ?? ""), [current?.name, current?.notes]);
  if (repos.length === 0) return null;
  const dirty = text !== (current?.notes ?? "");
  return (
    <details className="reponotes">
      <summary>Operator notes for workers{current?.notes ? " ✓" : ""}</summary>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <select value={repo} onChange={(e) => setRepo(e.target.value)} style={{ width: "auto" }}>
          {repos.map((r) => (
            <option key={r.name}>{r.name}</option>
          ))}
        </select>
      </div>
      <textarea
        placeholder="Guidance every worker on this repo gets, e.g. “Use the Edit tool, not scripts, for file changes.”"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        className="btn"
        disabled={!dirty}
        onClick={async () => {
          try {
            onSaved(await api<Repo>(`/api/repos/${encodeURIComponent(repo)}/notes`, "PUT", { notes: text }));
          } catch (e) {
            onError((e as Error).message);
          }
        }}
      >
        Save notes
      </button>
    </details>
  );
}

function readPng(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:image\/png;base64,/, ""));
    r.onerror = () => reject(new Error("could not read image"));
    r.readAsDataURL(file);
  });
}

// ------------------------------------------------------------------- run view

function RunView({
  run,
  ticket,
  eventSink,
  act,
}: {
  run: Run;
  ticket: Ticket | null;
  eventSink: React.MutableRefObject<((e: RunEvent) => void) | null>;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [perms, setPerms] = useState<PermissionRequest[]>([]);
  const [tab, setTab] = useState<"activity" | "diff">("activity");
  const [text, setText] = useState("");
  const [image, setImage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const buffered: RunEvent[] = [];
    eventSink.current = (e) => {
      if (e.run_id !== run.id) return;
      if (cancelled) return;
      buffered.push(e);
      setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e]));
      if (e.kind === "permission.request") setPerms((p) => [...p, e.data as unknown as PermissionRequest]);
      if (e.kind === "permission.decision") setPerms((p) => p.filter((x) => x.id !== (e.data as any).id));
    };
    api(`/api/runs/${run.id}`).then((d) => {
      if (cancelled) return;
      const ids = new Set<number>(d.events.map((e: RunEvent) => e.id));
      setEvents([...d.events, ...buffered.filter((e) => !ids.has(e.id))]);
      setPerms(d.permissions);
    });
    return () => {
      cancelled = true;
      eventSink.current = null;
    };
  }, [run.id, eventSink]);

  const post = (path: string, body?: unknown) => act(() => api(`/api/runs/${run.id}/${path}`, "POST", body));
  const s = run.state;
  const canMessage = ["running", "paused", "awaiting_review", "failed"].includes(s);
  const canNote = s !== "preparing";
  const send = (mode: "message" | "redirect") => {
    if (!text.trim()) return;
    post(mode, { text }).then(() => setText(""));
  };
  const addNote = () => {
    if (!text.trim() && !image) return;
    post("notes", { text, image: image ?? undefined }).then(() => {
      setText("");
      setImage(null);
    });
  };
  const openPreview = () =>
    act(async () => {
      const { url } = await api<{ url: string }>(`/api/runs/${run.id}/preview`, "POST");
      window.open(url, "_blank", "noopener");
    });

  return (
    <>
      <div className="runhead">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>
            #{run.ticket_id} {ticket?.title ?? ""}
          </h2>
          <span className={`chip ${s}`}>{s.replace("_", " ")}</span>
        </div>
        <div className="facts">
          <span>run {run.id}</span>
          <span>{run.repo}</span>
          {run.model && <span>{run.model}</span>}
          <span>attempt {run.attempt}</span>
          <span title="API-equivalent estimate; billed against your subscription. Updated when each turn ends.">≈${run.cost_usd.toFixed(2)}</span>
          {run.gates_ok !== null && <span style={{ color: run.gates_ok ? "var(--ok)" : "var(--err)" }}>checks {run.gates_ok ? "passed" : "failed"}</span>}
          {run.bookmark && <span>bookmark {run.bookmark}</span>}
          {run.workspace_path && <span title={run.workspace_path}>workspace {run.workspace_name}</span>}
        </div>
        {ticket?.body && (
          <details className="ticketbody" open={ticket.body.length < 400}>
            <summary>Ticket</summary>
            <Markdown text={ticket.body} />
          </details>
        )}
        <div className="row">
          {s === "running" && <button className="btn" onClick={() => post("pause")}>Pause</button>}
          {s === "paused" && <button className="btn" onClick={() => post("resume")}>Resume</button>}
          {s === "awaiting_review" && (
            <button className="btn primary" onClick={() => post("approve")}>Approve &amp; land</button>
          )}
          {run.workspace_path && !["done", "failed", "cancelled"].includes(s) && (
            <button className="btn" onClick={openPreview} title="Start this run's preview server (if the repo has one) and open it">
              Open preview
            </button>
          )}
          {["preparing", "running", "paused", "verifying", "awaiting_review"].includes(s) && (
            <button className="btn danger" onClick={() => confirm("Kill this run? The workspace is kept until you discard it.") && post("kill")}>
              Kill
            </button>
          )}
          {["paused", "awaiting_review", "failed", "cancelled"].includes(s) && run.workspace_path && (
            <button className="btn danger" onClick={() => confirm("Discard this run's changes and delete its workspace?") && post("discard")}>
              Discard
            </button>
          )}
        </div>
      </div>

      {perms.map((p) => (
        <div className="perm" key={p.id}>
          <div>
            <b>Permission needed:</b> <code>{p.tool}</code>
            {p.blockedPath && <> (path outside workspace: <code>{p.blockedPath}</code>)</>}
            {p.reason && <div className="hint">Why: {p.reason}</div>}
          </div>
          <pre>{p.tool === "Bash" ? String((p.input as any).command ?? "") : JSON.stringify(p.input, null, 2)}</pre>
          <div className="row">
            <button className="btn ok" onClick={() => post(`permissions/${p.id}`, { behavior: "allow" })}>Allow once</button>
            {p.canAlwaysAllow && (
              <button className="btn ok" onClick={() => post(`permissions/${p.id}`, { behavior: "allow", always: true })}>
                Allow for this run
              </button>
            )}
            <button
              className="btn danger"
              onClick={() => {
                const message = prompt("Tell the agent why (optional):") ?? undefined;
                post(`permissions/${p.id}`, { behavior: "deny", message });
              }}
            >
              Deny
            </button>
          </div>
        </div>
      ))}

      <div className="tabs">
        <button className={`tab ${tab === "activity" ? "on" : ""}`} onClick={() => setTab("activity")}>Activity</button>
        <button className={`tab ${tab === "diff" ? "on" : ""}`} onClick={() => setTab("diff")}>Diff</button>
      </div>

      {tab === "activity" ? <Timeline events={events} root={run.workspace_path} /> : <DiffView run={run} />}

      {canNote && (
        <div className="composer">
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
            <textarea
              placeholder={
                !canMessage
                  ? "Add a review note to this run"
                  : s === "awaiting_review"
                    ? "Send back with a note: what should change? (or Add note to record it without sending)"
                    : s === "running"
                      ? "Message the agent (queued), or Redirect to interrupt it"
                      : "Message to continue the session"
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(e.shiftKey ? "redirect" : "message");
              }}
              onPaste={(e) => {
                const f = [...e.clipboardData.files].find((f) => f.type === "image/png");
                if (f) {
                  e.preventDefault();
                  readPng(f).then(setImage, (err) => act(() => Promise.reject(err)));
                }
              }}
            />
            <span className="hint">
              Ctrl+Enter sends · Ctrl+Shift+Enter redirects · paste a PNG to attach it to a note
              {image && (
                <>
                  {" "}· image attached{" "}
                  <button className="btn sm" onClick={() => setImage(null)}>remove</button>
                </>
              )}
            </span>
          </div>
          <div className="row" style={{ flexDirection: "column", alignItems: "stretch" }}>
            {canMessage && (
              <button className="btn primary" disabled={!text.trim()} onClick={() => send("message")}>
                {s === "awaiting_review" ? "Send back" : "Send"}
              </button>
            )}
            {s === "running" && (
              <button className="btn" disabled={!text.trim()} onClick={() => send("redirect")} title="Interrupt the current turn and give new instructions">
                Redirect
              </button>
            )}
            <button className="btn" disabled={!text.trim() && !image} onClick={addNote} title="Save a review note on this run (not sent to the agent)">
              Add note
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function toolArg(name: string, input: any, root?: string | null): string {
  if (!input || typeof input !== "object") return "";
  if (name === "Bash") return input.command ?? "";
  const s: string = input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? JSON.stringify(input);
  return root && s.startsWith(root + "/") ? s.slice(root.length + 1) : s;
}

function Timeline({ events, root }: { events: RunEvent[]; root: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const results = useMemo(() => {
    const m = new Map<string, any>();
    for (const e of events) if (e.kind === "agent.tool_result") m.set((e.data as any).tool_use_id, e.data);
    return m;
  }, [events]);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events]);

  return (
    <div
      className="scroll"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {events.length === 0 && <div className="empty">Waiting for events…</div>}
      {events.map((e) => (
        <EventRow key={e.id} e={e} results={results} root={root} runId={e.run_id} />
      ))}
    </div>
  );
}

/** Artifacts need the token, which an <img src> can't send, so fetch them and show a blob URL. */
function Shot({ runId, name, caption }: { runId: number; name: string; caption?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    fetch(`/api/runs/${runId}/artifacts/${encodeURIComponent(name)}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((b) => {
        if (!live) return;
        url = URL.createObjectURL(b);
        setSrc(url);
      })
      .catch(() => {});
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [runId, name]);
  if (!src) return <span className="shot">loading screenshot…</span>;
  return (
    <a className="shot" href={src} target="_blank" rel="noreferrer noopener" title={caption}>
      <img src={src} alt={caption ?? "screenshot"} />
    </a>
  );
}

function EventRow({ e, results, root, runId }: { e: RunEvent; results: Map<string, any>; root: string | null; runId: number }) {
  const d = e.data as any;
  switch (e.kind) {
    case "run.state":
      return (
        <div className="ev state">
          {d.to.replace("_", " ")}
          {d.reason ? ` — ${d.reason}` : ""}
        </div>
      );
    case "agent.init":
      return <div className="ev log">session {String(d.session_id).slice(0, 8)} · {d.model} · sandbox {d.sandboxed ? "on" : "off"}</div>;
    case "agent.text":
      return (
        <div className="ev text">
          <Markdown text={String(d.text)} />
        </div>
      );
    case "agent.tool_use": {
      const r = results.get(d.id);
      return (
        <div className="ev">
          <details className="tool">
            <summary>
              <span className="name">{d.name}</span>
              <span className="arg">{toolArg(d.name, d.input, root)}</span>
              <span className={`st ${r ? (r.is_error ? "err" : "ok") : ""}`}>{r ? (r.is_error ? "error" : "✓") : "…"}</span>
            </summary>
            <pre>{JSON.stringify(d.input, null, 2)}</pre>
            {r && <pre>{r.content}</pre>}
          </details>
        </div>
      );
    }
    case "agent.tool_result":
      return null;
    case "agent.result":
      return (
        <div className="ev result">
          turn ended: {d.subtype} · {d.turns} turns · {(d.duration_ms / 1000).toFixed(0)}s · ≈${Number(d.turn_cost_usd ?? d.cost_usd).toFixed(3)}
        </div>
      );
    case "user.message":
      return (
        <div className="ev user">
          <div className="who">{d.by === "acutis" ? "Acutis (check results)" : d.mode === "redirect" ? "You — redirect" : "You"}</div>
          {d.text}
        </div>
      );
    case "gate.start":
    case "setup.start":
      return null;
    case "gate.result":
    case "setup.result":
      return (
        <div className="ev">
          <details className={`tool gate ${d.ok ? "ok" : "fail"}`} open={!d.ok}>
            <summary>
              <span className="name">{d.ok ? "✓" : "✗"} {e.kind === "setup.result" ? "setup" : "check"}</span>
              <span className="arg">{d.run}</span>
              <span className="st">{(d.duration_ms / 1000).toFixed(1)}s</span>
            </summary>
            {d.artifact && <Shot runId={runId} name={d.artifact} caption={d.name} />}
            <pre>{d.output || "(no output)"}</pre>
          </details>
        </div>
      );
    case "artifact":
      if (d.source === "gate" || d.source === "operator") return null; // shown with the check or note
      return (
        <div className="ev log">
          {d.caption}
          <Shot runId={runId} name={d.name} caption={d.caption} />
        </div>
      );
    case "review.note":
      return (
        <div className="ev note">
          <div className="who">Review note</div>
          {d.text && <Markdown text={d.text} />}
          {d.artifact && <Shot runId={runId} name={d.artifact} caption={d.text} />}
        </div>
      );
    case "permission.request":
      return (
        <div className="ev log warn">
          permission requested: {d.tool} {toolArg(d.tool, d.input)}
          {d.reason ? ` — ${d.reason}` : ""}
        </div>
      );
    case "permission.decision":
      return (
        <div className="ev log">
          permission {d.behavior === "allow" ? (d.always ? "allowed for run" : "allowed") : d.by === "timeout" ? "timed out (denied)" : "denied"}: {d.tool}
          {d.message ? ` (${d.message})` : ""}
        </div>
      );
    case "policy.flag":
      return (
        <div className="ev flag">
          ⚠ {d.msg} <code>{(d.files ?? []).join(", ")}</code>
        </div>
      );
    case "system.log":
      return (
        <div className={`ev log ${d.level ?? ""}`}>
          {d.msg}
          {d.gates?.length ? ` · checks: ${d.gates.join(", ")}` : ""}
        </div>
      );
    default:
      return <div className="ev log">{e.kind}</div>;
  }
}

function DiffView({ run }: { run: Run }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api<string>(`/api/runs/${run.id}/diff`)
      .then((d) => {
        setDiff(d);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
  }, [run.id]);
  useEffect(load, [load, run.state, run.updated_at]);

  if (err) return <div className="scroll"><div className="ev log error">{err}</div></div>;
  if (diff === null) return <div className="scroll"><div className="empty">Loading…</div></div>;
  if (!diff.trim()) {
    return (
      <div className="scroll">
        <div className="empty">{run.workspace_path ? "No changes yet." : "Workspace is gone (landed or discarded)."}</div>
      </div>
    );
  }
  return (
    <div className="scroll">
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn sm" onClick={load}>Refresh</button>
      </div>
      <div className="diff">
        {diff.split("\n").map((line, i) => {
          const cls = line.startsWith("diff --git")
            ? "file"
            : line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+") && !line.startsWith("+++")
                ? "add"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "del"
                  : "";
          if (line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---")) return null;
          return (
            <div key={i} className={cls}>
              {cls === "file" ? line.replace(/^diff --git a\/(.*) b\/.*$/, "$1") : line || " "}
            </div>
          );
        })}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
