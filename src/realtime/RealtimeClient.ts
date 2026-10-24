import { knowledgeInstructions, type StudentKnowledgeSnapshot } from "../state/studentKnowledge";
import { isDrawingTool, type DrawingHandler } from "../whiteboard/drawingTools";
import {
  SERVER,
  describeClose,
  functionCallOutput,
  inputAudioAppend,
  responseCreate,
  truncateItem,
  userTextItem,
  type ClientEvent,
  type CloseInfo,
  type ServerEvent,
} from "./events";
import { buildSessionConfig, studentPrompt, SYSTEM_PROMPT } from "./sessionConfig";
import { VisualContextChannel } from "../whiteboard/contextChannel";
import type { VisualContext } from "../whiteboard/observations";
import { RingPlayer } from "../audio/playback";
import { MicCapture } from "../audio/capture";
import { dispatch as dispatchTool } from "../tools/registry";
import { CLIENT_TOOL_RESULT } from "../state/transcriptStore";
import type { KnowledgeState, ToolResult } from "../state/knowledge";
import { createKnowledgeTracker, type KnowledgeContext } from "../state/createKnowledgeTracker";
import type { LessonDefinition, EvidenceAssessor } from "../state/lesson";
import { studentToolFeedback } from "../state/topicKnowledge";
import { buildRealtimeUrl, type RealtimeCredentials } from "./runtimeConfig";
import { buildTaggedSpeechInput, chooseSpeechEmotion, cleanSpokenTranscript } from "./speechTags";
import { EmotionAcknowledgmentTracker } from "./emotionAcknowledgment";

export type ConnectionState = "idle" | "connecting" | "open" | "closing" | "closed";
export type AudioRenderer = "realtime" | "tagged-tts";

/** Coarse state for the status bar. */
export type Activity = "idle" | "listening" | "thinking" | "speaking";

export interface LogEntry {
  id: number;
  dir: "recv" | "send" | "info";
  type: string;
  at: number;
  raw: unknown;
}

export interface RealtimeCallbacks {
  onConnectionState?: (s: ConnectionState) => void;
  onActivity?: (a: Activity) => void;
  onLog?: (entry: LogEntry) => void;
  onServerEvent?: (evt: ServerEvent) => void;
  onClose?: (info: CloseInfo) => void;
  /** Fired when the microphone starts or stops. */
  onMicChange?: (active: boolean) => void;
  /** Live microphone level (RMS, ~10 per second) for the meter. */
  onMicLevel?: (rms: number) => void;
  /** Mints a fresh ephemeral key for each connection. Required. */
  tokenProvider: () => Promise<RealtimeCredentials>;
  onDrawingTool?: DrawingHandler;
  lesson?: LessonDefinition;
  assessEvidence?: EvidenceAssessor;
  onKnowledgeChange?: (state: KnowledgeState) => void;
  onStudentKnowledgeChange?: (state: StudentKnowledgeSnapshot) => void;
  onError?: (message: string) => void;
  audioRenderer?: AudioRenderer;
}

let logSeq = 0;

/**
 * Everything to do with the WebSocket lives here, behind a callback interface.
 * React components never touch the socket — they render what this reports.
 */
export class RealtimeClient {
  private visualContext: VisualContextChannel | null = null;
  private ws: WebSocket | null = null;
  private state: ConnectionState = "idle";
  private player: RingPlayer;
  private capture: MicCapture;
  private cb: RealtimeCallbacks;
  private knowledge: KnowledgeContext;
  private turnEpoch = 0;
  private lastStudentQuestion: string | undefined;
  private drawingCalls = 0;
  private drawingInterrupted = false;
  private generation = 0;
  private sessionReady = false;
  private taggedAudioPending = false;
  private taggedAudioStarted = false;
  private taggedAudioPlaying = false;
  private taggedAudioAbort: AbortController | null = null;
  private taggedItems = new Set<string>();
  private emotionAcknowledgment: EmotionAcknowledgmentTracker;

  /**
   * The assistant item currently producing audio. This is what we truncate on
   * barge-in, so we track it from whichever event mentions it first.
   */
  private currentAssistantItemId: string | null = null;

  /**
   * Every call_id we have already started running.
   *
   * Tool calls can be announced twice — once by
   * response.function_call_arguments.done and again in response.done's output
   * list. Without this Set you execute each one twice, which for a search is
   * merely wasteful and for anything that writes is a real bug.
   */
  private handledCallIds = new Set<string>();

  /**
   * Tool calls belonging to the response currently being generated.
   *
   * The model can request several at once. Each result must come back as its
   * own function_call_output, but there must be exactly ONE response.create
   * afterwards — so the batch is collected here and flushed together.
   */
  private toolBatch: { promises: Promise<void>[]; outputs: ClientEvent[]; epoch: number } | null = null;

  /**
   * ⚠ The single most important line in this file.
   *
   * React StrictMode mounts every component twice in development, so an effect
   * that calls connect() opens two sockets.
   *
   * The API does not stop you: verified 2026-08-07, two sockets sharing one
   * ephemeral key both get their own session.created with different session
   * ids, and both keep working. So there is no error to notice — just two live
   * conversations, two audio streams playing over each other, and two sessions
   * on the bill. It sounds like the model is echoing itself.
   *
   * Guarding here rather than in the component means it holds for every caller,
   * including a user double-clicking the button.
   */
  private connecting = false;

  constructor(callbacks: RealtimeCallbacks) {
    this.cb = callbacks;
    this.emotionAcknowledgment = new EmotionAcknowledgmentTracker(result => this.log("info", result.type, result));
    this.knowledge = createKnowledgeTracker(state => {
      callbacks.onKnowledgeChange?.(state);
      if (this.knowledge?.student) callbacks.onStudentKnowledgeChange?.(this.knowledge.student.snapshot());
      this.refreshStudentKnowledge();
    }, callbacks.lesson, callbacks.assessEvidence, state => {
      callbacks.onStudentKnowledgeChange?.(state); this.refreshStudentKnowledge();
    });
    this.player = new RingPlayer((speaking) => {
      if (!speaking) {
        this.taggedAudioPlaying = false;
        this.setActivity(this.taggedAudioPending ? "thinking" : this.capture?.active ? "listening" : "idle");
      }
    });
    this.capture = new MicCapture(
      (base64) => this.send(inputAudioAppend(base64)),
      (rms) => this.cb.onMicLevel?.(rms),
    );
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get micActive(): boolean {
    return this.capture.active;
  }

  /** Start streaming microphone audio. Throws if permission is denied. */
  async startMic(): Promise<void> {
    if (!this.sessionReady) throw new Error("Wait for your student to connect before enabling the microphone.");
    try { await this.capture.start(); }
    catch (error) { await this.capture.stop(); throw error; }
    if (!this.sessionReady) { await this.capture.stop(); return; }
    this.cb.onMicChange?.(true);
    this.setActivity("listening");
    this.info("Microphone started.");
  }

  async stopMic(): Promise<void> {
    await this.capture.stop();
    this.cb.onMicChange?.(false);
    this.cb.onMicLevel?.(0);
    this.setActivity("idle");
    this.info("Microphone stopped.");
  }

  /** Mint a key and open the socket. Safe to call twice; the second is ignored. */
  async connect(): Promise<void> {
    if (this.connecting || this.state === "open" || this.state === "connecting") {
      this.info("connect() ignored — a connection is already active.");
      return;
    }
    this.connecting = true;
    const generation = ++this.generation;
    this.sessionReady = false;
    this.knowledge.reset();
    this.drawingCalls = 0; this.drawingInterrupted = false; this.lastStudentQuestion = undefined;
    this.handledCallIds.clear();
    this.toolBatch = null;
    this.currentAssistantItemId = null;
    this.taggedItems.clear();
    this.taggedAudioPending = false;
    this.taggedAudioStarted = false;
    this.setState("connecting");

    // Must happen inside the user gesture that triggered this call, or the
    // browser leaves the AudioContext suspended and playback is silent.
    let credentials: RealtimeCredentials;
    let websocketUrl: string;
    try {
      await this.player.resume();
      credentials = await this.cb.tokenProvider();
      websocketUrl = buildRealtimeUrl(credentials);
    } catch (e) {
      if (generation !== this.generation) return;
      this.connecting = false;
      this.setState("closed");
      const message = e instanceof Error ? e.message : String(e);
      this.cb.onClose?.({ code: 0, reason: "", message: `Token error: ${message}`, retryable: false });
      return;
    }
    if (generation !== this.generation) return;

    // A browser cannot set headers on a WebSocket handshake, so there is no
    // `Authorization` header to use. The API takes the credential as a
    // subprotocol instead: "realtime" names the protocol, and the second entry
    // carries the ephemeral key.
    const ws = new WebSocket(websocketUrl, ["realtime", `bai-client-secret.${credentials.value}`]);
    this.ws = ws;
    this.visualContext = new VisualContextChannel(this.studentInstructions(), event => this.send(event));

    ws.onopen = () => {
      if (generation !== this.generation) return;
      this.connecting = false;
      this.info("Socket open — sending session.update.");
      this.send(buildSessionConfig(credentials.model, this.cb.lesson));
    };
    ws.onmessage = (ev) => { if (generation === this.generation) this.onMessage(ev); };
    ws.onerror = () => this.info("WebSocket error — the close code below has the detail.");
    ws.onclose = (ev) => {
      this.visualContext?.close(); this.visualContext = null;
      if (generation !== this.generation) return;
      this.connecting = false;
      this.sessionReady = false;
      this.ws = null;
      void this.stopMic();
      void this.player.flush();
      const info = describeClose(ev.code, ev.reason);
      this.log("info", `close:${ev.code}`, info);
      this.setState("closed");
      this.setActivity("idle");
      this.cb.onClose?.(info);
    };
  }

  disconnect(): void {
    this.visualContext?.close(); this.visualContext = null;
    ++this.generation;
    this.connecting = false;
    this.sessionReady = false;
    this.toolBatch = null;
    if (this.ws && (this.state === "open" || this.state === "connecting")) {
      this.setState("closing");
      this.ws.close(1000, "client disconnect");
    } else {
      this.setState("closed");
    }
    this.ws = null;
    this.taggedAudioAbort?.abort();
    this.taggedAudioAbort = null;
    this.taggedAudioPending = false;
    this.taggedAudioPlaying = false;
    this.setState("closed");
    void this.player.flush();
    this.setActivity("idle");
    void this.capture.stop().then(() => this.cb.onMicChange?.(false));
  }

  /** Send a typed message and ask for a reply. */
  sendUserText(text: string): void {
    if (this.state !== "open") {
      this.info("sendUserText ignored — the socket is not open.");
      return;
    }
    this.drawingCalls = 0;
    const item_id = `typed-${Date.now()}-${++logSeq}`;
    this.knowledge.observeHuman(item_id, text, this.lastStudentQuestion); this.lastStudentQuestion = undefined;
    this.cb.onServerEvent?.({ type: SERVER.transcriptionCompleted, item_id, transcript: text });
    this.send(userTextItem(text));
    // Adding the message does not start a turn. This does.
    this.send(responseCreate());
    this.setActivity("thinking");
  }

  send(evt: ClientEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(evt));
    this.log("send", evt.type, evt);
  }

  private studentInstructions() {
    const base = this.cb.lesson ? studentPrompt(this.cb.lesson) : SYSTEM_PROMPT;
    return this.knowledge.student ? knowledgeInstructions(base, this.knowledge.student.snapshot()) : base;
  }
  private refreshStudentKnowledge() {
    if (this.sessionReady && this.visualContext) void this.visualContext.setBase(this.studentInstructions()).catch(() => {});
  }
  updateWhiteboard(context: VisualContext) {
    if (!this.sessionReady || !this.visualContext) return Promise.reject(new Error("Start the voice conversation before sharing the board."));
    return this.visualContext.update(context);
  }

  async close(): Promise<void> {
    this.disconnect();
    await this.capture.stop();
    await this.player.close();
  }

  // --- internals -------------------------------------------------------------

  private onMessage(ev: MessageEvent): void {
    let evt: ServerEvent;
    try {
      evt = JSON.parse(ev.data as string);
    } catch {
      this.info(`Ignoring non-JSON message: ${String(ev.data).slice(0, 80)}`);
      return;
    }

    // Log first, act second. Everything the server says shows up in the drawer,
    // including the events no branch below handles.
    this.log("recv", evt.type, evt);
    this.visualContext?.handle(evt);
    // Tagged speech is complete before playback. Keep the visible transcript
    // aligned with the validated words instead of streaming rejected text.
    if (this.cb.audioRenderer === "tagged-tts" && this.knowledge.student) {
      if (evt.type === SERVER.audioTranscriptDelta) return;
      if (evt.type === SERVER.audioTranscriptDone && typeof evt.transcript === "string") {
        const review = this.knowledge.student.review(evt.transcript);
        if (!review.allowed) this.log("info", "client.knowledge_guard", { item_id: evt.item_id, reason: review.reason });
        evt = { ...evt, transcript: review.approved_text };
      }
    }
    this.cb.onServerEvent?.(evt);
    if (evt.type === SERVER.transcriptionCompleted && typeof evt.item_id === "string" && typeof evt.transcript === "string") {
      this.knowledge.observeHuman(evt.item_id, evt.transcript, this.lastStudentQuestion); this.lastStudentQuestion = undefined;
      this.emotionAcknowledgment.observeTeacher(evt.transcript);
    }

    switch (evt.type) {
      case SERVER.sessionCreated:
      case SERVER.sessionUpdated:
        this.sessionReady = true;
        this.setState("open");
        break;
      case SERVER.responseCreated:
        this.drawingInterrupted = false;
        ++this.turnEpoch;
        // A new assistant turn. Zero the played-sample counter so the truncate
        // maths below measures into *this* reply, not the whole session.
        this.player.reset();
        this.taggedAudioAbort?.abort();
        this.taggedAudioPending = this.cb.audioRenderer === "tagged-tts";
        this.taggedAudioStarted = false;
        this.toolBatch = null;
        this.setActivity("thinking");
        this.info(`AI response started${responseId(evt) ? ` (${responseId(evt)})` : ""}.`);
        break;

      case SERVER.functionCallArgsDone:
        this.onFunctionCallArgsDone(evt);
        break;

      case SERVER.responseDone:
        this.onResponseDone(evt);
        this.info(`AI response finished${responseId(evt) ? ` (${responseId(evt)})` : ""} with status ${responseStatus(evt) ?? "unknown"}.`);
        break;

      case SERVER.audioTranscriptDone:
        if (typeof evt.transcript === "string" && this.knowledge.student) {
          const review = this.knowledge.student.review(evt.transcript);
          this.lastStudentQuestion = review.allowed ? evt.transcript.match(/[^.!?]*\?/gu)?.at(-1)?.trim() : undefined;
          if (!review.allowed) {
            this.log("info", "client.knowledge_guard", { item_id: evt.item_id, reason: review.reason, approved_text: review.approved_text });
            // Native realtime audio may already have played. Do not start a
            // competing response; refresh permissions for the next turn.
            this.refreshStudentKnowledge();
          }
        }
        if (this.cb.audioRenderer === "tagged-tts" && typeof evt.transcript === "string") {
          void this.playTaggedTranscript(evt);
        }
        break;

      case SERVER.speechStarted:
        this.drawingInterrupted = true; this.drawingCalls = 0;
        ++this.turnEpoch;
        // The user started talking over the model. This is the barge-in path.
        this.info(`User speech detected${typeof evt.item_id === "string" ? ` (${evt.item_id})` : ""}; interruption handling started.`);
        void this.handleBargeIn();
        break;

      case SERVER.speechStopped:
        this.info(`User speech ended${typeof evt.item_id === "string" ? ` (${evt.item_id})` : ""}.`);
        this.setActivity("thinking");
        break;

      case SERVER.outputItemAdded: {
        const item = evt.item as { id?: string; type?: string } | undefined;
        if (item?.type === "message" && typeof item.id === "string") {
          this.currentAssistantItemId = item.id;
        }
        break;
      }

      case SERVER.outputAudioDelta: {
        // The audio itself: base64 PCM16 in `delta`.
        const b64 = evt.delta;
        if (typeof b64 === "string" && b64.length > 0) {
          if (typeof evt.item_id === "string") this.currentAssistantItemId = evt.item_id;
          if (this.cb.audioRenderer !== "tagged-tts") {
            this.player.enqueueBase64(b64);
            this.setActivity("speaking");
          }
        }
        break;
      }

      case SERVER.error:
        // Never let these pass silently. A session field the server rejected is
        // reported here and nowhere else — if you are not watching, your config
        // is quietly not doing what you think it is.
        this.info(`server error: ${JSON.stringify(evt.error ?? evt)}`);
        this.cb.onError?.(String((evt.error as { message?: string } | undefined)?.message ?? "Boson reported a session error. See connection details."));
        break;

      default:
        // Unrecognised event types are normal — the server sends more than we
        // handle. They are already logged. Never throw here.
        break;
    }
  }

  // --- the tool loop ---------------------------------------------------------

  /**
   * The model has finished dictating a tool call's arguments. Start running it
   * immediately rather than waiting for response.done — the sooner it starts,
   * the sooner the model can speak the answer.
   */
  private onFunctionCallArgsDone(evt: ServerEvent): void {
    const callId = typeof evt.call_id === "string" ? evt.call_id : undefined;
    const name = typeof evt.name === "string" ? evt.name : undefined;
    if (!callId || !name) return;

    let args: Record<string, unknown> = {};
    const raw = typeof evt.arguments === "string" ? evt.arguments : undefined;
    try {
      if (raw) args = JSON.parse(raw);
    } catch {
      // Malformed arguments are the model's mistake, not a reason to crash.
      // Run the tool with nothing and let it return its own complaint.
      this.info(`could not parse arguments for ${name}: ${raw}`);
    }
    this.startToolCall(callId, name, args);
  }

  private async executeDrawing(name: string, args: Record<string, unknown>) {
    const permission = this.knowledge.student?.authorizeDrawing(name, args);
    if (permission && !permission.allowed) return permission;
    return await this.cb.onDrawingTool?.(name, permission?.args ?? args) ?? { error: "board_unavailable", summary: "Whiteboard is unavailable." };
  }
  private startToolCall(callId: string, name: string, args: Record<string, unknown>): void {
    // ⚠ The guard that stops the double-fire. See onResponseDone.
    if (this.handledCallIds.has(callId)) return;
    this.handledCallIds.add(callId);

    if (!this.toolBatch) this.toolBatch = { promises: [], outputs: [], epoch: this.turnEpoch };
    const batch = this.toolBatch;
    const generation = this.generation;
    const startedAt = Date.now();

    const p = (async () => {
      let result: unknown;
      try {
        result = name === "prepare_response" && this.knowledge.student
          ? this.knowledge.student.prepare(args)
          : isDrawingTool(name)
          ? this.drawingInterrupted ? { error: "interrupted", summary: "Drawing interrupted. Inspect board before continuing." }
            : ++this.drawingCalls > 32 ? { error: "drawing_limit", summary: "Drawing call limit reached. Wait for the teacher before continuing." }
            : await this.executeDrawing(name, args)
          : await dispatchTool(name, args, this.knowledge);
      } catch (e) {
        // A thrown handler must still produce an output, or the model waits
        // forever for a call_id that never comes back.
        this.info(`tool ${name} threw: ${e instanceof Error ? e.message : String(e)}`);
        result = { summary: "That lookup failed.", error: "tool_failed" };
      }
      // Feed the result into the transcript through the same reducer path as
      // everything else, using a synthetic event type of our own.
      if (generation !== this.generation) return;
      this.cb.onServerEvent?.({
        type: CLIENT_TOOL_RESULT,
        call_id: callId,
        result,
        ms: Date.now() - startedAt,
      });
      const output = name === "update_understanding" && this.cb.lesson && isToolResult(result)
        ? studentToolFeedback(this.cb.lesson, result) + (this.knowledge.student ? "\n" + knowledgeInstructions("", this.knowledge.student.snapshot()) : "")
        : JSON.stringify(result);
      batch.outputs.push(functionCallOutput(callId, output));
    })();

    batch.promises.push(p);
  }

  /**
   * The turn is over. If it contained tool calls, this is where we answer them.
   */
  private onResponseDone(evt: ServerEvent): void {
    if (["cancelled", "failed"].includes(responseStatus(evt) ?? "")) this.drawingInterrupted = true;
    // ⚠ The double-fire. Tool calls that already arrived via
    // function_call_arguments.done can appear AGAIN in response.done's output
    // list. We still walk it — occasionally a call shows up only here — but
    // handledCallIds means nothing runs twice.
    const output = (evt.response as { output?: unknown[] } | undefined)?.output ?? [];
    for (const raw of output) {
      const item = raw as { type?: string; name?: string; call_id?: string; arguments?: string };
      if (item?.type === "function_call" && item.call_id && item.name) {
        let args: Record<string, unknown> = {};
        try {
          if (item.arguments) args = JSON.parse(item.arguments);
        } catch {
          /* handled above */
        }

        this.startToolCall(item.call_id, item.name, args);
      }
    }

    if (this.cb.audioRenderer === "tagged-tts" && this.taggedAudioPending && !this.taggedAudioStarted) {
      this.taggedAudioPending = false;
    }
    if (this.toolBatch && this.toolBatch.promises.length > 0) {
      void this.flushToolBatch(responseStatus(evt));
    } else if (!this.taggedAudioPending && !this.taggedAudioPlaying) {
      this.setActivity(this.capture.active ? "listening" : "idle");
    }
  }

  private async playTaggedTranscript(evt: ServerEvent): Promise<void> {
    if (typeof evt.transcript !== "string") return;
    const proposed = cleanSpokenTranscript(evt.transcript).trim();
    const transcript = this.knowledge.student?.review(proposed).approved_text ?? proposed;
    const itemId = typeof evt.item_id === "string" ? evt.item_id : null;
    if (!transcript || (itemId && this.taggedItems.has(itemId))) return;
    if (itemId) {
      this.taggedItems.add(itemId);
      this.currentAssistantItemId = itemId;
    }
    const generation = this.generation;
    const turn = this.turnEpoch;
    const emotion = chooseSpeechEmotion();
    const taggedInput = emotion ? buildTaggedSpeechInput(transcript, emotion) : transcript;
    const abort = new AbortController();
    this.taggedAudioAbort?.abort();
    this.taggedAudioAbort = abort;
    this.taggedAudioPending = true;
    this.taggedAudioStarted = true;
    this.setActivity("thinking");
    this.info(`Tagged TTS selected ${taggedInput.slice(0, taggedInput.indexOf(transcript))}`);
    try {
      const response = await fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: transcript, emotion }),
        signal: abort.signal,
      });
      if (!response.ok) {
        let message = `Tagged speech synthesis failed (${response.status}).`;
        try {
          const body = await response.json() as { error?: string };
          if (typeof body.error === "string") message = body.error;
        } catch { /* Keep the status-based error when the response is not JSON. */ }
        throw new Error(message);
      }
      if (!response.body) throw new Error("Boson returned no tagged speech audio stream.");
      const reader = response.body.getReader();
      let remainder = new Uint8Array(0);
      let receivedAudio = false;
      let emotionRecorded = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (generation !== this.generation || turn !== this.turnEpoch || abort.signal.aborted) {
            await reader.cancel();
            return;
          }
          if (done) break;
          if (!value?.length) continue;
          const combined = new Uint8Array(remainder.length + value.length);
          combined.set(remainder);
          combined.set(value, remainder.length);
          const completeLength = combined.length - (combined.length % 2);
          if (completeLength > 0) {
            this.player.enqueuePcm(combined.slice(0, completeLength).buffer);
            receivedAudio = true;
            if (!emotionRecorded) {
              if (emotion) {
                this.emotionAcknowledgment.noteEmotion(emotion, itemId ?? undefined);
                this.log("info", "client.emotion_used", { emotion, item_id: itemId, transcript, tags: taggedInput.slice(0, taggedInput.indexOf(transcript)) });
              } else {
                this.log("info", "client.emotion_not_selected", { item_id: itemId, transcript });
              }
              emotionRecorded = true;
            }
            this.taggedAudioPlaying = true;
            this.setActivity("speaking");
          }
          remainder = combined.slice(completeLength);
        }
      } finally {
        reader.releaseLock();
      }
      if (remainder.length) throw new Error("Boson returned an incomplete PCM audio sample.");
      if (!receivedAudio) throw new Error("Boson returned an empty tagged speech audio stream.");
      this.taggedAudioPending = false;
      this.info(`Tagged TTS audio ready (${emotion}).`);
    } catch (error) {
      if (abort.signal.aborted) return;
      this.taggedAudioPending = false;
      this.taggedAudioPlaying = false;
      void this.player.flush();
      const message = error instanceof Error ? error.message : "Could not synthesize tagged speech.";
      this.info(message);
      this.cb.onError?.(message);
      this.setActivity(this.capture.active ? "listening" : "idle");
    }
  }

  /**
   * Wait for every tool in this turn, send one output per call_id, then exactly
   * one response.create.
   *
   * Both halves of that matter. Miss an output and the model hangs waiting for
   * a call_id it never hears back about. Send response.create per tool instead
   * of once, and you get two replies talking over each other.
   */
  private async flushToolBatch(status?: string): Promise<void> {
    const batch = this.toolBatch;
    const generation = this.generation;
    this.toolBatch = null;
    if (!batch || batch.promises.length === 0) return;

    if (batch.promises.length > 1) {
      this.info(`${batch.promises.length} tool calls in one turn — running them in parallel`);
    }
    this.setActivity("thinking");

    // Promise.all, not a loop with await: two independent lookups should take
    // as long as the slower one, not as long as both.
    await Promise.all(batch.promises);
    if (generation !== this.generation || !this.sessionReady) return;

    for (const out of batch.outputs) this.send(out);

    // A newer human turn must not be interrupted by a delayed assessment.
    if (batch.epoch === this.turnEpoch && this.drawingCalls <= 32 && status !== "cancelled" && status !== "failed") {
      this.send(responseCreate());
    } else {
      this.info(`Tool continuation suppressed (${status ?? "superseded turn"}).`);
    }
  }

  /**
   * Barge-in. Two things have to happen, and the second is the one everybody
   * forgets.
   *
   * 1. Stop playing at once. We may be holding several seconds of audio the
   *    user has not heard yet; without this, the model keeps talking over them.
   *
   * 2. Tell the server how much was actually heard. The server has already
   *    stored the whole reply as a conversation item, so its memory now
   *    contains words that never reached anyone's ears. Left alone, the model
   *    will refer back to things it "said" that the user never heard — and
   *    "sorry, what was that last bit?" gets answered from the wrong text.
   *
   * `flush()` resolves with the played-sample count converted to milliseconds,
   * which is exactly `audio_end_ms`. Note we do NOT send response.create here:
   * the server's own VAD starts the new user turn.
   */
  private async handleBargeIn(): Promise<void> {
    this.taggedAudioAbort?.abort();
    this.taggedAudioPending = false;
    this.taggedAudioPlaying = false;
    this.setActivity("listening");
    const playedMs = await this.player.flush();
    this.info(`Audio playback cleared at ${Math.round(playedMs)} ms.`);
    if (this.currentAssistantItemId && playedMs > 0) {
      this.send(truncateItem(this.currentAssistantItemId, playedMs));
      this.info(`Interrupted assistant item truncated (${this.currentAssistantItemId}).`);
    }
    this.currentAssistantItemId = null;
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.cb.onConnectionState?.(s);
  }

  private setActivity(a: Activity): void {
    this.cb.onActivity?.(a);
  }

  private info(message: string): void {
    this.log("info", "info", message);
  }

  private log(dir: LogEntry["dir"], type: string, raw: unknown): void {
    this.cb.onLog?.({ id: ++logSeq, dir, type, at: Date.now(), raw });
  }
}

function isToolResult(value: unknown): value is ToolResult {
  return Boolean(value && typeof value === "object" && "summary" in value);
}

function responseId(evt: ServerEvent): string | undefined {
  const id = (evt.response as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}

function responseStatus(evt: ServerEvent): string | undefined {
  const status = (evt.response as { status?: unknown } | undefined)?.status;
  return typeof status === "string" ? status : undefined;
}
