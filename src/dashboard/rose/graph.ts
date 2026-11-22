/**
 * The mind-map web behind the Rose: which items relate to which, and where each node sits.
 * Pure functions over client-side data, so the layout is deterministic (nodes never move under
 * the cursor) and testable without a browser. Web.tsx renders the result.
 *
 * A node key is "<kind>:<id>": petal:board, ticket:7, run:12, decision:3, noticed:4, lesson:5,
 * draft:9 (the writer run's id), scout:<repo>:<type>, and the synthetic more:<parent> ("+N more")
 * and hidden:<parent> ("N done or cancelled hidden").
 *
 * The web is one expanded path from a petal outwards: path[0] is the petal at the centre, ring k
 * holds path[k-1]'s related items, and path[k] is the one item expanded in ring k.
 */
import { isRunnerTicket } from "../../core/scouts";
import type { Decision, Lesson, Noticed, Run, Ticket } from "../../core/types";
import type { Draft, RankedDecision, ScoutTypeInfo } from "../state";

export type PetalId = "waiting" | "drafts" | "decisions" | "lessons" | "noticed" | "proposed" | "board" | "new";
export type NodeKind = "petal" | "ticket" | "run" | "decision" | "noticed" | "lesson" | "draft" | "scout" | "more" | "hidden";

/** What the web reads; Layout builds it from the dashboard state. */
export interface WebData {
  tickets: Map<number, Ticket>;
  runs: Map<number, Run>;
  drafts: Draft[];
  openDecisions: RankedDecision[];
  decided: Decision[];
  noticed: Noticed[];
  lessons: Lesson[];
  /** Runs with a pending permission or waiting for review (the "Runs waiting" petal). */
  waitingRuns: Run[];
  scoutTypes: ScoutTypeInfo[];
  repos: { name: string }[];
}

export const MAX_PER_RING = 8;
const ENDED = ["done", "cancelled"];

export const kindOf = (key: string) => key.slice(0, key.indexOf(":")) as NodeKind;
export const idOf = (key: string) => key.slice(key.indexOf(":") + 1);
const num = (key: string) => Number(idOf(key));

/** Done and cancelled tickets and runs, hidden unless the operator shows them. */
export function isEnded(key: string, data: WebData): boolean {
  const k = kindOf(key);
  if (k === "ticket") return ENDED.includes(data.tickets.get(num(key))?.status ?? "");
  if (k === "run") return ENDED.includes(data.runs.get(num(key))?.state ?? "");
  return false;
}

/** Whether the item behind a key still exists in the data. */
export function exists(key: string, data: WebData): boolean {
  const id = num(key);
  switch (kindOf(key)) {
    case "petal":
      return true;
    case "ticket":
      return data.tickets.has(id);
    case "run":
      return data.runs.has(id);
    case "decision":
      return data.openDecisions.some((x) => x.id === id) || data.decided.some((x) => x.id === id);
    case "noticed":
      return data.noticed.some((x) => x.id === id);
    case "lesson":
      return data.lessons.some((x) => x.id === id);
    case "draft":
      return data.drafts.some((x) => x.run_id === id);
    case "scout":
      return true;
    default:
      return false;
  }
}

const byIdDesc = <T extends { id: number }>(a: T, b: T) => b.id - a.id;
const uniq = <T,>(keys: T[]) => [...new Set(keys)];
const scoutKey = (repo: string, type: string) => `scout:${repo}:${type}`;
function splitScout(key: string): { repo: string; type: string } {
  const rest = idOf(key);
  const i = rest.lastIndexOf(":");
  return { repo: rest.slice(0, i), type: rest.slice(i + 1) };
}

/** Tickets a scout type filed in a repo (approximate: by source and repo). */
function filedBy(data: WebData, repo: string, type: string): Ticket[] {
  return [...data.tickets.values()].filter((t) => t.repo === repo && t.source === `scout:${type}`).sort(byIdDesc);
}

/** Every item related to `key`, most relevant first. Includes ended items; `children` filters them. */
export function related(key: string, data: WebData): string[] {
  const kind = kindOf(key);
  const tickets = [...data.tickets.values()].filter((t) => !isRunnerTicket(t));
  const runs = [...data.runs.values()];
  if (kind === "petal") {
    switch (idOf(key) as PetalId) {
      case "waiting":
        return data.waitingRuns.map((r) => `run:${r.id}`);
      case "drafts":
        return data.drafts.map((x) => `draft:${x.run_id}`);
      case "decisions":
        return data.openDecisions.map((x) => `decision:${x.id}`);
      case "lessons": {
        const stale = data.lessons.filter((l) => l.status === "approved" && l.stale);
        const proposed = data.lessons.filter((l) => l.status === "proposed");
        return [...stale, ...proposed].map((l) => `lesson:${l.id}`);
      }
      case "noticed":
        return data.noticed.map((n) => `noticed:${n.id}`);
      case "proposed":
        return tickets.filter((t) => t.status === "proposed").sort(byIdDesc).map((t) => `ticket:${t.id}`);
      case "board": {
        const order = ["review", "in_progress", "todo", "held", "done", "cancelled"];
        return tickets
          .filter((t) => order.includes(t.status))
          .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.id - a.id)
          .map((t) => `ticket:${t.id}`);
      }
      case "new":
        return data.repos.flatMap((r) => data.scoutTypes.map((s) => scoutKey(r.name, s.id)));
    }
  }
  const id = num(key);
  switch (kind) {
    case "ticket": {
      const t = data.tickets.get(id);
      if (!t) return [];
      const out = runs.filter((r) => r.ticket_id === id).sort(byIdDesc).map((r) => `run:${r.id}`);
      if (t.decision_id !== null) out.push(`decision:${t.decision_id}`);
      const n = data.noticed.find((x) => x.id === t.noticed_id || x.ticket_id === id);
      if (n) out.push(`noticed:${n.id}`);
      for (const x of data.drafts) if (x.saved?.ticket_id === id) out.push(`draft:${x.run_id}`);
      if (t.source.startsWith("scout:")) out.push(scoutKey(t.repo, t.source.slice("scout:".length)));
      return uniq(out);
    }
    case "run": {
      const r = data.runs.get(id);
      if (!r) return [];
      const out: string[] = [];
      if (r.kind === "work") out.push(`ticket:${r.ticket_id}`);
      if (r.kind === "writer") {
        if (data.drafts.some((x) => x.run_id === id)) out.push(`draft:${id}`);
      }
      if (r.kind === "scout" && r.scout) out.push(...filedBy(data, r.repo, r.scout).map((t) => `ticket:${t.id}`));
      for (const x of [...data.openDecisions, ...data.decided]) if (x.run_id === id) out.push(`decision:${x.id}`);
      for (const n of data.noticed) if (n.run_ids.split(",").includes(String(id))) out.push(`noticed:${n.id}`);
      for (const l of data.lessons) if (l.run_id === id) out.push(`lesson:${l.id}`);
      return uniq(out);
    }
    case "decision": {
      const open = data.openDecisions.find((x) => x.id === id);
      const x = open ?? data.decided.find((y) => y.id === id);
      const held = open?.held_tickets.map((t) => t.id) ?? [];
      const out = uniq([...held, ...tickets.filter((t) => t.decision_id === id).map((t) => t.id)]).map((t) => `ticket:${t}`);
      if (x?.run_id) out.push(`run:${x.run_id}`);
      return out;
    }
    case "noticed": {
      const n = data.noticed.find((x) => x.id === id);
      if (!n) return [];
      const out = n.run_ids.split(",").filter(Boolean).map((r) => `run:${r}`).filter((k) => data.runs.has(num(k)));
      for (const t of tickets) if (t.noticed_id === id || n.ticket_id === t.id) out.push(`ticket:${t.id}`);
      return uniq(out);
    }
    case "lesson": {
      const l = data.lessons.find((x) => x.id === id);
      return l?.run_id && data.runs.has(l.run_id) ? [`run:${l.run_id}`] : [];
    }
    case "draft": {
      const x = data.drafts.find((y) => y.run_id === id);
      if (!x) return [];
      const out = [`run:${id}`];
      if (x.saved) out.push(`ticket:${x.saved.ticket_id}`);
      return out.filter((k) => exists(k, data));
    }
    case "scout": {
      const { repo, type } = splitScout(key);
      const scoutRuns = runs.filter((r) => r.kind === "scout" && r.scout === type && r.repo === repo).sort(byIdDesc);
      return [...scoutRuns.map((r) => `run:${r.id}`), ...filedBy(data, repo, type).map((t) => `ticket:${t.id}`)];
    }
    default:
      return [];
  }
}

export type Ring = {
  parent: string;
  /** Nodes placed in this ring (may end in a more: or hidden: node). */
  keys: string[];
  /** Related items already placed further in, drawn as cross-links instead of repeated. */
  links: string[];
  /** How many items the "+N more" node stands for, and how many ended ones are hidden. */
  more: number;
  hidden: number;
};

export type WebOpts = { showEnded: boolean; /** Parents whose "+N more" was expanded. */ expanded: Set<string> };

/** The rings of the web for `path`: ring k holds path[k]'s related items. */
export function rings(path: string[], data: WebData, opts: WebOpts): Ring[] {
  const placed = new Set<string>([path[0]!]);
  const out: Ring[] = [];
  for (let k = 0; k < path.length; k++) {
    const parent = path[k]!;
    const next = path[k + 1];
    const all = related(parent, data);
    const links = all.filter((x) => placed.has(x) && x !== path[k - 1]);
    let fresh = all.filter((x) => !placed.has(x));
    const ended = opts.showEnded ? [] : fresh.filter((x) => isEnded(x, data) && x !== next);
    fresh = fresh.filter((x) => !ended.includes(x));
    let more = 0;
    if (!opts.expanded.has(parent) && fresh.length > MAX_PER_RING) {
      const room = MAX_PER_RING - 1;
      let shown = fresh.slice(0, room);
      // The expanded item always stays visible, even past the cut.
      if (next && fresh.includes(next) && !shown.includes(next)) shown = [...shown.slice(0, room - 1), next];
      more = fresh.length - shown.length;
      fresh = shown;
    }
    const keys = [...fresh];
    if (more) keys.push(`more:${parent}`);
    if (ended.length) keys.push(`hidden:${parent}`);
    for (const x of keys) placed.add(x);
    out.push({ parent, keys, links, more, hidden: ended.length });
    if (!next || !fresh.includes(next)) break;
  }
  return out;
}

/** Drop path entries that no longer exist or are no longer related to the one before. */
export function prunePath(path: string[], data: WebData): string[] {
  const out: string[] = [];
  for (const key of path) {
    if (!exists(key, data)) break;
    if (out.length && !related(out[out.length - 1]!, data).includes(key)) break;
    out.push(key);
  }
  return out;
}

// ------------------------------------------------------------------- layout

export const NODE_W = 210;
const ARC_STEP = 232; // distance between neighbouring nodes along a ring
const RING_GAP = 250;
const FIRST_RING = 260;

export type Placed = { key: string; x: number; y: number; ring: number; parent: string };
export type Edge = { from: string; to: string; link?: boolean };
export type WebLayout = { nodes: Placed[]; edges: Edge[]; box: { x0: number; y0: number; x1: number; y1: number } };

/**
 * Concentric rings around the petal at (0, 0). Ring 1 goes all the way round; each later ring is
 * a fan centred on the angle of the node it expands, as wide as its nodes need.
 */
export function layout(rs: Ring[]): WebLayout {
  const root = rs[0]?.parent ?? "";
  const pos = new Map<string, Placed>([[root, { key: root, x: 0, y: 0, ring: 0, parent: "" }]]);
  const angle = new Map<string, number>([[root, -Math.PI / 2]]);
  const nodes: Placed[] = [pos.get(root)!];
  const edges: Edge[] = [];
  let radius = 0;
  rs.forEach((ring, i) => {
    const n = ring.keys.length;
    if (!n) return;
    if (i === 0) {
      radius = Math.max(FIRST_RING, (n * ARC_STEP) / (2 * Math.PI));
      ring.keys.forEach((key, j) => angle.set(key, -Math.PI / 2 + (j * 2 * Math.PI) / n));
    } else {
      radius = Math.max(radius + RING_GAP, ((n + 1) * ARC_STEP) / (2 * Math.PI));
      const step = ARC_STEP / radius;
      const centre = angle.get(ring.parent) ?? -Math.PI / 2;
      ring.keys.forEach((key, j) => angle.set(key, centre + (j - (n - 1) / 2) * step));
    }
    for (const key of ring.keys) {
      const a = angle.get(key)!;
      const p = { key, x: Math.round(Math.cos(a) * radius), y: Math.round(Math.sin(a) * radius), ring: i + 1, parent: ring.parent };
      pos.set(key, p);
      nodes.push(p);
      edges.push({ from: ring.parent, to: key });
    }
    for (const key of ring.links) if (pos.has(key)) edges.push({ from: ring.parent, to: key, link: true });
  });
  const pad = { x: NODE_W / 2 + 20, y: 80 };
  const box = {
    x0: Math.min(...nodes.map((p) => p.x)) - pad.x,
    y0: Math.min(...nodes.map((p) => p.y)) - pad.y,
    x1: Math.max(...nodes.map((p) => p.x)) + pad.x,
    y1: Math.max(...nodes.map((p) => p.y)) + pad.y,
  };
  return { nodes, edges, box };
}
