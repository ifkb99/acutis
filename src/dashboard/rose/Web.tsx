/**
 * The web a petal grows into: its items as small glass cards on a ring around it, joined by lines.
 * Clicking a card expands its related items one ring further out (as deep as the operator goes)
 * and opens it in the drawer on the right, which shows its full info and every action, the
 * destructive ones behind a confirm. Cards themselves only carry safe quick actions.
 * The graph and its layout are pure (graph.ts); this file draws them, pans and zooms.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PermissionRequest, RunEvent } from "../../core/types";
import { api } from "../api";
import { DecisionCard, DraftCard, EventRow, LessonEntry, lessonsTitle, NoticedEntry, TicketCard } from "../components";
import { Markdown } from "../markdown";
import { LIVE_STATES, stateLabel, WRITER_BUSY, type Dashboard } from "../state";
import { PetalBody, petals } from "./petals";
import { idOf, kindOf, layout, NODE_W, rings, type PetalId, type WebData } from "./graph";

export const SHOW_ENDED_KEY = "acutis-web-show-ended";
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.6;

type Props = {
  d: Dashboard;
  path: string[];
  setPath: (path: string[]) => void;
  drawer: string | null;
  setDrawer: (key: string | null) => void;
  /** Open the full-width run view of the selected run. */
  onRunView: () => void;
  onHub: () => void;
};

function usePhone(): boolean {
  const q = "(max-width: 640px)";
  const [phone, setPhone] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setPhone(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

export function webData(d: Dashboard): WebData {
  return {
    tickets: d.tickets,
    runs: d.runs,
    drafts: d.drafts,
    openDecisions: d.openDecisions,
    decided: d.decided,
    noticed: d.noticed,
    lessons: d.lessons,
    waitingRuns: d.attention.waitingRuns,
    scoutTypes: d.scoutTypes,
    repos: d.repos,
  };
}

export function Web({ d, path, setPath, drawer, setDrawer, onRunView, onHub }: Props) {
  const data = useMemo(() => webData(d), [d.tickets, d.runs, d.drafts, d.openDecisions, d.decided, d.noticed, d.lessons, d.attention.waitingRuns, d.scoutTypes, d.repos]);
  const [showEnded, setShowEndedState] = useState(() => localStorage.getItem(SHOW_ENDED_KEY) === "1");
  const setShowEnded = (on: boolean) => {
    localStorage.setItem(SHOW_ENDED_KEY, on ? "1" : "0");
    setShowEndedState(on);
  };
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const rs = useMemo(() => rings(path, data, { showEnded, expanded }), [path, data, showEnded, expanded]);
  const lay = useMemo(() => layout(rs), [rs]);
  const live = rs.map((r) => r.parent);
  const phone = usePhone();

  // An item that went away (accepted, landed, dismissed) closes the part of the web it held.
  useEffect(() => {
    if (live.length < path.length) setPath(live);
  }, [live.join("|"), path.join("|")]);
  useEffect(() => {
    if (drawer && !lay.nodes.some((n) => n.key === drawer)) setDrawer(null);
  }, [drawer, lay]);

  const root = path[0]!;
  const back = () => {
    if (path.length > 1) {
      const p = path.slice(0, -1);
      setPath(p);
      setDrawer(p[p.length - 1]!);
    } else onHub();
  };
  // Esc steps back, unless the operator is typing.
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable]")) return;
      backRef.current();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const choose = (key: string, ring: number) => {
    const kind = kindOf(key);
    if (kind === "more") return setExpanded((s) => new Set(s).add(idOf(key)));
    if (kind === "hidden") return setShowEnded(true);
    if (ring > 0 && path[ring] !== key) setPath([...path.slice(0, ring), key]);
    setDrawer(key);
  };
  const goPetal = (id: PetalId) => {
    setExpanded(new Set());
    setPath([`petal:${id}`]);
    setDrawer(`petal:${id}`);
  };

  // ------------------------------------------------------------- pan and zoom
  const canvas = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [phone]);
  const [view, setView] = useState({ x: 0, y: 0, z: 1, glide: false });
  const fit = () => {
    const { box } = lay;
    if (!size.w || !size.h) return;
    const fitZ = Math.min(size.w / (box.x1 - box.x0), size.h / (box.y1 - box.y0), 1);
    const z = Math.max(fitZ, MIN_ZOOM + 0.2);
    // Too big to fit: centre on the newest ring's parent instead.
    const focus = fitZ < z ? lay.nodes.find((n) => n.key === live[live.length - 1]) : null;
    const cx = focus ? focus.x : (box.x0 + box.x1) / 2;
    const cy = focus ? focus.y : (box.y0 + box.y1) / 2;
    setView({ x: -cx * z, y: -cy * z, z, glide: true });
  };
  const shape = lay.nodes.map((n) => `${n.key}@${n.x},${n.y}`).join(";");
  useEffect(fit, [shape, size.w, size.h]);
  const zoomAt = (factor: number, px = 0, py = 0) =>
    setView((v) => {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z * factor));
      const wx = (px - v.x) / v.z;
      const wy = (py - v.y) / v.z;
      return { x: px - wx * z, y: py - wy * z, z, glide: false };
    });
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [phone]);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest(".web-node, .web-petals, .web-zoom")) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = drag.current;
    if (g) setView((v) => ({ ...v, x: g.vx + e.clientX - g.x, y: g.vy + e.clientY - g.y, glide: false }));
  };
  const onPointerUp = () => (drag.current = null);

  const pos = new Map(lay.nodes.map((n) => [n.key, n]));
  const onPath = new Set(live.slice(1).map((k, i) => `${live[i]}>${k}`));
  const { box } = lay;
  const ps = petals(d);
  const shownDrawer = drawer ?? (phone ? root : null);
  const crumbs = live;

  return (
    <div className={`rose rose-web ${shownDrawer ? "with-drawer" : ""}`}>
      <header className="web-bar">
        <button className="back web-back" onClick={back} title="Step back (Esc)">
          <span className="rosette" aria-hidden="true">
            ‹
          </span>
          Back
        </button>
        <nav className="crumbs" aria-label="Breadcrumb">
          <button className="crumb" onClick={onHub}>
            Rose
          </button>
          {crumbs.map((k, i) => (
            <React.Fragment key={k}>
              <span className="crumb-sep" aria-hidden="true">
                ›
              </span>
              <button
                className={`crumb ${i === crumbs.length - 1 ? "on" : ""}`}
                aria-current={i === crumbs.length - 1 ? "location" : undefined}
                onClick={() => {
                  setPath(crumbs.slice(0, i + 1));
                  setDrawer(k);
                }}
              >
                {crumbLabel(k, d)}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <label className="web-ended" title="Show done and cancelled tickets and runs in the web">
          <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} /> Show done
        </label>
        {d.run && (
          <button className="btn resume" onClick={onRunView}>
            Back to run #{d.run.ticket_id}
          </button>
        )}
      </header>
      <div className="web-main">
        <div className="web-canvas" ref={canvas} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <nav className="web-petals" aria-label="Petals">
            {ps.map((p) => (
              <button
                key={p.id}
                className={`mini-petal tint-${p.tint} ${root === `petal:${p.id}` ? "on" : ""} ${p.urgent ? "urgent" : ""}`}
                title={`${p.label}${p.count ? ` · ${p.count}` : ""}`}
                aria-label={p.label}
                onClick={() => goPetal(p.id)}
              >
                {p.id === "new" ? "+" : p.count}
              </button>
            ))}
          </nav>
          <div className={`web-zoom`}>
            <button className="btn sm" onClick={() => zoomAt(1 / 1.25)} aria-label="Zoom out">
              −
            </button>
            <button className="btn sm" onClick={fit} title="Fit the web to the view">
              Fit
            </button>
            <button className="btn sm" onClick={() => zoomAt(1.25)} aria-label="Zoom in">
              +
            </button>
          </div>
          <div
            className={`web-plane ${view.glide ? "glide" : ""}`}
            style={{ transform: `translate(${size.w / 2 + view.x}px, ${size.h / 2 + view.y}px) scale(${view.z})` }}
          >
            <svg className="web-edges" style={{ left: box.x0, top: box.y0 }} width={box.x1 - box.x0} height={box.y1 - box.y0} viewBox={`${box.x0} ${box.y0} ${box.x1 - box.x0} ${box.y1 - box.y0}`} aria-hidden="true">
              {lay.edges.map((e) => {
                const a = pos.get(e.from);
                const b = pos.get(e.to);
                if (!a || !b) return null;
                return <line key={`${e.from}>${e.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`${e.link ? "link" : ""} ${onPath.has(`${e.from}>${e.to}`) ? "on" : ""}`} />;
              })}
            </svg>
            {lay.nodes.map((n, j) =>
              n.ring === 0 ? (
                <RootNode key={n.key} d={d} petal={idOf(n.key) as PetalId} sel={shownDrawer === n.key} onClick={() => choose(n.key, 0)} />
              ) : (
                <WebNode
                  key={n.key}
                  d={d}
                  k={n.key}
                  x={n.x}
                  y={n.y}
                  order={j}
                  expanded={live[n.ring] === n.key}
                  sel={shownDrawer === n.key}
                  rings={rs}
                  ring={n.ring}
                  onClick={() => choose(n.key, n.ring)}
                />
              ),
            )}
          </div>
        </div>
        {shownDrawer && <Drawer d={d} k={shownDrawer} onClose={() => (phone ? onHub() : setDrawer(null))} onRunView={onRunView} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- nodes

function RootNode({ d, petal, sel, onClick }: { d: Dashboard; petal: PetalId; sel: boolean; onClick: () => void }) {
  const p = petals(d).find((x) => x.id === petal)!;
  return (
    <button className={`web-root petal tint-${p.tint} ${sel ? "sel" : ""}`} onClick={onClick} title="Open the full list" aria-pressed={sel}>
      <span className="petal-count">{p.id === "new" ? "+" : p.count}</span>
      <span className="petal-label">{p.label}</span>
      <span className="petal-hint">{p.hint}</span>
    </button>
  );
}

type NodeView = { title: string; tint: string; chip?: { cls: string; text: string }; facts: string[]; actions?: React.ReactNode };

function nodeView(key: string, d: Dashboard, rs: ReturnType<typeof rings>, ring: number): NodeView {
  const id = Number(idOf(key));
  const kind = kindOf(key);
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  switch (kind) {
    case "ticket": {
      const t = d.tickets.get(id);
      if (!t) return { title: `#${id}`, tint: "aqua", facts: [] };
      const r = d.latestRun.get(t.id);
      const actions =
        t.status === "proposed" ? (
          <>
            <button className="btn sm primary" onClick={stop(() => d.acceptTicket(t.id))}>
              Accept
            </button>
            <button className="btn sm" onClick={stop(() => d.rejectTicket(t.id))}>
              Reject
            </button>
          </>
        ) : t.status === "todo" ? (
          <button className="btn sm primary" onClick={stop(() => d.startTicket(t.id))}>
            Start
          </button>
        ) : null;
      const facts = [t.repo];
      if (r) facts.push(`≈$${r.cost_usd.toFixed(2)}`);
      if (t.confidence) facts.push(`${t.confidence} confidence`);
      const chip = r && t.status !== "done" && t.status !== "cancelled" ? { cls: d.pendingRuns.has(r.id) ? "needs" : r.state, text: d.pendingRuns.has(r.id) ? "needs you" : stateLabel(r, d.queuePos) } : { cls: t.status, text: t.status.replace("_", " ") };
      return { title: `#${t.id} ${t.title}`, tint: t.status === "proposed" ? "peach" : "aqua", chip, facts, actions };
    }
    case "run": {
      const r = d.runs.get(id);
      if (!r) return { title: `run ${id}`, tint: "sky", facts: [] };
      const perm = [...d.pending.values()].find((p) => p.runId === id);
      const what = r.kind === "work" ? `#${r.ticket_id} ${d.tickets.get(r.ticket_id)?.title ?? ""}` : r.kind === "scout" ? `${r.scout} scout` : "ticket writer";
      const facts = [`run ${r.id}`, r.repo, `≈$${r.cost_usd.toFixed(2)}`];
      if (r.gates_ok !== null) facts.push(`checks ${r.gates_ok ? "passed" : "failed"}`);
      const actions = perm ? (
        <>
          <button className="btn sm ok allow-once" onClick={stop(() => d.answerPermission(id, perm.req.id, { behavior: "allow" }))} title={permText(perm.req)}>
            Allow once
          </button>
          {perm.req.canAlwaysAllow && (
            <button className="btn sm ok" onClick={stop(() => d.answerPermission(id, perm.req.id, { behavior: "allow", always: true }))}>
              Allow for run
            </button>
          )}
        </>
      ) : null;
      const chip = perm ? { cls: "needs", text: `asks: ${perm.req.tool}` } : { cls: r.state, text: stateLabel(r, d.queuePos) };
      return { title: what, tint: perm ? "rose" : "sky", chip, facts, actions };
    }
    case "decision": {
      const open = d.openDecisions.find((x) => x.id === id);
      const x = open ?? d.decided.find((y) => y.id === id);
      if (!x) return { title: `decision ${id}`, tint: "sky", facts: [] };
      const facts = [x.repo, x.area];
      if (open?.held) facts.push(`holds ${open.held}`);
      return { title: x.question || x.decision, tint: "sky", chip: { cls: open ? "needs" : "done", text: open ? "open" : x.status }, facts };
    }
    case "noticed": {
      const n = d.noticed.find((x) => x.id === id);
      if (!n) return { title: `noticed ${id}`, tint: "lilac", facts: [] };
      const facts = [n.repo];
      if (n.count > 1) facts.push(`×${n.count} reports`);
      return {
        title: n.title,
        tint: "lilac",
        chip: { cls: `kind-${n.kind}`, text: n.kind },
        facts,
        actions: (
          <button className="btn sm primary" onClick={stop(() => d.noticedTicket(n.id))} title="Create a ticket from this report (marked as worker-written)">
            Make ticket
          </button>
        ),
      };
    }
    case "lesson": {
      const l = d.lessons.find((x) => x.id === id);
      if (!l) return { title: `L${id}`, tint: "mint", facts: [] };
      const stale = l.status === "approved" && l.stale;
      const actions = stale ? (
        <button className="btn sm primary" onClick={stop(() => d.lessonAct(l.id, "confirm"))}>
          Still true
        </button>
      ) : l.status === "proposed" ? (
        <button className="btn sm primary" onClick={stop(() => d.lessonAct(l.id, "approve"))} title="Approved lessons go into later runs' instructions">
          Approve
        </button>
      ) : null;
      return { title: l.text, tint: "mint", chip: { cls: stale ? "needs" : l.status === "proposed" ? "proposed" : "done", text: stale ? "recheck" : l.status }, facts: [`L${l.id}`, l.repo], actions };
    }
    case "draft": {
      const x = d.drafts.find((y) => y.run_id === id);
      if (!x) return { title: `draft ${id}`, tint: "lemon", facts: [] };
      const busy = WRITER_BUSY.includes(x.run.state);
      const status = busy ? "writing" : x.run.state === "failed" ? "failed" : x.questions.length ? `${x.questions.length} question${x.questions.length > 1 ? "s" : ""}` : x.draft ? "ready" : "stopped";
      return {
        title: x.draft?.title ?? x.prompt,
        tint: "lemon",
        chip: { cls: busy ? x.run.state : x.questions.length ? "needs" : x.run.state === "failed" ? "failed" : "done", text: status },
        facts: [x.repo, `≈$${x.run.cost_usd.toFixed(2)}`],
      };
    }
    case "scout": {
      const rest = idOf(key);
      const i = rest.lastIndexOf(":");
      const repo = rest.slice(0, i);
      const type = rest.slice(i + 1);
      const last = [...d.runs.values()].filter((r) => r.kind === "scout" && r.scout === type && r.repo === repo).sort((a, b) => b.id - a.id)[0];
      const running = Boolean(last && LIVE_STATES.includes(last.state));
      const title = d.scoutTypes.find((s) => s.id === type)?.title ?? type;
      return {
        title: `${title} scout`,
        tint: "pearl",
        chip: last ? { cls: last.state, text: last.state.replace("_", " ") } : { cls: "queued", text: "never run" },
        facts: [repo, ...(last ? [`≈$${last.cost_usd.toFixed(2)}`] : [])],
        actions: (
          <button className="btn sm" disabled={running} onClick={stop(() => d.startScout(repo, type))}>
            {running ? "Running" : "Run"}
          </button>
        ),
      };
    }
    case "more": {
      const r = rs[ring - 1];
      return { title: `+${r?.more ?? 0} more`, tint: "pearl", facts: ["show the rest of this ring"] };
    }
    case "hidden": {
      const r = rs[ring - 1];
      return { title: `${r?.hidden ?? 0} done or cancelled`, tint: "pearl", facts: ["hidden · show them"] };
    }
    default:
      return { title: key, tint: "pearl", facts: [] };
  }
}

function permText(req: PermissionRequest): string {
  return req.tool === "Bash" ? String((req.input as any).command ?? "") : JSON.stringify(req.input);
}

function WebNode({ d, k, x, y, order, expanded, sel, rings: rs, ring, onClick }: { d: Dashboard; k: string; x: number; y: number; order: number; expanded: boolean; sel: boolean; rings: ReturnType<typeof rings>; ring: number; onClick: () => void }) {
  const v = nodeView(k, d, rs, ring);
  const kind = kindOf(k);
  const synthetic = kind === "more" || kind === "hidden";
  return (
    <div
      className={`web-node kind-${kind} tint-${v.tint} ${expanded ? "expanded" : ""} ${sel ? "sel" : ""} ${synthetic ? "synthetic" : ""}`}
      style={{ left: x, top: y, width: NODE_W, "--j": order } as React.CSSProperties}
      data-key={k}
      role="button"
      tabIndex={0}
      aria-pressed={sel}
      onClick={onClick}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="wn-title" title={v.title}>
        {v.title}
      </div>
      {(v.chip || v.facts.length > 0) && (
        <div className="wn-facts">
          {v.chip && <span className={`chip ${v.chip.cls}`}>{v.chip.text}</span>}
          {v.facts.slice(0, 3).map((f) => (
            <span key={f} className="wn-fact">
              {f}
            </span>
          ))}
        </div>
      )}
      {v.actions && (
        <div className="wn-actions" onClick={(e) => e.stopPropagation()}>
          {v.actions}
        </div>
      )}
    </div>
  );
}

export function crumbLabel(key: string, d: Dashboard): string {
  const id = idOf(key);
  switch (kindOf(key)) {
    case "petal":
      return petals(d).find((p) => p.id === id)?.label ?? id;
    case "ticket":
      return `#${id}`;
    case "run":
      return `run ${id}`;
    case "decision":
      return `decision ${id}`;
    case "noticed":
      return `noticed ${id}`;
    case "lesson":
      return `L${id}`;
    case "draft":
      return `draft ${id}`;
    case "scout":
      return `${id.slice(id.lastIndexOf(":") + 1)} scout`;
    default:
      return id;
  }
}

// ------------------------------------------------------------------- drawer

/** Two-step button for actions that can't be undone: the first click asks, the second does it. */
function Confirm({ label, ask, yes, onYes, className = "btn danger", children }: { label: string; ask: string; yes?: string; onYes: () => void; className?: string; children?: React.ReactNode }) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <button className={className} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  return (
    <div className="confirm" role="group" aria-label={ask}>
      <span>{ask}</span>
      {children}
      <button
        className="btn danger confirm-yes"
        onClick={() => {
          setAsking(false);
          onYes();
        }}
      >
        {yes ?? label}
      </button>
      <button className="btn" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </div>
  );
}

function Drawer({ d, k, onClose, onRunView }: { d: Dashboard; k: string; onClose: () => void; onRunView: () => void }) {
  const kind = kindOf(k);
  const id = idOf(k);
  const petal = kind === "petal" ? petals(d).find((p) => p.id === id) : null;
  const title = petal ? (petal.id === "lessons" ? lessonsTitle(d.lessons) : petal.label) : crumbLabel(k, d);
  const tint = petal?.tint ?? { ticket: "aqua", run: "sky", decision: "sky", noticed: "lilac", lesson: "mint", draft: "lemon" }[kind as string] ?? "pearl";
  /** Links and cards that open a run go to the full run view, even when that run is already selected. */
  const openRunsOnClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest("button, summary, input, textarea, select")) return;
    if (t.closest('a[href^="#run-"]') || t.closest(".card.has-run")) onRunView();
  };
  return (
    <aside className={`drawer tint-${tint} ${petal?.id === "lessons" ? "lessons" : ""}`} aria-label="Details" data-key={k} onClick={openRunsOnClick}>
      <header className="drawer-head">
        <span className="drawer-kind">{petal ? "petal" : kind}</span>
        <h2>{title}</h2>
        <button className="drawer-close" onClick={onClose} aria-label="Close the drawer" title="Close">
          ×
        </button>
      </header>
      <div className="drawer-body">
        <DrawerBody d={d} k={k} onRunView={onRunView} />
      </div>
    </aside>
  );
}

function DrawerBody({ d, k, onRunView }: { d: Dashboard; k: string; onRunView: () => void }) {
  const id = Number(idOf(k));
  switch (kindOf(k)) {
    case "petal":
      return <PetalBody d={d} id={idOf(k) as PetalId} />;
    case "ticket": {
      const t = d.tickets.get(id);
      if (!t) return null;
      const why = (t.source.startsWith("scout:") || t.source === "work-request") && (t.status === "proposed" || t.status === "todo");
      const runs = [...d.runs.values()].filter((r) => r.ticket_id === id).sort((a, b) => b.id - a.id);
      return (
        <>
          <TicketCard d={d} t={t} />
          <div className="facts">
            <span>{t.status.replace("_", " ")}</span>
            <span>from {t.source}</span>
            <span>{t.repo}</span>
          </div>
          {!why && t.body && (
            <details className="ticketbody" open>
              <summary>Ticket</summary>
              <Markdown text={t.body} />
            </details>
          )}
          {runs.length > 0 && (
            <>
              <h3>Runs</h3>
              <ul className="drawer-runs">
                {runs.map((r) => (
                  <li key={r.id}>
                    <a href={`#run-${r.id}`} onClick={() => d.setSelected(r.id)}>
                      run {r.id}
                    </a>{" "}
                    <span className={`chip ${r.state}`}>{stateLabel(r, d.queuePos)}</span> <span className="muted">≈${r.cost_usd.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      );
    }
    case "run":
      return <RunDrawer key={id} d={d} id={id} onRunView={onRunView} />;
    case "decision": {
      const open = d.openDecisions.find((x) => x.id === id);
      if (open) return <DecisionCard key={`${open.id}-${open.version}`} d={open} onDecide={d.decide} onWithdraw={d.withdrawDecision} />;
      const x = d.decided.find((y) => y.id === id);
      if (!x) return null;
      return (
        <div className="card decision-done">
          {x.question && <div className="muted">{x.question}</div>}
          <div>{x.decision}</div>
          <div className="muted">
            {x.repo} · {x.area} · {x.status}
          </div>
        </div>
      );
    }
    case "noticed": {
      const n = d.noticed.find((x) => x.id === id);
      return n ? <NoticedEntry d={d} n={n} full /> : null;
    }
    case "lesson": {
      const l = d.lessons.find((x) => x.id === id);
      return l ? <LessonEntry key={l.id} d={d} l={l} /> : null;
    }
    case "draft": {
      const x = d.drafts.find((y) => y.run_id === id);
      return x ? <DraftCard key={x.run_id} d={x} onAct={d.draftAct} onOpenRun={d.setSelected} /> : null;
    }
    case "scout": {
      const rest = idOf(k);
      const i = rest.lastIndexOf(":");
      const repo = rest.slice(0, i);
      const type = rest.slice(i + 1);
      const runs = [...d.runs.values()].filter((r) => r.kind === "scout" && r.scout === type && r.repo === repo).sort((a, b) => b.id - a.id);
      const filed = [...d.tickets.values()].filter((t) => t.repo === repo && t.source === `scout:${type}`);
      const running = Boolean(runs[0] && LIVE_STATES.includes(runs[0].state));
      return (
        <>
          <div className="facts">
            <span>{repo}</span>
            <span>
              {filed.length} ticket{filed.length === 1 ? "" : "s"} filed
            </span>
            <span>≈${runs.reduce((s, r) => s + r.cost_usd, 0).toFixed(2)} in all</span>
          </div>
          <div className="row">
            <button className="btn primary" disabled={running} onClick={() => d.startScout(repo, type)}>
              {running ? "Running" : "Run this scout"}
            </button>
          </div>
          {runs.length > 0 && (
            <>
              <h3>Runs</h3>
              <ul className="drawer-runs">
                {runs.map((r) => (
                  <li key={r.id}>
                    <a href={`#run-${r.id}`} onClick={() => d.setSelected(r.id)}>
                      run {r.id}
                    </a>{" "}
                    <span className={`chip ${r.state}`}>{r.state.replace("_", " ")}</span> <span className="muted">≈${r.cost_usd.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      );
    }
    default:
      return null;
  }
}

const QUIET = new Set(["agent.tool_result", "gate.start", "setup.start", "worker-check.start", "writer.ready"]);

/** A run in the drawer: header, facts, every action (destructive ones confirm), recent activity. */
function RunDrawer({ d, id, onRunView }: { d: Dashboard; id: number; onRunView: () => void }) {
  const run = d.runs.get(id);
  const [events, setEvents] = useState<RunEvent[] | null>(null);
  const [acceptContracts, setAcceptContracts] = useState(false);
  const perms = [...d.pending.values()].filter((p) => p.runId === id).map((p) => p.req);
  useEffect(() => {
    let live = true;
    api<{ events: RunEvent[] }>(`/api/runs/${id}`)
      .then((r) => live && setEvents(r.events))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, run?.state, run?.updated_at, perms.length]);
  const results = useMemo(() => {
    const m = new Map<string, any>();
    for (const e of events ?? []) if (e.kind === "agent.tool_result") m.set((e.data as any).tool_use_id, e.data);
    return m;
  }, [events]);
  if (!run) return null;
  const ticket = d.tickets.get(run.ticket_id);
  const s = run.state;
  const post = (path: string, body?: unknown) => d.act(() => api(`/api/runs/${id}/${path}`, "POST", body));
  const touchesContract = (events ?? []).some((e) => e.kind === "contract.changed" || e.kind === "contract.stale");
  const recent = (events ?? []).filter((e) => !QUIET.has(e.kind)).slice(-12);
  return (
    <>
      <div className="runhead drawer-runhead">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>{run.kind === "work" ? `#${run.ticket_id} ${ticket?.title ?? ""}` : run.kind === "scout" ? `${run.scout} scout on ${run.repo}` : "Ticket writer"}</h3>
          <span className={`chip ${s}`}>{stateLabel(run, d.queuePos)}</span>
        </div>
        <div className="facts">
          <span>run {run.id}</span>
          <span>{run.repo}</span>
          {run.model && <span>{run.model}</span>}
          <span>attempt {run.attempt}</span>
          <span>≈${run.cost_usd.toFixed(2)}</span>
          {run.gates_ok !== null && <span style={{ color: run.gates_ok ? "var(--ok)" : "var(--err)" }}>checks {run.gates_ok ? "passed" : "failed"}</span>}
          {run.bookmark && <span>bookmark {run.bookmark}</span>}
        </div>
        {run.error && <div className="detail err">{run.error}</div>}
      </div>
      {perms.map((p) => (
        <div className="perm drawer-perm" key={p.id}>
          <div>
            <b>Permission needed:</b> <code>{p.tool}</code>
            {p.blockedPath && <> (path outside workspace: <code>{p.blockedPath}</code>)</>}
            {p.reason && <div className="hint">Why: {p.reason}</div>}
          </div>
          <pre>{p.tool === "Bash" ? String((p.input as any).command ?? "") : JSON.stringify(p.input, null, 2)}</pre>
          <div className="row">
            <button className="btn ok" onClick={() => d.answerPermission(id, p.id, { behavior: "allow" })}>
              Allow once
            </button>
            {p.canAlwaysAllow && (
              <button className="btn ok" onClick={() => d.answerPermission(id, p.id, { behavior: "allow", always: true })}>
                Allow for this run
              </button>
            )}
            <DenyButton onDeny={(message) => d.answerPermission(id, p.id, { behavior: "deny", message })} />
          </div>
        </div>
      ))}
      <div className="row drawer-actions">
        <button className="btn primary open-full" onClick={() => (d.setSelected(id), onRunView())}>
          Open full view
        </button>
        {s === "running" && (
          <button className="btn" onClick={() => post("pause")}>
            Pause
          </button>
        )}
        {s === "paused" && (
          <button className="btn" onClick={() => post("resume")}>
            Resume
          </button>
        )}
        {s === "awaiting_review" && (
          <Confirm label="Approve & land" ask="Land this run's changes on trunk?" yes="Yes, land" className="btn ok act-approve" onYes={() => post("approve", { acceptContracts })}>
            {touchesContract && (
              <label className="row contract-accept">
                <input type="checkbox" checked={acceptContracts} onChange={(e) => setAcceptContracts(e.target.checked)} /> I've reviewed the contract change
              </label>
            )}
          </Confirm>
        )}
        {s === "queued" && <Confirm label="Remove from queue" ask="Remove this run from the queue?" yes="Remove" className="btn danger act-kill" onYes={() => post("kill")} />}
        {["preparing", "running", "paused", "verifying", "awaiting_review"].includes(s) && <Confirm label="Kill" ask="Kill this run? The workspace is kept until you discard it." yes="Kill" className="btn danger act-kill" onYes={() => post("kill")} />}
        {["paused", "awaiting_review", "failed", "cancelled"].includes(s) && run.workspace_path && (
          <Confirm label="Discard" ask="Discard this run's changes and delete its workspace?" yes="Discard" className="btn danger act-discard" onYes={() => post("discard")} />
        )}
      </div>
      <h3>Recent activity</h3>
      <div className="drawer-activity">
        {events === null && <div className="empty">Loading…</div>}
        {events && recent.length === 0 && <div className="empty">Nothing yet.</div>}
        {recent.map((e) => (
          <EventRow key={e.id} e={e} results={results} root={run.workspace_path} runId={run.id} />
        ))}
      </div>
    </>
  );
}

function DenyButton({ onDeny }: { onDeny: (message?: string) => void }) {
  const [msg, setMsg] = useState("");
  return (
    <Confirm label="Deny…" ask="Deny this request?" yes="Deny" className="btn danger act-deny" onYes={() => onDeny(msg.trim() || undefined)}>
      <input className="deny-why" placeholder="Tell the agent why (optional)" value={msg} onChange={(e) => setMsg(e.target.value)} aria-label="Why deny" />
    </Confirm>
  );
}
