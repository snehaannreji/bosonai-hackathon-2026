import { useEffect, useRef } from "react";
import {
  toList,
  toPlainText,
  type TranscriptItem,
  type TranscriptState,
} from "../state/transcriptStore";

export function TranscriptPanel({ state, topic, name = "Maya", collapsed = false, onToggle }: { state: TranscriptState; topic?: string; name?: string; collapsed?: boolean; onToggle?: () => void }) {
  const items = toList(state);
  const endRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    const panel = endRef.current?.closest(".transcript-wrap");
    if (!panel) return;
    const onScroll = () => { follow.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80; };
    panel.addEventListener("scroll", onScroll, { passive: true });
    return () => panel.removeEventListener("scroll", onScroll);
  }, []);

  // Follow new speech only while the reader is already near the latest turn.
  useEffect(() => {
    const panel = endRef.current?.closest(".transcript-wrap");
    if (panel && follow.current && !collapsed) panel.scrollTo({ top: panel.scrollHeight, behavior: "smooth" });
  }, [items.length, items[items.length - 1], collapsed]);

  if (items.length === 0) {
    return <p className="empty">Your conversation will appear here. {topic ? `Turn on your microphone and teach ${name} about ${topic}.` : "Choose a topic and start a lesson."}</p>;
  }

  return (
    <section className={`transcript-panel ${collapsed ? "is-collapsed" : ""}`}>
      <div className="transcript-head">
        <span>Conversation <small>{items.length} updates</small></span><div><button className="link" onClick={() => void navigator.clipboard.writeText(toPlainText(state))}>Copy</button>{onToggle && <button className="link" onClick={onToggle}>{collapsed ? "Expand" : "Collapse"}</button>}</div>
      </div>
      {(collapsed ? items.slice(-2) : items).map((item) => (
        <TurnBubble key={item.itemId} item={item} name={name} />
      ))}
      <div ref={endRef} />
    </section>
  );
}

function TurnBubble({ item, name }: { item: TranscriptItem; name: string }) {
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
      <span className="who">{name}</span>
      {item.text}
      {item.status === "streaming" && <span className="caret" />}
      {item.status === "interrupted" && <span className="badge">interrupted</span>}
    </div>
  );
}
