import { BOARD_WIDTH, BOARD_HEIGHT, type Mark, type Point } from "./model";
export * from "./model";
export function markAt(marks: readonly Mark[], point: Point): number {
  for (let i = marks.length - 1; i >= 0; i--) {
    const mark = marks[i]; if (mark.tool === "eraser" || !mark.points.length) continue;
    const xs = mark.points.map(p => p.x), ys = mark.points.map(p => p.y);
    const right = mark.tool === "text" ? Math.min(BOARD_WIDTH, xs[0] + Math.max(...(mark.text ?? "").split("\n").map(s => s.length)) * 14) : Math.max(...xs);
    const bottom = mark.tool === "text" ? ys[0] + (mark.text ?? "").split("\n").length * 29 : Math.max(...ys);
    if (point.x >= Math.min(...xs) - 10 && point.x <= right + 10 && point.y >= Math.min(...ys) - 10 && point.y <= bottom + 10) return i;
  }
  return -1;
}
export function moveMark(mark: Mark, dx: number, dy: number): Mark {
  if (!mark.points.length) return mark;
  const xs = mark.points.map(p => p.x), ys = mark.points.map(p => p.y);
  dx = Math.max(-Math.min(...xs), Math.min(BOARD_WIDTH - Math.max(...xs), dx));
  dy = Math.max(-Math.min(...ys), Math.min(BOARD_HEIGHT - Math.max(...ys), dy));
  return { ...mark, points: mark.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
}
export function boardPoint(client: Point, bounds: { left: number; top: number; width: number; height: number }): Point {
  return {
    x: Math.max(0, Math.min(BOARD_WIDTH, (client.x - bounds.left) * BOARD_WIDTH / bounds.width)),
    y: Math.max(0, Math.min(BOARD_HEIGHT, (client.y - bounds.top) * BOARD_HEIGHT / bounds.height)),
  };
}
/** The visible board IS the capture canvas. No DOM/SVG screenshot conversion,
 * camera permission, external image tainting, or toolbar pixels are involved. */
export function renderBoard(ctx: CanvasRenderingContext2D, marks: readonly Mark[]) {
  ctx.save(); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (const mark of marks) {
    const first = mark.points[0]; const last = mark.points.at(-1);
    if (!first || !last) continue;
    ctx.strokeStyle = mark.tool === "eraser" ? "#ffffff" : mark.color;
    ctx.fillStyle = mark.color;
    ctx.lineWidth = mark.tool === "eraser" ? mark.width * 7 : mark.width;
    if (mark.tool === "text") {
      ctx.font = "24px sans-serif"; ctx.textBaseline = "top";
      for (const [index, line] of (mark.text ?? "").split("\n").entries()) {
        ctx.fillText(line, first.x, first.y + index * 29, BOARD_WIDTH - first.x);
      }
      continue;
    }
    ctx.beginPath();
    if (mark.tool !== "circle") ctx.moveTo(first.x, first.y);
    if (mark.tool === "rectangle") ctx.rect(first.x, first.y, last.x - first.x, last.y - first.y);
    else if (mark.tool === "circle") ctx.ellipse((first.x + last.x) / 2, (first.y + last.y) / 2, Math.abs(last.x - first.x) / 2, Math.abs(last.y - first.y) / 2, 0, 0, Math.PI * 2);
    else {
      const points = mark.tool === "pen" || mark.tool === "eraser" ? mark.points : [first, last];
      for (const point of points) ctx.lineTo(point.x, point.y);
      if (mark.tool === "arrow") {
        const angle = Math.atan2(last.y - first.y, last.x - first.x);
        const length = 16;
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(last.x - length * Math.cos(angle - Math.PI / 6), last.y - length * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(last.x - length * Math.cos(angle + Math.PI / 6), last.y - length * Math.sin(angle + Math.PI / 6));
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Reproducible pixel sources for the LOCAL capture experiment only.
 * These commands and their labels are never passed to the model as text. */
export function experimentBoard(stage: 0 | 1 | 2 | 3): Mark[] {
  const circle: Mark = { tool: "circle", color: "#dc2626", width: 5, points: [{ x: 360, y: 180 }, { x: 480, y: 300 }] };
  const arrow: Mark = { tool: "arrow", color: "#2563eb", width: 5, points: [{ x: 140, y: 240 }, { x: 340, y: 240 }] };
  return stage === 0 ? [] : stage === 1 ? [circle] : stage === 2 ? [circle, arrow] : [arrow];
}
