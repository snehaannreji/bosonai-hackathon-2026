import type { KnowledgeState } from "../state/knowledge";
import type { LessonDefinition } from "../state/lesson";
export function LearningMap({ lesson, state, preparing, name = "Maya" }: { lesson: LessonDefinition | null; state: KnowledgeState; preparing: boolean; name?: string }) {
  const understood = lesson?.concepts.filter(c => state[c.id]?.status === "understood").length ?? 0;
  const count = lesson?.concepts.length ?? 0;
  const progress = count ? Math.round(understood / count * 100) : 0;
  return <section className="knowledge-card"><p className="eyebrow">THE LEARNING MAP</p><h2>Inside {name}’s mind</h2><p className="subtle">{lesson ? `Learning ${lesson.topic}` : "A new topic. A fresh perspective."}</p>
    {lesson ? <><div className="progress-line"><span>{understood} of {count} concepts understood</span><span>{progress}%</span></div><div className="progress-track"><div style={{ width: `${progress}%` }} /></div>
      <div className="concepts" aria-live="polite">{lesson.concepts.map((concept, i) => <article className="concept" key={concept.id}><div className="concept-top"><span className="concept-number">0{i + 1}</span><h3>{concept.label}</h3></div><span className={`knowledge-status ${state[concept.id]?.status ?? "unknown"}`}>{state[concept.id]?.status ?? "unknown"}</span><p>{state[concept.id]?.evidence ?? "Waiting for your explanation."}</p>{state[concept.id]?.reason && <p className="assessment-reason">{state[concept.id].reason}</p>}</article>)}</div>
    </> : <div className="lesson-map-empty"><span>✳</span><p>{preparing ? "Finding three starting points for your topic…" : `Enter a topic and start a lesson. ${name}’s learning map will appear here.`}</p></div>}
    <p className="fine-print">{lesson?.mock ? "Local mock: learning updates are simulated for UI development." : "Learning is simulated from evidence in your explanations. This is not a formal assessment."}</p>
  </section>;
}
