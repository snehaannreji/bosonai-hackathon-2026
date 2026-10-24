import type { KnowledgeState } from "../state/knowledge";
import { createKnowledgeTracker, type KnowledgeContext } from "../state/createKnowledgeTracker";
import type { EvidenceAssessor, LessonDefinition } from "../state/lesson";
import { CLIENT_TOOL_RESULT } from "../state/transcriptStore";
import { functionCallOutput, responseCreate, type ClientEvent, type ServerEvent } from "./events";
import type { CharacterId } from "../state/characters";
import { isKevinConcentrationCommand } from "../state/kevinSpeech";

interface Batch { promises: Promise<void>[]; outputs: ClientEvent[] }
/** The same topic-aware tracker/evidence checks power voice and avatar modes. */
export class AvatarToolBridge {
  private tracker: KnowledgeContext;
  private handled = new Set<string>();
  private batch: Batch | null = null;
  private epoch = 0;
  private kevinLearningStarted = false;
  constructor(private cb: {
    onEvent: (event: ServerEvent) => void;
    onKnowledge: (state: KnowledgeState) => void;
    send: (event: ClientEvent) => void;
    onKevinConcentration?: () => void;
  }, lesson?: LessonDefinition, assess?: EvidenceAssessor, private characterId: CharacterId = "alex") { this.tracker = createKnowledgeTracker(cb.onKnowledge, lesson, assess); }
  observeText(id: string, text: string) {
    const wasLearning = this.kevinLearningStarted;
    this.activateKevinLearning(text);
    if (this.characterId !== "kevin" || wasLearning) this.tracker.observeHuman(id, text);
    this.cb.onEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: text });
  }
  handle(event: ServerEvent) {
    this.cb.onEvent(event);
    if (event.type === "response.created" || event.type === "input_audio_buffer.speech_started") this.epoch++;
    if (event.type === "conversation.item.input_audio_transcription.completed" && typeof event.item_id === "string" && typeof event.transcript === "string") {
      const wasLearning = this.kevinLearningStarted;
      this.activateKevinLearning(event.transcript);
      if (this.characterId !== "kevin" || wasLearning) this.tracker.observeHuman(event.item_id, event.transcript);
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
      try {
        result = this.characterId === "kevin" && !this.kevinLearningStarted
          ? { error: "learning_not_activated", summary: "Kevin is still in playful mode. No learning was recorded; wait until the user gives the concentration cue." }
          : event.name === "update_understanding" ? await this.tracker.update(args) : { error: "unknown_tool", summary: "Only update_understanding is available." };
      }
      catch { result = { error: "tool_failed", summary: "The evidence check failed; continue learning and retry next turn." }; }
      this.cb.onEvent({ type: CLIENT_TOOL_RESULT, call_id: callId, result, ms: 0 });
      batch.outputs.push(functionCallOutput(callId, JSON.stringify(result)));
    })();
    batch.promises.push(promise);
  }
  private activateKevinLearning(text: string) {
    if (this.characterId !== "kevin" || this.kevinLearningStarted || !isKevinConcentrationCommand(text)) return;
    this.kevinLearningStarted = true;
    this.cb.onKevinConcentration?.();
  }
}
