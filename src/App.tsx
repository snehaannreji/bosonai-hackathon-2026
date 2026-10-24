import { useEffect, useMemo, useRef, useState } from "react";
import { RealtimeClient, type Activity, type AudioRenderer, type ConnectionState, type LogEntry, type RealtimeCallbacks } from "./realtime/RealtimeClient";
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
import { WhiteboardPanel } from "./ui/WhiteboardPanel";
import type { VisualContext } from "./whiteboard/observations";
import { MicButton } from "./ui/MicButton";
import { TranscriptPanel } from "./ui/TranscriptPanel";
import type { RealtimeCredentials } from "./realtime/runtimeConfig";
import { AvatarPhoto } from "./ui/AvatarPhoto";
import { LiveAvatarClient } from "./realtime/LiveAvatarClient";
import { LiveAvatarVideo } from "./ui/LiveAvatarVideo";
import type { RemoteVideoTrack } from "livekit-client";
import { emotionDashboardRecords } from "./realtime/emotionDashboard";
import { avatarForStudent, studentAvatarSelection, type AvatarCatalog, type AvatarOption } from "./realtime/avatarCatalog";
import { DEFAULT_STUDENT, studentName as getStudentName, type StudentSettings } from "./state/student";
import { InteractionStatus } from "./ui/InteractionStatus";
import { LessonCompletion } from "./ui/LessonCompletion";

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
  const [audioRenderer, setAudioRenderer] = useState<AudioRenderer>("realtime");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [activity, setActivity] = useState<Activity>("idle");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [emotionLog, setEmotionLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscript);
  const [knowledge, setKnowledge] = useState<KnowledgeState>({});
  const [topic, setTopic] = useState("");
  const [instructorNotes, setInstructorNotes] = useState("");
  const [familiarity, setFamiliarity] = useState(0);
  const [student, setStudent] = useState<StudentSettings>({ ...DEFAULT_STUDENT });
  const [studentName, setStudentName] = useState("Maya");
  const studentNameCustomized = useRef(false);
  const [lesson, setLesson] = useState<LessonDefinition | null>(null);
  const name = lesson?.studentName ?? studentName;
  const [instructorGuide, setInstructorGuide] = useState<InstructorGuideFact[]>([]);
  const [preparing, setPreparing] = useState(false);
  const startupVersion = useRef(0);
  const startupAbort = useRef<AbortController | null>(null);
  const [micActive, setMicActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micPending, setMicPending] = useState(false);
  const [avatarStatus, setAvatarStatus] = useState<{ configured: boolean; missing: string[]; pythonInstalled: boolean } | null>(null);
  const [presets, setPresets] = useState<AvatarOption[]>([]);
  const catalogRef = useRef<AvatarCatalog | null>(null);
  const studentRef = useRef(student);
  studentRef.current = student;
  const [avatarId, setAvatarId] = useState("");
  const [avatarNotice, setAvatarNotice] = useState<string | null>(null);
  const [videoTrack, setVideoTrack] = useState<RemoteVideoTrack | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarReload, setAvatarReload] = useState(0);
  const [whiteboardOpen, setWhiteboardOpen] = useState(false);
  const [developerOpen, setDeveloperOpen] = useState(false);
  const [transcriptCollapsed, setTranscriptCollapsed] = useState(false);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const whiteboardRef = useRef<HTMLElement>(null);
  const client = useRef<RealtimeClient | MockClient | LiveAvatarClient | null>(null);
  const micBusy = useRef(false);
  const connected = connection === "open";
  const busy = preparing || connected || connection === "connecting" || connection === "closing";
  const deliverWhiteboard = useMemo(() => {
    const target = client.current;
    if (!connected || mode === "mock" || !target || !("updateWhiteboard" in target)) return undefined;
    return (context: VisualContext) => target.updateWhiteboard(context);
  }, [connected, mode, lesson?.id]);
  const emotionRecords = useMemo(() => emotionDashboardRecords(emotionLog), [emotionLog]);
  const selectedFace = presets.find(face => face.id === avatarId);
  const studentAppearance = catalogRef.current ? studentAvatarSelection(catalogRef.current, student) : null;
  const changeStudent = (next: StudentSettings) => {
    if (busy) return;
    if (catalogRef.current && next.id !== student.id) setAvatarId(avatarForStudent(catalogRef.current, next));
    if (!studentNameCustomized.current) setStudentName(getStudentName(next));
    setStudent(next); setLesson(null); setKnowledge({}); setTranscript(emptyTranscript); setLog([]); setEmotionLog([]);
  };

  useEffect(() => {
    let active = true;
    void fetch("/api/config").then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(config => {
      if (active) setConfigured(Boolean(config.voiceConfigured));
    }).catch(() => { if (active) setError("Cannot reach the local server. Run npm run dev to start both servers."); });
    return () => { active = false; };
  }, []);
  useEffect(() => () => { startupAbort.current?.abort(); void client.current?.close(); }, []);
  useEffect(() => {
    if (whiteboardRef.current) (whiteboardRef.current as HTMLElement & { inert: boolean }).inert = !whiteboardOpen;
  }, [whiteboardOpen, lesson]);
  useEffect(() => {
    if (mode !== "avatar") return;
    let active = true;
    setAvatarError(null);
    void fetch("/api/avatar/status").then(r => { if (!r.ok) throw new Error("Restart npm run dev to enable the avatar server."); return r.json(); })
      .then(status => { if (active) setAvatarStatus(status); })
      .catch(e => { if (active) setAvatarError(e instanceof Error ? e.message : "Could not load avatar settings."); });
    void fetch("/api/avatar/presets").then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error); return data; })
      .then((catalog: AvatarCatalog) => {
        if (!active) return;
        catalogRef.current = catalog;
        setPresets(catalog.presets);
        setAvatarId(avatarForStudent(catalog, studentRef.current));
        setAvatarNotice(catalog.warning);
        if (!studentNameCustomized.current) {
          setStudentName(getStudentName(studentRef.current));
        }
      }).catch(e => { if (active) setAvatarError(e instanceof Error ? e.message : "Could not load Boson avatars."); });
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
      const prepared = await prepareLesson(topic, mode === "mock", familiarity, studentName, instructorNotes, abort.signal, student);
      if (version !== startupVersion.current) return;
      setLesson(prepared.lesson); setInstructorGuide(prepared.instructorGuide); setKnowledge(initialTopicKnowledge(prepared.lesson)); setTranscript(emptyTranscript); setLog([]); setEmotionLog([]); setCompletionDismissed(false); setWhiteboardOpen(false); setDeveloperOpen(false);
      const callbacks: RealtimeCallbacks = {
        tokenProvider: fetchToken, lesson: prepared.lesson, assessEvidence: lessonAssessor(prepared.lesson, prepared.instructorGuide), audioRenderer,
        onConnectionState: state => { if (version === startupVersion.current) setConnection(state); }, onActivity: activity => { if (version === startupVersion.current) setActivity(activity); },
        onLog: entry => {
          if (version !== startupVersion.current) return;
          setLog(l => [...l.slice(-249), { ...entry, raw: entry.type.includes("audio.delta") || entry.type === "input_audio_buffer.append" ? "[audio chunk omitted]" : entry.raw }]);
          if (entry.type === "client.emotion_used" || entry.type === "client.emotion_acknowledgment") setEmotionLog(events => [...events, entry]);
        },
        onClose: info => { if (version === startupVersion.current) setError(info.code === 1000 ? null : info.message); },
        onError: message => { if (version === startupVersion.current) setError(message); }, onMicChange: active => { if (version === startupVersion.current) setMicActive(active); }, onMicLevel: level => { if (version === startupVersion.current) setMicLevel(level); },
        onKnowledgeChange: state => { if (version === startupVersion.current) setKnowledge(state); },
        onServerEvent: evt => { if (version === startupVersion.current) setTranscript(s => transcriptReducer(s, evt, Date.now())); },
      };
      const next = mode === "avatar" ? new LiveAvatarClient(callbacks, avatarId, track => { if (version === startupVersion.current) setVideoTrack(track); }, audioRenderer) : mode === "mock" ? new MockClient(callbacks) : new RealtimeClient(callbacks);
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
  const newLesson = () => { end(); setLesson(null); setKnowledge({}); setTranscript(emptyTranscript); setInstructorGuide([]); setEmotionLog([]); setCompletionDismissed(false); setWhiteboardOpen(false); };
  const completed = Boolean(lesson?.concepts.length && lesson.concepts.every(concept => knowledge[concept.id]?.status === "understood"));
  const changeMode = (next: Mode) => { setMode(next); setError(null); setTranscript(emptyTranscript); setKnowledge({}); setLesson(null); setInstructorGuide([]); setEmotionLog([]); };
  const modeLabel = mode === "avatar" ? "Boson talking avatar" : mode === "voice" ? "Boson voice + photo" : "Local mock";
  const advancedControls = <>
    <div className="field-group"><label htmlFor="conversation-mode">Conversation mode</label><select id="conversation-mode" value={mode} onChange={e => changeMode(e.target.value as Mode)} disabled={busy}><option value="avatar">Boson talking avatar</option><option value="voice">Boson voice + photo</option><option value="mock">Local mock (text only)</option></select></div>
    {mode !== "mock" && <div className="field-group"><label htmlFor="speech-mode">Speech rendering</label><select id="speech-mode" value={audioRenderer} onChange={e => setAudioRenderer(e.target.value as AudioRenderer)} disabled={busy}><option value="realtime">Realtime audio</option><option value="tagged-tts">Emotion-tagged Higgs TTS</option></select></div>}
    {mode === "avatar" && <div className="field-group avatar-field"><label htmlFor="avatar-preset">Avatar appearance</label><select id="avatar-preset" value={avatarId} onChange={e => setAvatarId(e.target.value)} disabled={busy || !presets.length}>{presets.length ? presets.map(p => <option value={p.id} key={p.id}>{p.name}{p.isPublic ? " · Preset" : " · Account avatar"}</option>) : <option>Loading avatars…</option>}</select>{selectedFace && <p>Live face: {selectedFace.name}</p>}{studentAppearance?.notice && studentAppearance.avatarId === avatarId && <p className="notice">{studentAppearance.notice}</p>}{avatarNotice && <p className="notice">{avatarNotice}</p>}{avatarStatus && !avatarStatus.configured && <p className="error">LiveKit setup is incomplete: {avatarStatus.missing.join(", ") || "BOSON_API_KEY"}.</p>}{avatarStatus && !avatarStatus.pythonInstalled && <p className="error">Run npm run avatar:setup once.</p>}{avatarError && <p className="error">{avatarError} <button type="button" onClick={() => setAvatarReload(value => value + 1)}>Retry</button></p>}</div>}
  </>;

  return <main className={`app ${lesson ? "classroom-view" : "setup-view"}`}>
    <header className="topbar"><button className="brand" onClick={() => { if (!lesson) return; newLesson(); }}><span className="brand-mark">hı</span><span>HUMAN INTELLIGENCE<small>TEACHBACK</small></span></button><span className="project-tag">BOSON AI HACKATHON / 2026</span></header>
    {!lesson ? <>
      <LessonSetup topic={topic} onTopic={setTopic} studentName={studentName} onStudentName={value => { studentNameCustomized.current = true; setStudentName(value); }} student={student} onStudent={changeStudent} notes={instructorNotes} onNotesChange={setInstructorNotes} familiarity={familiarity} onFamiliarity={setFamiliarity} mockMode={mode === "mock"} disabled={busy} preparing={preparing} onStart={() => void start()} advancedControls={advancedControls} />
      {configured === false && mode !== "mock" && <p className="setup-error notice" role="status">Boson voice credentials are not configured yet. Add them to <code>.env</code>, or choose Local mock in Advanced settings.</p>}
      {error && <p className="setup-error error" role="alert">{error}</p>}
      <footer>YOU TEACH. {studentName.toUpperCase()} LEARNS. YOU UNDERSTAND.<span>Powered by Boson Higgs Realtime</span></footer>
    </> : <>
      <header className="classroom-header"><div><button className="back-button" onClick={newLesson} aria-label="Start a new lesson">←</button><div><span>NOW TEACHING</span><h1>{lesson.topic}</h1><p>with {name}</p></div></div><div className="classroom-header-actions"><details className="lesson-settings-popover"><summary>Lesson settings</summary><div><strong>{modeLabel}</strong><span>{audioRenderer === "realtime" ? "Realtime speech" : "Emotion-tagged speech"}</span><span>{lesson.familiarity}% questioning</span><span>{selectedFace ? `${selectedFace.name} avatar` : `${name} profile`}</span></div></details><button onClick={connected || connection === "connecting" ? end : () => void start()}>{connected || connection === "connecting" ? "End session" : "Reconnect"}</button><button className="primary" onClick={newLesson}>New lesson</button></div></header>
      {completed && !completionDismissed && <LessonCompletion lesson={lesson} state={knowledge} studentName={name} onReview={() => setCompletionDismissed(true)} onNewLesson={newLesson} />}
      <div className="classroom-grid">
        <section className="avatar-classroom-card" aria-label={`Live classroom with ${name}`}>
          <div className="avatar-card-head"><div><span className={`dot ${connected ? "dot-open" : ""}`} /><strong>{name}</strong><small>{modeLabel}</small></div><span className="live-pill">{connected ? "LIVE" : connection === "connecting" ? "CONNECTING" : "OFFLINE"}</span></div>
          <div className={`student-stage ${activity === "speaking" ? "speaking" : ""}`}>{mode === "avatar" ? <LiveAvatarVideo track={videoTrack} connecting={connection === "connecting"} name={name} /> : <AvatarPhoto name={name} />}</div>
          <InteractionStatus connection={connection} activity={activity} micActive={micActive} micLevel={micLevel} name={name} hasError={Boolean(error)} />
          <div className="classroom-controls">{mode !== "mock" && <MicButton active={micActive} level={micLevel} disabled={!connected || micPending} onToggle={() => void toggleMic()} />}<button className="whiteboard-launch" onClick={() => setWhiteboardOpen(true)}>✎ Open whiteboard</button></div>
          {error && <p className="error classroom-error" role="alert">{error}</p>}
        </section>
        <LearningMap lesson={lesson} state={knowledge} preparing={preparing} studentName={name} instructorGuide={instructorGuide} emotionRecords={emotionRecords} />
        <section className="conversation-workspace"><div className="transcript-wrap" aria-label="Conversation transcript"><TranscriptPanel state={transcript} topic={lesson.topic} name={name} collapsed={transcriptCollapsed} onToggle={() => setTranscriptCollapsed(value => !value)} /></div><form className="composer" onSubmit={e => { e.preventDefault(); send(); }}><input aria-label="Your explanation" value={text} onChange={e => setText(e.target.value)} placeholder={connected ? `Type an explanation for ${name}…` : "Reconnect to continue…"} disabled={!connected} /><button className="send" disabled={!connected || !text.trim()} aria-label="Send explanation">↑</button></form><div className="conversation-actions"><button disabled={!connected || activity === "thinking" || activity === "speaking"} onClick={() => send(`Can you teach back what I explained? Try a small example and tell me what still confuses you, ${name}.`)}>↗ Ask {name} to teach it back</button></div></section>
      </div>
      <aside ref={whiteboardRef} className={`whiteboard-workspace ${whiteboardOpen ? "open" : ""}`} aria-label="Classroom whiteboard" aria-hidden={!whiteboardOpen}><div className="whiteboard-workspace-head"><div><span>TEACHING TOOL</span><strong>Whiteboard</strong></div><div>{mode !== "mock" && <MicButton active={micActive} level={micLevel} disabled={!connected || micPending} onToggle={() => void toggleMic()} />}<button className="close-workspace" onClick={() => setWhiteboardOpen(false)}>Close ×</button></div></div><WhiteboardPanel sessionKey={lesson.id} ownerToken={lesson.whiteboardOwnerToken} active={connected} deliverObservation={deliverWhiteboard} diagnostics={developerOpen} experiment={new URLSearchParams(window.location.search).get("whiteboardTest") === "1"} /></aside>
      <details className="developer-panel" open={developerOpen} onToggle={event => setDeveloperOpen(event.currentTarget.open)}><summary>Developer &amp; diagnostics <span>{log.length} events</span></summary><div className="developer-panel-body"><div><strong>Connection</strong><p>{connection} · {activity} · {modeLabel}</p></div><div><strong>Whiteboard vision</strong><p>{whiteboardOpen ? "Open the whiteboard to inspect capture and latency diagnostics." : "Open the whiteboard, then return here to enable diagnostics."}</p></div><DebugDrawer entries={log} embedded /></div></details>
      <footer>YOU TEACH. {name.toUpperCase()} LEARNS. YOU UNDERSTAND.<span>Powered by Boson Higgs Realtime</span></footer>
    </>}
  </main>;
}
