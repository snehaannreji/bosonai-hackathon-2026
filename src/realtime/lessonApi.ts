import { mockLesson, normalizeInstructorNotes, normalizeStudentName, normalizeTopic, type EvidenceAssessment, type EvidenceAssessor, type InstructorGuideFact, type LessonDefinition } from "../state/lesson";
import { normalizeStudent, type StudentSettings } from "../state/student";
export interface PreparedLesson { lesson: LessonDefinition; instructorGuide: InstructorGuideFact[] }
export function prepareLesson(topic: string, mock: boolean, signal?: AbortSignal, student?: StudentSettings): Promise<LessonDefinition>;
export function prepareLesson(topic: string, mock: boolean, familiarity?: number, studentName?: string, instructorNotes?: string, signal?: AbortSignal, student?: StudentSettings): Promise<PreparedLesson>;
export async function prepareLesson(
  topic: string,
  mock: boolean,
  familiarityOrSignal?: number | AbortSignal,
  nameOrStudent: string | StudentSettings = "Alex",
  instructorNotes = "",
  legacySignal?: AbortSignal,
  selectedStudent?: StudentSettings,
): Promise<LessonDefinition | PreparedLesson> {
  const normalized = normalizeTopic(topic);
  const modernCall = typeof familiarityOrSignal !== "number";
  const signal = modernCall ? familiarityOrSignal : legacySignal;
  const familiarity = typeof familiarityOrSignal === "number" ? familiarityOrSignal : 0;
  const student = normalizeStudent(modernCall && typeof nameOrStudent !== "string" ? nameOrStudent : selectedStudent);
  const rawName = typeof nameOrStudent === "string" ? nameOrStudent : "Alex";
  if (!Number.isInteger(familiarity) || familiarity < 0 || familiarity > 100) throw new Error("Student familiarity must be between 0 and 100.");
  const normalizedName = normalizeStudentName(rawName);
  const notes = normalizeInstructorNotes(instructorNotes);
  const lessonStudent = student;
  const lessonName = modernCall ? undefined : normalizedName;
  if (mock) {
    const lesson = mockLesson(normalized, modernCall ? student : familiarity, normalizedName);
    lesson.student = lessonStudent;
    if (lessonName) lesson.studentName = lessonName;
    if (modernCall) return lesson;
    return { lesson, instructorGuide: [] };
  }
  const response = await fetch("/api/lessons", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: normalized, familiarity, studentName: lessonName, student: lessonStudent, instructorNotes: notes }),
    signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Could not prepare this topic.");
  if (modernCall) {
    if (!data.lesson || typeof data.lesson !== "object") throw new Error("The server returned an invalid lesson. Restart the local server.");
    return data.lesson as LessonDefinition;
  }
  if (!data.lesson || !Array.isArray(data.instructorGuide) || !data.instructorGuide.every((fact: unknown) =>
    Boolean(fact && typeof fact === "object" && typeof (fact as InstructorGuideFact).id === "string" && typeof (fact as InstructorGuideFact).text === "string" && (typeof (fact as InstructorGuideFact).sourceText === "string" || (fact as InstructorGuideFact).sourceText === undefined) && ((fact as InstructorGuideFact).conceptId === null || typeof (fact as InstructorGuideFact).conceptId === "string")),
  )) throw new Error("The server returned an invalid instructor teaching guide. Restart the local server.");
  const prepared = { lesson: data.lesson as LessonDefinition, instructorGuide: data.instructorGuide as InstructorGuideFact[] };
  return prepared;
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
