import { mockLesson, normalizeInstructorNotes, normalizeStudentName, normalizeTopic, type EvidenceAssessment, type EvidenceAssessor, type InstructorGuideFact, type LessonDefinition } from "../state/lesson";
export interface PreparedLesson { lesson: LessonDefinition; instructorGuide: InstructorGuideFact[] }
export async function prepareLesson(topic: string, mock: boolean, familiarity = 0, studentName = "Alex", instructorNotes = "", signal?: AbortSignal): Promise<PreparedLesson> {
  const normalized = normalizeTopic(topic);
  if (!Number.isInteger(familiarity) || familiarity < 0 || familiarity > 100) throw new Error("Student familiarity must be between 0 and 100.");
  const normalizedName = normalizeStudentName(studentName);
  const notes = normalizeInstructorNotes(instructorNotes);
  if (mock) return { lesson: mockLesson(normalized, familiarity, normalizedName), instructorGuide: [] };
  const response = await fetch("/api/lessons", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: normalized, familiarity, studentName: normalizedName, instructorNotes: notes }), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Could not prepare this topic.");
  if (!data.lesson || !Array.isArray(data.instructorGuide) || !data.instructorGuide.every((fact: unknown) =>
    Boolean(fact && typeof fact === "object" && typeof (fact as InstructorGuideFact).id === "string" && typeof (fact as InstructorGuideFact).text === "string" && (typeof (fact as InstructorGuideFact).sourceText === "string" || (fact as InstructorGuideFact).sourceText === undefined) && ((fact as InstructorGuideFact).conceptId === null || typeof (fact as InstructorGuideFact).conceptId === "string")),
  )) throw new Error("The server returned an invalid instructor teaching guide. Restart the local server.");
  return { lesson: data.lesson as LessonDefinition, instructorGuide: data.instructorGuide as InstructorGuideFact[] };
}
export function lessonAssessor(lesson: LessonDefinition, instructorGuide: InstructorGuideFact[] = []): EvidenceAssessor {
  return async ({ concept, turns, quote }) => {
    const response = await fetch(`/api/lessons/${lesson.id}/assess`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ concept: concept.id, turns, quote }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Could not check the explanation.");
    const assessment = data.assessment as EvidenceAssessment;
    if (!assessment || !Array.isArray(assessment.taughtGuideFactIds) || !Array.isArray(assessment.matchedConcepts) || typeof assessment.independentFactTaught !== "boolean" || typeof assessment.topicFactTaught !== "boolean") throw new Error("The instructor assessment returned invalid teaching coverage. Restart the local server.");
    const taughtIds = new Set(assessment.taughtGuideFactIds);
    return { ...assessment, taughtGuideFacts: instructorGuide.filter(fact => taughtIds.has(fact.id)) };
  };
}
