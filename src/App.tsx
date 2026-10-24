import { useEffect, useRef, useState } from "react";
import { RealtimeClient, type Activity, type ConnectionState, type LogEntry, type RealtimeCallbacks } from "./realtime/RealtimeClient";
import { MockClient } from "./realtime/MockClient";
import { emptyTranscript, transcriptReducer, type TranscriptState } from "./state/transcriptStore";
import type { KnowledgeState } from "./state/knowledge";
import type { LessonDefinition } from "./state/lesson";
import type { InstructorGuideFact } from "./state/lesson";
import { initialTopicKnowledge } from "./state/topicKnowledge";
import { prepareLesson, lessonAssessor } from "./realtime/lessonApi";
import { LessonSetup } from "./ui/LessonSetup";
import { LearningMap } from "./ui/LearningMap";
import { DebugDrawer } from "./ui/DebugDrawer";
import { MicButton } from "./ui/MicButton";
import { TranscriptPanel } from "./ui/TranscriptPanel";
import type { RealtimeCredentials } from "./realtime/runtimeConfig";
import { AvatarPhoto } from "./ui/AvatarPhoto";
import { LiveAvatarClient } from "./realtime/LiveAvatarClient";
import { LiveAvatarVideo } from "./ui/LiveAvatarVideo";
import type { RemoteVideoTrack } from "livekit-client";

async function fetchToken(): Promise<RealtimeCredentials> {
  const res = await fetch("/api/token");
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  if (typeof body.value !== "string" || typeof body.model !== "string" || typeof body.websocketUrl !== "string") throw new Error("The server returned invalid voice settings. Restart the local server.");
  return { value: body.value, model: body.model, websocketUrl: body.websocketUrl };
}
type Mode = "avatar" | "voice" | "mock";

export default function App() {
  const [mode, setMode] = useState<Mode>("avatar");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [activity, setActivity] = useState<Activity>("idle");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscript);
  const [knowledge, setKnowledge] = useState<KnowledgeState>({});
  const [topic, setTopic] = useState("");
  const [instructorNotes, setInstructorNotes] = useState("");
  const [familiarity, setFamiliarity] = useState(0);
  const [lesson, setLesson] = useState<LessonDefinition | null>(null);
  const [instructorGuide, setInstructorGuide] = useState<InstructorGuideFact[]>([]);
  const [preparing, setPreparing] = useState(false);
  const startupVersion = useRef(0);
  const startupAbort = useRef<AbortController | null>(null);
  const [micActive, setMicActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micPending, setMicPending] = useState(false);
  const [avatarStatus, setAvatarStatus] = useState<{ configured: boolean; missing: string[]; pythonInstalled: boolean } | null>(null);
  const [presets, setPresets] = useState<{ id: string; name: string }[]>([]);
  const [avatarId, setAvatarId] = useState("builtin_claire_v1");
  const [studentName, setStudentName] = useState("Alex");
  const studentNameCustomized = useRef(false);
  const [videoTrack, setVideoTrack] = useState<RemoteVideoTrack | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarReload, setAvatarReload] = useState(0);
  const client = useRef<RealtimeClient | MockClient | LiveAvatarClient | null>(null);
  const micBusy = useRef(false);
  const connected = connection === "open";
  const busy = preparing || connected || connection === "connecting" || connection === "closing";

  useEffect(() => {
    let active = true;
    void fetch("/api/config").then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(config => {
      if (active) setConfigured(Boolean(config.voiceConfigured));
    }).catch(() => { if (active) setError("Cannot reach the local server. Run npm run dev to start both servers."); });
    return () => { active = false; };
  }, []);
  useEffect(() => () => { startupAbort.current?.abort(); void client.current?.close(); }, []);
  useEffect(() => {
    if (mode !== "avatar") return;
    let active = true;
    setAvatarError(null);
    void fetch("/api/avatar/status").then(r => { if (!r.ok) throw new Error("Restart npm run dev to enable the avatar server."); return r.json(); })
      .then(status => { if (active) setAvatarStatus(status); })
      .catch(e => { if (active) setAvatarError(e instanceof Error ? e.message : "Could not load avatar settings."); });
    void fetch("/api/avatar/presets").then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error); return data; })
      .then(catalog => {
        if (!active) return;
        setPresets(catalog.presets);
        setAvatarId(current => catalog.presets.some((p: { id: string }) => p.id === current) ? current : catalog.presets[0]?.id ?? "");
        if (!studentNameCustomized.current) {
          const selected = catalog.presets.find((preset: { id: string }) => preset.id === avatarId) ?? catalog.presets[0];
          if (selected) setStudentName(selected.name);
        }
      }).catch(e => { if (active) setAvatarError(e instanceof Error ? e.message : "Could not load Boson presets."); });
    return () => { active = false; };
  }, [mode, avatarReload]);

  const start = async () => {
    if (busy) return;
    const version = ++startupVersion.current;
    const abort = new AbortController(); startupAbort.current = abort;
    setError(null); setPreparing(true); setConnection("connecting");
    try {
      if (client.current) await client.current.close();
      if (version !== startupVersion.current) return;
      const prepared = await prepareLesson(topic, mode === "mock", familiarity, studentName, instructorNotes, abort.signal);
      if (version !== startupVersion.current) return;
      setLesson(prepared.lesson); setInstructorGuide(prepared.instructorGuide); setKnowledge(initialTopicKnowledge(prepared.lesson)); setTranscript(emptyTranscript); setLog([]);
      const callbacks: RealtimeCallbacks = {
        tokenProvider: fetchToken, lesson: prepared.lesson, assessEvidence: lessonAssessor(prepared.lesson, prepared.instructorGuide),
        onConnectionState: state => { if (version === startupVersion.current) setConnection(state); }, onActivity: activity => { if (version === startupVersion.current) setActivity(activity); },
        onLog: entry => { if (version === startupVersion.current) setLog(l => [...l.slice(-249), { ...entry, raw: entry.type.includes("audio.delta") || entry.type === "input_audio_buffer.append" ? "[audio chunk omitted]" : entry.raw }]); },
        onClose: info => { if (version === startupVersion.current) setError(info.code === 1000 ? null : info.message); },
        onError: message => { if (version === startupVersion.current) setError(message); }, onMicChange: active => { if (version === startupVersion.current) setMicActive(active); }, onMicLevel: level => { if (version === startupVersion.current) setMicLevel(level); },
        onKnowledgeChange: state => { if (version === startupVersion.current) setKnowledge(state); },
        onServerEvent: evt => { if (version === startupVersion.current) setTranscript(s => transcriptReducer(s, evt, Date.now())); },
      };
      const next = mode === "avatar" ? new LiveAvatarClient(callbacks, avatarId, track => { if (version === startupVersion.current) setVideoTrack(track); }) : mode === "mock" ? new MockClient(callbacks) : new RealtimeClient(callbacks);
      client.current = next;
      setPreparing(false);
      await next.connect();
    } catch (error) {
      if (version !== startupVersion.current) return;
      if (!(error instanceof DOMException && error.name === "AbortError")) setError(error instanceof Error ? error.message : String(error));
      setConnection("closed");
    } finally { if (version === startupVersion.current) setPreparing(false); }
  };
  const toggleMic = async () => {
    if (micBusy.current || !client.current) return;
    micBusy.current = true; setMicPending(true); setError(null);
    try { if (client.current.micActive) await client.current.stopMic(); else await client.current.startMic(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { micBusy.current = false; setMicPending(false); }
  };
  const send = (value = text) => {
    if (!value.trim() || !connected) return;
    void client.current?.sendUserText(value.trim()); setText("");
  };
  const end = () => { ++startupVersion.current; startupAbort.current?.abort(); setPreparing(false); client.current?.disconnect(); setConnection("closed"); setMicActive(false); setMicLevel(0); setVideoTrack(null); };
  return <main className="app">
    <header className="topbar"><a className="brand" href="/"><span className="brand-mark">hı</span> HUMAN INTELLIGENCE</a><span className="project-tag">BOSON AI HACKATHON / 2026</span></header>
    <section className="intro"><div><p className="eyebrow">LEARN BY EXPLAINING</p><h1>A little teaching.<br /><em>A deeper understanding.</em></h1><p className="lede">Meet {studentName}, your AI student. Make a tricky idea click by explaining it in your own words.</p></div><div className="lesson-tag"><span>YOUR CLASSROOM</span><strong>{lesson?.topic || topic.trim() || "Your next lesson"}</strong><span>Any topic. Your explanation.</span></div></section>
    <LessonSetup topic={topic} onTopic={setTopic} studentName={studentName} onStudentName={value => { studentNameCustomized.current = true; setStudentName(value); }} notes={instructorNotes} onNotesChange={setInstructorNotes} familiarity={familiarity} onFamiliarity={setFamiliarity} mockMode={mode === "mock"} disabled={busy} preparing={preparing} onStart={() => void start()} />
    <div className="workspace">
      <section className="conversation-card" aria-label={`Conversation with ${studentName || "your student"}`}>
        <div className="card-head"><div><span className={`dot ${connected ? "dot-open" : ""}`} /><strong>{studentName || "Your student"}</strong><span className="subtle">Your curious student</span></div><span className="pill">{mode === "avatar" ? "HIGGS AVATAR + REALTIME" : mode === "mock" ? "LOCAL MOCK · TEXT ONLY" : "HIGGS REALTIME"}</span></div>
        <div className="controls">
          <div className="session-controls"><select aria-label="Conversation mode" value={mode} onChange={e => { setMode(e.target.value as Mode); setError(null); setTranscript(emptyTranscript); setKnowledge({}); setLesson(null); setInstructorGuide([]); }} disabled={busy}><option value="avatar">Boson talking avatar</option><option value="voice">Boson voice + photo</option><option value="mock">Local mock (text only)</option></select>
          {!busy ? <button className="primary" disabled={!topic.trim() || (mode === "avatar" && (!avatarStatus?.configured || !presets.length))} onClick={() => void start()}>Start lesson <span>↗</span></button> : <button onClick={end}>{preparing ? "Cancel lesson setup" : connection === "connecting" ? "Cancel connection" : "End lesson"}</button>}</div>
          {mode !== "mock" && <MicButton active={micActive} level={micLevel} disabled={!connected || micPending} onToggle={() => void toggleMic()} />}
          {configured === false && mode === "voice" && <p className="notice">Add BOSON_API_KEY to .env and restart the server for live voice, or select Local mock to explore.</p>}
          {mode === "avatar" && <div className="avatar-setup">
            <label htmlFor="avatar-preset">Student avatar</label><select id="avatar-preset" value={avatarId} onChange={e => { const id = e.target.value; setAvatarId(id); studentNameCustomized.current = false; setStudentName(presets.find(preset => preset.id === id)?.name ?? ""); }} disabled={busy || !presets.length}>{presets.length ? presets.map(p => <option value={p.id} key={p.id}>{p.name}</option>) : <option>Loading Boson presets…</option>}</select>
            <p className="avatar-upload-note">To use your own portrait, choose <strong>Boson voice + photo</strong> mode; uploaded photos are not used as live-video presets.</p>
            {avatarStatus && !avatarStatus.configured && <div className="notice"><strong>Connect LiveKit Cloud to start the talking avatar.</strong><p>Create a project at <a href="https://cloud.livekit.io" target="_blank" rel="noreferrer">LiveKit Cloud</a>, then add these missing settings to your local .env and restart npm run dev:</p><code>{avatarStatus.missing.length ? avatarStatus.missing.join(", ") : "BOSON_API_KEY"}</code><p>You can choose “Boson voice + photo” while setting this up.</p></div>}
            {avatarStatus && !avatarStatus.pythonInstalled && <p className="notice">Install the avatar agent once with <code>npm run avatar:setup</code> (Python 3.10+).</p>}
            {avatarError && <div className="error" role="alert"><p>{avatarError}</p><button type="button" disabled={busy} onClick={() => setAvatarReload(value => value + 1)}>Retry avatar setup</button></div>}
          </div>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <div className={`student-stage ${activity === "speaking" ? "speaking" : ""}`}>
          <div className="stage-label">{mode === "avatar" ? "LIVE AVATAR CLASSROOM" : mode === "mock" ? "UI DEVELOPMENT MODE" : "VOICE CLASSROOM"}</div>
          {mode === "avatar" ? <LiveAvatarVideo track={videoTrack} connecting={connection === "connecting"} studentName={studentName} /> : <AvatarPhoto studentName={studentName} />}
          <h2>Let’s figure it out together.</h2><p>{connected ? (mode === "mock" ? `Type an explanation below to try the learning flow with ${studentName}.` : activity === "speaking" ? mode === "avatar" ? `${studentName} is speaking… Wait until they finish, then respond.` : `${studentName} is speaking… You can interrupt.` : activity === "thinking" ? `${studentName} is thinking…` : micActive ? `${studentName} is listening. Go ahead.` : `Turn on your microphone and say hello to ${studentName}.`) : preparing ? `Getting ${studentName} ready to learn your topic…` : lesson?.openingQuestion ?? `Choose a topic and help ${studentName} make sense of it.`}</p>
          <div className="avatar-note">{mode === "avatar" ? "Boson renders the face and speech together in LiveKit." : "Photo mode · Live animation is available in Boson talking avatar mode."}</div>
        </div>
        <div className="transcript-wrap" aria-label="Conversation transcript"><TranscriptPanel state={transcript} topic={lesson?.topic} studentName={studentName} /></div>
        <form className="composer" onSubmit={e => { e.preventDefault(); send(); }}><input aria-label="Your explanation" value={text} onChange={e => setText(e.target.value)} placeholder={connected ? "Or type your explanation here…" : `Start a lesson to talk with ${studentName}…`} disabled={!connected} /><button className="send" disabled={!connected || !text.trim()} aria-label="Send explanation">↑</button></form>
        <div className="conversation-actions"><button className="link" disabled={!connected || activity === "thinking" || activity === "speaking"} onClick={() => send(`Can you teach back what I explained? Try a small example and tell me what still confuses you, ${studentName}.`)}>Ask {studentName} to teach back ↗</button></div>
      </section>
      <aside className="sidebar">
        <LearningMap lesson={lesson} state={knowledge} preparing={preparing} studentName={studentName} instructorGuide={instructorGuide} />
        <section className="hint-card"><span className="spark">✳</span><p className="eyebrow">A PLACE TO START</p><h3>{lesson?.openingQuestion ?? "What would you like your student to learn?"}</h3><p>{studentName} starts with a blank knowledge state and follows the facts you choose to teach, rather than a preset concept sequence.</p><div className="hint-divider" /><p className="fine-print">Ask {studentName} what they learned from the facts you taught.</p></section>
        <a className="avatar-link" href="https://docs.boson.ai/models/higgs-avatar/realtime-sessions" target="_blank" rel="noreferrer">Boson live avatar setup guide ↗</a>
      </aside>
    </div>
    <footer>YOU TEACH. {studentName.toUpperCase()} LEARNS. YOU UNDERSTAND.<span>Powered by Boson Higgs Realtime</span></footer>
    <DebugDrawer entries={log} />
  </main>;
}
