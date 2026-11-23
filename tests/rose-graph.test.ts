import { describe, expect, test } from "bun:test";
import type { Decision, Lesson, Noticed, Run, Ticket } from "../src/core/types";
import { isEnded, layout, MAX_PER_RING, prunePath, related, rings, type WebData } from "../src/dashboard/rose/graph";
import type { Draft, RankedDecision } from "../src/dashboard/state";

const ts = "2026-01-01T00:00:00Z";
const ticket = (id: number, o: Partial<Ticket> = {}): Ticket => ({
  id, repo: "r", title: `T${id}`, body: "", status: "todo", source: "local", confidence: null, decision_id: null, noticed_id: null, builds_on: null, origin_run_id: null, external_id: null, created_at: ts, updated_at: ts, ...o,
});
const run = (id: number, ticket_id: number, o: Partial<Run> = {}): Run => ({
  id, ticket_id, repo: "r", kind: "work", scout: null, woken_by: null, state: "running", workspace_name: null, workspace_path: null, base_commit: null, trunk_commit: null, landed_commit: null,
  session_id: null, model: null, attempt: 1, gates_ok: null, cost_usd: 0, session_cost: null, error: null, bookmark: null, created_at: ts, updated_at: ts, ...o,
});
const decision = (id: number, o: Partial<Decision> = {}): Decision => ({
  id, repo: "r", area: "tests", question: `Q${id}`, context: "", options: "", status: "open", decision: "", asked_by: "tests", run_id: null, version: 1, superseded_by: null, created_at: ts, updated_at: ts, decided_at: null, ...o,
});
const lesson = (id: number, o: Partial<Lesson> = {}): Lesson => ({
  id, repo: "r", text: `L${id}`, text_key: `l${id}`, evidence: "", tags: "", status: "proposed", source: "worker", run_id: null, uses: 0, paths: null, seen_commit: null, stale: null, created_at: ts, updated_at: ts, decided_at: null, ...o,
});
const noticed = (id: number, o: Partial<Noticed> = {}): Noticed => ({
  id, repo: "r", kind: "bug", title: `N${id}`, detail: "", evidence: "", status: "open", count: 1, run_ids: "", ticket_id: null, created_at: ts, updated_at: ts, ...o,
});

function data(o: Partial<WebData> & { ticketList?: Ticket[]; runList?: Run[] } = {}): WebData {
  const { ticketList = [], runList = [], ...rest } = o;
  return {
    tickets: new Map(ticketList.map((t) => [t.id, t])),
    runs: new Map(runList.map((r) => [r.id, r])),
    drafts: [],
    openDecisions: [],
    decided: [],
    noticed: [],
    lessons: [],
    waitingRuns: [],
    scoutTypes: [],
    repos: [{ name: "r" }],
    ...rest,
  };
}
const opts = (o: { showEnded?: boolean; expanded?: string[] } = {}) => ({ showEnded: o.showEnded ?? false, expanded: new Set(o.expanded ?? []) });

describe("relations", () => {
  test("ticket ↔ runs, decision ↔ held tickets, noticed ↔ runs and its ticket", () => {
    const d0 = decision(3);
    const held = ticket(2, { status: "held", decision_id: 3 });
    const fromNoticed = ticket(4, { noticed_id: 9 });
    const D = data({
      ticketList: [ticket(1), held, fromNoticed],
      runList: [run(10, 1), run(11, 1, { state: "failed" }), run(12, 4)],
      openDecisions: [{ ...d0, held: 1, held_tickets: [held] } as RankedDecision],
      noticed: [noticed(9, { run_ids: "10,12" })],
    });
    expect(related("ticket:1", D)).toEqual(["run:11", "run:10"]);
    expect(related("run:10", D)).toEqual(["ticket:1", "noticed:9"]);
    expect(related("decision:3", D)).toEqual(["ticket:2"]);
    expect(related("ticket:2", D)).toEqual(["decision:3"]);
    expect(related("noticed:9", D)).toEqual(["run:10", "run:12", "ticket:4"]);
    expect(related("ticket:4", D)).toEqual(["run:12", "noticed:9"]);
  });

  test("lesson ↔ source run, draft ↔ writer run ↔ saved ticket, scout run ↔ the scout type's filed tickets", () => {
    const writer = run(20, 99, { kind: "writer" });
    const draft = { run_id: 20, repo: "r", prompt: "p", draft: null, questions: [], rounds: 0, saved: { ticket_id: 5 }, run: writer } as Draft;
    const D = data({
      ticketList: [ticket(5, { source: "writer" }), ticket(6, { source: "scout:tests", status: "proposed" }), ticket(7, { source: "scout:tests", repo: "other" }), ticket(99, { source: "writer-run" })],
      runList: [writer, run(30, 98, { kind: "scout", scout: "tests" }), run(31, 5)],
      lessons: [lesson(1, { run_id: 31 })],
      drafts: [draft],
      scoutTypes: [{ id: "tests", title: "Tests" }],
    });
    expect(related("lesson:1", D)).toEqual(["run:31"]);
    expect(related("run:31", D)).toEqual(["ticket:5", "lesson:1"]);
    expect(related("draft:20", D)).toEqual(["run:20", "ticket:5"]);
    expect(related("run:20", D)).toEqual(["draft:20"]);
    expect(related("ticket:5", D)).toEqual(["run:31", "draft:20"]);
    // Only the same repo's tickets from that scout type.
    expect(related("run:30", D)).toEqual(["ticket:6"]);
    expect(related("ticket:6", D)).toEqual(["scout:r:tests"]);
    expect(related("scout:r:tests", D)).toEqual(["run:30", "ticket:6"]);
    expect(related("petal:new", D)).toEqual(["scout:r:tests"]);
  });

  test("petals list their items; the board leaves out runner tickets and puts review first", () => {
    const D = data({
      ticketList: [ticket(1, { status: "todo" }), ticket(2, { status: "review" }), ticket(3, { status: "proposed" }), ticket(4, { source: "scout-run:tests" }), ticket(5, { status: "done" })],
      lessons: [lesson(1), lesson(2, { status: "approved", stale: "{}" }), lesson(3, { status: "approved" })],
    });
    expect(related("petal:board", D)).toEqual(["ticket:2", "ticket:1", "ticket:5"]);
    expect(related("petal:proposed", D)).toEqual(["ticket:3"]);
    expect(related("petal:lessons", D)).toEqual(["lesson:2", "lesson:1"]);
  });
});

describe("rings", () => {
  test("each ring holds the expanded node's related items, never repeating one already placed", () => {
    const D = data({ ticketList: [ticket(1), ticket(2)], runList: [run(10, 1)], lessons: [lesson(1, { run_id: 10 })] });
    const rs = rings(["petal:board", "ticket:1", "run:10"], D, opts());
    expect(rs.map((r) => [r.parent, r.keys])).toEqual([
      ["petal:board", ["ticket:2", "ticket:1"]],
      ["ticket:1", ["run:10"]],
      ["run:10", ["lesson:1"]],
    ]);
  });

  test("done and cancelled tickets and runs are hidden behind one node unless shown", () => {
    const D = data({ ticketList: [ticket(1), ticket(2, { status: "done" }), ticket(3, { status: "cancelled" })] });
    expect(isEnded("ticket:2", D)).toBe(true);
    const hidden = rings(["petal:board"], D, opts())[0]!;
    expect(hidden.keys).toEqual(["ticket:1", "hidden:petal:board"]);
    expect(hidden.hidden).toBe(2);
    expect(rings(["petal:board"], D, opts({ showEnded: true }))[0]!.keys).toEqual(["ticket:1", "ticket:2", "ticket:3"]);
    // An ended item on the expanded path stays.
    expect(rings(["petal:board", "ticket:2"], D, opts())[0]!.keys).toEqual(["ticket:1", "ticket:2", "hidden:petal:board"]);
  });

  test(`at most ${MAX_PER_RING} nodes a ring, then "+N more" (which keeps the expanded item visible) until expanded`, () => {
    const many = Array.from({ length: 12 }, (_, i) => ticket(i + 1));
    const D = data({ ticketList: many });
    const r = rings(["petal:board"], D, opts())[0]!;
    expect(r.keys.length).toBe(MAX_PER_RING);
    expect(r.keys.at(-1)).toBe("more:petal:board");
    expect(r.more).toBe(12 - (MAX_PER_RING - 1));
    const withPath = rings(["petal:board", "ticket:1"], D, opts())[0]!;
    expect(withPath.keys).toContain("ticket:1");
    expect(withPath.keys.length).toBe(MAX_PER_RING);
    expect(rings(["petal:board"], D, opts({ expanded: ["petal:board"] }))[0]!.keys.length).toBe(12);
  });

  test("a path entry that went away is pruned", () => {
    const D = data({ ticketList: [ticket(1)], runList: [run(10, 1)] });
    expect(prunePath(["petal:board", "ticket:1", "run:10"], D)).toEqual(["petal:board", "ticket:1", "run:10"]);
    expect(prunePath(["petal:board", "ticket:1", "run:11"], D)).toEqual(["petal:board", "ticket:1"]);
    expect(rings(["petal:proposed", "ticket:1"], D, opts()).map((r) => r.parent)).toEqual(["petal:proposed"]);
  });
});

describe("layout", () => {
  test("deterministic rings: ring 1 all round the petal, later rings fanned out past the node they expand", () => {
    // The board lists newest first, so #4 is the first node (on top) and #1 the last.
    const D = data({ ticketList: [ticket(4), ticket(3), ticket(2), ticket(1)], runList: [run(10, 4), run(11, 4)] });
    const rs = rings(["petal:board", "ticket:4"], D, opts({ showEnded: true }));
    const a = layout(rs);
    expect(layout(rings(["petal:board", "ticket:4"], D, opts({ showEnded: true })))).toEqual(a);
    const at = (k: string) => a.nodes.find((n) => n.key === k)!;
    expect(at("petal:board")).toMatchObject({ x: 0, y: 0, ring: 0 });
    const r1 = Math.hypot(at("ticket:4").x, at("ticket:4").y);
    for (const k of ["ticket:1", "ticket:2", "ticket:3"]) expect(Math.abs(Math.hypot(at(k).x, at(k).y) - r1)).toBeLessThan(2);
    // #4 is on top; its runs sit further out, around the same direction.
    expect(at("ticket:4").x).toBe(0);
    expect(at("ticket:4").y).toBeLessThan(0);
    for (const k of ["run:10", "run:11"]) {
      expect(Math.hypot(at(k).x, at(k).y)).toBeGreaterThan(r1 + 200);
      expect(at(k).y).toBeLessThan(at("ticket:4").y);
      expect(at(k).parent).toBe("ticket:4");
    }
    expect(a.edges).toContainEqual({ from: "ticket:4", to: "run:10" });
    expect(a.box.x0).toBeLessThan(a.box.x1);
  });

  test("nodes in a ring don't overlap, however many there are", () => {
    const D = data({ ticketList: Array.from({ length: 30 }, (_, i) => ticket(i + 1)) });
    const a = layout(rings(["petal:board"], D, opts({ expanded: ["petal:board"] })));
    const ring = a.nodes.filter((n) => n.ring === 1);
    expect(ring.length).toBe(30);
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(220);
    }
  });

  test("cross-links: an item related to the expanded node but already placed gets a link edge, not a copy", () => {
    const D = data({ ticketList: [ticket(4, { noticed_id: 9 })], runList: [run(10, 99), run(12, 4)], noticed: [noticed(9, { run_ids: "10,12" })] });
    // Board → #4 (ring 2: run 12, noticed 9) → noticed 9, whose related items are run 10 (new),
    // run 12 (already beside it in ring 2) and #4 (its parent).
    const rs = rings(["petal:board", "ticket:4", "noticed:9"], D, opts());
    expect(rs[1]!.keys).toEqual(["run:12", "noticed:9"]);
    expect(rs.at(-1)).toMatchObject({ parent: "noticed:9", keys: ["run:10"], links: ["run:12"] });
    const a = layout(rs);
    expect(a.edges.filter((e) => e.link)).toEqual([{ from: "noticed:9", to: "run:12", link: true }]);
    expect(a.nodes.filter((n) => n.key === "run:12").length).toBe(1);
  });
});
