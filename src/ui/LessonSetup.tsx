import { useRef, useState, type ReactNode } from "react";
import { normalizeInstructorNotes } from "../state/lesson";
import { LEARNING_LEVELS, STUDENTS, type StudentSettings } from "../state/student";

interface Props {
  topic: string; onTopic: (value: string) => void;
  studentName: string; onStudentName: (value: string) => void;
  student: StudentSettings; onStudent: (value: StudentSettings) => void;
  notes: string; onNotesChange: (value: string) => void;
  familiarity: number; onFamiliarity: (value: number) => void;
  mockMode?: boolean; disabled: boolean; preparing: boolean;
  onStart: () => void; advancedControls?: ReactNode;
}

const SUGGESTIONS = ["Gradient descent", "Photosynthesis", "French past tense", "Jazz improvisation"];

export function LessonSetup({ topic, onTopic, studentName, onStudentName, student, onStudent, notes, onNotesChange, familiarity, onFamiliarity, mockMode = false, disabled, preparing, onStart, advancedControls }: Props) {
  const notesInput = useRef<HTMLInputElement>(null);
  const [notesFileName, setNotesFileName] = useState("");
  const [notesError, setNotesError] = useState("");
  const [readingNotes, setReadingNotes] = useState(false);
  const familiarityLabel = familiarity === 0 ? "Very receptive" : familiarity === 100 ? "More questioning" : familiarity < 50 ? "Mostly receptive" : "Somewhat questioning";
  const uploadNotes = async (file?: File) => {
    if (!file) return;
    setNotesError("");
    if (!file.name.toLocaleLowerCase().endsWith(".txt")) return setNotesError("Choose a plain-text .txt file.");
    if (file.size > 64 * 1024) return setNotesError("Notes file must be 64 KB or smaller.");
    setReadingNotes(true);
    try {
      const content = normalizeInstructorNotes(await file.text());
      if (!content) throw new Error("The notes file is empty.");
      onNotesChange(content); setNotesFileName(file.name);
    } catch (error) { setNotesError(error instanceof Error ? error.message : "Could not read this notes file."); }
    finally { setReadingNotes(false); if (notesInput.current) notesInput.current.value = ""; }
  };

  return <section className="setup-shell" aria-label="Create a lesson">
    <div className="setup-copy"><p className="eyebrow">TEACHBACK CLASSROOM</p><h1>The best way to learn<br />is to <em>teach.</em></h1><p>Choose a topic and explain it to an AI student who questions, learns, and teaches it back.</p></div>
    <form className="setup-card" onSubmit={event => { event.preventDefault(); if (!disabled && topic.trim()) onStart(); }}>
      <div className="setup-step"><span>01</span><div><label htmlFor="lesson-topic">What would you like to teach?</label><p>Any idea is welcome. Start broad or get wonderfully specific.</p></div></div>
      <div className="topic-entry"><input id="lesson-topic" value={topic} onChange={event => onTopic(event.target.value)} disabled={disabled} maxLength={160} placeholder="e.g. Why gradient descent moves downhill" autoComplete="off" autoFocus /><button className="start-teaching" type="submit" disabled={disabled || !topic.trim()}>{preparing ? "Preparing lesson…" : "Start teaching"}<span aria-hidden="true">→</span></button></div>
      <div className="topic-chips" aria-label="Suggested topics">{SUGGESTIONS.map(example => <button type="button" key={example} disabled={disabled} className={topic === example ? "selected" : ""} onClick={() => onTopic(example)}>{example}</button>)}</div>
      <div className="setup-divider" />
      <div className="setup-step"><span>02</span><div><strong>Choose your student</strong><p>Both students learn from your explanation and begin without topic facts.</p></div></div>
      <div className="student-choices">{Object.entries(STUDENTS).map(([id, profile]) => <button type="button" key={id} disabled={disabled} className={student.id === id ? "student-choice selected" : "student-choice"} aria-pressed={student.id === id} onClick={() => onStudent({ ...student, id: id as StudentSettings["id"] })}><span className="student-monogram">{profile.name[0]}</span><span><strong>{profile.name}</strong><small>{profile.title}</small><span className="student-description">{profile.description}</span></span><span className="choice-check">{student.id === id ? "✓" : ""}</span></button>)}</div>
      <details className="advanced-settings"><summary><span>Advanced settings</span><small>Intelligence, voice, references and avatar</small></summary><div className="advanced-grid">
        <div className="field-group"><label htmlFor="student-intelligence">Student intelligence</label><select id="student-intelligence" value={student.level} disabled={disabled} onChange={e => onStudent({ ...student, level: e.target.value as StudentSettings["level"] })}>{Object.entries(LEARNING_LEVELS).map(([id, level]) => <option key={id} value={id}>{level.label}</option>)}</select><p>{LEARNING_LEVELS[student.level].description}</p></div>
        <div className="field-group"><label htmlFor="student-name">Student name</label><input id="student-name" value={studentName} onChange={event => onStudentName(event.target.value)} disabled={disabled} maxLength={40} autoComplete="off" /></div>
        <div className="field-group response-style"><div className="familiarity-heading"><label htmlFor="student-familiarity">Response style</label><output htmlFor="student-familiarity">{familiarityLabel}</output></div><input id="student-familiarity" type="range" min="0" max="100" value={familiarity} onChange={event => onFamiliarity(Number(event.target.value))} disabled={disabled} /><div className="familiarity-labels"><span>Receptive</span><span>More questioning</span></div><p>Changes how readily the student questions claims, never its starting knowledge.</p></div>
        {advancedControls}
        <div className="notes-upload"><label htmlFor="instructor-notes">Instructor reference notes</label><input ref={notesInput} id="instructor-notes" type="file" accept=".txt,text/plain" disabled={disabled || readingNotes} onChange={event => void uploadNotes(event.target.files?.[0])} /><p>Optional .txt, up to 64 KB. Used only for instructor verification.</p>{notesFileName && <div className="notes-file"><span>{notesFileName}</span><button type="button" disabled={disabled} onClick={() => { onNotesChange(""); setNotesFileName(""); setNotesError(""); }}>Remove</button></div>}{notesError && <p className="error" role="alert">{notesError}</p>}{mockMode && notes.length > 0 && <p className="notes-mode-notice">Mock mode does not use reference notes.</p>}</div>
      </div></details>
      <span className="visually-hidden" role="status">{preparing ? "Preparing your lesson." : ""}</span>
    </form>
  </section>;
}
