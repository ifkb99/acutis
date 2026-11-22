/**
 * TEMPORARY scaffolding for comparing the dashboard samples (ticket #15). Once the operator picks
 * one, delete the others' directories and their lines here, then this file and its use in app.tsx.
 *
 * To remove a sample: delete `samples/<name>/` and its import and entry in SAMPLES below.
 */
import React, { useLayoutEffect, useState } from "react";
import type { Dashboard } from "./state";
import { Layout as Cathedral } from "./samples/cathedral/Layout";
import { Layout as Manuscript } from "./samples/manuscript/Layout";
import { Layout as Rose } from "./samples/rose/Layout";

export type Sample = { id: string; label: string; Layout: (p: { d: Dashboard }) => React.ReactNode };

/** The one registry of samples. The first is the default. */
export const SAMPLES: Sample[] = [
  { id: "cathedral", label: "Cathedral", Layout: Cathedral },
  { id: "manuscript", label: "Manuscript", Layout: Manuscript },
  { id: "rose", label: "Rose window", Layout: Rose },
];

// Kept in localStorage like the token (api.ts), so the choice survives a reload.
const SAMPLE_KEY = "acutis-sample";

/** `?sample=<id>` in the URL picks a sample too (handy for side-by-side links and screenshots). */
function storedSample(): string | null {
  try {
    const fromUrl = new URLSearchParams(location.search).get("sample");
    if (fromUrl) localStorage.setItem(SAMPLE_KEY, fromUrl);
    return localStorage.getItem(SAMPLE_KEY);
  } catch {
    return null;
  }
}

/** The current sample, applied as `<html data-sample="…">` so its scoped stylesheet takes effect. */
export function useSample(): [Sample, (id: string) => void] {
  const [id, setId] = useState(() => storedSample() ?? "");
  const sample = SAMPLES.find((s) => s.id === id) ?? SAMPLES[0]!;
  useLayoutEffect(() => {
    document.documentElement.dataset.sample = sample.id;
  }, [sample.id]);
  const choose = (next: string) => {
    try {
      localStorage.setItem(SAMPLE_KEY, next);
    } catch {}
    setId(next);
  };
  return [sample, choose];
}

export function SampleSwitcher({ current, onChange }: { current: string; onChange: (id: string) => void }) {
  if (SAMPLES.length < 2) return null;
  return (
    <label className="sample-switcher" title="Temporary: compare dashboard designs">
      <span>Design</span>
      <select value={current} onChange={(e) => onChange(e.target.value)}>
        {SAMPLES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}
