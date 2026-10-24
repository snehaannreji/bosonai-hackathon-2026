import { describe, expect, it } from "vitest";
import { applyDrawing, DRAWING_TOOLS } from "../src/whiteboard/drawingTools";
import { boardPoint, moveMark, type Mark } from "../src/whiteboard/board";
import { buildSessionConfig } from "../src/realtime/sessionConfig";

const arrow = { id: "direction", tool: "arrow", points: [{ x: .7, y: .3 }, { x: .8, y: .2 }] };
const teacher: Mark = { id: "teacher", owner: "user", tool: "pen", color: "#ff0000", width: 3, points: [{ x: 10, y: 20 }] };
describe("student drawing command safety and teach-back demo", () => {
  it("draws a quadratic, demonstrates an arrow misconception, and targets its correction", () => {
    const axes = applyDrawing("draw_shapes", { shapes: [
      { id: "x-axis", tool: "arrow", points: [{ x: .1, y: .85 }, { x: .9, y: .85 }] },
      { id: "y-axis", tool: "arrow", points: [{ x: .1, y: .85 }, { x: .1, y: .1 }] },
    ] }, [teacher], 0);
    expect(axes.changed).toBe(true);
    const curve = applyDrawing("plot_function", { id: "loss", coefficients: [0, 0, 1], xMin: -2, xMax: 2, yMin: 0, yMax: 4, points: [{ x: .15, y: .15 }, { x: .85, y: .8 }] }, axes.marks, 1);
    expect(curve.changed).toBe(true);
    const path = curve.marks.at(-1)!;
    expect(path.points).toHaveLength(161); expect(path.points[80].y).toBeCloseTo(384);
    expect(path.points[0].y).toBeCloseTo(72); expect(path.points[160].y).toBeCloseTo(72);
    const wrong = applyDrawing("draw_shapes", { shapes: [arrow] }, curve.marks, 2);
    const corrected = applyDrawing("update_shapes", { revision: 3, shapes: [{ id: "direction", points: [{ x: .8, y: .2 }, { x: .7, y: .3 }] }] }, wrong.marks, 3);
    expect(corrected.changed).toBe(true);
    expect(corrected.marks.slice(0, -1)).toEqual(curve.marks);
    expect(corrected.marks.at(-1)?.points).toEqual([...wrong.marks.at(-1)!.points].reverse());
    expect(corrected.marks[0]).toBe(teacher);
    const labeled = applyDrawing("draw_text", { shapes: [{ id: "label", tool: "text", text: "−∇L", points: [{ x: .6, y: .2 }] }] }, corrected.marks, 4);
    expect(labeled.marks.at(-1)?.text).toBe("−∇L");
  });
  it("constructs a network from model-chosen primitives without a diagram library", () => {
    const shapes = [0, 1, 2].flatMap(layer => [0, 1].map(row => ({ id: `node-${layer}-${row}`, tool: "circle", points: [{ x: .15 + layer * .3, y: .2 + row * .4 }, { x: .23 + layer * .3, y: .3 + row * .4 }] })));
    const nodes = applyDrawing("draw_shapes", { shapes }, [], 0);
    const connections = applyDrawing("draw_shapes", { shapes: [{ id: "edge", tool: "line", points: [{ x: .23, y: .25 }, { x: .45, y: .25 }] }] }, nodes.marks, 1);
    expect(connections.marks).toHaveLength(7);
  });
  it("preserves manual edits and rejects stale revisions and teacher deletions atomically", () => {
    const initial = applyDrawing("draw_shapes", { shapes: [arrow] }, [teacher], 0);
    const moved = [teacher, moveMark(initial.marks[1], -32, 48)];
    const stale = applyDrawing("update_shapes", { revision: 1, shapes: [{ id: "direction", color: "#00ff00" }] }, moved, 2);
    expect(stale.changed).toBe(false); expect(stale.marks).toEqual(moved);
    const fresh = applyDrawing("update_shapes", { revision: 2, shapes: [{ id: "direction", color: "#00ff00" }] }, moved, 2);
    expect(fresh.marks[1].points).toEqual(moved[1].points);
    const erased = applyDrawing("erase_shapes", { ids: ["direction", "teacher"], revision: 3 }, fresh.marks, 3);
    expect(erased.changed).toBe(false); expect(erased.marks).toEqual(fresh.marks);
    expect(applyDrawing("erase_shapes", { ids: ["direction"], revision: 3 }, fresh.marks, 3).marks).toEqual([teacher]);
  });
  it.each([
    null, { shapes: [{ ...arrow, points: [{ x: NaN, y: .5 }] }] },
    { shapes: [{ ...arrow, points: [{ x: 1.1, y: .2 }, { x: .3, y: .4 }] }] },
    { shapes: [{ ...arrow, tool: "script" }] }, { shapes: [{ ...arrow, color: "url(javascript:evil)" }] },
    { shapes: [arrow, { ...arrow, id: "other", code: "alert(1)" }] },
    { shapes: Array.from({ length: 41 }, (_, i) => ({ ...arrow, id: `a${i}` })) },
  ])("rejects malformed or unsafe commands without partial mutations: %j", args => {
    const result = applyDrawing("draw_shapes", args, [teacher], 0);
    expect(result.changed).toBe(false); expect(result.result.error).toBe("invalid_drawing"); expect(result.marks).toEqual([teacher]);
  });
  it("bounds path cost, IDs, text and polynomial output", () => {
    expect(applyDrawing("draw_path", { shapes: [{ id: "curve", tool: "path", points: Array(513).fill({ x: .1, y: .2 }) }] }, [], 0).changed).toBe(false);
    expect(applyDrawing("draw_text", { shapes: [{ id: "t", tool: "text", text: "x".repeat(501), points: [{ x: .1, y: .2 }] }] }, [], 0).changed).toBe(false);
    expect(applyDrawing("plot_function", { id: "f", coefficients: [0, 0, 1], xMin: -2, xMax: 2, yMin: 0, yMax: 1, points: [{ x: .1, y: .1 }, { x: .9, y: .9 }] }, [], 0).changed).toBe(false);
  });
  it("uses the same coordinates as responsive teacher input and registers application tools", () => {
    const drawing = applyDrawing("draw_shapes", { shapes: [arrow] }, [], 0);
    expect(drawing.marks[0].points[0]).toEqual(boardPoint({ x: 20 + .7 * 320, y: 30 + .3 * 240 }, { left: 20, top: 30, width: 320, height: 240 }));
    const session = buildSessionConfig("higgs-realtime-1.5-preview").session as { tools: { name: string }[] };
    expect(session.tools.map(t => t.name)).toEqual(["update_understanding", ...DRAWING_TOOLS.map(t => t.name), "prepare_response"]);
    expect(applyDrawing("get_whiteboard", {}, drawing.marks, 1).result).toMatchObject({ revision: 1, objects: [{ id: "direction", owner: "ai", points: arrow.points }] });
  });
});
