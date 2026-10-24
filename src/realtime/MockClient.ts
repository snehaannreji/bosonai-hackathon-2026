import type { RealtimeCallbacks } from "./RealtimeClient";
import { CONCEPTS } from "../state/knowledge";
import { createKnowledgeTracker, type KnowledgeContext } from "../state/createKnowledgeTracker";
import { dispatch } from "../tools/registry";
import { CLIENT_TOOL_RESULT } from "../state/transcriptStore";
import { studentName, type StudentSettings } from "../state/student";
import { misconceptionKey, shouldSurfaceMisconception, soundsLikeCorrection } from "../state/mockMisconceptions";

/** Text-only deterministic UI fixture. No microphone, network or synthesized voice. */
export class MockClient {
  private active = false;
  private tracker: KnowledgeContext;
  private explanations: string[] = [];
  private unresolvedMisconception: string | null = null;
  private resolvedMisconceptions = new Set<string>();
  private sequence = 0;
  readonly micActive = false;
  constructor(private cb: RealtimeCallbacks) { this.tracker = createKnowledgeTracker(cb.onKnowledgeChange, cb.lesson, cb.assessEvidence); }
  async connect() {
    this.active = true;
    this.tracker.reset(); this.explanations = []; this.unresolvedMisconception = null; this.resolvedMisconceptions.clear();
    this.cb.onConnectionState?.("open");
    this.reply(this.cb.lesson ? `Hey, I’m ${this.cb.lesson.studentName ?? studentName(this.cb.lesson.student)}. ${this.cb.lesson.openingQuestion}` : "Hey, I'm Maya. I thought the gradient points toward the minimum. Is that how it works?");
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
      const settings = this.cb.lesson.student;
      if (/teach back|explain it back|quiz/i.test(text)) {
        if (!this.explanations.length) this.reply(`I’m still new to ${this.cb.lesson.topic}. What would you like to teach me first?`);
        else if (settings?.id === "kai") this.reply(`Let me reason it through: ${this.explanations.at(-1)!.slice(0, 190)}. In a new case, I would apply that same rule step by step. Which assumption should I check?`);
        else this.reply(`Let me put it in everyday terms: ${this.explanations.at(-1)!.slice(0, 190)}. It feels like an example I could picture, but does that comparison hold?`);
        return;
      }
      const call = `mock-tool-${++this.sequence}`;
      const args = { concept: "topic_fact", evidence: text };
      this.cb.onServerEvent?.({ type: "response.function_call_arguments.done", call_id: call, name: "update_understanding", arguments: JSON.stringify(args) });
      const result = await dispatch("update_understanding", args, this.tracker);
      this.cb.onServerEvent?.({ type: CLIENT_TOOL_RESULT, call_id: call, result, ms: 0 });
      if (!result.error) this.explanations.push(text);
      const level = this.cb.lesson.student?.level ?? "balanced";
      const selected: StudentSettings = this.cb.lesson.student ?? { id: "maya", level };
      if (!result.error && this.unresolvedMisconception && soundsLikeCorrection(text)) {
        this.resolvedMisconceptions.add(this.unresolvedMisconception); this.unresolvedMisconception = null;
        this.reply(selected.id === "maya"
          ? "Oh, that fixes the picture I had. I shouldn’t stretch the example beyond the limits you explained."
          : "That resolves the gap in my reasoning. The rule depends on that condition, so I shouldn’t apply it universally.");
        return;
      }
      const candidate = misconceptionKey(text, selected);
      if (!result.error && !this.unresolvedMisconception && !this.resolvedMisconceptions.has(candidate) && shouldSurfaceMisconception(text, selected)) {
        this.unresolvedMisconception = candidate;
        this.reply(selected.id === "maya"
          ? "I’m taking that example to mean it works the same way in every situation. Is that a safe comparison?"
          : "I’m assuming that rule still holds if one of its conditions changes. Is that necessarily true?");
        return;
      }
      if (!result.error && level === "supported") {
        this.reply("Could we go through one simple example, a step at a time?");
        return;
      }
      if (!result.error && level === "quick") {
        this.reply("I see the connection. What changes if we try a different situation?");
        return;
      }
      if (!result.error && settings?.id === "kai") {
        this.reply(this.cb.lesson.familiarity < 25
          ? "Okay, I’ll go with that for now. Which assumption makes the conclusion hold?"
          : "I can follow that step. What assumption makes the conclusion hold?");
        return;
      }
      if (!result.error && settings?.id === "maya") {
        this.reply(this.cb.lesson.familiarity < 25
          ? "Oh, okay. I’ll go with that for now. Could you connect it to one everyday example?"
          : "That gives me a picture of it. Could you connect it to one everyday example?");
        return;
      }
      const response = this.cb.lesson.familiarity < 25
        ? result.error === "ungrounded_evidence"
          ? "I missed that. Could you say it once more?"
          : "Oh, okay. I’ll go with that for now. Could you tell me a little more?"
        : result.error ? "Could you tell me a little more about that?" : "That helps. What else should I know about it?";
      this.reply(response);
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
