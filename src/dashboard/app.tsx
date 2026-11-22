import React from "react";
import { createRoot } from "react-dom/client";
import { ErrorToast, TokenPlaceholder } from "./components";
import { Layout } from "./rose/Layout";
import { useDashboard } from "./state";

/** Get the state, render the Rose layout. */
function App() {
  const d = useDashboard();
  return (
    <>
      {d.needsToken ? <TokenPlaceholder /> : <Layout d={d} />}
      <ErrorToast d={d} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
