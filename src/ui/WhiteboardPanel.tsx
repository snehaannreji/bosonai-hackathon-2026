import { useEffect, useRef, useState, type PointerEvent } from "react";
import { BOARD_HEIGHT, BOARD_WIDTH, boardPoint, experimentBoard, markAt, moveMark, renderBoard, type DrawTool, type Mark, type Point } from "../whiteboard/board";
import { captureWhiteboard, type BoardCapture } from "../whiteboard/capture";
import { boardSnapshotter } from "../whiteboard/snapshot";
import { WhiteboardVisionPipeline, type VisionDebug } from "../whiteboard/visionPipeline";
import type { ContextReceipt, VisualContext } from "../whiteboard/observations";
import QRCode from "qrcode";
import { createWhiteboardPairing, revokeWhiteboardPairing, SharedBoardClient, type PairingDetails, type SharedBoardStatus } from "../whiteboard/sharedBoard";

const tools: (DrawTool | "move")[] = ["pen", "arrow", "line", "rectangle", "circle", "text", "move", "eraser"];
export function WhiteboardPanel({ lab = false, experiment = false, diagnostics = false, sessionKey = "", ownerToken = "", active = true, deliverObservation }: { lab?: boolean; experiment?: boolean; diagnostics?: boolean; sessionKey?: string; ownerToken?: string; active?: boolean; deliverObservation?: (context: VisualContext) => Promise<ContextReceipt> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const preview = useRef<HTMLVideoElement>(null);
  const capture = useRef<BoardCapture | null>(null);
  const marks = useRef<Mark[]>([]);
  const draft = useRef<Mark | null>(null);
  const moving = useRef<{ index: number; origin: Point; original: Mark } | null>(null);
  const history = useRef<Mark[][]>([]);
  const future = useRef<Mark[][]>([]);
  const shared = useRef<SharedBoardClient | null>(null);
  const previewSentAt = useRef(0);
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
  const [pairing, setPairing] = useState<PairingDetails | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingQr, setPairingQr] = useState("");
  const [tabletStatus, setTabletStatus] = useState<SharedBoardStatus>("disconnected");
  const [tabletPeers, setTabletPeers] = useState(0);
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
    return () => { mounted.current = false; request.current?.abort(); capture.current?.stop(); capture.current = null; shared.current?.close(); if (sessionKey && ownerToken) void revokeWhiteboardPairing(sessionKey, ownerToken); };
  }, []);
  useEffect(() => {
    if (active || !pairing) return;
    shared.current?.close(); shared.current = null; setTabletStatus("disconnected"); setTabletPeers(0); setPairing(null); setPairingQr("");
    if (ownerToken) void revokeWhiteboardPairing(sessionKey, ownerToken);
  }, [active, pairing, sessionKey, ownerToken]);
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
      marks.current[index] = moveMark(original, next.x - origin.x, next.y - origin.y); paint("intermediate");
      if (performance.now() - previewSentAt.current > 45) { previewSentAt.current = performance.now(); shared.current?.send(marks.current, false); } return;
    }
    if (!draft.current || event.pointerId !== pointer.current) return;
    const next = point(event);
    const last = draft.current.points.at(-1);
    if (last && Math.hypot(next.x - last.x, next.y - last.y) < 0.8) return;
    if (draft.current.tool === "pen" || draft.current.tool === "eraser") {
      if (draft.current.points.length < 2000) draft.current.points.push(next);
    } else draft.current.points = [draft.current.points[0], next];
    paint("intermediate");
    if (performance.now() - previewSentAt.current > 45) { previewSentAt.current = performance.now(); shared.current?.send([...marks.current, draft.current], false); }
  };
  const finish = (event: PointerEvent<HTMLCanvasElement>, cancel = false) => {
    if (event.pointerId !== pointer.current) return;
    const before = moving.current ? marks.current.map((mark, index) => index === moving.current!.index ? moving.current!.original : mark) : marks.current;
    if (moving.current) { if (cancel) marks.current[moving.current.index] = moving.current.original; moving.current = null; }
    if (draft.current && !cancel) marks.current.push(draft.current);
    if (!cancel) { history.current.push(before); if (history.current.length > 100) history.current.shift(); future.current = []; }
    draft.current = null; pointer.current = null; setCount(marks.current.length); paint("complete");
    shared.current?.send(marks.current, true);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const replace = (next: Mark[], record = true, send = true) => { if (record) { history.current.push(marks.current); if (history.current.length > 100) history.current.shift(); future.current = []; } marks.current = next; draft.current = null; moving.current = null; pointer.current = null; setCount(next.length); paint(next.length ? "complete" : "clear"); if (send) shared.current?.send(next, true); };
  const undo = () => { const previous = history.current.pop(); if (!previous) return; future.current.push(marks.current); replace(previous, false); };
  const redo = () => { const next = future.current.pop(); if (!next) return; history.current.push(marks.current); replace(next, false); };
  const connectTablet = async () => {
    if (!sessionKey || pairingBusy) return;
    setPairingBusy(true); setError(null);
    try {
      if (!ownerToken) throw new Error("This lesson has no tablet pairing credential. Restart the local server and start a new lesson.");
      const details = await createWhiteboardPairing(sessionKey, ownerToken); setPairing(details); setPairingQr(await QRCode.toDataURL(details.url, { width: 260, margin: 1, errorCorrectionLevel: "M" })); setPairingOpen(true);
      shared.current?.close();
      const connection = new SharedBoardClient(details, { onStatus: setTabletStatus, onPeers: setTabletPeers, onMarks: (next, complete) => { if (complete) replace(next, true, false); else { marks.current = next; draft.current = null; setCount(next.length); paint("intermediate"); } } });
      shared.current = connection; connection.connect();
    } catch (error) { setError(error instanceof Error ? error.message : "Could not create a tablet link."); }
    finally { setPairingBusy(false); }
  };
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
    <p className="whiteboard-help">Draw while you explain. {running ? `${deliverObservation ? "Your student receives" : "Vision analyzes"} meaningful changes automatically.` : vision?.reason ?? "Start a live lesson to share drawing changes."}</p>
    <div className="board-toolbar" role="toolbar" aria-label="Drawing tools">
      {tools.map(value => <button type="button" key={value} aria-pressed={tool === value} onClick={() => setTool(value)}>{value}</button>)}
      <label>Color <input aria-label="Drawing color" type="color" value={color} onChange={e => setColor(e.target.value)} /></label>
      <label>Width <input aria-label="Stroke width" type="range" min={2} max={12} value={size} onChange={e => setSize(Number(e.target.value))} /></label>
      <button type="button" disabled={!history.current.length} onClick={undo}>Undo</button>
      <button type="button" disabled={!future.current.length} onClick={redo}>Redo</button>
      <button type="button" onClick={() => replace([])}>Clear whiteboard</button>
    </div>
    {tool === "text" && <label className="board-text">Text or equation (Unicode math supported)<textarea value={text} maxLength={500} onChange={e => setText(e.target.value)} placeholder="e.g. L(θ) = θ² or ∇L = 2θ — then click to place" /></label>}
    <div className={`board-canvases ${diagnostics || lab ? "with-preview" : ""}`}>
      <canvas ref={canvas} width={BOARD_WIDTH} height={BOARD_HEIGHT} aria-label="Draw your explanation here" onPointerDown={down} onPointerMove={move} onPointerUp={e => finish(e)} onPointerCancel={e => finish(e, true)} onLostPointerCapture={e => finish(e, true)} />
      {(diagnostics || lab) && <div className={`board-preview ${capturing ? "capture-active" : ""}`}><video ref={preview} muted autoPlay playsInline aria-label="Local whiteboard capture preview" /><span>{capturing ? `Local video preview · ${previewFrames} decoded frames · Video track stays local` : "Local capture preview · Not connected"}</span></div>}
    </div>
    <div className="board-actions"><button className="connect-tablet" type="button" disabled={!sessionKey || !ownerToken || pairingBusy || !active} onClick={() => void connectTablet()}>{pairingBusy ? "Creating link…" : tabletStatus === "connected" && tabletPeers > 1 ? "Tablet connected" : "Connect tablet"}</button><button type="button" disabled={sharing === "checking" || Boolean(running)} onClick={() => void startSharing()}>Start sharing</button><button type="button" disabled={!running && sharing === "idle"} onClick={() => { request.current?.abort(); setEnabled(false); setSharing("idle"); setError(null); stopCapture(); }}>Stop sharing</button>{(diagnostics || lab) && <button type="button" onClick={() => capturing ? stopCapture() : void startCapture()}>{capturing ? "Stop local capture" : "Test local capture"}</button>}</div>
    {pairingOpen && pairing && <div className="pairing-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setPairingOpen(false); }}><section className="pairing-dialog" role="dialog" aria-modal="true" aria-labelledby="pairing-title"><button className="pairing-close" onClick={() => setPairingOpen(false)} aria-label="Close tablet pairing">×</button><p className="eyebrow">SHARED DRAWING</p><h3 id="pairing-title">Connect a tablet</h3><p>Scan with your tablet camera. It joins this lesson’s whiteboard only—voice stays on this computer.</p>{pairingQr && <img src={pairingQr} alt="QR code for this whiteboard session" />}<span className={`tablet-status ${tabletStatus}`}>{tabletStatus === "connected" ? `${Math.max(0, tabletPeers - 1)} tablet${tabletPeers === 2 ? "" : "s"} connected` : tabletStatus}</span><a href={pairing.url} target="_blank" rel="noreferrer">Open tablet view on this device</a><button onClick={() => void navigator.clipboard.writeText(pairing.url)}>Copy pairing link</button><small>Link expires at {new Date(pairing.expiresAt).toLocaleTimeString()}. Ending the lesson revokes it immediately.</small></section></div>}
    {(diagnostics || lab) && <><p className="whiteboard-help">Event-driven JPEG analysis · 120 ms stroke-end debounce · latest frame wins · separate Vertex vision fallback.</p>
    <details className="vision-debug"><summary>Vision diagnostics · revision {revisionClock.current}</summary><dl>
      <dt>Model</dt><dd>{vision?.model ?? "Not configured"}</dd><dt>Analyzed / delivered revision</dt><dd>{debug?.analyzedRevision ?? "—"} / {debug?.deliveredRevision ?? "—"}</dd>
      <dt>Status / pending revisions</dt><dd>{debug?.status ?? "off"} / {debug?.queued ? "one replaceable revision" : "none"}</dd><dt>Latest description</dt><dd>{debug?.description || "No current visual observation"}</dd>
      <dt>Age of last success</dt><dd>{debug?.lastSuccessAt ? `${Math.max(0, (clock - debug.lastSuccessAt) / 1000).toFixed(1)} s` : "—"}</dd><dt>Capture / vision provider / round trip</dt><dd>{ms(debug?.captureMs)} / {ms(debug?.analysisMs)} / {ms(debug?.requestMs)}</dd>
      <dt>Context acknowledgement / total</dt><dd>{ms(debug?.contextMs)} / {ms(debug?.totalMs)}</dd><dt>Discarded stale results</dt><dd>{debug?.discarded ?? 0}</dd></dl>
      <button type="button" onClick={() => { if (canvas.current) void boardSnapshotter(canvas.current)(revisionClock.current, performance.now()).then(frame => setLocalCaptureMs(frame.captureMs)).catch(e => setError(String(e))); }}>Measure local JPEG export</button>
      <p>Local export benchmark: {ms(localCaptureMs)}. This diagnostic does not send an image or observation.</p>
      {debug?.error && <p className="error">{debug.error}</p>}</details></>}
    {count >= 300 && <p className="notice">This prototype holds 300 marks. Undo or clear the board to continue.</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {(lab || (experiment && diagnostics)) && <div className="board-experiment"><h3>Current-frame experiment</h3><p>These controls alter actual canvas pixels for model verification.</p><div className="board-actions">{["Blank board", "Red circle", "Add blue arrow", "Erase circle"].map((label, index) => <button type="button" key={label} onClick={() => replace(experimentBoard(index as 0 | 1 | 2 | 3))}>{label}</button>)}</div></div>}
  </section>;
}
