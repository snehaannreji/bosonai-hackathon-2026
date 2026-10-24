import type { CSSProperties } from "react";
import type { Activity, ConnectionState } from "../realtime/RealtimeClient";

export function InteractionStatus({ connection, activity, micActive, micLevel, name, hasError }: { connection: ConnectionState; activity: Activity; micActive: boolean; micLevel: number; name: string; hasError?: boolean }) {
  const state = hasError ? "error" : connection === "connecting" ? "connecting" : connection !== "open" ? "disconnected" : activity === "speaking" ? "speaking" : activity === "thinking" ? "thinking" : micActive ? "listening" : "waiting";
  const copy = {
    error: ["Connection issue", "Check diagnostics or reconnect"], connecting: [`Connecting ${name}`, "Preparing the live classroom"], disconnected: ["Not connected", "Start or reconnect the lesson"],
    speaking: [`${name} is speaking`, "You can interrupt at any time"], thinking: [`${name} is thinking`, "Making sense of your explanation"], listening: [`${name} is listening`, "Go ahead — explain it your way"], waiting: ["Waiting for you", "Turn on the microphone or type below"],
  }[state];
  const level = state === "listening" ? Math.max(8, Math.min(100, Math.sqrt(micLevel) * 180)) : state === "speaking" ? 72 : 12;
  return <div className={`interaction-status status-${state}`} role="status" aria-live="polite"><span className="status-orb"><i /><i /><i /><i /></span><span><strong>{copy[0]}</strong><small>{copy[1]}</small></span><span className="status-level" style={{ "--level": `${level}%` } as CSSProperties} /></div>;
}
