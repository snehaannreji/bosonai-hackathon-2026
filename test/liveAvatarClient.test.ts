import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
interface TestRoom { handlers: Map<string, (...args: unknown[]) => void>; localParticipant: { audioLevel: number; setMicrophoneEnabled: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
const state = vi.hoisted(() => ({ rooms: [] as TestRoom[] }));
vi.mock("livekit-client", () => ({
  RoomEvent: { TrackSubscribed: "track", TrackUnsubscribed: "untrack", Disconnected: "disconnected", ParticipantDisconnected: "participant-left", AudioPlaybackStatusChanged: "audio" },
  Track: { Kind: { Video: "video", Audio: "audio" } },
  Room: class {
    handlers = new Map();
    localParticipant = { audioLevel: 0.1, setMicrophoneEnabled: vi.fn(async () => {}) };
    connect = vi.fn(async () => {}); disconnect = vi.fn(async () => {}); startAudio = vi.fn(async () => {});
    on(event: string, cb: (...args: unknown[]) => void) { this.handlers.set(event, cb); }
    constructor() { state.rooms.push(this); }
  },
}));
import { LiveAvatarClient } from "../src/realtime/LiveAvatarClient";
class Events {
  static instances: Events[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor() { Events.instances.push(this); }
  emit(message: object) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
const fetchMock = vi.fn(async (_path: string, _options?: unknown) => ({ ok: true, json: async () => ({ id: "lesson-1", url: "wss://test.livekit.cloud", token: "scoped-user-token" }) }));
const callbacks = () => ({ tokenProvider: vi.fn(async () => { throw new Error("No direct Boson browser connection in avatar mode"); }), onConnectionState: vi.fn(), onMicChange: vi.fn(), onMicLevel: vi.fn(), onActivity: vi.fn(), onError: vi.fn(), onKnowledgeChange: vi.fn(), onServerEvent: vi.fn(), onLog: vi.fn() });
beforeEach(() => {
  vi.useFakeTimers(); state.rooms = []; Events.instances = []; fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("EventSource", Events);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { body: { appendChild: vi.fn() } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const video = { kind: "video" };
const open = async (client: LiveAvatarClient) => { await client.connect(); Events.instances[0].emit({ kind: "ready" }); state.rooms[0].handlers.get("track")?.(video, {}, { identity: "boson-avatar" }); };
describe("integrated Boson talking-avatar client", () => {
  it("passes the selected account avatar ID through the existing lesson connection", async () => {
    const client = new LiveAvatarClient(callbacks(), "owned_alex_test", vi.fn());
    await open(client);
    expect(fetchMock).toHaveBeenCalledWith("/api/avatar/lessons", expect.objectContaining({
      body: JSON.stringify({ avatarId: "owned_alex_test" }),
    }));
    await client.close();
  });
  it("opens only after both the agent and real avatar video track are ready", async () => {
    const cb = callbacks(); const onVideo = vi.fn(); const client = new LiveAvatarClient(cb, "builtin_claire_v1", onVideo);
    await client.connect(); Events.instances[0].emit({ kind: "ready" });
    expect(cb.onConnectionState).not.toHaveBeenCalledWith("open");
    state.rooms[0].handlers.get("track")?.(video, {}, { identity: "someone-else" });
    expect(onVideo).not.toHaveBeenCalled();
    state.rooms[0].handlers.get("track")?.(video, {}, { identity: "boson-avatar" });
    expect(cb.onConnectionState).toHaveBeenLastCalledWith("open");
    expect(cb.tokenProvider).not.toHaveBeenCalled();
    await client.close();
  });
  it("uses LiveKit microphone controls and releases room and server session on end", async () => {
    const cb = callbacks(); const client = new LiveAvatarClient(cb, "builtin_claire_v1", vi.fn()); await open(client);
    await client.startMic(); expect(client.micActive).toBe(true);
    expect(state.rooms[0].localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, expect.objectContaining({ echoCancellation: true }));
    vi.advanceTimersByTime(100); expect(cb.onMicLevel).toHaveBeenCalledWith(0.1);
    await client.stopMic(); expect(client.micActive).toBe(false);
    await client.close();
    expect(state.rooms[0].disconnect).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/api/avatar/lessons/lesson-1/end", expect.objectContaining({ keepalive: true }));
    expect(Events.instances[0].close).toHaveBeenCalled();
  });
  it("passes the selected tagged TTS renderer to the avatar session", async () => {
    const client = new LiveAvatarClient(callbacks(), "builtin_claire_v1", vi.fn(), "tagged-tts");
    await open(client);
    expect(fetchMock).toHaveBeenCalledWith("/api/avatar/lessons", expect.objectContaining({
      body: JSON.stringify({ avatarId: "builtin_claire_v1", lessonId: undefined, audioRenderer: "tagged-tts" }),
    }));
    await client.close();
  });
  it("logs tagged avatar emotions and tracks the next teacher acknowledgment", async () => {
    const cb = callbacks();
    const client = new LiveAvatarClient(cb, "builtin_claire_v1", vi.fn(), "tagged-tts");
    await open(client);
    const events = Events.instances[0];
    events.emit({ kind: "emotion", item_id: "response-1", emotion: "anger", tags: "<|emotion:anger|><|style:shouting|>" });
    events.emit({ kind: "server_event", event: { type: "conversation.item.input_audio_transcription.completed", transcript: "I hear that you're frustrated." } });
    expect(cb.onLog).toHaveBeenCalledWith(expect.objectContaining({
      type: "client.emotion_used",
      raw: expect.objectContaining({ emotion: "anger", tags: "<|emotion:anger|><|style:shouting|>" }),
    }));
    expect(cb.onLog).toHaveBeenCalledWith(expect.objectContaining({
      type: "client.emotion_acknowledgment",
      raw: expect.objectContaining({ emotion: "anger", acknowledged: true }),
    }));
    await client.close();
  });
  it("plays only the avatar's synchronized audio track, and detaches it on cleanup", async () => {
    const cb = callbacks(); const client = new LiveAvatarClient(cb, "builtin_claire_v1", vi.fn()); await open(client);
    const element = { style: { display: "" }, remove: vi.fn() };
    const audio = { kind: "audio", attach: vi.fn(() => element), detach: vi.fn() };
    const track = state.rooms[0].handlers.get("track")!;
    track(audio, {}, { identity: "agent" }); expect(audio.attach).not.toHaveBeenCalled();
    track(audio, {}, { identity: "boson-avatar" }); expect(audio.attach).toHaveBeenCalledTimes(1);
    await client.close(); expect(audio.detach).toHaveBeenCalledWith(element); expect(element.remove).toHaveBeenCalled();
  });
  it("routes transcripts/state to the existing dashboard and reports avatar failure without fallback", async () => {
    const cb = callbacks(); const client = new LiveAvatarClient(cb, "builtin_claire_v1", vi.fn()); await open(client);
    const events = Events.instances[0];
    events.emit({ kind: "server_event", event: { type: "input_audio_buffer.speech_started", item_id: "u1" } });
    expect(cb.onServerEvent).toHaveBeenCalledWith({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    events.emit({ kind: "error", message: "Boson capacity is full." });
    expect(cb.onError).toHaveBeenCalledWith("Boson capacity is full.");
    expect(cb.onConnectionState).toHaveBeenLastCalledWith("closed");
    expect(cb.tokenProvider).not.toHaveBeenCalled();
    await client.close();
  });
});
