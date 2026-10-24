import type { KnowledgeState } from "../state/knowledge";
import { createKnowledgeTracker, type KnowledgeContext } from "../state/createKnowledgeTracker";
import type { EvidenceAssessor, LessonDefinition } from "../state/lesson";
import { studentToolFeedback } from "../state/topicKnowledge";
import { CLIENT_TOOL_RESULT } from "../state/transcriptStore";
import { functionCallOutput, responseCreate, type ClientEvent, type ServerEvent } from "./events";

interface Batch { promises: Promise<void>[]; outputs: ClientEvent[] }
const EMOTION_CUES = [
  { emotion: "elation", tags: "<|emotion:elation|><|prosody:expressive_high|>", response: "That's wonderful! I think that finally clicked." },
  { emotion: "amusement", tags: "<|emotion:amusement|><|prosody:expressive_high|>", response: "Haha, that example made it much easier to understand!" },
  { emotion: "contentment", tags: "<|emotion:contentment|>", response: "I'm glad this is starting to make sense, one step at a time." },
  { emotion: "anger", tags: "<|emotion:anger|><|prosody:expressive_high|>", response: "Ah, this part is frustrating. Could we try a different example?" },
  { emotion: "sadness", tags: "<|emotion:sadness|><|prosody:speed_slow|><|prosody:expressive_high|>", response: "Aw, I was hoping I'd understand that. Could we go through it once more?" },
  { emotion: "sadness", tags: "<|emotion:sadness|><|prosody:expressive_high|><|sfx:crying|>", response: "Boohoo, I thought I had it that time. Maybe one more example will help." },
  { emotion: "sadness", tags: "<|emotion:sadness|><|prosody:pitch_low|><|prosody:speed_slow|><|sfx:sigh|>", response: "Ah, I still have a little way to go. Let's try that again." },
  { emotion: "contemplation", tags: "<|emotion:contemplation|>", response: "Let's think carefully about why this works." },
  { emotion: "surprise", tags: "<|emotion:surprise|>", response: "Wait, really? I wasn't expecting that connection!" },
  { emotion: "pride", tags: "<|emotion:pride|>", response: "I'm proud of how much better I understand this now!" },
  { emotion: "fear", tags: "<|emotion:fear|>", response: "I'm a little worried I'll forget this part. Can we practice it once?" },
  { emotion: "affection", tags: "<|emotion:affection|>", response: "It's okay. We'll work through this together." },
  { emotion: "amusement", tags: "<|emotion:amusement|>", response: "Well, that took an unexpected turn! I think I understand now." },
] as const;
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
      if (batch) void this.flush(batch, this.epoch, response?.status);
    }
  }
  private takeQuestionContext() {
    const question = this.lastAssistantQuestion ?? undefined;
    this.lastAssistantQuestion = null;
    return question;
  }
  private async flush(batch: Batch, epoch: number, status?: string) {
    await Promise.all(batch.promises);
    for (const output of batch.outputs) this.cb.send(output);
    if (epoch === this.epoch && status !== "cancelled" && status !== "failed") this.cb.send(responseCreate());
  }
  private run(event: ServerEvent) {
    if (typeof event.call_id !== "string" || this.handled.has(event.call_id)) return;
    this.handled.add(event.call_id);
    if (!this.batch) this.batch = { promises: [], outputs: [] };
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
      const emotionCue = this.lesson && event.name === "update_understanding" && !result.error && Math.random() < 0.8
        ? EMOTION_CUES[Math.floor(Math.random() * EMOTION_CUES.length)]
        : undefined;
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
      if (emotionCue) {
        this.cb.onEvent({
          type: "client.emotion_selected",
          call_id: callId,
          emotion: emotionCue.emotion,
          tags: emotionCue.tags,
          response: emotionCue.response,
        });
      }
      const emotionInstruction = emotionCue
        ? `\nFor your next spoken reply, say this exact line verbatim and preserve the leading vocal-control tags. Do not omit or paraphrase the tags, and do not explain them:\n${emotionCue.tags}${emotionCue.response}`
        : "";
      const output = this.lesson
        ? `${studentToolFeedback(this.lesson, result)}${frustration > 0 ? `\n${feedback.guidance}` : ""}${emotionInstruction}`
        : `${result.summary}\n${feedback.guidance}`;
      batch.outputs.push(functionCallOutput(callId, output));
    })();
    batch.promises.push(promise);
  }
}

function extractLastQuestion(text: string): string | null {
  const questions = text.match(/[^.!?]*\?/gu);
  return questions?.at(-1)?.trim() || null;
}
