import type { RealtimeCallbacks } from "./RealtimeClient";
import { CONCEPTS } from "../state/knowledge";
import { createKnowledgeTracker, type KnowledgeContext } from "../state/createKnowledgeTracker";
import { dispatch } from "../tools/registry";
import { CLIENT_TOOL_RESULT } from "../state/transcriptStore";

/** Text-only deterministic UI fixture. No microphone, network or synthesized voice. */
export class MockClient {
  private active = false;
  private tracker: KnowledgeContext;
  private explanations: string[] = [];
  private sequence = 0;
  readonly micActive = false;
  constructor(private cb: RealtimeCallbacks) { this.tracker = createKnowledgeTracker(cb.onKnowledgeChange, cb.lesson, cb.assessEvidence); }
  async connect() {
    this.active = true;
    this.tracker.reset(); this.explanations = [];
    this.cb.onConnectionState?.("open");
    this.reply(this.cb.lesson ? `Hey, I’m ${this.cb.lesson.studentName ?? "Alex"}. ${this.cb.lesson.openingQuestion}` : "Hey, I'm Alex. I thought the gradient points toward the minimum. Is that how it works?");
  }
  disconnect() { this.active = false; this.cb.onConnectionState?.("closed"); this.cb.onActivity?.("idle"); }
  async close() { this.disconnect(); }
  async startMic() { throw new Error("Local mock is text-only. Switch to Boson voice to use your microphone."); }
  async stopMic() {}
  async sendUserText(text: string) {
    if (!this.active) return;
    const item = `mock-human-${++this.sequence}`;
    this.tracker.observeHuman(item, text);
    this.cb.onServerEvent?.({ type: "conversation.item.input_audio_transcription.completed", item_id: item, transcript: text });
    if (this.cb.lesson) {
      if (/teach back|explain it back|quiz/i.test(text)) {
        this.reply(this.explanations.length ? `Let me try: ${this.explanations.at(-1)!.slice(0, 220)} Did I explain that clearly?` : `I’m still new to ${this.cb.lesson.topic}. What would you like to teach me first?`);
        return;
      }
      const call = `mock-tool-${++this.sequence}`;
      const args = { concept: "topic_fact", evidence: text };
      this.cb.onServerEvent?.({ type: "response.function_call_arguments.done", call_id: call, name: "update_understanding", arguments: JSON.stringify(args) });
      const result = await dispatch("update_understanding", args, this.tracker);
      this.cb.onServerEvent?.({ type: CLIENT_TOOL_RESULT, call_id: call, result, ms: 0 });
      if (!result.error) this.explanations.push(text);
      this.reply(this.cb.lesson.familiarity < 25
        ? result.error === "ungrounded_evidence"
          ? "I missed that. Could you say it once more?"
          : "Oh, okay. I’ll go with that for now. Could you tell me a little more?"
        : result.error ? "Could you tell me a little more about that?" : "That helps. What else should I know about it?");
      return;
    }
    let learned = false;
    for (const concept of CONCEPTS) {
      for (const status of ["understood", "partial"] as const) {
        const result = await dispatch("update_understanding", { concept, status, evidence: text }, this.tracker);
        if (!result.error) {
          learned = true;
          const call = `mock-tool-${++this.sequence}`;
          this.cb.onServerEvent?.({ type: "response.function_call_arguments.done", call_id: call, name: "update_understanding", arguments: JSON.stringify({ concept, status, evidence: text }) });
          this.cb.onServerEvent?.({ type: CLIENT_TOOL_RESULT, call_id: call, result, ms: 0 });
          break;
        }
      }
    }
    const state = this.tracker.snapshot();
    if (/teach back|explain it back|quiz/i.test(text)) {
      this.reply(state.gradient_direction.status === "understood"
        ? "Let me try: the gradient points uphill, so I take a step the other way to lower the loss. For a positive gradient, I would decrease the parameter. Did I get that?"
        : "I still think the gradient points toward the minimum. Could you explain which direction makes the loss increase?");
    } else this.reply(learned
      ? "Oh, that helps. Could we try a small example so I can check I have it right?"
      : "I'm still a little confused. What direction does the gradient point, and why would we step the other way?");
  }
  private reply(text: string) {
    const item_id = `mock-alex-${++this.sequence}`;
    this.cb.onServerEvent?.({ type: "response.output_audio_transcript.delta", item_id, delta: text });
    this.cb.onServerEvent?.({ type: "response.output_audio_transcript.done", item_id, transcript: text });
    this.cb.onActivity?.("idle");
  }
}
