import { LEARNING_LEVELS, STUDENTS, studentName, type StudentSettings } from "../state/student";

export function LessonSetup({ topic, onTopic, student, onStudent, disabled, preparing, onStart }: { topic: string; onTopic: (value: string) => void; student: StudentSettings; onStudent: (value: StudentSettings) => void; disabled: boolean; preparing: boolean; onStart: () => void }) {
  const name = studentName(student);
  return <section className="lesson-setup" aria-label="Choose a lesson topic">
    <form onSubmit={event => { event.preventDefault(); if (!disabled) onStart(); }}>
      <label htmlFor="lesson-topic">What would you like to teach {name}?</label>
      <input id="lesson-topic" value={topic} onChange={event => onTopic(event.target.value)} disabled={disabled} maxLength={160} placeholder="Any topic — photosynthesis, jazz improvisation, your favorite recipe…" aria-describedby="topic-help" autoComplete="off" />
    </form>
    <div className="student-settings">
      <div><label htmlFor="student-name">Your student</label><select id="student-name" value={student.id} disabled={disabled} onChange={e => onStudent({ ...student, id: e.target.value as StudentSettings["id"] })}>{Object.entries(STUDENTS).map(([id, profile]) => <option key={id} value={id}>{profile.name}</option>)}</select></div>
      <div><label htmlFor="student-intelligence">Student intelligence</label><select id="student-intelligence" value={student.level} disabled={disabled} aria-describedby="student-level-help" onChange={e => onStudent({ ...student, level: e.target.value as StudentSettings["level"] })}>{Object.entries(LEARNING_LEVELS).map(([id, level]) => <option key={id} value={id}>{level.label}</option>)}</select></div>
      <p id="student-level-help">{LEARNING_LEVELS[student.level].description} Adjusts simulated learning behavior.</p>
    </div>
    <div className="topic-help-row"><p id="topic-help">{preparing ? `Preparing ${name}’s questions and learning map…` : "Choose a topic, start a lesson, and explain it in your own words."}</p><div className="topic-examples">{["Photosynthesis", "French past tense", "Gradient descent"].map(example => <button type="button" key={example} disabled={disabled} onClick={() => onTopic(example)}>{example}</button>)}</div></div>
    <span className="visually-hidden" role="status">{preparing ? "Preparing your lesson." : ""}</span>
  </section>;
}
