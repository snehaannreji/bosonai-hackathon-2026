import type { KnowledgeState } from "../state/knowledge";
import { createKnowledgeTracker, type KnowledgeContext } from "../state/createKnowledgeTracker";
import type { EvidenceAssessor, LessonDefinition } from "../state/lesson";
import { studentToolFeedback } from "../state/topicKnowledge";
import { CLIENT_TOOL_RESULT } from "../state/transcriptStore";
import { functionCallOutput, responseCreate, type ClientEvent, type ServerEvent } from "./events";

interface Batch { promises: Promise<void>[]; outputs: ClientEvent[]; epoch: number }
const SUPPORTED_EMOTIONS = new Set([
  "elation", "amusement", "contentment", "anger", "sadness",
  "contemplation", "surprise", "pride", "fear", "affection",
]);
/** The same topic-aware tracker/evidence checks power voice and avatar modes. */
export class AvatarToolBridge {
  private tracker: KnowledgeContext;
  private handled = new Set<string>();
  private batch: Batch | null = null;
  private epoch = 0;
  private failedUpdates = 0;
  private lastAssistantQuestion: string | null = null;
  private lesson?: LessonDefinition;
  constructor(private cb: {
    onEvent: (event: ServerEvent) => void;
    onKnowledge: (state: KnowledgeState) => void;
    send: (event: ClientEvent) => void;
  }, lesson?: LessonDefinition, assess?: EvidenceAssessor) { this.lesson = lesson; this.tracker = createKnowledgeTracker(cb.onKnowledge, lesson, assess); }
  observeText(id: string, text: string) {
    this.tracker.observeHuman(id, text, this.takeQuestionContext());
    this.cb.onEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: text });
  }
  handle(event: ServerEvent) {
    this.cb.onEvent(event);
    if (event.type === "response.created" || event.type === "input_audio_buffer.speech_started") this.epoch++;
    if (event.type === "response.output_audio_transcript.done" && typeof event.transcript === "string") {
      const emotion = extractEmotion(event.transcript);
      if (emotion) this.cb.onEvent({ type: "client.emotion_used", emotion, tag: `<|emotion:${emotion}|>` });
      this.lastAssistantQuestion = extractLastQuestion(event.transcript);
    }
    if (event.type === "conversation.item.input_audio_transcription.completed" && typeof event.item_id === "string" && typeof event.transcript === "string") {
      this.tracker.observeHuman(event.item_id, event.transcript, this.takeQuestionContext());
    }
    if (event.type === "response.function_call_arguments.done") this.run(event);
    if (event.type === "response.done") {
      const response = event.response as { output?: ServerEvent[]; status?: string } | undefined;
      for (const item of response?.output ?? []) {
        if (item.type === "function_call" && typeof item.call_id === "string" && !this.handled.has(item.call_id)) {
          const synthetic = { ...item, type: "response.function_call_arguments.done" };
          this.cb.onEvent(synthetic); this.run(synthetic);
        }
      }
      const batch = this.batch; this.batch = null;
      if (batch) void this.flush(batch, response?.status);
    }
  }
  private takeQuestionContext() {
    const question = this.lastAssistantQuestion ?? undefined;
    this.lastAssistantQuestion = null;
    return question;
  }
  private async flush(batch: Batch, status?: string) {
    await Promise.all(batch.promises);
    for (const output of batch.outputs) this.cb.send(output);
    if (batch.epoch === this.epoch && status !== "cancelled" && status !== "failed") this.cb.send(responseCreate());
  }
  private run(event: ServerEvent) {
    if (typeof event.call_id !== "string" || this.handled.has(event.call_id)) return;
    this.handled.add(event.call_id);
    if (!this.batch) this.batch = { promises: [], outputs: [], epoch: this.epoch };
    const batch = this.batch;
    const callId = event.call_id;
    const promise = (async () => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(String(event.arguments ?? "{}")) ?? {}; } catch { /* validator answers malformed arguments */ }
      let result;
      try { result = event.name === "update_understanding" ? await this.tracker.update(args) : { error: "unknown_tool", summary: "Only update_understanding is available." }; }
      catch { result = { error: "tool_failed", summary: "The evidence check failed; continue learning and retry next turn." }; }
      const lowFamiliarity = Boolean(this.lesson && this.lesson.familiarity < 25);
      const frustration = event.name === "update_understanding" && result.error && !lowFamiliarity
        ? Math.min(++this.failedUpdates, 4)
        : (this.failedUpdates = 0, 0);
      const feedback = frustration === 0
        ? { level: 0, guidance: "You made progress; respond naturally and do not mention frustration." }
        : {
            level: frustration,
            guidance: [
              "",
              "Sound mildly angry and impatient with the teacher's explanation; firmly say it still does not make sense and ask for a clearer example.",
              "Sound distinctly angry and frustrated with how the teacher is explaining it; say this approach is not helping and demand a different explanation.",
              "Sound very angry and sharp with the teacher's explanation; directly say you are fed up with being confused and insist they try another approach.",
              "Sound intensely angry and exasperated with the teaching approach, with a raised, forceful tone; confront the teacher about not making the idea clear and demand a concrete example.",
            ][frustration] + " This is roleplay directed at the explanation and teaching approach, not the teacher's worth or identity. Do not threaten, demean, or use slurs.",
          };
      this.cb.onEvent({ type: CLIENT_TOOL_RESULT, call_id: callId, result, ms: 0 });
      const output = this.lesson
        ? `${studentToolFeedback(this.lesson, result)}${frustration > 0 ? `\n${feedback.guidance}` : ""}`
        : `${result.summary}\n${feedback.guidance}`;
      batch.outputs.push(functionCallOutput(callId, output));
    })();
    batch.promises.push(promise);
  }
}

function extractEmotion(text: string): string | null {
  const emotion = /<\|emotion:([a-z_]+)\|>/u.exec(text)?.[1];
  return emotion && SUPPORTED_EMOTIONS.has(emotion) ? emotion : null;
}

function extractLastQuestion(text: string): string | null {
  const questions = text.match(/[^.!?]*\?/gu);
  return questions?.at(-1)?.trim() || null;
}
