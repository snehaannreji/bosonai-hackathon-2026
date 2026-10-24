import { KnowledgeTracker, type KnowledgeState, type ToolResult } from "./knowledge";
import type { EvidenceAssessor, LessonDefinition } from "./lesson";
import { TopicKnowledgeTracker, mockAssessor } from "./topicKnowledge";
export interface KnowledgeContext {
  snapshot(): KnowledgeState;
  observeHuman(id: string, text: string): void;
  reset(): void;
  update(args: Record<string, unknown>): ToolResult | Promise<ToolResult>;
}
export function createKnowledgeTracker(onChange?: (state: KnowledgeState) => void, lesson?: LessonDefinition, assess?: EvidenceAssessor): KnowledgeContext {
  if (!lesson) return new KnowledgeTracker(onChange); // original diagnostic fixtures
  return new TopicKnowledgeTracker(lesson, lesson.mock ? mockAssessor : assess ?? (async () => { throw new Error("No evidence assessor is configured."); }), onChange);
}
