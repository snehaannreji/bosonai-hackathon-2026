import { Room, RoomEvent, Track, type RemoteAudioTrack, type RemoteVideoTrack } from "livekit-client";
import type { Activity, AudioRenderer, RealtimeCallbacks } from "./RealtimeClient";
import type { KnowledgeState } from "../state/knowledge";
import type { ServerEvent } from "./events";
import { EmotionAcknowledgmentTracker } from "./emotionAcknowledgment";
import { isSpeechEmotion } from "./speechTags";

async function post(path: string, body = {}, keepalive = false) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Avatar request failed (${response.status}).`);
  return data;
}

/** LiveKit handles microphone/WebRTC transport. Only Boson's synchronized
 * avatar audio is played; no browser PCM player runs in this mode. */
export class LiveAvatarClient {
  private room: Room | null = null;
  private events: EventSource | null = null;
  private lessonId: string | null = null;
  private generation = 0;
  private active = false;
  private mic = false;
  private voiceReady = false;
  private videoReady = false;
  private elements = new Map<RemoteAudioTrack, HTMLMediaElement>();
  private meter: ReturnType<typeof setInterval> | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private release: Promise<unknown> = Promise.resolve();
  private emotionAcknowledgment: EmotionAcknowledgmentTracker;
  private unload = () => { if (this.lessonId) navigator.sendBeacon(`/api/avatar/lessons/${this.lessonId}/end`, ""); };
  constructor(private cb: RealtimeCallbacks, private avatarId: string, private onVideo: (track: RemoteVideoTrack | null) => void, private audioRenderer: AudioRenderer = "realtime") {
    this.emotionAcknowledgment = new EmotionAcknowledgmentTracker(result => this.cb.onLog?.({
      id: Date.now() + Math.random(),
      dir: "info",
      type: result.type,
      at: Date.now(),
      raw: result,
    }));
  }
  get micActive() { return this.mic; }

  async connect() {
    if (this.active) return;
    this.active = true;
    this.voiceReady = false; this.videoReady = false;
    const generation = ++this.generation;
    this.cb.onConnectionState?.("connecting");
    const room = new Room(); this.room = room;
    room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (participant.identity !== "boson-avatar") return;
      if (track.kind === Track.Kind.Video) { this.onVideo(track as RemoteVideoTrack); this.videoReady = true; this.maybeReady(); }
      if (track.kind === Track.Kind.Audio) {
        const audio = track as RemoteAudioTrack;
        const element = audio.attach(); element.style.display = "none";
        document.body.appendChild(element); this.elements.set(audio, element);
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
      if (participant.identity !== "boson-avatar") return;
      if (track.kind === Track.Kind.Video) { this.videoReady = false; this.onVideo(null); }
      if (track.kind === Track.Kind.Audio) { const audio = track as RemoteAudioTrack; audio.detach().forEach(element => element.remove()); this.elements.delete(audio); }
    });
    room.on(RoomEvent.Disconnected, () => { if (this.active) this.fail("LiveKit disconnected. Start a new avatar lesson to reconnect."); });
    room.on(RoomEvent.ParticipantDisconnected, participant => {
      if (this.active && participant.identity === "boson-avatar") this.fail("Boson’s avatar left the room. End this lesson and start a new one.");
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (!room.canPlaybackAudio) this.cb.onError?.("Click Start microphone or send a message to enable avatar sound.");
    });
    try {
      await room.startAudio();
      const lesson = await post("/api/avatar/lessons", {
        avatarId: this.avatarId,
        lessonId: this.cb.lesson?.id,
        ...(this.audioRenderer === "tagged-tts" ? { audioRenderer: this.audioRenderer } : {}),
      }) as { id: string; url: string; token: string };
      if (generation !== this.generation) { await post(`/api/avatar/lessons/${lesson.id}/end`); return; }
      this.lessonId = lesson.id;
      window.addEventListener("pagehide", this.unload);
      this.events = new EventSource(`/api/avatar/lessons/${lesson.id}/events`);
      this.events.onmessage = event => {
        if (generation !== this.generation) return;
        const message = JSON.parse(event.data) as { kind: string; event?: ServerEvent; state?: KnowledgeState; activity?: Activity; message?: string; emotion?: string; tags?: string; item_id?: string };
        if (message.kind === "server_event" && message.event) {
          this.cb.onServerEvent?.(message.event);
          this.cb.onLog?.({ id: Date.now() + Math.random(), dir: "recv", type: message.event.type, at: Date.now(), raw: message.event });
          if (message.event.type === "client.emotion_used" && isSpeechEmotion(message.event.emotion)) {
            this.emotionAcknowledgment.noteEmotion(message.event.emotion, typeof message.event.item_id === "string" ? message.event.item_id : undefined);
          }
          if (message.event.type === "conversation.item.input_audio_transcription.completed" && typeof message.event.transcript === "string") {
            this.emotionAcknowledgment.observeTeacher(message.event.transcript);
          }
          if (message.event.type === "error") this.cb.onError?.(String((message.event.error as { message?: string } | undefined)?.message ?? "Boson reported a voice session error."));
        } else if (message.kind === "knowledge" && message.state) this.cb.onKnowledgeChange?.(message.state);
        else if (message.kind === "emotion" && isSpeechEmotion(message.emotion)) {
          this.emotionAcknowledgment.noteEmotion(message.emotion, message.item_id);
          this.cb.onLog?.({ id: Date.now() + Math.random(), dir: "info", type: "client.emotion_used", at: Date.now(), raw: message });
        }
        else if (message.kind === "tts_error") this.cb.onError?.(message.message ?? "Tagged speech synthesis failed.");
        else if (message.kind === "activity" && message.activity) this.cb.onActivity?.(message.activity === "listening" && !this.mic ? "idle" : message.activity);
        else if (message.kind === "ready") { this.voiceReady = true; this.maybeReady(); }
        else if (message.kind === "error") this.fail(message.message ?? "Avatar session failed.");
        else if (message.kind === "closed") this.disconnect();
      };
      this.events.onerror = () => { if (this.active) this.fail("Lost connection to the avatar agent. Start a new lesson to reconnect."); };
      this.timeout = setTimeout(() => this.fail("The avatar did not become ready. Check Boson capacity and LiveKit settings, then start a new lesson."), 90000);
      await room.connect(lesson.url, lesson.token);
      if (generation !== this.generation) return;
      await post(`/api/avatar/lessons/${lesson.id}/start`);
    } catch (error) { if (generation === this.generation) this.fail(error instanceof Error ? error.message : "Could not connect the avatar."); }
  }
  async startMic() {
    const room = this.room;
    if (!room || !this.lessonId) throw new Error("Connect the avatar first.");
    await room.startAudio();
    await room.localParticipant.setMicrophoneEnabled(true, { echoCancellation: true, noiseSuppression: true });
    if (!this.active) { await room.localParticipant.setMicrophoneEnabled(false); return; }
    this.mic = true; this.cb.onMicChange?.(true); this.cb.onActivity?.("listening");
    this.meter = setInterval(() => this.cb.onMicLevel?.(this.room?.localParticipant.audioLevel ?? 0), 100);
  }
  async stopMic() {
    await this.room?.localParticipant.setMicrophoneEnabled(false);
    this.mic = false; this.cb.onMicChange?.(false); this.cb.onMicLevel?.(0);
    if (this.meter) { clearInterval(this.meter); this.meter = null; }
  }
  async sendUserText(text: string) {
    if (!this.lessonId) return;
    try { await this.room?.startAudio(); await post(`/api/avatar/lessons/${this.lessonId}/text`, { text }); }
    catch (error) { this.cb.onError?.(error instanceof Error ? error.message : "Could not send that explanation."); }
  }
  disconnect() {
    this.active = false; ++this.generation;
    this.events?.close(); this.events = null;
    if (this.timeout) { clearTimeout(this.timeout); this.timeout = null; }
    if (this.meter) { clearInterval(this.meter); this.meter = null; }
    window.removeEventListener("pagehide", this.unload);
    for (const [track, element] of this.elements) { track.detach(element); element.remove(); }
    this.elements.clear(); this.onVideo(null);
    const room = this.room; this.room = null;
    const id = this.lessonId; this.lessonId = null;
    this.release = Promise.all([room?.disconnect().catch(() => {}), id ? post(`/api/avatar/lessons/${id}/end`, {}, true).catch(() => {}) : undefined]);
    this.mic = false; this.cb.onMicChange?.(false); this.cb.onMicLevel?.(0); this.cb.onActivity?.("idle"); this.cb.onConnectionState?.("closed");
  }
  async close() { this.disconnect(); await this.release; }
  private maybeReady() {
    if (!this.active || !this.voiceReady || !this.videoReady) return;
    if (this.timeout) { clearTimeout(this.timeout); this.timeout = null; }
    this.cb.onConnectionState?.("open");
  }
  private fail(message: string) { this.cb.onError?.(message); this.disconnect(); }
}
