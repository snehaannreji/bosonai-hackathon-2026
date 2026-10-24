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
});
