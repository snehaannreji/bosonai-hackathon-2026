export function LessonSetup({ topic, onTopic, disabled, preparing, onStart }: { topic: string; onTopic: (value: string) => void; disabled: boolean; preparing: boolean; onStart: () => void }) {
  return <section className="lesson-setup" aria-label="Choose a lesson topic">
    <form onSubmit={event => { event.preventDefault(); if (!disabled) onStart(); }}>
      <label htmlFor="lesson-topic">What would you like to teach Alex?</label>
      <input id="lesson-topic" value={topic} onChange={event => onTopic(event.target.value)} disabled={disabled} maxLength={160} placeholder="Any topic — photosynthesis, jazz improvisation, your favorite recipe…" aria-describedby="topic-help" autoComplete="off" />
    </form>
    <div className="topic-help-row"><p id="topic-help">{preparing ? "Preparing Alex’s questions and learning map…" : "Choose a topic, start a lesson, and explain it in your own words."}</p><div className="topic-examples">{["Photosynthesis", "French past tense", "Gradient descent"].map(example => <button type="button" key={example} disabled={disabled} onClick={() => onTopic(example)}>{example}</button>)}</div></div>
    <span className="visually-hidden" role="status">{preparing ? "Preparing your lesson." : ""}</span>
  </section>;
}
