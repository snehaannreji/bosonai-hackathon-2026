import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { WhiteboardPanel } from "./ui/WhiteboardPanel";
import { TabletWhiteboard } from "./ui/TabletWhiteboard";
import "./index.css";

// StrictMode is left ON deliberately. In development it mounts every component
// twice, which is exactly the condition that breaks a naive WebSocket connect
// (see Part 1 — "StrictMode opens two sockets"). Better to hit that on your
// own machine than to leave it lurking.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {window.location.pathname === "/tablet"
      ? <TabletWhiteboard />
      : window.location.pathname === "/vision-lab"
      ? <main className="app vision-lab"><p><a href="/">← Return to TeachBack</a></p><h1>Whiteboard vision lab</h1><p>Event-driven image analysis. No voice session is connected on this isolated page.</p><WhiteboardPanel lab /></main>
      : <App />}
  </StrictMode>,
);
