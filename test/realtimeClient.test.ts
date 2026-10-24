import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const audio = vi.hoisted(() => ({ flush: vi.fn(async () => 120), close: vi.fn(async () => {}), stop: vi.fn(async () => {}), resume: vi.fn(async () => {}) }));
vi.mock("../src/audio/playback", () => ({ RingPlayer: class { resume = audio.resume; flush = audio.flush; close = audio.close; reset() {} enqueueBase64() {} } }));
vi.mock("../src/audio/capture", () => ({ MicCapture: class { active = false; async start() { this.active = true; } async stop() { this.active = false; await audio.stop(); } } }));
import { RealtimeClient } from "../src/realtime/RealtimeClient";
import type { RealtimeCredentials } from "../src/realtime/runtimeConfig";
const credentials: RealtimeCredentials = { value: "temporary-test-credential", model: "early-access-test-model", websocketUrl: "wss://api.boson.ai/v1/realtime" };

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  sent: { type: string; [key: string]: unknown }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: ((evt: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string, readonly protocols: string[]) { FakeSocket.instances.push(this); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: "client disconnect" }); }
  receive(evt: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(evt) }); }
}
const make = () => { const onServerEvent = vi.fn(); const onKnowledgeChange = vi.fn(); const client = new RealtimeClient({ tokenProvider: async () => credentials, onServerEvent, onKnowledgeChange }); return { client, onServerEvent, onKnowledgeChange }; };
const ready = async (client: RealtimeClient) => { await client.connect(); const ws = FakeSocket.instances.at(-1)!; ws.onopen?.(); ws.receive({ type: "session.created" }); return ws; };
beforeEach(() => { FakeSocket.instances = []; vi.stubGlobal("WebSocket", FakeSocket); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });
describe("reused Boson client with Alex's learning tool", () => {
  it("updates visual context silently in the existing session and awaits its ACK", async () => {
    const { client } = make(); const ws = await ready(client);
    const receipt = client.updateWhiteboard({ revision: 5, status: "cleared" });
    const update = ws.sent.at(-1)!;
    expect(update.type).toBe("session.update");
    expect(Object.keys(update.session as object)).toEqual(["instructions"]);
    expect(ws.sent.filter(e => e.type === "response.create")).toHaveLength(0);
    ws.receive({ type: "session.updated", session: update.session });
    expect(await receipt).toMatchObject({ revision: 5, accepted: true });
    expect(client.connectionState).toBe("open"); client.disconnect();
  });
  it("waits for session acknowledgement and prevents duplicate connects", async () => {
    const { client } = make(); await client.connect(); await client.connect();
    expect(FakeSocket.instances).toHaveLength(1); expect(client.connectionState).toBe("connecting");
    await expect(client.startMic()).rejects.toThrow("Wait for your student");
    const ws = FakeSocket.instances[0]; ws.onopen?.();
    expect(ws.sent[0].type).toBe("session.update");
    expect(new URL(ws.url).searchParams.get("model")).toBe(credentials.model);
    expect((ws.sent[0].session as { model: string }).model).toBe(credentials.model);
    expect(ws.protocols).toEqual(["realtime", `bai-client-secret.${credentials.value}`]);
    ws.receive({ type: "session.created" });
    expect(client.connectionState).toBe("open"); client.disconnect();
  });
  it("keeps typed human messages visible and grounded", async () => {
    const { client, onServerEvent, onKnowledgeChange } = make(); const ws = await ready(client);
    client.sendUserText("The gradient points uphill.");
    expect(onServerEvent).toHaveBeenCalledWith(expect.objectContaining({ transcript: "The gradient points uphill." }));
    const call = { type: "response.function_call_arguments.done", call_id: "c1", name: "update_understanding", arguments: JSON.stringify({ concept: "gradient_direction", status: "partial", evidence: "The gradient points uphill." }) };
    ws.receive({ type: "response.created" }); ws.receive(call); ws.receive(call);
    ws.receive({ type: "response.done", response: { output: [{ type: "function_call", call_id: "c1", name: call.name, arguments: call.arguments }] } });
    await vi.waitFor(() => expect(ws.sent.filter(e => (e.item as { type?: string } | undefined)?.type === "function_call_output")).toHaveLength(1));
    expect(onKnowledgeChange).toHaveBeenLastCalledWith(expect.objectContaining({ gradient_direction: expect.objectContaining({ status: "partial" }) }));
    expect(ws.sent.filter(e => e.type === "response.create")).toHaveLength(2); // typed turn + exactly one tool continuation
    client.disconnect();
  });
  it("stops mic and queued playback on disconnect and ignores late events", async () => {
    const { client } = make(); const ws = await ready(client); await client.startMic();
    expect(client.micActive).toBe(true); client.disconnect();
    await vi.waitFor(() => expect(client.micActive).toBe(false));
    expect(audio.flush).toHaveBeenCalled(); expect(client.connectionState).toBe("closed");
    ws.receive({ type: "session.created" }); expect(client.connectionState).toBe("closed");
  });
  it("does not open a late socket when a token request was cancelled", async () => {
    let resolve!: (key: RealtimeCredentials) => void;
    const token = new Promise<RealtimeCredentials>(r => { resolve = r; });
    const client = new RealtimeClient({ tokenProvider: () => token });
    const pending = client.connect(); client.disconnect(); resolve(credentials); await pending;
    expect(FakeSocket.instances).toHaveLength(0); expect(client.connectionState).toBe("closed");
  });
  it("uses the official interruption path to flush and truncate played audio", async () => {
    const { client } = make(); const ws = await ready(client);
    ws.receive({ type: "response.output_item.added", item: { type: "message", id: "alex-1" } });
    ws.receive({ type: "input_audio_buffer.speech_started" });
    await vi.waitFor(() => expect(ws.sent).toContainEqual({ type: "conversation.item.truncate", item_id: "alex-1", content_index: 0, audio_end_ms: 120 }));
    client.disconnect();
  });
  it("stays silent after a completed response with no tool continuation", async () => {
    const { client } = make(); const ws = await ready(client);
    ws.receive({ type: "response.created", response: { id: "r1" } });
    ws.receive({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
    await Promise.resolve();
    expect(ws.sent.filter(e => e.type === "response.create")).toHaveLength(0);
    client.disconnect();
  });
  it("does not create a tool continuation after the response was cancelled", async () => {
    const { client } = make(); const ws = await ready(client);
    ws.receive({ type: "response.created", response: { id: "r1" } });
    ws.receive({ type: "response.function_call_arguments.done", call_id: "cancelled-call", name: "update_understanding", arguments: "{}" });
    ws.receive({ type: "input_audio_buffer.speech_started", item_id: "u2" });
    ws.receive({ type: "response.done", response: { id: "r1", status: "cancelled", output: [] } });
    await vi.waitFor(() => expect(ws.sent.some(e => (e.item as { type?: string } | undefined)?.type === "function_call_output")).toBe(true));
    expect(ws.sent.filter(e => e.type === "response.create")).toHaveLength(0);
    client.disconnect();
  });
});

it("executes drawing calls once on the active voice session and returns structured IDs", async () => {
  const onDrawingTool = vi.fn(() => ({ summary: "Applied", revision: 1, objects: [{ id: "arrow", owner: "ai" }] }));
  const client = new RealtimeClient({ tokenProvider: async () => credentials, onDrawingTool }); const ws = await ready(client);
  const call = { type: "response.function_call_arguments.done", call_id: "drawing", name: "draw_shapes", arguments: "{}" };
  ws.receive({ type: "response.created" }); ws.receive(call); ws.receive(call);
  ws.receive({ type: "response.done", response: { status: "completed", output: [{ ...call, type: "function_call" }] } });
  await vi.waitFor(() => expect(ws.sent.filter(e => e.type === "response.create")).toHaveLength(1));
  expect(onDrawingTool).toHaveBeenCalledOnce();
  const output = ws.sent.find(e => (e.item as { type?: string } | undefined)?.type === "function_call_output")!.item as { output: string };
  expect(JSON.parse(output.output)).toMatchObject({ revision: 1, objects: [{ id: "arrow" }] });
  expect(client.connectionState).toBe("open"); expect(FakeSocket.instances).toHaveLength(1); client.disconnect();
});
it("rejects drawing calls discovered in cancelled responses after barge-in", async () => {
  const onDrawingTool = vi.fn(); const client = new RealtimeClient({ tokenProvider: async () => credentials, onDrawingTool }); const ws = await ready(client);
  ws.receive({ type: "response.created" }); ws.receive({ type: "input_audio_buffer.speech_started" });
  ws.receive({ type: "response.done", response: { status: "cancelled", output: [{ type: "function_call", call_id: "late", name: "draw_shapes", arguments: "{}" }] } });
  await vi.waitFor(() => expect(ws.sent.some(e => (e.item as { call_id?: string } | undefined)?.call_id === "late")).toBe(true));
  expect(onDrawingTool).not.toHaveBeenCalled(); expect(ws.sent.filter(e => e.type === "response.create")).toHaveLength(0); client.disconnect();
});

it("grounds live student responses and drawings in earned state without exposing evaluator answers", async () => {
  const { mockLesson } = await import("../src/state/lesson");
  const onDrawingTool = vi.fn(() => ({ summary: "Drawn" }));
  const secret = "PRIVATE reference answer: sigmoid derivative and chain rule";
  const client = new RealtimeClient({ tokenProvider: async () => credentials, lesson: { ...mockLesson("Neural networks"), mock: false }, onDrawingTool,
    assessEvidence: async () => ({ matchedCriteria: [], matchedConcepts: [], topicFactTaught: true, misconception: true, groundTruth: secret, reason: secret }) });
  const ws = await ready(client);
  const tool = async (call_id: string, name: string, args: object) => {
    ws.receive({ type: "response.created" });
    ws.receive({ type: "response.function_call_arguments.done", call_id, name, arguments: JSON.stringify(args) });
    ws.receive({ type: "response.done", response: { status: "completed" } });
    await vi.waitFor(() => expect(ws.sent.some(e => (e.item as { call_id?: string } | undefined)?.call_id === call_id)).toBe(true));
    return JSON.parse((ws.sent.find(e => (e.item as { call_id?: string } | undefined)?.call_id === call_id)!.item as { output: string }).output);
  };
  const args = { shapes: [{ id: "a", tool: "circle", points: [{ x: .1, y: .2 }, { x: .2, y: .3 }] }], intent: "Draw a neural network", evidence_ids: [] };
  expect(await tool("before", "draw_shapes", args)).toMatchObject({ error: "untaught_drawing" });
  expect(onDrawingTool).not.toHaveBeenCalled();
  client.sendUserText("A neural network has connected nodes. We draw nodes as circles joined by lines.");
  const source = ws.sent.filter(e => (e.item as { role?: string } | undefined)?.role === "user").at(-1)!.item as { content: { text: string }[] };
  const transcript = source.content[0].text;
  // The typed event uses a generated human source ID; get it from callback-free
  // evidence matching by inspecting the returned safe prepare_response state.
  ws.receive({ type: "response.created" });
  ws.receive({ type: "response.function_call_arguments.done", call_id: "teach", name: "update_understanding", arguments: JSON.stringify({ concept: "topic_fact", evidence: transcript }) });
  ws.receive({ type: "response.done", response: { status: "completed" } });
  await vi.waitFor(() => expect(ws.sent.some(e => (e.item as { call_id?: string } | undefined)?.call_id === "teach")).toBe(true));
  const prepared = await tool("prepare", "prepare_response", { text: "Could we try a simple example?", evidence_ids: [] });
  const factId = prepared.knowledge.facts[0].id;
  expect(prepared.knowledge.facts[0].text).toBe(transcript);
  const after = await tool("after", "draw_shapes", { ...args, evidence_ids: [factId] });
  expect(after.summary).toBe("Drawn");
  expect(onDrawingTool).toHaveBeenCalledWith("draw_shapes", { shapes: args.shapes });
  expect(JSON.stringify(ws.sent)).not.toContain(secret);
  client.disconnect();
});

it("checks complete tagged speech before synthesis and shows only the approved transcript", async () => {
  const { mockLesson } = await import("../src/state/lesson");
  const onServerEvent = vi.fn();
  const fetch = vi.fn(async () => ({ ok: true, body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) } }));
  vi.stubGlobal("fetch", fetch);
  const client = new RealtimeClient({ tokenProvider: async () => credentials, lesson: mockLesson("Neural networks"), audioRenderer: "tagged-tts", onServerEvent });
  const ws = await ready(client);
  ws.receive({ type: "response.created" });
  ws.receive({ type: "response.output_audio_transcript.delta", item_id: "expert", delta: "The sigmoid derivative is" });
  ws.receive({ type: "response.output_audio_transcript.done", item_id: "expert", transcript: "The sigmoid derivative is sigmoid(x) * (1 - sigmoid(x))." });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body);
  expect(body.text).not.toContain("sigmoid"); expect(body.text).toContain("not sure");
  expect(onServerEvent.mock.calls.some(([e]) => e.type === "response.output_audio_transcript.delta")).toBe(false);
  expect(onServerEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "response.output_audio_transcript.done", transcript: body.text }));
  client.disconnect();
});

it("draws immediately after transcribed teaching without waiting for evaluator approval", async () => {
  const { mockLesson } = await import("../src/state/lesson");
  const onDrawingTool = vi.fn(() => ({ summary: "Drawn" })), onStudentKnowledgeChange = vi.fn();
  const assessEvidence = vi.fn(async () => { throw new Error("No evaluator available"); });
  const client = new RealtimeClient({ tokenProvider: async () => credentials, lesson: { ...mockLesson("Neural networks"), mock: false }, onDrawingTool, onStudentKnowledgeChange, assessEvidence });
  const ws = await ready(client);
  ws.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "spoken", transcript: "When drawing a neural network, circles are nodes and lines connect the nodes." });
  expect(onStudentKnowledgeChange).toHaveBeenLastCalledWith(expect.objectContaining({ drawing: expect.objectContaining({ ready: true }), facts: [expect.objectContaining({ sourceId: "spoken" })] }));
  const shapes = [{ id: "node", tool: "circle", points: [{ x: .1, y: .1 }, { x: .2, y: .2 }] }];
  ws.receive({ type: "response.created" });
  ws.receive({ type: "response.function_call_arguments.done", call_id: "draw-explained", name: "draw_shapes", arguments: JSON.stringify({ intent: "I'll sketch an annotated neural network layout", shapes }) });
  ws.receive({ type: "response.done", response: { status: "completed" } });
  await vi.waitFor(() => expect(onDrawingTool).toHaveBeenCalledWith("draw_shapes", { shapes }));
  expect(assessEvidence).not.toHaveBeenCalled(); client.disconnect();
});
