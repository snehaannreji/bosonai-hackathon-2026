export function LessonSetup({ topic, onTopic, familiarity, onFamiliarity, disabled, preparing, onStart }: { topic: string; onTopic: (value: string) => void; familiarity: number; onFamiliarity: (value: number) => void; disabled: boolean; preparing: boolean; onStart: () => void }) {
  const familiarityLabel = familiarity === 0 ? "No understanding" : familiarity === 100 ? "Understands everything" : familiarity < 50 ? "A little understanding" : "Understands most things";
  return <section className="lesson-setup" aria-label="Choose a lesson topic">
    <form onSubmit={event => { event.preventDefault(); if (!disabled) onStart(); }}>
      <label htmlFor="lesson-topic">What would you like to teach Alex?</label>
      <input id="lesson-topic" value={topic} onChange={event => onTopic(event.target.value)} disabled={disabled} maxLength={160} placeholder="Any topic — photosynthesis, jazz improvisation, your favorite recipe…" aria-describedby="topic-help" autoComplete="off" />
    </form>
    <div className="familiarity-control">
      <div className="familiarity-heading"><label htmlFor="student-familiarity">Alex’s starting understanding</label><output htmlFor="student-familiarity">{familiarity}% · {familiarityLabel}</output></div>
      <input id="student-familiarity" type="range" min="0" max="100" step="1" value={familiarity} onChange={event => onFamiliarity(Number(event.target.value))} disabled={disabled} aria-valuetext={`${familiarity} percent, ${familiarityLabel}`} />
      <div className="familiarity-labels" aria-hidden="true"><span>No understanding</span><span>Understands everything</span></div>
    </div>
    <div className="topic-help-row"><p id="topic-help">{preparing ? "Preparing Alex’s questions and learning map…" : "Choose a topic, start a lesson, and explain it in your own words."}</p><div className="topic-examples">{["Photosynthesis", "French past tense", "Gradient descent"].map(example => <button type="button" key={example} disabled={disabled} onClick={() => onTopic(example)}>{example}</button>)}</div></div>
    <span className="visually-hidden" role="status">{preparing ? "Preparing your lesson." : ""}</span>
  </section>;
}
