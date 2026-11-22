/**
 * All dashboard state, loading, hub handling and actions, independent of how it looks. The layout
 * (rose/Layout.tsx) gets the result of `useDashboard()` and only decides what to show where.
 */
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isRunnerTicket } from "../core/scouts";
import type { Decision, Lesson, Noticed, PermissionRequest, Repo, Run, RunEvent, Ticket } from "../core/types";
import type { DraftView } from "../core/writer";
import { api, AuthError, getToken, setToken, tokenFromHash, useHub } from "./api";

export type RankedDecision = Decision & { held: number; held_tickets: Ticket[] };
export type ScoutTypeInfo = { id: string; title: string };
export type Draft = DraftView & { run: Run };
export type DraftAction = "answer" | "save" | "stop" | "discard" | "continue";
export type LessonAction = "approve" | "reject" | "retire" | "edit" | "confirm";
export type DecideBody = { decision: string; version: number; keep: number[]; drop: number[] };
/** A pending permission request and the run it blocks. */
export type PendingPermission = { runId: number; req: PermissionRequest };
export type PermissionAnswer = { behavior: "allow"; always?: boolean } | { behavior: "deny"; message?: string };

export type Column = { key: Ticket["status"]; label: string; collapsed?: boolean; hideEmpty?: boolean };
export const COLUMNS: Column[] = [
  { key: "review", label: "Review" },
  { key: "in_progress", label: "In progress" },
  { key: "proposed", label: "Proposed by scouts", hideEmpty: true },
  { key: "todo", label: "Todo" },
  { key: "done", label: "Done" },
  { key: "cancelled", label: "Cancelled", collapsed: true },
];

export const LIVE_STATES = ["queued", "preparing", "running", "paused", "verifying"];
/** A writer is busy in these states; between turns it rests paused, waiting for the operator. */
export const WRITER_BUSY = ["queued", "preparing", "running"];

export function stateLabel(run: Run, queuePos: Map<number, number>): string {
  if (run.state === "queued") return queuePos.has(run.id) ? `queued · #${queuePos.get(run.id)} in line` : "queued";
  return run.state.replace("_", " ");
}

export function toolArg(name: string, input: any, root?: string | null): string {
  if (!input || typeof input !== "object") return "";
  if (name === "Bash") return input.command ?? "";
  const s: string = input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description ?? JSON.stringify(input);
  return root && s.startsWith(root + "/") ? s.slice(root.length + 1) : s;
}

export function readPng(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:image\/png;base64,/, ""));
    r.onerror = () => reject(new Error("could not read image"));
    r.readAsDataURL(file);
  });
}

export function useDashboard() {
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
  const [needsToken, setNeedsToken] = useState(!getToken());
  const [noticed, setNoticed] = useState<Noticed[]>([]);
  const loadNoticed = useCallback(() => api<Noticed[]>("/api/noticed").then(setNoticed).catch(() => {}), []);
  const [openDecisions, setOpenDecisions] = useState<RankedDecision[]>([]);
  const [decided, setDecided] = useState<Decision[]>([]);
  const [scoutTypes, setScoutTypes] = useState<ScoutTypeInfo[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const loadLessons = useCallback(() => api<Lesson[]>("/api/lessons").then(setLessons).catch(() => {}), []);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const loadDrafts = useCallback(() => api<Draft[]>("/api/drafts").then(setDrafts).catch(() => {}), []);
  const loadDecisions = useCallback(
    () =>
      Promise.all([api<RankedDecision[]>("/api/decisions"), api<Decision[]>("/api/decisions?status=decided")])
        .then(([o, d]) => (setOpenDecisions(o), setDecided(d)))
        .catch(() => {}),
    [],
  );
  // Request id → the full request, so the sidebar can show and answer it without opening the run.
  const [pending, setPending] = useState<Map<string, PendingPermission>>(new Map());
  const eventSink = useRef<((e: RunEvent) => void) | null>(null);

  const reload = useCallback(async () => {
    const s = await api("/api/state");
    setRepos(s.repos);
    setTickets(new Map(s.tickets.map((t: Ticket) => [t.id, t])));
    setRuns(new Map(s.runs.map((r: Run) => [r.id, r])));
    setSandbox(s.sandbox);
    setSandboxReason(s.sandboxReason);
    setPending(new Map((s.permissions ?? []).map((p: PendingPermission) => [p.req.id, { runId: p.runId, req: p.req }])));
    setScoutTypes(s.scoutTypes ?? []);
    await Promise.all([loadNoticed(), loadDecisions(), loadLessons(), loadDrafts()]);
  }, [loadNoticed, loadDecisions, loadLessons, loadDrafts]);

  useEffect(() => {
    if (!getToken()) return; // nothing to ask with; the sign-in screen is already showing
    reload().catch((e) => (e instanceof AuthError ? setNeedsToken(true) : setError(e.message)));
  }, [reload]);

  // Pasting the login link into an open tab only changes the hash, which doesn't reload the page.
  useEffect(() => {
    const onHash = () => {
      const t = tokenFromHash();
      if (!t) return;
      setToken(t);
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
    else if (m.type === "run") {
      setRuns((prev) => new Map(prev).set(m.run.id, m.run));
      if (m.run.kind === "writer") loadDrafts();
    } else if (m.type === "event") {
      const e = m.event;
      if (e.kind === "noticed") loadNoticed();
      if (e.kind.startsWith("scout.")) loadDecisions();
      if (e.kind === "lesson.proposed" || e.kind === "lesson.stale") loadLessons();
      if (e.kind.startsWith("writer.")) loadDrafts();
      if (e.kind === "permission.request") {
        const req = e.data as unknown as PermissionRequest;
        setPending((p) => new Map(p).set(req.id, { runId: e.run_id, req }));
      }
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
  const pendingRuns = useMemo(() => new Set([...pending.values()].map((p) => p.runId)), [pending]);

  // Reload state after reconnecting so nothing missed while offline is lost.
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connected && wasConnected.current === false) reload().catch(() => {});
    wasConnected.current = connected;
  }, [connected, reload]);

  // Queued runs start oldest first, so a run's place in line is its rank among queued runs.
  const queuePos = useMemo(() => {
    const m = new Map<number, number>();
    [...runs.values()].filter((r) => r.state === "queued").sort((a, b) => a.id - b.id).forEach((r, i) => m.set(r.id, i + 1));
    return m;
  }, [runs]);

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

  const putTicket = (t: Ticket) => setTickets((prev) => new Map(prev).set(t.id, t));
  const putRun = (r: Run) => setRuns((prev) => new Map(prev).set(r.id, r));

  // ---------------------------------------------------------------- actions
  const actions = {
    startTicket: (id: number) =>
      act(async () => {
        const run = await api<Run>(`/api/tickets/${id}/start`, "POST");
        putRun(run);
        setSelected(run.id);
      }),
    /** Answer a run's permission request. The hub's permission.decision event then clears it everywhere. */
    answerPermission: (runId: number, id: string, answer: PermissionAnswer) =>
      act(() => api(`/api/runs/${runId}/permissions/${id}`, "POST", answer)),
    acceptTicket: (id: number) => act(() => api(`/api/tickets/${id}/accept`, "POST")),
    rejectTicket: (id: number) => act(() => api(`/api/tickets/${id}/reject`, "POST")),
    /** Add a ticket. Errors go to the toast; resolves true when it was created. */
    createTicket: async (repo: string, title: string, body: string): Promise<boolean> => {
      try {
        putTicket(await api<Ticket>("/api/tickets", "POST", { repo, title, body }));
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      }
    },
    draftTicket: (repo: string, prompt: string) =>
      act(async () => {
        await api<Run>("/api/drafts", "POST", { repo, prompt });
        await loadDrafts();
      }),
    draftAct: (id: number, action: DraftAction, payload?: unknown) =>
      act(async () => {
        if (action === "continue") await api(`/api/runs/${id}/resume`, "POST");
        else {
          const out = await api(`/api/drafts/${id}/${action}`, "POST", payload);
          if (action === "save") {
            putTicket(out.ticket);
            if (out.run) {
              putRun(out.run);
              setSelected(out.run.id);
            }
          }
        }
        await loadDrafts();
      }),
    noticedTicket: (id: number) =>
      act(async () => {
        putTicket(await api<Ticket>(`/api/noticed/${id}/ticket`, "POST"));
        await loadNoticed();
      }),
    noticedDismiss: (id: number) => act(async () => (await api(`/api/noticed/${id}/dismiss`, "POST"), await loadNoticed())),
    decide: (id: number, body: DecideBody) => act(async () => (await api(`/api/decisions/${id}/decide`, "POST", body), await loadDecisions())),
    withdrawDecision: (id: number) => act(async () => (await api(`/api/decisions/${id}/withdraw`, "POST"), await loadDecisions())),
    lessonAct: (id: number, action: LessonAction, text?: string) =>
      act(async () => (await api(`/api/lessons/${id}/${action}`, "POST", text === undefined ? undefined : { text }), await loadLessons())),
    startScout: (repo: string, type: string) =>
      act(async () => {
        const run = await api<Run>(`/api/repos/${encodeURIComponent(repo)}/scouts/${type}`, "POST");
        putRun(run);
        setSelected(run.id);
      }),
    /** Save a repo's operator notes. Errors go to the toast. */
    saveNotes: async (repo: string, notes: string) => {
      try {
        const r = await api<Repo>(`/api/repos/${encodeURIComponent(repo)}/notes`, "PUT", { notes });
        setRepos((prev) => prev.map((x) => (x.name === r.name ? r : x)));
      } catch (e) {
        setError((e as Error).message);
      }
    },
  };

  // ---------------------------------------------------------------- derived
  const board = useMemo(
    () =>
      COLUMNS.map((col) => ({
        ...col,
        items: [...tickets.values()].filter((t) => t.status === col.key && !isRunnerTicket(t)).sort((a, b) => b.id - a.id),
      })),
    [tickets],
  );

  /** What needs the operator, for layouts to put up front. */
  const attention = useMemo(() => {
    const waitingRuns = [...runs.values()]
      .filter((r) => pendingRuns.has(r.id) || (r.kind === "work" && r.state === "awaiting_review"))
      .sort((a, b) => Number(pendingRuns.has(b.id)) - Number(pendingRuns.has(a.id)) || b.id - a.id);
    const draftsWaiting = drafts.filter((x) => !WRITER_BUSY.includes(x.run.state)).length;
    const lessonsWaiting = lessons.filter((l) => l.status === "proposed" || (l.status === "approved" && l.stale)).length;
    const proposed = board.find((c) => c.key === "proposed")?.items.length ?? 0;
    return {
      waitingRuns,
      permissions: pending.size,
      drafts: draftsWaiting,
      decisions: openDecisions.length,
      lessons: lessonsWaiting,
      noticed: noticed.length,
      proposed,
      total: waitingRuns.length + draftsWaiting + openDecisions.length + lessonsWaiting + noticed.length + proposed,
    };
  }, [runs, pendingRuns, drafts, lessons, openDecisions, noticed, board, pending]);

  const run = selected ? runs.get(selected) ?? null : null;

  return {
    repos,
    tickets,
    runs,
    sandbox,
    sandboxReason,
    selected,
    setSelected,
    run,
    error,
    setError,
    needsToken,
    connected,
    noticed,
    openDecisions,
    decided,
    scoutTypes,
    lessons,
    drafts,
    pending,
    pendingRuns,
    queuePos,
    latestRun,
    eventSink: eventSink as React.MutableRefObject<((e: RunEvent) => void) | null>,
    act,
    board,
    attention,
    ...actions,
  };
}

export type Dashboard = ReturnType<typeof useDashboard>;
