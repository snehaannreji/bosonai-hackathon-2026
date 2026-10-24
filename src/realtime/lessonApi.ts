import { mockLesson, normalizeTopic, type EvidenceAssessor, type LessonDefinition } from "../state/lesson";
export async function prepareLesson(topic: string, mock: boolean, signal?: AbortSignal): Promise<LessonDefinition> {
  const normalized = normalizeTopic(topic);
  if (mock) return mockLesson(normalized);
  const response = await fetch("/api/lessons", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: normalized }), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Could not prepare this topic.");
  return data.lesson as LessonDefinition;
}
export function lessonAssessor(lesson: LessonDefinition): EvidenceAssessor {
  return async ({ concept, turns, quote }) => {
    const response = await fetch(`/api/lessons/${lesson.id}/assess`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ concept: concept.id, turns, quote }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Could not check the explanation.");
    return data.assessment;
  };
}
