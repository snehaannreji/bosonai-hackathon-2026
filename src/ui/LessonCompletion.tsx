import type { KnowledgeState } from "../state/knowledge";
import type { LessonDefinition } from "../state/lesson";

export function LessonCompletion({ lesson, state, studentName, onReview, onNewLesson }: { lesson: LessonDefinition; state: KnowledgeState; studentName: string; onReview: () => void; onNewLesson: () => void }) {
  const learned = lesson.concepts.filter(concept => state[concept.id]?.status === "understood");
  const corrected = learned.filter(concept => Boolean(concept.initialBelief));
  return <section className="completion-card" role="dialog" aria-labelledby="lesson-complete-title"><div className="completion-spark" aria-hidden="true">✦</div><p className="eyebrow">LESSON COMPLETE</p><h2 id="lesson-complete-title">You taught {studentName} about {lesson.topic}.</h2><p>{studentName} demonstrated evidence-backed understanding across every lesson concept.</p><div className="completion-stats"><div><strong>{learned.length}</strong><span>concepts learned</span></div><div><strong>{corrected.length}</strong><span>misconceptions corrected</span></div></div><ul>{learned.map(concept => <li key={concept.id}><span>✓</span><div><strong>{concept.label}</strong><small>{state[concept.id]?.evidence || "Verified through the lesson."}</small></div></li>)}</ul><div className="completion-actions"><button onClick={onReview}>Review lesson</button><button className="primary" onClick={onNewLesson}>Teach another topic →</button></div></section>;
}
