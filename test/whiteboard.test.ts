import { afterEach, describe, expect, it, vi } from "vitest";
import { boardPoint, experimentBoard, markAt, moveMark, renderBoard } from "../src/whiteboard/board";
import { captureWhiteboard } from "../src/whiteboard/capture";
import { visionCapability } from "../src/whiteboard/visionCapability";
import { studentPrompt } from "../src/realtime/sessionConfig";
import { mockLesson } from "../src/state/lesson";

afterEach(() => vi.useRealTimers());
function source(manual = true) {
  const track = { kind: "video", readyState: "live", stop: vi.fn(), ...(manual ? { requestFrame: vi.fn() } : {}) };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const context = { drawImage: vi.fn() };
  const canvas = { captureStream: vi.fn(() => stream), getContext: () => context };
  return { track, stream, canvas, context };
}
describe("whiteboard video source and capability boundary", () => {
  it("selects and translates the existing shape for meaningful move events", () => {
    const marks = experimentBoard(2);
    expect(markAt(marks, { x: 420, y: 240 })).toBe(0);
    expect(markAt(marks, { x: 10, y: 10 })).toBe(-1);
    const moved = moveMark(marks[0], -20, 30);
    expect(moved.points[0]).toEqual({ x: 340, y: 210 });
    expect(marks[0].points[0]).toEqual({ x: 360, y: 180 });
  });
  it("maps mouse/touch coordinates to the complete fixed-size board", () => {
    const bounds = { left: 20, top: 30, width: 320, height: 240 };
    expect(boardPoint({ x: 180, y: 150 }, bounds)).toEqual({ x: 320, y: 240 });
    expect(boardPoint({ x: -10, y: 900 }, bounds)).toEqual({ x: 0, y: 480 });
  });
  it("renders a cleared white frame before the latest marks, including after erasure", () => {
    const ctx = { save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(),
      moveTo: vi.fn(), lineTo: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), stroke: vi.fn(), fillText: vi.fn() };
    renderBoard(ctx as unknown as CanvasRenderingContext2D, experimentBoard(2));
    expect(ctx.ellipse).toHaveBeenCalledOnce();
    // An initial moveTo would connect the ellipse to its drag origin with a
    // spurious diagonal line. The first moveTo belongs to the later arrow.
    expect(ctx.ellipse.mock.invocationCallOrder[0]).toBeLessThan(ctx.moveTo.mock.invocationCallOrder[0]);
    expect(experimentBoard(2).map(m => m.color)).toEqual(["#dc2626", "#2563eb"]);
    ctx.ellipse.mockClear();
    renderBoard(ctx as unknown as CanvasRenderingContext2D, experimentBoard(3));
    expect(ctx.fillRect).toHaveBeenLastCalledWith(0, 0, 640, 480);
    expect(ctx.ellipse).not.toHaveBeenCalled();
    expect(experimentBoard(3)).toMatchObject([{ tool: "arrow", color: "#2563eb" }]);
    renderBoard(ctx as unknown as CanvasRenderingContext2D, []);
    expect(ctx.fillRect).toHaveBeenCalledTimes(3);
  });
  it("captures a real source track only on changes, coalescing rapid draws at 3 FPS", () => {
    vi.useFakeTimers(); const { canvas, stream, track, context } = source();
    const capture = captureWhiteboard(canvas as unknown as HTMLCanvasElement);
    expect(capture.stream).toBe(stream); expect(canvas.captureStream).toHaveBeenCalledWith(0);
    vi.advanceTimersByTime(334); expect(track.requestFrame).toHaveBeenCalledTimes(1);
    expect(context.drawImage).toHaveBeenLastCalledWith(canvas, 0, 0);
    expect(track.requestFrame!.mock.invocationCallOrder[0]).toBeLessThan(context.drawImage.mock.invocationCallOrder[0]);
    vi.advanceTimersByTime(1000); expect(track.requestFrame).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 100; i++) capture.changed();
    vi.advanceTimersByTime(334); expect(track.requestFrame).toHaveBeenCalledTimes(2);
    capture.stop();
    expect(track.stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    capture.changed(); capture.stop(); vi.advanceTimersByTime(1000);
    expect(track.requestFrame).toHaveBeenCalledTimes(2); expect(track.stop).toHaveBeenCalledOnce();
  });
  it("releases the first track and uses native 3 FPS capture when requestFrame is absent", () => {
    vi.useFakeTimers(); const initial = source(false), replacement = source(false);
    initial.canvas.captureStream.mockReturnValueOnce(initial.stream).mockReturnValueOnce(replacement.stream);
    const capture = captureWhiteboard(initial.canvas as unknown as HTMLCanvasElement);
    expect(initial.track.stop).toHaveBeenCalledOnce();
    expect(initial.canvas.captureStream.mock.calls).toEqual([[0], [3]]);
    expect(capture.stream).toBe(replacement.stream);
    capture.stop(); expect(replacement.track.stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("reports capture failures instead of claiming that sharing started", () => {
    expect(() => captureWhiteboard({} as HTMLCanvasElement)).toThrow("unavailable");
    const canvas = { captureStream: () => ({ getVideoTracks: () => [], getTracks: () => [] }) };
    expect(() => captureWhiteboard(canvas as unknown as HTMLCanvasElement)).toThrow("live video track");
  });
  it("never advertises a connected model transport or confirmed vision from local capture", () => {
    expect(visionCapability("higgs-realtime-1.5-preview")).toMatchObject({ adapterReady: false, transport: null, modelVisionConfirmed: false });
    expect(studentPrompt(mockLesson("Loss functions"))).toContain("Pending, cleared or off invalidates ALL older drawings");
  });
});
