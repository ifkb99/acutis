/**
 * Rose window: a hub, a web and a focus view. The hub is a rose of eight petals around a centre
 * that counts what needs you; each petal is one kind of work (runs waiting, drafts, decisions, …).
 * Clicking a petal grows it into a mind-map web of its items (Web.tsx), with a drawer for the
 * selected item's full info. Opening a run switches to a focused, full-width run view; Back returns
 * to the web. In every view the left sidebar (NeedsYou.tsx) lists what needs the operator and
 * answers most of it in one click; on phones it sits behind a toggle.
 */
import React, { useEffect, useRef, useState } from "react";
import { Badges, SelectedRun } from "../components";
import type { Dashboard } from "../state";
import { needsCount, NeedsYou } from "./NeedsYou";
import { petals } from "./petals";
import "./styles.css";
import { Web } from "./Web";
import type { PetalId } from "./graph";

/** The tracery behind the petals: rings and spokes. */
function Tracery() {
  return (
    <svg className="tracery" viewBox="-100 -100 200 200" aria-hidden="true">
      <circle r="98" />
      <circle r="94" />
      <circle r="42" />
      {Array.from({ length: 8 }, (_, i) => (
        <line key={i} x1="0" y1="-42" x2="0" y2="-94" transform={`rotate(${i * 45 + 22.5})`} />
      ))}
      {Array.from({ length: 8 }, (_, i) => (
        <circle key={`c${i}`} cx="0" cy="-84" r="8" transform={`rotate(${i * 45 + 22.5})`} />
      ))}
    </svg>
  );
}

export function Layout({ d }: { d: Dashboard }) {
  const [mode, setMode] = useState<"hub" | "run">(() => (d.selected ? "run" : "hub"));
  // The web's expanded path: [] is the rose itself, path[0] the open petal.
  const [path, setPath] = useState<string[]>([]);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const openRun = (id: number) => {
    d.setSelected(id);
    setMode("run");
    setNavOpen(false);
  };
  /** Grow a petal into its web, with its full list in the drawer. */
  const goPetal = (id: PetalId) => {
    setPath([`petal:${id}`]);
    setDrawer(`petal:${id}`);
    setMode("hub");
    setNavOpen(false);
  };
  const count = needsCount(d);
  return (
    <div className={`rose-shell ${navOpen ? "nav-open" : ""}`}>
      <NeedsYou d={d} open={navOpen} onOpenRun={openRun} onPetal={goPetal} />
      <button className="needs-toggle" aria-expanded={navOpen} onClick={() => setNavOpen((x) => !x)}>
        {navOpen ? "Close" : <>Needs you{count > 0 && <b> {count}</b>}</>}
      </button>
      <div className="rose-content">
        <Rose d={d} mode={mode} setMode={setMode} path={path} setPath={setPath} drawer={drawer} setDrawer={setDrawer} goPetal={goPetal} />
      </div>
    </div>
  );
}

function Rose({
  d,
  mode,
  setMode,
  path,
  setPath,
  drawer,
  setDrawer,
  goPetal,
}: {
  d: Dashboard;
  mode: "hub" | "run";
  setMode: (m: "hub" | "run") => void;
  path: string[];
  setPath: (p: string[]) => void;
  drawer: string | null;
  setDrawer: (k: string | null) => void;
  goPetal: (id: PetalId) => void;
}) {
  const ps = petals(d);
  // Opening a run from anywhere (Start, Save & start, a scout) switches to the focused run view.
  const first = useRef(d.selected);
  useEffect(() => {
    if (d.selected && d.selected !== first.current) setMode("run");
    first.current = null;
  }, [d.selected]);
  const total = d.attention.total;
  const toHub = () => {
    setPath([]);
    setDrawer(null);
  };

  if (mode === "run") {
    return (
      <div className="rose rose-focus">
        <header className="focus-bar">
          <button className="back" onClick={() => setMode("hub")} title={path.length ? "Back to the web" : "Back to the rose"}>
            <span className="rosette" aria-hidden="true">
              {total || "✿"}
            </span>
            {path.length ? "Back" : "Rose"}
          </button>
          <nav className="petal-chips" aria-label="Needs you">
            {ps
              .filter((p) => p.urgent)
              .map((p) => (
                <button key={p.id} className={`petal-chip tint-${p.tint}`} onClick={() => goPetal(p.id)}>
                  {p.label} <b>{p.count}</b>
                </button>
              ))}
          </nav>
          <Badges d={d} />
        </header>
        <main className="focus-run">
          <SelectedRun d={d} empty={<p>No run is open. Go back to the rose and pick one from the Board.</p>} />
        </main>
      </div>
    );
  }

  if (path.length) {
    return <Web d={d} path={path} setPath={setPath} drawer={drawer} setDrawer={setDrawer} onRunView={() => setMode("run")} onHub={toHub} />;
  }

  return (
    <div className="rose rose-hub">
      <section className="wheel-wrap" aria-label="What needs you">
        <div className="wheel">
          <Tracery />
          {ps.map((p, i) => (
            <button
              key={p.id}
              className={`petal tint-${p.tint} ${p.urgent ? "urgent" : ""}`}
              style={{ "--i": i } as React.CSSProperties}
              onClick={() => goPetal(p.id)}
              title={`Open ${p.label} as a web`}
            >
              <span className="petal-count">{p.id === "new" ? "+" : p.count}</span>
              <span className="petal-label">{p.label}</span>
              <span className="petal-hint">{p.hint}</span>
            </button>
          ))}
          <div className="hub">
            <span className="hub-name">Acutis</span>
            <span className="hub-total">{total}</span>
            <span className="hub-label">{total ? (total === 1 ? "thing needs you" : "things need you") : "all calm"}</span>
          </div>
        </div>
        <Badges d={d} />
        {d.run && (
          <button className="btn resume" onClick={() => setMode("run")}>
            Back to run #{d.run.ticket_id}
          </button>
        )}
      </section>
    </div>
  );
}
