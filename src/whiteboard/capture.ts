export interface BoardCapture {
  stream: MediaStream;
  changed(): void;
  stop(): void;
}
/** Local capture only. A stream/track existing does NOT mean Higgs receives it.
 * The future verified vision adapter must explicitly accept this video track. */
export function captureWhiteboard(canvas: HTMLCanvasElement): BoardCapture {
  if (typeof canvas.captureStream !== "function") throw new Error("Canvas video capture is unavailable in this browser. Try a current Chrome browser.");
  let stream = canvas.captureStream(0);
  let track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  if (!track || track.readyState === "ended") { stream.getTracks().forEach(t => t.stop()); throw new Error("The whiteboard did not create a live video track."); }
  // requestFrame lets us transmit only changed board renders at <= 3 FPS.
  // Browsers lacking it use the native canvas-changes capture mode at 3 FPS.
  if (typeof track.requestFrame !== "function") {
    stream.getTracks().forEach(t => t.stop());
    stream = canvas.captureStream(3);
    track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
    if (!track || track.readyState === "ended") { stream.getTracks().forEach(t => t.stop()); throw new Error("The whiteboard video track is unavailable."); }
  }
  const video = track;
  const context = canvas.getContext("2d");
  if (!context) { stream.getTracks().forEach(t => t.stop()); throw new Error("The drawing canvas is unavailable."); }
  let dirty = true, stopped = false;
  const timer = setInterval(() => {
    if (!stopped && dirty && video.readyState === "live" && typeof video.requestFrame === "function") {
      video.requestFrame();
      // A request captures the next canvas paint. Repaint the CURRENT pixels
      // after requesting, including a final erase/clear when no later stroke
      // will arrive. Otherwise a manual source can lag one change behind.
      context.drawImage(canvas, 0, 0);
      dirty = false;
    }
  }, 1000 / 3);
  return { stream,
    changed() { if (!stopped) dirty = true; },
    stop() { if (stopped) return; stopped = true; clearInterval(timer); stream.getTracks().forEach(t => t.stop()); },
  };
}
