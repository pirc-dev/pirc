import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./fonts.ts";
import { App } from "./App.tsx";
import "./index.css";
import { applyLook } from "./look.ts";
import "./update.ts";

applyLook();
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

// Installable as an app, and its notifications (docs/web.md, section 6).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
