import { useEffect, useRef } from "react";
import {
  toList,
  toPlainText,
  type TranscriptItem,
  type TranscriptState,
} from "../state/transcriptStore";

export function TranscriptPanel({ state, topic, studentName = "Alex" }: { state: TranscriptState; topic?: string; studentName?: string }) {
  const items = toList(state);
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the conversation as it grows.
  useEffect(() => {
    const panel = endRef.current?.closest(".transcript-wrap");
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [items.length, items[items.length - 1]]);

  if (items.length === 0) {
    return <p className="empty">Your conversation will appear here. {topic ? `Turn on your microphone and teach ${studentName} about ${topic}.` : "Choose a topic and start a lesson."}</p>;
  }

  return (
    <section className="transcript-panel">
      <div className="transcript-head">
        <span>Transcript</span>
        <button
          className="link"
          onClick={() => void navigator.clipboard.writeText(toPlainText(state))}
        >
          copy
        </button>
      </div>
      {items.map((item) => (
        <TurnBubble key={item.itemId} item={item} studentName={studentName} />
      ))}
      <div ref={endRef} />
    </section>
  );
}

function TurnBubble({ item, studentName = "Alex" }: { item: TranscriptItem; studentName?: string }) {
  if (item.kind === "system") {
    return <div className="turn system">— {item.text} —</div>;
  }

  if (item.kind === "tool") {
    const summary =
      item.result && typeof item.result === "object" && "summary" in item.result
        ? String((item.result as { summary: unknown }).summary)
        : null;
    return (
      <details className={`turn tool ${item.status}`}><summary>Learning update · {item.status}</summary>
        <span className="who">
          {item.name}
          {item.ms != null && <span className="ms"> {item.ms}ms</span>}
        </span>
        <code className="args">{item.args ? JSON.stringify(item.args) : "…"}</code>
        {item.status === "running" && <span className="pending"> running…</span>}
        {summary && <div className="tool-result">{summary}</div>}
      </details>
    );
  }

  if (item.kind === "user") {
    return (
      <div className="turn user">
        <span className="who">you</span>
        {/* text is null until the transcription arrives — which is seconds
            after the words were spoken. Showing the placeholder is what makes
            the UI feel responsive rather than broken. */}
        {item.text === null ? <span className="pending">transcribing…</span> : item.text}
      </div>
    );
  }

  return (
    <div className={`turn assistant ${item.status}`}>
      <span className="who">{studentName}</span>
      {item.text}
      {item.status === "streaming" && <span className="caret" />}
      {item.status === "interrupted" && <span className="badge">interrupted</span>}
    </div>
  );
}
