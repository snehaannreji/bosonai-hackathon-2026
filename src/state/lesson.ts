import { normalizeStudent, studentName, type StudentSettings } from "./student";

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
  familiarity: number;
  studentName?: string;
  openingQuestion: string;
  concepts: LessonConcept[];
  mock: boolean;
  student?: StudentSettings;
  /** Browser-only authorization for creating/revoking this lesson's tablet link. */
  whiteboardOwnerToken?: string;
}
export interface InstructorGuideFact { id: string; text: string; conceptId: string | null; sourceText?: string }
export interface HumanTurn { id: string; text: string }
export interface EvidenceAssessment { matchedCriteria: string[]; matchedConcepts?: { conceptId: string; matchedCriteria: string[] }[]; misconception: boolean; reason: string; factAccuracy?: "accurate" | "incorrect" | "uncertain"; groundTruth?: string; taughtGuideFactIds?: string[]; taughtGuideFacts?: InstructorGuideFact[]; independentFactTaught?: boolean; topicFactTaught?: boolean }
export type EvidenceAssessor = (input: { concept: LessonConcept; lessonConcepts?: LessonConcept[]; turns: HumanTurn[]; quote: string }) => Promise<EvidenceAssessment>;
export const CRITERIA_IDS = ["criterion_1", "criterion_2"] as const;
export const MAX_INSTRUCTOR_NOTES_LENGTH = 16_000;

const instructorFactTokens = (value: string) => value
  .normalize("NFKC")
  .toLocaleLowerCase()
  .replace(/\bkilomet(?:er|re)s?\b|\bkm\b/gu, " kilometer ")
  .replace(/[\d,]+/gu, match => match.replace(/,/gu, ""))
  .match(/[\p{L}\p{N}]+/gu) ?? [];

export function explanationCoversSourceText(sourceText: string, explanation: string): boolean {
  const ignored = new Set(["a", "an", "and", "are", "as", "at", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with"]);
  const expected = [...new Set(instructorFactTokens(sourceText).filter(token => !ignored.has(token)))];
  if (expected.length < 4) return false;
  const actual = new Set(instructorFactTokens(explanation));
  const matches = expected.filter(token => actual.has(token)).length;
  return matches / expected.length >= 0.85;
}

export function coveredInstructorGuideFactIds(
  guide: InstructorGuideFact[],
  explanation: string,
  assessedFactIds: string[] = [],
): string[] {
  return [...new Set([
    ...assessedFactIds,
    ...guide.filter(fact => fact.sourceText && explanationCoversSourceText(fact.sourceText, explanation)).map(fact => fact.id),
  ])];
}

export function normalizeInstructorNotes(value: unknown): string {
  if (typeof value !== "string") throw new Error("Notes must be plain text.");
  const notes = value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  if (notes.length > MAX_INSTRUCTOR_NOTES_LENGTH) throw new Error(`Notes must be ${MAX_INSTRUCTOR_NOTES_LENGTH.toLocaleString()} characters or fewer.`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(notes)) throw new Error("Notes contain unsupported control characters. Upload a plain-text file.");
  return notes;
}

export function normalizeTopic(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a topic you want to teach.");
  const topic = value.replace(/\s+/gu, " ").trim();
  if (topic.length < 2 || topic.length > 160) throw new Error("Enter a topic between 2 and 160 characters.");
  return topic;
}

export function normalizeStudentName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a student name.");
  const name = value.trim();
  if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error("Enter a name between 1 and 40 characters.");
  return name;
}

export function mockLesson(topic: string, studentOrFamiliarity?: StudentSettings | number, studentNameOverride = "Alex"): LessonDefinition {
  const student = typeof studentOrFamiliarity === "object" ? normalizeStudent(studentOrFamiliarity) : normalizeStudent(undefined);
  const familiarity = typeof studentOrFamiliarity === "number" ? studentOrFamiliarity : 0;
  const name = typeof studentOrFamiliarity === "number" ? normalizeStudentName(studentNameOverride) : studentName(student);
  return { id: `mock-${Date.now()}`, topic: normalizeTopic(topic), familiarity, studentName: name, student, mock: true,
    openingQuestion: `What is the main idea behind ${topic}?`,
    concepts: [
      { id: "concept_1", label: "The main idea", goal: `Explain what ${topic} means.`, criteria: ["Define the central idea in your own words.", "Explain why it matters."], initialBelief: null },
      { id: "concept_2", label: "How it works", goal: "Explain the mechanism, method, or relationships.", criteria: ["Describe the key parts or steps.", "Explain how the parts connect."], initialBelief: null },
      { id: "concept_3", label: "An example", goal: "Apply the idea to a concrete example.", criteria: ["Give a specific example.", "Connect the example to the main idea."], initialBelief: null },
    ] };
}
