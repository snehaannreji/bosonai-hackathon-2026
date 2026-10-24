import { useEffect, useRef, useState } from "react";
import { RealtimeClient, type Activity, type ConnectionState, type LogEntry, type RealtimeCallbacks } from "./realtime/RealtimeClient";
import { MockClient } from "./realtime/MockClient";
import { emptyTranscript, transcriptReducer, type TranscriptState } from "./state/transcriptStore";
import type { KnowledgeState } from "./state/knowledge";
import type { LessonDefinition } from "./state/lesson";
import { initialTopicKnowledge } from "./state/topicKnowledge";
import { prepareLesson, lessonAssessor } from "./realtime/lessonApi";
import { LessonSetup, type ExperienceMode } from "./ui/LessonSetup";
import { LearningMap } from "./ui/LearningMap";
import { DebugDrawer } from "./ui/DebugDrawer";
import { MicButton } from "./ui/MicButton";
import { TranscriptPanel } from "./ui/TranscriptPanel";
import type { RealtimeCredentials } from "./realtime/runtimeConfig";
import { AvatarPhoto } from "./ui/AvatarPhoto";
import { LiveAvatarClient } from "./realtime/LiveAvatarClient";
import { LiveAvatarVideo } from "./ui/LiveAvatarVideo";
import type { RemoteVideoTrack } from "livekit-client";
import { getCharacter, type CharacterId } from "./state/characters";
import { loadAvatarPhoto } from "./state/avatarPhoto";
import { DEFAULT_LEARNER_SETTINGS, type LearnerSettings } from "./state/learnerSettings";

async function fetchToken(): Promise<RealtimeCredentials> {
  const res = await fetch("/api/token");
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  if (typeof body.value !== "string" || typeof body.model !== "string" || typeof body.websocketUrl !== "string") throw new Error("The server returned invalid voice settings. Restart the local server.");
  return { value: body.value, model: body.model, websocketUrl: body.websocketUrl };
}
type Mode = "avatar" | "voice" | "mock" | "character-clips";
type AvatarStream = { body: ReadableStream<Uint8Array>; contentType: string; key: string };
const isCharacterClipMode = (mode: Mode) => mode === "character-clips";
const hasBundledTalkingPortrait = (id: CharacterId) => id === "baby-yoda" || id === "kevin";

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(new Error("Could not read the character portrait."));
    reader.readAsDataURL(blob);
  });
}

/** Crop the bundled full-body Kevin portrait to a mouth-forward 3:4 framing for Higgs. */
async function cropKevinForLipSync(blob: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width / bitmap.height <= 0.86) { bitmap.close(); return blob; }
    const cropWidth = bitmap.height * 0.675;
    const cropHeight = bitmap.height * 0.9;
    const canvas = document.createElement("canvas");
    canvas.width = 756; canvas.height = 1008;
    const context = canvas.getContext("2d");
    if (!context) { bitmap.close(); return blob; }
    context.drawImage(bitmap, (bitmap.width - cropWidth) / 2, 0, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise(resolve => canvas.toBlob(result => resolve(result ?? blob), "image/webp", 0.92));
  } catch { return blob; }
}

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
  const [learnerSettings, setLearnerSettings] = useState<LearnerSettings>(DEFAULT_LEARNER_SETTINGS);
  const [sourceMaterialName, setSourceMaterialName] = useState("");
  const [sourceMaterial, setSourceMaterial] = useState("");
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>("study");
  const [characterId, setCharacterId] = useState<CharacterId>("maya");
  const character = getCharacter(characterId);
  const [lesson, setLesson] = useState<LessonDefinition | null>(null);
  const [preparing, setPreparing] = useState(false);
  const startupVersion = useRef(0);
  const startupAbort = useRef<AbortController | null>(null);
  const [micActive, setMicActive] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micPending, setMicPending] = useState(false);
  const [avatarStatus, setAvatarStatus] = useState<{ configured: boolean; missing: string[]; pythonInstalled: boolean } | null>(null);
  const [presets, setPresets] = useState<{ id: string; name: string }[]>([]);
  const [avatarId, setAvatarId] = useState("builtin_claire_v1");
  const [videoTrack, setVideoTrack] = useState<RemoteVideoTrack | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarReload, setAvatarReload] = useState(0);
  const [clipId, setClipId] = useState<string | null>(null);
  const [clipStream, setClipStream] = useState<AvatarStream | null>(null);
  const [clipStatus, setClipStatus] = useState("");
  const clipAbort = useRef<AbortController | null>(null);
  const resumeMicAfterClip = useRef(false);
  const client = useRef<RealtimeClient | MockClient | LiveAvatarClient | null>(null);
  const micBusy = useRef(false);
  const connected = connection === "open";
  const busy = preparing || connected || connection === "connecting" || connection === "closing";

  const makeCharacterClip = async (characterId: CharacterId, replyText: string, version: number, feedbackDirectness: number) => {
    setClipId(null); setClipStream(null); setClipStatus(`Preparing ${getCharacter(characterId).name}’s reply…`); setError(null);
    const abort = new AbortController(); clipAbort.current = abort;
    try {
      resumeMicAfterClip.current = Boolean(client.current?.micActive);
      if (resumeMicAfterClip.current) await client.current?.stopMic();
      setMicActive(false); setMicLevel(0);
      const photo = await loadAvatarPhoto(characterId);
      let portrait: Blob;
      let usingBundledPortrait = false;
      if (photo?.blob) portrait = photo.blob;
      else {
        usingBundledPortrait = true;
        const bundledPortrait = characterId === "kevin" ? "/characters/kevin.jpeg?v=2" : "/characters/baby-yoda.jpeg";
        const response = await fetch(bundledPortrait);
        if (!response.ok) throw new Error(`Could not load ${getCharacter(characterId).name}’s portrait.`);
        portrait = await response.blob();
      }
      if (characterId === "kevin" && usingBundledPortrait) portrait = await cropKevinForLipSync(portrait);
      setClipStatus("Generating a voice and lip-synced talking clip…");
      const response = await fetch(characterId === "kevin" ? "/api/avatar/character-videos/stream" : "/api/avatar/character-videos", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId, imageMime: portrait.type || (characterId === "kevin" ? "image/webp" : "image/jpeg"), imageBase64: await blobBase64(portrait), replyText, feedbackDirectness }),
        signal: abort.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `Could not create ${getCharacter(characterId).name}’s talking clip.`);
      }
      if (characterId === "kevin") {
        if (!response.body) throw new Error("Boson started the clip without a video stream.");
        setClipStream({ body: response.body, contentType: response.headers.get("content-type") ?? "video/mp4", key: `${version}-${Date.now()}` });
        setClipStatus("Kevin is starting to talk…");
        return;
      }
      const created = await response.json();
      for (let attempt = 0; attempt < 150; attempt++) {
        if (abort.signal.aborted || startupVersion.current !== version) return;
        const statusResponse = await fetch(`/api/avatar/character-videos/${created.id}`, { signal: abort.signal });
        const status = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(status.error ?? "Could not check the talking clip.");
        if (status.status === "failed") throw new Error(status.error ?? "Boson could not render the talking clip.");
        if (status.status === "completed") {
          setClipId(created.id); setClipStatus("Your reply is ready. Playing now…");
          return;
        }
        setClipStatus(`Generating the talking clip… ${Math.max(0, Math.min(99, status.progress ?? 0))}%`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      throw new Error("The talking clip is taking too long. You can try another reply in a moment.");
    } catch (e) {
      if (!abort.signal.aborted && startupVersion.current === version) {
        setError(e instanceof Error ? e.message : "Could not generate the talking clip.");
        setClipStatus("");
        const resume = resumeMicAfterClip.current; resumeMicAfterClip.current = false;
        if (resume) try { await client.current?.startMic(); } catch { /* the user can restart the microphone */ }
      }
    }
  };
  const resumeCharacterClipMic = () => {
    const resume = resumeMicAfterClip.current; resumeMicAfterClip.current = false;
    setClipId(null); setClipStream(null); setClipStatus(""); setActivity(resume ? "listening" : "idle");
    if (resume) void client.current?.startMic().catch(e => setError(e instanceof Error ? e.message : "Could not restart the microphone."));
  };

  useEffect(() => {
    let active = true;
    void fetch("/api/config").then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(config => {
      if (active) setConfigured(Boolean(config.voiceConfigured));
    }).catch(() => { if (active) setError("Cannot reach the local server. Run npm run dev to start both servers."); });
    return () => { active = false; };
  }, []);
  useEffect(() => () => { startupAbort.current?.abort(); clipAbort.current?.abort(); void client.current?.close(); }, []);
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
      const prepared = await prepareLesson(topic, mode === "mock", abort.signal);
      if (version !== startupVersion.current) return;
      setLesson(prepared); setKnowledge(initialTopicKnowledge(prepared)); setTranscript(emptyTranscript); setLog([]);
      const callbacks: RealtimeCallbacks = {
        tokenProvider: fetchToken, lesson: prepared, characterId, learnerSettings, sourceMaterial, assessEvidence: lessonAssessor(prepared),
        outputMode: isCharacterClipMode(mode) ? "text" : "audio",
        onAssistantReply: isCharacterClipMode(mode) ? reply => { void makeCharacterClip(characterId, reply, version, learnerSettings.feedbackDirectness); } : undefined,
        onConnectionState: state => { if (version === startupVersion.current) setConnection(state); }, onActivity: activity => { if (version === startupVersion.current) setActivity(activity); },
        onLog: entry => { if (version === startupVersion.current) setLog(l => [...l.slice(-249), { ...entry, raw: entry.type.includes("audio.delta") || entry.type === "input_audio_buffer.append" ? "[audio chunk omitted]" : entry.raw }]); },
        onClose: info => { if (version === startupVersion.current) setError(info.code === 1000 ? null : info.message); },
        onError: message => { if (version === startupVersion.current) setError(message); }, onMicChange: active => { if (version === startupVersion.current) setMicActive(active); }, onMicLevel: level => { if (version === startupVersion.current) setMicLevel(level); },
        onKnowledgeChange: state => { if (version === startupVersion.current) setKnowledge(state); },
        onServerEvent: evt => { if (version === startupVersion.current) setTranscript(s => transcriptReducer(s, evt, Date.now())); },
      };
      const next = mode === "avatar" ? new LiveAvatarClient(callbacks, avatarId, track => { if (version === startupVersion.current) setVideoTrack(track); }, characterId) : mode === "mock" ? new MockClient(callbacks) : new RealtimeClient(callbacks);
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
    if (!value.trim() || !connected || (isCharacterClipMode(mode) && Boolean(clipStatus))) return;
    void client.current?.sendUserText(value.trim()); setText("");
  };
  const end = () => { ++startupVersion.current; startupAbort.current?.abort(); clipAbort.current?.abort(); setPreparing(false); setClipId(null); setClipStream(null); setClipStatus(""); client.current?.disconnect(); setConnection("closed"); setMicActive(false); setMicLevel(0); setVideoTrack(null); };
  const startingHunch = lesson?.concepts.find(c => c.initialBelief)?.initialBelief;

  return <main className="app">
    <header className="topbar"><a className="brand" href="/"><span className="brand-mark">hı</span> HUMAN INTELLIGENCE</a><span className="project-tag">BOSON AI HACKATHON / 2026</span></header>
    <section className="intro"><div><p className="eyebrow">LEARN BY EXPLAINING</p><h1>A little teaching.<br /><em>A deeper understanding.</em></h1><p className="lede">Meet {character.name}, your AI student. Make a tricky idea click by explaining it in your own words.</p></div><div className="lesson-tag"><span>YOUR CLASSROOM</span><strong>{lesson?.topic || topic.trim() || "Your next lesson"}</strong><span>Any topic. Your explanation.</span></div></section>
    <LessonSetup topic={topic} onTopic={setTopic} experienceMode={experienceMode} onExperienceMode={next => { setExperienceMode(next); const nextCharacter: CharacterId = next === "study" ? "maya" : "kevin"; setCharacterId(nextCharacter); setClipId(null); setClipStream(null); setClipStatus(""); setMode(next === "fun" ? "character-clips" : "avatar"); }} characterId={characterId} onCharacter={id => { setCharacterId(id); setClipId(null); setClipStream(null); setClipStatus(""); if (hasBundledTalkingPortrait(id)) setMode("character-clips"); else if (isCharacterClipMode(mode)) setMode("avatar"); }} settings={learnerSettings} onSettings={value => { setLearnerSettings(value); if (client.current instanceof RealtimeClient) client.current.updateLearnerSettings(value, sourceMaterial); else if (client.current instanceof LiveAvatarClient) void client.current.updateLearnerSettings(value, sourceMaterial); }} sourceMaterialName={sourceMaterialName} onSourceMaterial={(name, value) => { setSourceMaterialName(name); setSourceMaterial(value); }} disabled={busy} preparing={preparing} onStart={() => void start()} />
    <div className="workspace">
      <section className="conversation-card" aria-label={`Conversation with ${character.name}`}>
          <div className="card-head"><div><span className={`dot ${connected ? "dot-open" : ""}`} /><strong>{character.name}</strong><span className="subtle">{character.description}</span></div><span className="pill">{mode === "avatar" ? "HIGGS AVATAR + REALTIME" : isCharacterClipMode(mode) ? "HIGGS TTS + GENERATED CLIPS" : mode === "mock" ? "LOCAL MOCK · TEXT ONLY" : "HIGGS REALTIME"}</span></div>
        <div className="controls">
          <div className="session-controls"><select aria-label="Conversation mode" value={mode} onChange={e => { setMode(e.target.value as Mode); setError(null); setTranscript(emptyTranscript); setKnowledge({}); setLesson(null); setClipId(null); setClipStream(null); setClipStatus(""); }} disabled={busy}><option value="avatar">Boson talking avatar</option><option value="voice">Boson voice + photo</option>{hasBundledTalkingPortrait(characterId) && <option value="character-clips">{character.name} talking clips</option>}<option value="mock">Local mock (text only)</option></select>
          {!busy ? <button className="primary" disabled={!topic.trim() || (mode === "avatar" && (!avatarStatus?.configured || !presets.length)) || (isCharacterClipMode(mode) && !configured)} onClick={() => void start()}>Start lesson <span>↗</span></button> : <button onClick={end}>{preparing ? "Cancel lesson setup" : connection === "connecting" ? "Cancel connection" : "End lesson"}</button>}</div>
          {mode !== "mock" && <MicButton active={micActive} level={micLevel} disabled={!connected || micPending || (isCharacterClipMode(mode) && Boolean(clipStatus))} onToggle={() => void toggleMic()} />}
          {configured === false && mode === "voice" && <p className="notice">Add BOSON_API_KEY to .env and restart the server for live voice, or select Local mock to explore.</p>}
          {mode === "avatar" && <div className="avatar-setup">
            <label htmlFor="avatar-preset">Student avatar</label><select id="avatar-preset" value={avatarId} onChange={e => setAvatarId(e.target.value)} disabled={busy || !presets.length}>{presets.length ? presets.map(p => <option value={p.id} key={p.id}>{p.name}</option>) : <option>Loading Boson presets…</option>}</select>
            <p className="character-note">{characterId === "baby-yoda" ? "Choose a registered Boson avatar here. Uploading a photo in voice + photo mode only displays a still image; a custom live face must first be enabled for your Boson API key." : "The selected character changes the learner’s personality. Live faces come from avatars enabled for your Boson API key."}</p>
            {avatarStatus && !avatarStatus.configured && <div className="notice"><strong>Connect LiveKit Cloud to start the talking avatar.</strong><p>Create a project at <a href="https://cloud.livekit.io" target="_blank" rel="noreferrer">LiveKit Cloud</a>, then add these missing settings to your local .env and restart npm run dev:</p><code>{avatarStatus.missing.length ? avatarStatus.missing.join(", ") : "BOSON_API_KEY"}</code><p>You can choose “Boson voice + photo” while setting this up.</p></div>}
            {avatarStatus && !avatarStatus.pythonInstalled && <p className="notice">Install the avatar agent once with <code>npm run avatar:setup</code> (Python 3.10+).</p>}
            {avatarError && <div className="error" role="alert"><p>{avatarError}</p><button type="button" disabled={busy} onClick={() => setAvatarReload(value => value + 1)}>Retry avatar setup</button></div>}
          </div>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <div className={`student-stage ${activity === "speaking" ? "speaking" : ""}`}>
          <div className="stage-label">{mode === "avatar" ? "LIVE AVATAR CLASSROOM" : isCharacterClipMode(mode) ? `${character.name.toUpperCase()} TALKING CLIPS` : mode === "mock" ? "UI DEVELOPMENT MODE" : "VOICE CLASSROOM"}</div>
          {mode === "avatar" ? <LiveAvatarVideo track={videoTrack} connecting={connection === "connecting"} name={character.name} /> : <AvatarPhoto name={character.name} characterId={characterId} photoSentToProvider={isCharacterClipMode(mode)} disabled={busy} videoSrc={isCharacterClipMode(mode) && clipId ? `/api/avatar/character-videos/${clipId}/content` : undefined} videoStream={isCharacterClipMode(mode) ? clipStream : null} clipPreparing={isCharacterClipMode(mode) && Boolean(clipStatus) && !clipId && !clipStream} onClipPlaying={() => setActivity("speaking")} onClipEnded={resumeCharacterClipMic} onClipError={message => { setError(message ?? "Could not play the generated clip. Check your connection and retry."); resumeCharacterClipMic(); }} />}
          <h2>{isCharacterClipMode(mode) ? `Your turn, then ${character.name} replies.` : "Let’s figure it out together."}</h2><p>{isCharacterClipMode(mode) && clipStatus ? clipStatus : connected ? (mode === "mock" ? "Type an explanation below to try the learning flow." : activity === "speaking" ? `${character.name} is speaking… You can interrupt.` : activity === "thinking" ? (isCharacterClipMode(mode) ? "Thinking of a reply…" : `${character.name} is thinking…`) : micActive ? `${character.name} is listening. Go ahead.` : "Turn on your microphone and say hello.") : preparing ? `Getting ${character.name} ready to learn your topic…` : lesson?.openingQuestion ?? `Choose a topic and help ${character.name} make sense of it.`}</p>
          <div className="avatar-note">{isCharacterClipMode(mode) ? `The included ${character.name} portrait is ready. Speak or type; Boson generates a moving clip for each reply. Upload another picture in this panel to change the look.` : mode === "avatar" ? characterId === "baby-yoda" ? "Live preset mode uses the selected Boson face. Choose Baby Yoda talking clips to animate the Baby Yoda portrait." : "Boson renders the face and speech together in LiveKit." : characterId === "baby-yoda" ? "Baby Yoda’s portrait is a still image here. Choose Baby Yoda talking clips to animate it." : "Photo mode · Live animation is available in Boson talking avatar mode."}</div>
        </div>
        <div className="transcript-wrap" aria-label="Conversation transcript"><TranscriptPanel state={transcript} topic={lesson?.topic} speakerName={character.name} /></div>
        <form className="composer" onSubmit={e => { e.preventDefault(); send(); }}><input aria-label="Your explanation" value={text} onChange={e => setText(e.target.value)} placeholder={connected ? "Or type your explanation here…" : `Start a lesson to talk with ${character.name}…`} disabled={!connected || (isCharacterClipMode(mode) && Boolean(clipStatus))} /><button className="send" disabled={!connected || !text.trim() || (isCharacterClipMode(mode) && Boolean(clipStatus))} aria-label="Send explanation">↑</button></form>
        <div className="conversation-actions"><button className="link" disabled={!connected || activity === "thinking" || activity === "speaking" || (isCharacterClipMode(mode) && Boolean(clipStatus))} onClick={() => send("Can you teach back what I explained? Try a small example and tell me what still confuses you.")}>Ask {character.name} to teach back ↗</button></div>
      </section>
      <aside className="sidebar">
        <LearningMap lesson={lesson} state={knowledge} preparing={preparing} studentName={character.name} />
        <section className="hint-card"><span className="spark">✳</span><p className="eyebrow">{startingHunch ? `${character.name.toUpperCase()}’S STARTING HUNCH` : "A PLACE TO START"}</p><h3>{startingHunch ? `“${startingHunch}”` : lesson?.openingQuestion ?? "What’s the big idea?"}</h3><p>{startingHunch ? `Help ${character.name} reason through this idea. Explain why, then try an example together.` : "Start with the main idea in plain language. Build on it one explanation at a time."}</p><div className="hint-divider" /><p className="fine-print">Ask {character.name} to explain it back in a new example.</p></section>
        <a className="avatar-link" href="https://docs.boson.ai/models/higgs-avatar/realtime-sessions" target="_blank" rel="noreferrer">Boson live avatar setup guide ↗</a>
      </aside>
    </div>
    <footer>YOU TEACH. {character.name.toUpperCase()} LEARNS. YOU UNDERSTAND.<span>Powered by Boson Higgs Realtime</span></footer>
    <DebugDrawer entries={log} />
  </main>;
}
