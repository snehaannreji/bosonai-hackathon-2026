import { useEffect, useRef, useState, type PointerEvent } from "react";
import { BOARD_HEIGHT, BOARD_WIDTH, boardPoint, renderBoard, type DrawTool, type Mark } from "../whiteboard/board";
import { SharedBoardClient, type SharedBoardStatus } from "../whiteboard/sharedBoard";

const COLORS = ["#17221b", "#dc2626", "#2563eb", "#16a34a", "#9333ea"];

export function TabletWhiteboard() {
  const canvas = useRef<HTMLCanvasElement>(null); const marks = useRef<Mark[]>([]); const draft = useRef<Mark | null>(null);
  const historyRef = useRef<Mark[][]>([]); const future = useRef<Mark[][]>([]); const pointer = useRef<number | null>(null); const client = useRef<SharedBoardClient | null>(null); const previewAt = useRef(0);
  const [tool, setTool] = useState<DrawTool>("pen"); const [color, setColor] = useState(COLORS[0]); const [size, setSize] = useState(4); const [status, setStatus] = useState<SharedBoardStatus>("connecting"); const [peers, setPeers] = useState(0); const [, refresh] = useState(0);
  const paint = () => { const ctx = canvas.current?.getContext("2d"); if (ctx) renderBoard(ctx, [...marks.current, ...(draft.current ? [draft.current] : [])]); };
  const update = (next: Mark[], record = true, send = true) => {
    if (record) { historyRef.current.push(marks.current); if (historyRef.current.length > 100) historyRef.current.shift(); future.current = []; }
    marks.current = next; draft.current = null; paint(); refresh(value => value + 1); if (send) client.current?.send(next, true);
  };
  useEffect(() => {
    paint();
    const session = new URLSearchParams(location.search).get("session"); const secret = new URLSearchParams(location.hash.slice(1)); const token = secret.get("token"); const expiresAt = Number(secret.get("expires"));
    if (!session || !token) { setStatus("error"); return; }
    const shared = new SharedBoardClient({ lessonId: session, token, expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : Date.now() }, { onStatus: setStatus, onPeers: setPeers, onMarks: (next, complete) => { if (complete) update(next, true, false); else { draft.current = null; marks.current = next; paint(); } } });
    client.current = shared; shared.connect();
    return () => { shared.close(); client.current = null; };
  }, []);
  const point = (event: PointerEvent<HTMLCanvasElement>) => boardPoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect());
  const down = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!event.isPrimary || event.button !== 0 || status !== "connected") return;
    pointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); draft.current = { tool, color, width: size, points: [point(event)] }; paint();
  };
  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!draft.current || pointer.current !== event.pointerId) return;
    const next = point(event), last = draft.current.points.at(-1); if (last && Math.hypot(next.x - last.x, next.y - last.y) < .8) return;
    if (draft.current.points.length < 2000) draft.current.points.push(next); paint();
    const now = performance.now(); if (now - previewAt.current > 45) { previewAt.current = now; client.current?.send([...marks.current, draft.current], false); }
  };
  const finish = (event: PointerEvent<HTMLCanvasElement>, cancel = false) => {
    if (pointer.current !== event.pointerId) return;
    if (draft.current && !cancel) update([...marks.current, draft.current]); else { draft.current = null; paint(); client.current?.send(marks.current, true); }
    pointer.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const undo = () => { const previous = historyRef.current.pop(); if (!previous) return; future.current.push(marks.current); update(previous, false); };
  const redo = () => { const next = future.current.pop(); if (!next) return; historyRef.current.push(marks.current); update(next, false); };
  return <main className="tablet-board"><header><div><span className="brand-mark">hı</span><div><strong>TeachBack whiteboard</strong><small className={`tablet-status ${status}`}>{status === "connected" ? `Connected · ${Math.max(0, peers - 1)} other device${peers === 2 ? "" : "s"}` : status}</small></div></div><button onClick={() => { client.current?.close(); window.history.replaceState(null, "", "/tablet"); setStatus("disconnected"); }}>Disconnect</button></header>
    <div className="tablet-toolbar" role="toolbar" aria-label="Tablet drawing tools"><button aria-pressed={tool === "pen"} onClick={() => setTool("pen")}>Pen</button><button aria-pressed={tool === "eraser"} onClick={() => setTool("eraser")}>Eraser</button><div className="tablet-colors">{COLORS.map(value => <button key={value} aria-label={`Use ${value}`} aria-pressed={color === value} style={{ background: value }} onClick={() => { setColor(value); setTool("pen"); }} />)}</div><label>Size <input type="range" min="2" max="12" value={size} onChange={event => setSize(Number(event.target.value))} /></label><button disabled={!historyRef.current.length} onClick={undo}>Undo</button><button disabled={!future.current.length} onClick={redo}>Redo</button><button disabled={!marks.current.length} onClick={() => update([])}>Clear</button></div>
    <section className="tablet-canvas-wrap"><canvas ref={canvas} width={BOARD_WIDTH} height={BOARD_HEIGHT} aria-label="Shared TeachBack whiteboard" onPointerDown={down} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)} /></section>
    {status !== "connected" && <div className="tablet-connection-message" role="status"><strong>{status === "expired" ? "Pairing link expired" : status === "disconnected" ? "Disconnected" : status === "error" ? "Could not join this whiteboard" : "Connecting to whiteboard…"}</strong><p>{status === "expired" || status === "error" ? "Ask the teacher to create a new tablet link." : "Your drawing tools will activate when the connection is ready."}</p></div>}
  </main>;
}
