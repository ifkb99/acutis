import React from "react";
import { createRoot } from "react-dom/client";
import { ErrorToast, TokenPlaceholder } from "./components";
import { useDashboard } from "./state";
import { SampleSwitcher, useSample } from "./switcher";

/** Get the state, pick the current sample, render its layout. */
function App() {
  const d = useDashboard();
  const [sample, setSample] = useSample();
  const { Layout } = sample;
  return (
    <>
      {d.needsToken ? <TokenPlaceholder /> : <Layout d={d} />}
      <ErrorToast d={d} />
      <SampleSwitcher current={sample.id} onChange={setSample} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
