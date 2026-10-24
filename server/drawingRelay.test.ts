import { afterEach, expect, it, vi } from "vitest";
import { DrawingRelay } from "./drawingRelay";
import { AvatarToolBridge } from "../src/realtime/avatarToolBridge";

afterEach(() => vi.useRealTimers());
it("waits for browser acknowledgement, rejects duplicates and times out safely", async () => {
  vi.useFakeTimers(); const publish = vi.fn(); const relay = new DrawingRelay(publish, 100);
  const pending = relay.execute("draw_shapes", { shapes: [] }); const requestId = publish.mock.calls[0][0].requestId;
  expect(relay.finish(requestId, { summary: "Applied", revision: 1 })).toBe(true);
  expect(relay.finish(requestId, { summary: "Duplicate" })).toBe(false);
  expect(await pending).toMatchObject({ revision: 1 });
  const timeout = relay.execute("get_whiteboard", {}); await vi.advanceTimersByTimeAsync(100);
  expect(await timeout).toMatchObject({ error: "board_timeout" });
  const cancelled = relay.execute("get_whiteboard", {}); relay.cancel();
  expect(await cancelled).toMatchObject({ error: "interrupted" });
});
it("serializes avatar drawing calls, deduplicates and resumes speech only after all results", async () => {
  const send = vi.fn(), onDrawingTool = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ summary: "Applied", revision: 1, objects: [{ id: "arrow" }] }));
  const bridge = new AvatarToolBridge({ onEvent: vi.fn(), onKnowledge: vi.fn(), send, onDrawingTool });
  bridge.handle({ type: "response.created" });
  const call = { type: "response.function_call_arguments.done", call_id: "draw1", name: "draw_shapes", arguments: "{}" };
  bridge.handle(call); bridge.handle(call);
  bridge.handle({ ...call, call_id: "draw2", name: "get_whiteboard" });
  bridge.handle({ type: "response.done", response: { status: "completed", output: [{ ...call, type: "function_call" }] } });
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
  expect(onDrawingTool.mock.calls.map(call => call[0])).toEqual(["draw_shapes", "get_whiteboard"]);
  expect(JSON.parse(send.mock.calls[0][0].item.output)).toMatchObject({ revision: 1, objects: [{ id: "arrow" }] });
  expect(send.mock.calls[2][0]).toEqual({ type: "response.create" });
});
it("drops queued avatar drawing commands after teacher interruption", async () => {
  const send = vi.fn(), onDrawingTool = vi.fn();
  const bridge = new AvatarToolBridge({ onEvent: vi.fn(), onKnowledge: vi.fn(), send, onDrawingTool });
  bridge.handle({ type: "response.created" });
  bridge.handle({ type: "response.function_call_arguments.done", call_id: "draw", name: "draw_shapes", arguments: "{}" });
  bridge.handle({ type: "input_audio_buffer.speech_started" });
  bridge.handle({ type: "response.done", response: { status: "cancelled" } });
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(onDrawingTool).not.toHaveBeenCalled();
  expect(JSON.parse(send.mock.calls[0][0].item.output).error).toBe("interrupted");
});
it("bounds autonomous drawing loops and waits for the teacher when the budget is exhausted", async () => {
  const send = vi.fn(), onDrawingTool = vi.fn(async () => ({ summary: "Current board" }));
  const bridge = new AvatarToolBridge({ onEvent: vi.fn(), onKnowledge: vi.fn(), send, onDrawingTool });
  bridge.handle({ type: "response.created" });
  for (let i = 0; i < 33; i++) bridge.handle({ type: "response.function_call_arguments.done", call_id: `call-${i}`, name: "get_whiteboard", arguments: "{}" });
  bridge.handle({ type: "response.done", response: { status: "completed" } });
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(33));
  expect(onDrawingTool).toHaveBeenCalledTimes(32);
  expect(send.mock.calls.some(([event]) => event.type === "response.create")).toBe(false);
  expect(JSON.parse(send.mock.calls[32][0].item.output)).toMatchObject({ error: "drawing_limit" });
});
