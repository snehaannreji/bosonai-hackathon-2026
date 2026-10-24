import { useRef, useState } from "react";
import { normalizeInstructorNotes } from "../state/lesson";
import { LEARNING_LEVELS, STUDENTS, type StudentSettings } from "../state/student";

export function LessonSetup({ topic, onTopic, studentName, onStudentName, student, onStudent, notes, onNotesChange, familiarity, onFamiliarity, mockMode = false, disabled, preparing, onStart }: { topic: string; onTopic: (value: string) => void; studentName: string; onStudentName: (value: string) => void; student: StudentSettings; onStudent: (value: StudentSettings) => void; notes: string; onNotesChange: (value: string) => void; familiarity: number; onFamiliarity: (value: number) => void; mockMode?: boolean; disabled: boolean; preparing: boolean; onStart: () => void }) {
  const notesInput = useRef<HTMLInputElement>(null);
  const [notesFileName, setNotesFileName] = useState("");
  const [notesError, setNotesError] = useState("");
  const [readingNotes, setReadingNotes] = useState(false);
  const familiarityLabel = familiarity === 0 ? "Very receptive" : familiarity === 100 ? "More questioning" : familiarity < 50 ? "Mostly receptive" : "Somewhat questioning";
  const uploadNotes = async (file?: File) => {
    if (!file) return;
    setNotesError("");
    if (!file.name.toLocaleLowerCase().endsWith(".txt")) {
      setNotesError("Choose a plain-text .txt file.");
      return;
    }
    if (file.size > 64 * 1024) {
      setNotesError("Notes file must be 64 KB or smaller.");
      return;
    }
    setReadingNotes(true);
    try {
      const content = normalizeInstructorNotes(await file.text());
      if (!content) throw new Error("The notes file is empty.");
      onNotesChange(content);
      setNotesFileName(file.name);
    } catch (error) {
      setNotesError(error instanceof Error ? error.message : "Could not read this notes file.");
    } finally {
      setReadingNotes(false);
      if (notesInput.current) notesInput.current.value = "";
    }
  };
  return <section className="lesson-setup" aria-label="Choose a lesson topic">
    <form onSubmit={event => { event.preventDefault(); if (!disabled) onStart(); }}>
      <label htmlFor="lesson-topic">What would you like to teach {studentName}?</label>
      <input id="lesson-topic" value={topic} onChange={event => onTopic(event.target.value)} disabled={disabled} maxLength={160} placeholder="Any topic — photosynthesis, jazz improvisation, your favorite recipe…" aria-describedby="topic-help" autoComplete="off" />
    </form>
    <div className="student-settings">
      <div><label htmlFor="student-profile">Student profile</label><select id="student-profile" value={student.id} disabled={disabled} onChange={e => onStudent({ ...student, id: e.target.value as StudentSettings["id"] })}>{Object.entries(STUDENTS).map(([id, profile]) => <option key={id} value={id}>{profile.name}</option>)}</select></div>
      <div><label htmlFor="student-intelligence">Student intelligence</label><select id="student-intelligence" value={student.level} disabled={disabled} onChange={e => onStudent({ ...student, level: e.target.value as StudentSettings["level"] })}>{Object.entries(LEARNING_LEVELS).map(([id, level]) => <option key={id} value={id}>{level.label}</option>)}</select></div>
      <p>{LEARNING_LEVELS[student.level].description}</p>
    </div>
    <label htmlFor="student-name">What should we call your student?</label>
    <input id="student-name" value={studentName} onChange={event => onStudentName(event.target.value)} disabled={disabled} maxLength={40} autoComplete="off" />
    <div className="notes-upload">
      <label htmlFor="instructor-notes">Instructor reference notes (optional)</label>
      <input ref={notesInput} id="instructor-notes" type="file" accept=".txt,text/plain" disabled={disabled || readingNotes} onChange={event => void uploadNotes(event.target.files?.[0])} aria-describedby="notes-help" />
      <p id="notes-help">Plain-text .txt only, up to 64 KB. Sent to Boson for instructor-only checks; the student will not see these notes. Avoid sensitive information, and teach the material to the student yourself.</p>
      {notesFileName && <div className="notes-file"><span>{notesFileName} · {notes.length.toLocaleString()} characters</span><button type="button" disabled={disabled} onClick={() => { onNotesChange(""); setNotesFileName(""); setNotesError(""); }}>Remove notes</button></div>}
      {notesError && <p className="error" role="alert">{notesError}</p>}
      {mockMode && notes.length > 0 && <p className="notes-mode-notice">Local mock mode does not use uploaded reference notes; select Boson voice or talking avatar for instructor checks against your notes.</p>}
    </div>
    <div className="familiarity-control">
      <div className="familiarity-heading"><label htmlFor="student-familiarity">{studentName}’s response style</label><output htmlFor="student-familiarity">{familiarity}% · {familiarityLabel}</output></div>
      <input id="student-familiarity" type="range" min="0" max="100" step="1" value={familiarity} onChange={event => onFamiliarity(Number(event.target.value))} disabled={disabled} aria-valuetext={`${familiarity} percent, ${familiarityLabel}`} />
      <div className="familiarity-labels" aria-hidden="true"><span>Receptive</span><span>More questioning</span></div>
      <p className="fine-print">The student always starts with no topic facts; this only changes how readily they question what is taught.</p>
    </div>
    <div className="topic-help-row"><p id="topic-help">{preparing ? `Preparing ${studentName}’s questions and learning map…` : "Choose a topic, start a lesson, and explain it in your own words."}</p><div className="topic-examples">{["Photosynthesis", "French past tense", "Gradient descent"].map(example => <button type="button" key={example} disabled={disabled} onClick={() => onTopic(example)}>{example}</button>)}</div></div>
    <span className="visually-hidden" role="status">{preparing ? "Preparing your lesson." : ""}</span>
  </section>;
}
