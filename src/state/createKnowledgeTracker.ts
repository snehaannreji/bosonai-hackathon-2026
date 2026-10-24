import { StudentKnowledge, type StudentKnowledgeSnapshot } from "./studentKnowledge";
import { KnowledgeTracker, type KnowledgeState, type ToolResult } from "./knowledge";
import type { EvidenceAssessor, LessonDefinition } from "./lesson";
import { TopicKnowledgeTracker, mockAssessor } from "./topicKnowledge";
export interface KnowledgeContext {
  readonly student?: StudentKnowledge;
  snapshot(): KnowledgeState;
  observeHuman(id: string, text: string, questionContext?: string): void;
  reset(): void;
  update(args: Record<string, unknown>): ToolResult | Promise<ToolResult>;
}
export function createKnowledgeTracker(onChange?: (state: KnowledgeState) => void, lesson?: LessonDefinition, assess?: EvidenceAssessor, onStudentChange?: (state: StudentKnowledgeSnapshot) => void): KnowledgeContext {
  if (!lesson) return new KnowledgeTracker(onChange); // original diagnostic fixtures
  const student = new StudentKnowledge(lesson);
  const tracker = new TopicKnowledgeTracker(lesson, lesson.mock ? mockAssessor : assess ?? (async () => { throw new Error("No evidence assessor is configured."); }), state => {
    student.applyAssessment(state); onChange?.(state);
  });
  return {
    student,
    snapshot: () => tracker.snapshot(),
    observeHuman: (id, text, question) => {
      const revision = student.snapshot().revision;
      student.observeHuman(id, text, question); tracker.observeHuman(id, text, question);
      if (student.snapshot().revision !== revision) onStudentChange?.(student.snapshot());
    },
    reset: () => { student.reset(); tracker.reset(); },
    update: args => tracker.update(args),
  };
}
