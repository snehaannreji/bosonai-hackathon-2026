import type { EmotionDashboardRecord } from "../realtime/emotionDashboard";

export function EmotionResponsePanel({ records }: { records: EmotionDashboardRecord[] }) {
  return <section className="learning-state-panel instructor-guide emotion-response" aria-label="Student emotion and teacher response" aria-live="polite">
    <h3>Emotion &amp; teacher response</h3>
    <p className="subtle">Anger and sadness expressed by the student, and whether the next teacher response acknowledged the emotion.</p>
    {records.length ? <ol>{records.map(record => <li key={record.id}>
      <strong>Student: {record.emotion}</strong>
      {record.studentTranscript && <p className="assessment-reason"><strong>Student said:</strong> {record.studentTranscript}</p>}
      {record.tags && <small>Audio cue: {record.tags}</small>}
      {record.acknowledged === null
        ? <p className="fine-print">Awaiting the teacher’s next response.</p>
        : <>
            <span className={`emotion-ack-status ${record.acknowledged ? "acknowledged" : "not-acknowledged"}`}>
              {record.acknowledged ? "Acknowledged" : "Not acknowledged"}
            </span>
            {record.teacherTranscript && <p className="assessment-reason"><strong>Teacher:</strong> {record.teacherTranscript}</p>}
          </>}
    </li>)}</ol> : <p className="fine-print">No student anger or sadness has been recorded yet. Use Emotion-tagged Higgs TTS for explicit emotion cues in the audio.</p>}
    <p className="fine-print">Acknowledgment is determined from the teacher’s transcribed words, not audio sentiment analysis.</p>
  </section>;
}
