import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerServiceWorker } from "./sw/register";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Best-effort SW registration; the app degrades to a "no inline preview"
// state if it fails (e.g. served over file://).
void registerServiceWorker();
