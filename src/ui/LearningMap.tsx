import type { StudentKnowledgeSnapshot } from "../state/studentKnowledge";
import type { KnowledgeState } from "../state/knowledge";
import type { InstructorGuideFact, LessonDefinition } from "../state/lesson";
import type { EmotionDashboardRecord } from "../realtime/emotionDashboard";
import { EmotionResponsePanel } from "./EmotionResponsePanel";
import { studentName as getStudentName } from "../state/student";

const reviewLabels = { unverified: "Not yet verified", accurate: "Instructor verified", misconception: "Misconception found" } as const;
const statusLabels = { unknown: "Not taught yet", partial: "In progress", misunderstood: "Misunderstood", understood: "Understood" } as const;

export function LearningMap({ studentKnowledge, lesson, state, preparing, studentName: suppliedName, instructorGuide = [], emotionRecords = [] }: { studentKnowledge?: StudentKnowledgeSnapshot | null; lesson: LessonDefinition | null; state: KnowledgeState; preparing: boolean; studentName?: string; instructorGuide?: InstructorGuideFact[]; emotionRecords?: EmotionDashboardRecord[] }) {
  const studentName = suppliedName ?? lesson?.studentName ?? getStudentName(lesson?.student);
  const understood = lesson?.concepts.filter(c => state[c.id]?.status === "understood").length ?? 0;
  const count = lesson?.concepts.length ?? 0;
  const progress = count ? Math.round(understood / count * 100) : 0;
  const learnedFacts = lesson ? Object.values(state).flatMap(value => value.learnedFacts ?? []).filter((fact, index, all) => all.findIndex(item => item.id === fact.id) === index) : [];
  const taughtFactIds = new Set(Object.values(state).flatMap(value => value.taughtGuideFactIds ?? []));

  return <section className="knowledge-card polished-learning"><div className="learning-heading"><div><p className="eyebrow">LEARNING PROGRESS</p><h2>{studentName}’s understanding</h2></div><span className="progress-count"><strong>{understood}</strong> / {count || 3}</span></div>
    {lesson ? <>
      {studentKnowledge && <p className="learning-disclaimer" aria-live="polite">Student memory: {studentKnowledge.stage === "unknown" ? "new to this subject" : studentKnowledge.stage === "introduced" ? "first ideas introduced" : studentKnowledge.stage === "partial" ? "connecting taught ideas" : "teacher-confirmed teach-back"} · {studentKnowledge.facts.length} teacher fact{studentKnowledge.facts.length === 1 ? "" : "s"}. Instructor verification is shown separately below.</p>}
      <div className="progress-summary"><div><span>{understood === count ? "All concepts understood" : `${count - understood} concept${count - understood === 1 ? "" : "s"} still developing`}</span><strong>{progress}%</strong></div><div className="progress-track" aria-label={`${progress}% understood`}><div style={{ width: `${progress}%` }} /></div></div>
      <div className="concept-card-list" aria-live="polite">{lesson.concepts.map((concept, index) => {
        const value = state[concept.id]; const status = value?.status ?? "unknown";
        return <details className={`concept-card status-${status}`} key={concept.id}><summary><span className="concept-index">{String(index + 1).padStart(2, "0")}</span><span className="concept-title"><strong>{concept.label}</strong><small>{statusLabels[status]}</small></span><span className={`concept-status ${status}`}>{status === "understood" ? "✓" : status === "misunderstood" ? "!" : "·"}</span></summary><div className="concept-detail">
          <div><span>What {studentName} has learned</span><p>{value?.evidence ?? "Waiting for an explanation with enough evidence."}</p></div>
          {value?.belief && <div><span>{studentName}’s working belief · {reviewLabels[value.beliefAccuracy ?? "unverified"]}</span><p>{value.belief}</p></div>}
          {value?.reason && <div><span>Instructor verification</span><p>{value.reason}</p></div>}
          {value?.groundTruth && <div className="misconception-note"><span>Correction for the instructor</span><p>{value.groundTruth}</p></div>}
        </div></details>;
      })}</div>
      <details className="verification-details"><summary>Instructor verification &amp; lesson evidence</summary><div className="verification-grid">
        {instructorGuide.length > 0 && <section><h3>Reference checklist</h3><ul>{instructorGuide.map(fact => <li key={fact.id} className={taughtFactIds.has(fact.id) ? "complete" : ""}><span>{taughtFactIds.has(fact.id) ? "✓" : "○"}</span>{fact.text}</li>)}</ul></section>}
        <section><h3>Recorded teaching evidence</h3>{learnedFacts.length ? <ul>{learnedFacts.map(fact => <li key={fact.id}><span>{fact.teachingComplete ? "✓" : "○"}</span><div>{fact.text}<small>{reviewLabels[fact.review]}</small></div></li>)}</ul> : <p>No facts have passed the instructor check yet.</p>}</section>
        {emotionRecords.length > 0 && <EmotionResponsePanel records={emotionRecords} />}
      </div></details>
      <p className="learning-disclaimer">{studentName}’s working understanding is separate from instructor verification. Progress changes only when evidence from the lesson satisfies the evaluator.</p>
    </> : <div className="lesson-map-empty"><span>✳</span><p>{preparing ? "Building a learning map for this topic…" : "Your student’s evidence-backed progress will appear here when the lesson starts."}</p></div>}
  </section>;
}
