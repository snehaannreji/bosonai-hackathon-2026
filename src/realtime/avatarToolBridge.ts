import { knowledgeInstructions, type StudentKnowledgeSnapshot } from "../state/studentKnowledge";
import { isDrawingTool, type DrawingHandler } from "../whiteboard/drawingTools";
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
  private drawingCalls = 0;
  private drawingInterrupted = false;
  private drawingQueue: Promise<unknown> = Promise.resolve();
  private lastAssistantQuestion: string | null = null;
  private lesson?: LessonDefinition;
  constructor(private cb: {
    onEvent: (event: ServerEvent) => void;
    onKnowledge: (state: KnowledgeState) => void;
    send: (event: ClientEvent) => void;
    onDrawingTool?: DrawingHandler;
    onStudentKnowledge?: (state: StudentKnowledgeSnapshot) => void;
  }, lesson?: LessonDefinition, assess?: EvidenceAssessor) { this.lesson = lesson; this.tracker = createKnowledgeTracker(state => {
    cb.onKnowledge(state); if (this.tracker.student) cb.onStudentKnowledge?.(this.tracker.student.snapshot());
  }, lesson, assess, state => cb.onStudentKnowledge?.(state)); }
  studentState() { return this.tracker.student?.snapshot(); }
  reviewSpeech(text: string) { return this.tracker.student?.review(text) ?? { allowed: true, approved_text: text }; }
  private executeDrawing(name: string, args: Record<string, unknown>) {
    const permission = this.tracker.student?.authorizeDrawing(name, args);
    if (permission && !permission.allowed) return permission;
    return this.cb.onDrawingTool?.(name, permission?.args ?? args) ?? { error: "board_unavailable", summary: "Whiteboard unavailable." };
  }
  observeText(id: string, text: string) {
    this.drawingCalls = 0;
    this.tracker.observeHuman(id, text, this.takeQuestionContext());
    this.cb.onEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: text });
  }
  handle(event: ServerEvent) {
    this.cb.onEvent(event);
    if (event.type === "input_audio_buffer.speech_started") { this.drawingInterrupted = true; this.drawingCalls = 0; }
    if (event.type === "response.created") this.drawingInterrupted = false;
    if (event.type === "response.created" || event.type === "input_audio_buffer.speech_started") this.epoch++;
    if (event.type === "response.output_audio_transcript.done" && typeof event.transcript === "string") {
      const emotion = extractEmotion(event.transcript);
      if (emotion) this.cb.onEvent({ type: "client.emotion_used", emotion, tag: `<|emotion:${emotion}|>` });
      const review = this.reviewSpeech(event.transcript);
      if (!review.allowed) this.cb.onEvent({ type: "client.knowledge_guard", item_id: event.item_id, reason: review.reason, approved_text: review.approved_text });
      this.lastAssistantQuestion = review.allowed ? extractLastQuestion(event.transcript) : null;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed" && typeof event.item_id === "string" && typeof event.transcript === "string") {
      this.tracker.observeHuman(event.item_id, event.transcript, this.takeQuestionContext());
    }
    if (event.type === "response.function_call_arguments.done") this.run(event);
    if (event.type === "response.done") {
      const response = event.response as { output?: ServerEvent[]; status?: string } | undefined;
      if (response?.status === "cancelled" || response?.status === "failed") this.drawingInterrupted = true;
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
    if (batch.epoch === this.epoch && this.drawingCalls <= 32 && status !== "cancelled" && status !== "failed") this.cb.send(responseCreate());
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
      try {
        if (event.name === "update_understanding") result = await this.tracker.update(args);
        else if (event.name === "prepare_response" && this.tracker.student) result = this.tracker.student.prepare(args);
        else if (typeof event.name === "string" && isDrawingTool(event.name)) {
          const name = event.name;
          const pending = this.drawingQueue.then(() => batch.epoch !== this.epoch || this.drawingInterrupted
            ? { error: "interrupted", summary: "Drawing interrupted; inspect the board before continuing." }
            : ++this.drawingCalls > 32 ? { error: "drawing_limit", summary: "Drawing call limit reached. Wait for the teacher before continuing." }
            : this.executeDrawing(name, args));
          this.drawingQueue = pending.catch(() => {});
          result = await pending;
        } else result = { error: "unknown_tool", summary: "Unknown tool." };
      }
      catch { result = { error: "tool_failed", summary: "The evidence check failed; continue learning and retry next turn." }; }
      const lowFamiliarity = Boolean(this.lesson && this.lesson.familiarity < 25);
      const frustration = event.name !== "update_understanding" ? 0
        : result.error && !lowFamiliarity ? Math.min(++this.failedUpdates, 4)
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
      const output = event.name !== "update_understanding" ? JSON.stringify(result) : this.lesson
        ? `${studentToolFeedback(this.lesson, result)}${this.tracker.student ? "\n" + knowledgeInstructions("", this.tracker.student.snapshot()) : ""}${frustration > 0 ? `\n${feedback.guidance}` : ""}`
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
