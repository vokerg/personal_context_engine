import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";
import { applyThemePreference, readThemePreference } from "./theme.js";

// Apply the stored choice before React mounts to avoid a wrong-theme flash.
applyThemePreference(readThemePreference());

const root = document.getElementById("root");
if (!root) throw new Error("Missing application mount node");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
