import { normalizeStudent, type StudentSettings } from "./student";

export interface LessonConcept {
  id: string;
  label: string;
  goal: string;
  criteria: [string, string];
  initialBelief: string | null;
}
export interface LessonDefinition {
  id: string;
  topic: string;
  openingQuestion: string;
  concepts: LessonConcept[];
  mock: boolean;
  student?: StudentSettings;
}
export interface HumanTurn { id: string; text: string }
export interface EvidenceAssessment { matchedCriteria: string[]; misconception: boolean; reason: string }
export type EvidenceAssessor = (input: { concept: LessonConcept; turns: HumanTurn[]; quote: string }) => Promise<EvidenceAssessment>;
export const CRITERIA_IDS = ["criterion_1", "criterion_2"] as const;

export function normalizeTopic(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a topic you want to teach.");
  const topic = value.replace(/\s+/gu, " ").trim();
  if (topic.length < 2 || topic.length > 160) throw new Error("Enter a topic between 2 and 160 characters.");
  return topic;
}

export function mockLesson(topic: string, student?: StudentSettings): LessonDefinition {
  return { id: `mock-${Date.now()}`, topic: normalizeTopic(topic), mock: true, student: normalizeStudent(student),
    openingQuestion: `What is the main idea behind ${topic}?`,
    concepts: [
      { id: "concept_1", label: "The main idea", goal: `Explain what ${topic} means.`, criteria: ["Define the central idea in your own words.", "Explain why it matters."], initialBelief: null },
      { id: "concept_2", label: "How it works", goal: "Explain the mechanism, method, or relationships.", criteria: ["Describe the key parts or steps.", "Explain how the parts connect."], initialBelief: null },
      { id: "concept_3", label: "An example", goal: "Apply the idea to a concrete example.", criteria: ["Give a specific example.", "Connect the example to the main idea."], initialBelief: null },
    ] };
}
