import { useEffect, useRef, useState, type PointerEvent } from "react";
import { BOARD_HEIGHT, BOARD_WIDTH, boardPoint, experimentBoard, markAt, moveMark, renderBoard, type DrawTool, type Mark, type Point } from "../whiteboard/board";
import { captureWhiteboard, type BoardCapture } from "../whiteboard/capture";
import { boardSnapshotter } from "../whiteboard/snapshot";
import { WhiteboardVisionPipeline, type VisionDebug } from "../whiteboard/visionPipeline";
import type { ContextReceipt, VisualContext } from "../whiteboard/observations";

const tools: (DrawTool | "move")[] = ["pen", "arrow", "line", "rectangle", "circle", "text", "move", "eraser"];
export function WhiteboardPanel({ lab = false, experiment = false, sessionKey = "", deliverObservation }: { lab?: boolean; experiment?: boolean; sessionKey?: string; deliverObservation?: (context: VisualContext) => Promise<ContextReceipt> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const capture = useRef<BoardCapture | null>(null);
  const marks = useRef<Mark[]>([]);
  const draft = useRef<Mark | null>(null);
  const moving = useRef<{ index: number; origin: Point; original: Mark } | null>(null);
  const pointer = useRef<number | null>(null);
  const mounted = useRef(false);
  const [tool, setTool] = useState<DrawTool | "move">("pen");
  const [color, setColor] = useState("#dc2626");
  const [text, setText] = useState("");
  const [size, setSize] = useState(4);
  const [count, setCount] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [previewFrames, setPreviewFrames] = useState(0);
  const [sharing, setSharing] = useState<"idle" | "checking" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const pipeline = useRef<WhiteboardVisionPipeline | null>(null);
  const revisionClock = useRef(0);
  const [vision, setVision] = useState<{ configured: boolean; model: string; reason?: string } | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [debug, setDebug] = useState<VisionDebug | null>(null);
  const [localCaptureMs, setLocalCaptureMs] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());
  const paint = (change?: "intermediate" | "complete" | "clear") => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    renderBoard(ctx, [...marks.current, ...(draft.current ? [draft.current] : [])]);
    capture.current?.changed();
    if (change) {
      if (pipeline.current) pipeline.current.change(change);
      else revisionClock.current++;
    }
  };
  const stopCapture = () => {
    capture.current?.stop(); capture.current = null;
    if (preview.current) preview.current.srcObject = null;
    setCapturing(false); setPreviewFrames(0);
  };
  useEffect(() => {
    mounted.current = true; setCapturing(false); setPreviewFrames(0);
    if (preview.current) preview.current.srcObject = null;
    paint();
    return () => { mounted.current = false; request.current?.abort(); capture.current?.stop(); capture.current = null; };
  }, []);
  const refreshVision = async () => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const response = await fetch("/api/vision/status", { signal: controller.signal });
    if (!response.ok) throw new Error("Could not reach the whiteboard vision service.");
    const status = await response.json();
    if (!controller.signal.aborted && mounted.current) setVision(status);
    return status;
  };
  useEffect(() => { void refreshVision().catch(() => {}); }, []);
  useEffect(() => {
    // This timer updates only the debug age label. It NEVER captures images.
    const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!enabled || !vision?.configured || !canvas.current || (!deliverObservation && !lab)) return;
    const instance = new WhiteboardVisionPipeline({
      initialRevision: revisionClock.current,
      capture: boardSnapshotter(canvas.current),
      analyze: async (frame, previous, signal) => {
        const response = await fetch("/api/vision/analyze", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: frame.revision, image: frame.image, previous }), signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? `Vision analysis failed (${response.status}).`);
        return result;
      },
      deliver: deliverObservation,
      onState: state => {
        revisionClock.current = Math.max(revisionClock.current, state.revision);
        if (mounted.current) setDebug(state);
        if (state.status === "current") console.debug("TeachBack whiteboard latency", { revision: state.revision, captureMs: state.captureMs, roundTripMs: state.requestMs, providerMs: state.analysisMs, contextAckMs: state.contextMs, totalMs: state.totalMs });
      },
    });
    pipeline.current = instance; instance.change("complete");
    return () => { instance.stop(); if (pipeline.current === instance) pipeline.current = null; };
  }, [enabled, vision?.configured, deliverObservation, sessionKey, lab]);
  useEffect(() => {
    const element = preview.current;
    if (!capturing || !element || typeof element.requestVideoFrameCallback !== "function") return;
    let callback = 0, alive = true;
    const frame = () => {
      if (!alive) return;
      setPreviewFrames(n => n + 1);
      callback = element.requestVideoFrameCallback(frame);
    };
    callback = element.requestVideoFrameCallback(frame);
    return () => { alive = false; element.cancelVideoFrameCallback(callback); };
  }, [capturing]);

  const point = (event: PointerEvent<HTMLCanvasElement>) => boardPoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect());
  const down = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    if (tool === "move") {
      const origin = point(event), index = markAt(marks.current, origin);
      if (index < 0) return;
      moving.current = { index, origin, original: marks.current[index] };
      pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); return;
    }
    if (marks.current.length >= 300) return;
    if (tool === "text" && !text.trim()) { setError("Type text or an equation, then click the board to place it."); return; }
    setError(null); pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId);
    draft.current = { tool, color, width: size, points: [point(event)], ...(tool === "text" ? { text: text.slice(0, 500) } : {}) }; paint("intermediate");
  };
  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    if (moving.current && event.pointerId === pointer.current) {
      const next = point(event), { index, origin, original } = moving.current;
      marks.current[index] = moveMark(original, next.x - origin.x, next.y - origin.y); paint("intermediate"); return;
    }
    if (!draft.current || event.pointerId !== pointer.current) return;
    const next = point(event);
    const last = draft.current.points.at(-1);
    if (last && Math.hypot(next.x - last.x, next.y - last.y) < 0.8) return;
    if (draft.current.tool === "pen" || draft.current.tool === "eraser") {
      if (draft.current.points.length < 2000) draft.current.points.push(next);
    } else draft.current.points = [draft.current.points[0], next];
    paint("intermediate");
  };
  const finish = (event: PointerEvent<HTMLCanvasElement>, cancel = false) => {
    if (event.pointerId !== pointer.current) return;
    if (moving.current) { if (cancel) marks.current[moving.current.index] = moving.current.original; moving.current = null; }
    if (draft.current && !cancel) marks.current.push(draft.current);
    draft.current = null; pointer.current = null; setCount(marks.current.length); paint("complete");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const replace = (next: Mark[]) => { marks.current = next; draft.current = null; moving.current = null; pointer.current = null; setCount(next.length); paint(next.length ? "complete" : "clear"); };
  const startCapture = async () => {
    if (!canvas.current || capture.current) return;
    setError(null);
    try {
      const next = captureWhiteboard(canvas.current); capture.current = next;
      if (preview.current) {
        preview.current.srcObject = next.stream;
        // Redraw AFTER creating capture: a zero-FPS canvas needs a fresh paint
        // to produce its initial frame before video.play() can resolve.
        paint();
        await preview.current.play();
      }
      if (!mounted.current || capture.current !== next) { next.stop(); return; }
      setCapturing(true); paint();
    } catch (error) { stopCapture(); setError(error instanceof Error ? error.message : "Local capture failed."); }
  };
  const startSharing = async () => {
    setSharing("checking"); setError(null);
    try {
      const status = await refreshVision();
      if (!status.configured) throw new Error(status.reason ?? "Configure the Vertex AI project and Application Default Credentials.");
      if (!deliverObservation && !lab) throw new Error("Start a live voice/avatar lesson first. Vision will then update it automatically.");
      setEnabled(true); setSharing("idle");
    } catch (error) {
      if (!mounted.current) return;
      setSharing("error"); setError(error instanceof Error ? error.message : "Whiteboard vision could not start.");
    }
  };
  const running = enabled && vision?.configured && (Boolean(deliverObservation) || lab);
  const ms = (value: number | null | undefined) => value == null ? "—" : `${Math.round(value)} ms`;
  return <section className="whiteboard-card" aria-label="Teaching whiteboard">
    <div className="whiteboard-heading"><div><p className="eyebrow">DRAW WHILE YOU TEACH</p><h2>Whiteboard</h2></div><span role="status" className={`board-status ${sharing === "error" || debug?.status === "error" ? "board-error" : ""}`}>{sharing === "error" ? "Vision setup error" : running ? debug?.status === "current" ? deliverObservation ? "Visual context current" : "Analysis current · no voice session" : `Vision: ${debug?.status ?? "starting"}` : "Vision off"}</span></div>
    <p className="whiteboard-help">Draw and keep talking. {running ? deliverObservation ? "Whiteboard images are analyzed automatically by Gemini on Vertex AI; observations update your existing conversation without starting speech." : "Whiteboard images are analyzed automatically by Gemini on Vertex AI. This isolated lab has no voice session." : vision?.reason ?? "Start a live lesson with Vertex AI configured to share drawing changes automatically."}</p>
    <div className="board-toolbar" role="toolbar" aria-label="Drawing tools">
      {tools.map(value => <button type="button" key={value} aria-pressed={tool === value} onClick={() => setTool(value)}>{value}</button>)}
      <label>Color <input aria-label="Drawing color" type="color" value={color} onChange={e => setColor(e.target.value)} /></label>
      <label>Width <input aria-label="Stroke width" type="range" min={2} max={12} value={size} onChange={e => setSize(Number(e.target.value))} /></label>
      <button type="button" disabled={!count} onClick={() => replace(marks.current.slice(0, -1))}>Undo</button>
      <button type="button" onClick={() => replace([])}>Clear whiteboard</button>
    </div>
    {tool === "text" && <label className="board-text">Text or equation (Unicode math supported)<textarea value={text} maxLength={500} onChange={e => setText(e.target.value)} placeholder="e.g. L(θ) = θ² or ∇L = 2θ — then click to place" /></label>}
    <div className="board-canvases">
      <canvas ref={canvas} width={BOARD_WIDTH} height={BOARD_HEIGHT} aria-label="Draw your explanation here" onPointerDown={down} onPointerMove={move} onPointerUp={e => finish(e)} onPointerCancel={e => finish(e, true)} onLostPointerCapture={e => finish(e, true)} />
      <div className={`board-preview ${capturing ? "capture-active" : ""}`}><video ref={preview} muted autoPlay playsInline aria-label="Local whiteboard capture preview" /><span>{capturing ? `Local video preview · ${previewFrames} decoded frames · Video track stays local` : "Local capture preview · Not connected"}</span></div>
    </div>
    <div className="board-actions"><button type="button" disabled={sharing === "checking" || Boolean(running)} onClick={() => void startSharing()}>Start sharing whiteboard</button><button type="button" disabled={!running && sharing === "idle"} onClick={() => { request.current?.abort(); setEnabled(false); setSharing("idle"); setError(null); stopCapture(); }}>Stop sharing whiteboard</button><button type="button" onClick={() => capturing ? stopCapture() : void startCapture()}>{capturing ? "Stop local capture" : "Test local capture"}</button></div>
    <p className="whiteboard-help">Event-driven JPEG analysis · stroke-end debounce 120 ms · active strokes up to every 350 ms · latest frame wins. This is a separate vision-model fallback, not native Boson video input.</p>
    <details className="vision-debug"><summary>Vision debugging · revision {revisionClock.current}</summary><dl>
      <dt>Model</dt><dd>{vision?.model ?? "Not configured"}</dd><dt>Analyzed / delivered revision</dt><dd>{debug?.analyzedRevision ?? "—"} / {debug?.deliveredRevision ?? "—"}</dd>
      <dt>Status / pending revisions</dt><dd>{debug?.status ?? "off"} / {debug?.queued ? "one replaceable revision" : "none"}</dd><dt>Latest description</dt><dd>{debug?.description || "No current visual observation"}</dd>
      <dt>Age of last success</dt><dd>{debug?.lastSuccessAt ? `${Math.max(0, (clock - debug.lastSuccessAt) / 1000).toFixed(1)} s` : "—"}</dd><dt>Capture / vision provider / round trip</dt><dd>{ms(debug?.captureMs)} / {ms(debug?.analysisMs)} / {ms(debug?.requestMs)}</dd>
      <dt>Context acknowledgement / total</dt><dd>{ms(debug?.contextMs)} / {ms(debug?.totalMs)}</dd><dt>Discarded stale results</dt><dd>{debug?.discarded ?? 0}</dd></dl>
      <button type="button" onClick={() => { if (canvas.current) void boardSnapshotter(canvas.current)(revisionClock.current, performance.now()).then(frame => setLocalCaptureMs(frame.captureMs)).catch(e => setError(String(e))); }}>Measure local JPEG export</button>
      <p>Local export benchmark: {ms(localCaptureMs)}. This diagnostic does not send an image or observation.</p>
      {debug?.error && <p className="error">{debug.error}</p>}</details>
    {count >= 300 && <p className="notice">This prototype holds 300 marks. Undo or clear the board to continue.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {(lab || experiment) && <div className="board-experiment"><h3>Current-frame experiment</h3><p>These buttons change actual canvas pixels. The vision model sees only the exported image; button labels and shape commands are not sent. {lab ? "This lab tests analysis alone. Use the classroom for voice/context delivery." : "Use these controlled drawing states to check the active conversation."}</p><div className="board-actions">{["Blank board", "Red circle", "Add blue arrow", "Erase circle"].map((label, index) => <button type="button" key={label} onClick={() => replace(experimentBoard(index as 0 | 1 | 2 | 3))}>{label}</button>)}</div></div>}
  </section>;
}
