import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { Router, type Response } from "express";
import type { LessonService } from "./lessons";
import type { LessonDefinition } from "../src/state/lesson";
import { getCharacter, type CharacterId } from "../src/state/characters";
import { catalogCache } from "../src/realtime/catalogCache";
import { AccessToken } from "livekit-server-sdk";
import { AvatarToolBridge } from "../src/realtime/avatarToolBridge";
import { buildSessionConfig, studentPrompt, SYSTEM_PROMPT } from "../src/realtime/sessionConfig";
import { readRealtimeSettings } from "../src/realtime/runtimeConfig";
import { userTextItem, responseCreate, type ClientEvent } from "../src/realtime/events";
import { DEFAULT_LEARNER_SETTINGS, type LearnerSettings } from "../src/state/learnerSettings";
import { VisualContextChannel } from "../src/whiteboard/contextChannel";
import { parseVisualContext, type VisualContext } from "../src/whiteboard/observations";

type StreamMessage = { kind: string; [key: string]: unknown };
interface Lesson {
  id: string; room: string; avatarId: string; characterId: CharacterId; child: ChildProcessWithoutNullStreams | null;
  definition?: LessonDefinition; avatarSessionId?: string; listeners: Set<Response>; history: StreamMessage[];
  learnerSettings: LearnerSettings; sourceMaterial: string;
  bridge: AvatarToolBridge; ready: boolean; ending: boolean; timer: ReturnType<typeof setTimeout>; kevinLearningStarted: boolean;
  visualContext: VisualContextChannel;
}
export function livekitMissing(env: Record<string, string | undefined>): string[] {
  return ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"].filter(name => !env[name]?.trim());
}
export function validateLivekitCloudUrl(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === "wss:" && parsed.hostname.endsWith(".livekit.cloud") && !parsed.username && !parsed.password && !parsed.port && parsed.pathname === "/" && !parsed.search && !parsed.hash; } catch { return false; }
}

export function createAvatarRouter(apiKey: string | undefined, lessonService: LessonService) {
  const router = Router();
  const lessons = new Map<string, Lesson>();
  const characterVideos = new Map<string, string>();
  const base = (process.env.BOSON_BASE_URL ?? "https://api.boson.ai").replace(/\/$/, "");
  const settings = readRealtimeSettings(process.env);
  const python = process.env.AVATAR_PYTHON || resolve(
    process.platform === "win32" ? ".venv-avatar/Scripts/python.exe" : ".venv-avatar/bin/python",
  );
  const publish = (lesson: Lesson, message: StreamMessage) => {
    lesson.history.push(message); if (lesson.history.length > 250) lesson.history.shift();
    for (const res of lesson.listeners) res.write(`data: ${JSON.stringify(message)}\n\n`);
  };
  const send = (lesson: Lesson, event: ClientEvent) => {
    if (!lesson.ending && lesson.child?.stdin.writable) lesson.child.stdin.write(JSON.stringify({ kind: "send", event }) + "\n");
  };
  const end = async (lesson: Lesson) => {
    if (lesson.ending) return;
    lesson.ending = true; clearTimeout(lesson.timer);
    lesson.visualContext.close();
    lesson.child?.kill("SIGINT");
    const force = setTimeout(() => lesson.child?.kill("SIGKILL"), lesson.avatarSessionId ? 10000 : 75000); force.unref();
    // Backup release also covers a worker crash. Releasing an ended session is safe.
    if (lesson.avatarSessionId && apiKey) {
      try { await fetch(`${base}/v1/avatar/sessions/${encodeURIComponent(lesson.avatarSessionId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) }); } catch { /* worker also releases in finally; session has a hard 10-minute cap */ }
    }
    publish(lesson, { kind: "closed" });
    for (const res of lesson.listeners) res.end();
    if (!lesson.child || lesson.child.exitCode !== null) lessons.delete(lesson.id);
  };
  const error = (lesson: Lesson, message: string) => { publish(lesson, { kind: "error", message }); void end(lesson); };

  router.get("/status", (_req, res) => {
    const missing = livekitMissing(process.env);
    res.json({ configured: Boolean(apiKey) && missing.length === 0, missing, pythonInstalled: existsSync(python) });
  });
  const loadCatalog = catalogCache(async () => {
    const upstream = await fetch(`${base}/v1/avatars`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) throw new Error(upstream.status === 429 ? "Boson’s avatar catalog is temporarily rate limited. Wait a moment and retry." : `Boson avatar catalog returned ${upstream.status}.`);
    const data = await upstream.json() as { data?: { avatar_id: string; name: string; is_public: boolean }[] };
    // Boson returns public presets and avatars enabled for this API key. Keep
    // both: customer supplied faces may be private to the account.
    return (data.data ?? []).filter(a => typeof a.avatar_id === "string" && a.avatar_id.length > 0).map(a => ({ id: a.avatar_id, name: a.name || a.avatar_id }));
  });
  router.get("/presets", async (_req, res) => {
    if (!apiKey) return res.status(503).json({ error: "Add BOSON_API_KEY to .env first." });
    try { return res.json({ presets: await loadCatalog() }); }
    catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : "Could not reach Boson’s avatar catalog." }); }
  });
  // Talking portrait mode uses a bundled image and voice reference. Assets
  // are forwarded to Boson server-side; API keys never reach the browser.
  router.post("/character-videos", async (req, res) => {
    if (!apiKey) return res.status(503).json({ error: "Add BOSON_API_KEY to .env first." });
    const characterId = req.body?.characterId;
    if (characterId !== "baby-yoda" && characterId !== "kevin") return res.status(400).json({ error: "Talking clips are only enabled for supported portrait characters." });
    const mime = req.body?.imageMime;
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) return res.status(400).json({ error: "Choose a JPG, PNG or WebP photo first." });
    const imageEncoded = req.body?.imageBase64;
    const reply = typeof req.body?.replyText === "string" ? req.body.replyText.trim() : "";
    if (typeof imageEncoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageEncoded)) return res.status(400).json({ error: "The avatar photo could not be read." });
    if (!reply || reply.length > 5000) return res.status(400).json({ error: "The generated reply text is empty or too long." });
    const image = Buffer.from(imageEncoded, "base64");
    if (!image.length || image.length > 10 * 1024 * 1024) return res.status(413).json({ error: "Choose a photo under 10 MB." });
    try {
      const voiceReferenceName = characterId === "kevin" ? "kevin-reference.mp3" : "baby-yoda-reference-short.mp3";
      const voiceReference = await readFile(resolve("assets/characters", voiceReferenceName));
      const tts = new FormData();
      tts.append("model", "higgs-tts-3");
      tts.append("response_format", "mp3");
      tts.append("ref_audio", new Blob([voiceReference], { type: "audio/mpeg" }), voiceReferenceName);
      // Reference audio guides the voice; it is not copied as dialogue.
      const cleanReply = reply.replace(/<\|[^|]+\|>/g, "");
      let spokenReply = cleanReply;
      let delivery = "<|emotion:affection|><|prosody:pitch_high|>";
      if (characterId === "kevin") {
        delivery = "<|emotion:amusement|><|prosody:expressive_high|>";
        spokenReply = cleanReply.replace(/\bbanana!?/giu, "<|emotion:enthusiasm|>Banana!<|emotion:amusement|>");
      }
      tts.append("input", `${delivery}${spokenReply}`);
      const speech = await fetch(`${base}/v1/audio/speech`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: tts, signal: AbortSignal.timeout(60000) });
      if (!speech.ok) {
        const data = await speech.json().catch(() => ({})) as { error?: { message?: string } };
        return res.status(speech.status || 502).json({ error: data.error?.message ?? `Boson voice cloning failed (${speech.status}).` });
      }
      const speechAudio = Buffer.from(await speech.arrayBuffer());
      if (!speechAudio.length) return res.status(502).json({ error: `Boson returned empty ${characterId} speech audio.` });

      const form = new FormData();
      form.append("model", "higgs-avatar"); form.append("size", "480x640");
      form.append("ref_image", new Blob([image], { type: mime }), mime === "image/png" ? "portrait.png" : mime === "image/webp" ? "portrait.webp" : "portrait.jpg");
      form.append("input", new Blob([speechAudio], { type: speech.headers.get("content-type") ?? "audio/mpeg" }), `${characterId}-reply.mp3`);
      const upstream = await fetch(`${base}/v1/videos`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(60000) });
      const data = await upstream.json() as { id?: string; error?: { message?: string } };
      if (!upstream.ok || typeof data.id !== "string") return res.status(upstream.status || 502).json({ error: data.error?.message ?? `Boson video creation failed (${upstream.status}).` });
      const id = randomUUID();
      characterVideos.set(id, data.id);
      while (characterVideos.size > 20) characterVideos.delete(characterVideos.keys().next().value!);
      return res.json({ id });
    } catch { return res.status(502).json({ error: "Could not reach Boson's video renderer. Check your connection and API credit." }); }
  });
  // Stream Kevin's fMP4 as soon as Higgs has its first fragments. Text and
  // reference voice go through Higgs TTS inside the Avatar request, ensuring
  // the exact synthesized audio is what drives the lip sync.
  router.post("/character-videos/stream", async (req, res) => {
    if (!apiKey) return res.status(503).json({ error: "Add BOSON_API_KEY to .env first." });
    if (req.body?.characterId !== "kevin") return res.status(400).json({ error: "Progressive clips are only enabled for Kevin." });
    const mime = req.body?.imageMime;
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) return res.status(400).json({ error: "Choose a JPG, PNG or WebP photo first." });
    const encoded = req.body?.imageBase64;
    const reply = typeof req.body?.replyText === "string" ? req.body.replyText.trim() : "";
    if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return res.status(400).json({ error: "The avatar photo could not be read." });
    if (!reply || reply.length > 5000) return res.status(400).json({ error: "The generated reply text is empty or too long." });
    const image = Buffer.from(encoded, "base64");
    if (!image.length || image.length > 10 * 1024 * 1024) return res.status(413).json({ error: "Choose a photo under 10 MB." });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    timeout.unref();
    try {
      const voiceReference = await readFile(resolve("assets/characters/kevin-reference.mp3"));
      const cleanReply = reply.replace(/<\|[^|]+\|>/g, "");
      const spokenReply = cleanReply.replace(/\bbanana!?/giu, "<|emotion:enthusiasm|>Banana!<|emotion:amusement|>");
      const requestBody = {
        model: "higgs-avatar", size: "480x640",
        ref_image: `data:${mime};base64,${image.toString("base64")}`,
        input_tts: {
          model: "higgs-tts-3", input: `<|emotion:amusement|><|prosody:expressive_high|>${spokenReply}`,
          response_format: "mp3", ref_audio: `data:audio/mpeg;base64,${voiceReference.toString("base64")}`,
        },
      };
      const upstream = await fetch(`${base}/v1/videos/stream`, {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(requestBody), signal: controller.signal,
      });
      if (!upstream.ok) {
        clearTimeout(timeout);
        const data = await upstream.json().catch(() => ({})) as { error?: { message?: string } };
        return res.status(upstream.status || 502).json({ error: data.error?.message ?? `Boson could not start Kevin's clip (${upstream.status}).` });
      }
      if (!upstream.body) { clearTimeout(timeout); return res.status(502).json({ error: "Boson opened the clip stream without a video body." }); }
      const contentType = upstream.headers.get("content-type") ?? "video/mp4";
      const stream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>);
      res.status(200).set({ "Content-Type": contentType, "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      res.on("close", () => { clearTimeout(timeout); if (!res.writableEnded) { controller.abort(); stream.destroy(); } });
      stream.on("end", () => clearTimeout(timeout));
      stream.on("error", () => { clearTimeout(timeout); if (!res.destroyed) res.destroy(); });
      stream.pipe(res);
    } catch {
      clearTimeout(timeout);
      if (!res.headersSent) return res.status(502).json({ error: "Could not stream Kevin's clip from Boson. Check your connection and API credit." });
      return res.destroy();
    }
  });
  router.get("/character-videos/:id", async (req, res) => {
    if (!apiKey) return res.status(503).json({ error: "Add BOSON_API_KEY to .env first." });
    const videoId = characterVideos.get(req.params.id);
    if (!videoId) return res.status(404).json({ error: "That talking clip has expired. Generate another reply." });
    try {
      const upstream = await fetch(`${base}/v1/videos/${encodeURIComponent(videoId)}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) });
      const data = await upstream.json() as { status?: string; progress?: number; error?: string };
      if (!upstream.ok) return res.status(upstream.status).json({ error: "Could not check the talking clip status." });
      return res.json({ status: data.status, progress: data.progress ?? 0, error: data.status === "failed" ? data.error ?? "Boson could not render this clip." : undefined });
    } catch { return res.status(502).json({ error: "Could not reach Boson's video renderer." }); }
  });
  router.get("/character-videos/:id/content", async (req, res) => {
    if (!apiKey) return res.status(503).end();
    const videoId = characterVideos.get(req.params.id);
    if (!videoId) return res.status(404).end();
    try {
      const upstream = await fetch(`${base}/v1/videos/${encodeURIComponent(videoId)}/content`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(60000) });
      if (!upstream.ok) return res.status(upstream.status).end();
      res.type("video/mp4").setHeader("Cache-Control", "no-store");
      return res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch { return res.status(502).end(); }
  });
  router.post("/lessons", async (req, res) => {
    const missing = livekitMissing(process.env);
    if (!apiKey || missing.length) return res.status(503).json({ error: `Talking avatars need ${!apiKey ? "BOSON_API_KEY and " : ""}${missing.length ? missing.join(", ") : "LiveKit Cloud settings"} in .env. Restart npm run dev after adding them.` });
    if (!validateLivekitCloudUrl(process.env.LIVEKIT_URL!)) return res.status(400).json({ error: "LIVEKIT_URL must be your wss://project.livekit.cloud URL." });
    if (lessons.size) return res.status(409).json({ error: "A talking-avatar lesson is already running. End that lesson first." });
    const avatarId = typeof req.body?.avatarId === "string" ? req.body.avatarId.trim() : "";
    if (!avatarId || avatarId.length > 256) return res.status(400).json({ error: "Choose a Boson preset avatar." });
    const characterId = getCharacter(req.body?.characterId).id;
    const check = spawnSync(python, [resolve("avatar/agent.py"), "--check"], { timeout: 20000, encoding: "utf8" });
    if (check.status !== 0) return res.status(503).json({ error: "The avatar Python agent is not installed. Run npm run avatar:setup (Python 3.10+), then try again." });
    const definition = typeof req.body?.lessonId === "string" ? lessonService.get(req.body.lessonId) : undefined;
    if (req.body?.lessonId && !definition) return res.status(404).json({ error: "This lesson expired. Start a new lesson." });
    const id = randomUUID();
    const room = `teachback-${id}`;
    const rawSettings = req.body?.learnerSettings;
    const learnerSettings = {
      knowledgeLevel: Number.isFinite(rawSettings?.knowledgeLevel) ? Math.max(0, Math.min(100, rawSettings.knowledgeLevel)) : DEFAULT_LEARNER_SETTINGS.knowledgeLevel,
      feedbackDirectness: Number.isFinite(rawSettings?.feedbackDirectness) ? Math.max(0, Math.min(100, rawSettings.feedbackDirectness)) : DEFAULT_LEARNER_SETTINGS.feedbackDirectness,
    };
    const sourceMaterial = typeof req.body?.sourceMaterial === "string" ? req.body.sourceMaterial.slice(0, 20000) : "";
    const lesson = { id, room, avatarId, characterId, definition, learnerSettings, sourceMaterial, child: null, listeners: new Set(), history: [], ready: false, ending: false, kevinLearningStarted: false } as unknown as Lesson;
    lesson.visualContext = new VisualContextChannel(definition ? studentPrompt(definition, characterId, learnerSettings, sourceMaterial) : SYSTEM_PROMPT, event => send(lesson, event));
    lesson.bridge = new AvatarToolBridge({
      onEvent: event => publish(lesson, { kind: "server_event", event }),
      onKnowledge: state => publish(lesson, { kind: "knowledge", state }),
      send: event => send(lesson, event),
      onKevinConcentration: () => {
        lesson.kevinLearningStarted = true;
        send(lesson, buildSessionConfig(settings.model, lesson.definition, lesson.characterId, "text", lesson.learnerSettings, lesson.sourceMaterial, true));
        if (lesson.child?.stdin.writable) lesson.child.stdin.write(JSON.stringify({ kind: "settings", feedbackDirectness: lesson.learnerSettings.feedbackDirectness, kevinLearningStarted: true }) + "\n");
      },
    }, definition, definition ? lessonService.assessor(definition) : undefined, lesson.characterId);
    lesson.timer = setTimeout(() => void end(lesson), 120000); // unused browser reservation
    lessons.set(id, lesson);
    try {
      const token = new AccessToken(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!, { identity: "user", ttl: 900 });
      token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: false });
      return res.json({ id, url: process.env.LIVEKIT_URL, token: await token.toJwt() });
    } catch { await end(lesson); return res.status(500).json({ error: "Could not create a LiveKit room token." }); }
  });
  router.get("/lessons/:id/events", (req, res) => {
    const lesson = lessons.get(req.params.id);
    if (!lesson) return res.status(404).end();
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" }); res.flushHeaders();
    res.write(": connected\n\n");
    for (const event of lesson.history) res.write(`data: ${JSON.stringify(event)}\n\n`);
    lesson.listeners.add(res);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    res.on("close", () => { clearInterval(heartbeat); lesson.listeners.delete(res); if (!lesson.listeners.size) void end(lesson); });
  });
  router.post("/lessons/:id/start", (req, res) => {
    const lesson = lessons.get(req.params.id);
    if (!lesson || lesson.ending) return res.status(404).json({ error: "This avatar lesson has ended." });
    if (lesson.child) return res.json({ ok: true });
    clearTimeout(lesson.timer);
    lesson.timer = setTimeout(() => void end(lesson), 10 * 60 * 1000);
    const child = spawn(python, [resolve("avatar/agent.py"), "--managed"], { env: { ...process.env, BOSON_API_KEY: apiKey!, TEACHBACK_ROOM: lesson.room, TEACHBACK_AVATAR_ID: lesson.avatarId, TEACHBACK_CHARACTER_ID: lesson.characterId, TEACHBACK_FEEDBACK_DIRECTNESS: String(lesson.learnerSettings.feedbackDirectness), TEACHBACK_SESSION_CONFIG: JSON.stringify(buildSessionConfig(settings.model, lesson.definition, lesson.characterId, "text", lesson.learnerSettings, lesson.sourceMaterial)), PYTHONUNBUFFERED: "1" }, stdio: "pipe" });
    lesson.child = child;
    // Never forward process environment, stderr or credentials into browser logs.
    child.stderr.on("data", () => {});
    createInterface({ input: child.stdout }).on("line", line => {
      let message: StreamMessage;
      try { message = JSON.parse(line); } catch { return; }
      if (message.kind === "avatar_session" && typeof message.id === "string") lesson.avatarSessionId = message.id;
      else if (lesson.ending) return;
      else if (message.kind === "server_event" && message.event && typeof message.event === "object") {
        lesson.visualContext.handle(message.event as { type: string });
        lesson.bridge.handle(message.event as { type: string });
      }
      else if (message.kind === "ready") { lesson.ready = true; publish(lesson, message); }
      else if (message.kind === "error") error(lesson, typeof message.message === "string" ? message.message : "Avatar agent failed.");
      else if (message.kind === "activity") publish(lesson, message);
    });
    child.on("error", () => error(lesson, "Could not start the avatar worker. Run npm run avatar:setup."));
    child.on("close", () => { if (lesson.ending) lessons.delete(lesson.id); });
    child.on("exit", () => { clearTimeout(lesson.timer); if (!lesson.ending) error(lesson, "The talking-avatar session ended. Start a new lesson to reconnect."); else lessons.delete(lesson.id); });
    return res.json({ ok: true });
  });
  router.post("/lessons/:id/text", (req, res) => {
    const lesson = lessons.get(req.params.id);
    if (!lesson?.ready || lesson.ending) return res.status(409).json({ error: "Wait for the talking avatar to connect." });
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > 5000) return res.status(400).json({ error: "Enter an explanation under 5,000 characters." });
    lesson.bridge.observeText(`typed-${randomUUID()}`, text);
    send(lesson, userTextItem(text)); send(lesson, responseCreate());
    return res.json({ ok: true });
  });
  router.post("/lessons/:id/visual-context", async (req, res) => {
    const lesson = lessons.get(req.params.id);
    if (!lesson?.ready || lesson.ending) return res.status(409).json({ error: "Wait for the talking avatar to connect." });
    let context: VisualContext;
    try { context = parseVisualContext(req.body?.context); }
    catch { return res.status(400).json({ error: "Invalid whiteboard observation." }); }
    try { return res.json(await lesson.visualContext.update(context)); }
    catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : "Visual context delivery failed." }); }
  });
  router.post("/lessons/:id/settings", (req, res) => {
    const lesson = lessons.get(req.params.id);
    if (!lesson || !lesson.ready || lesson.ending) return res.status(409).json({ error: "Wait for the avatar lesson to connect." });
    const raw = req.body?.learnerSettings;
    if (!Number.isFinite(raw?.knowledgeLevel) || !Number.isFinite(raw?.feedbackDirectness)) return res.status(400).json({ error: "Choose valid learner settings." });
    lesson.learnerSettings = { knowledgeLevel: Math.max(0, Math.min(100, raw.knowledgeLevel)), feedbackDirectness: Math.max(0, Math.min(100, raw.feedbackDirectness)) };
    if (typeof req.body?.sourceMaterial === "string") lesson.sourceMaterial = req.body.sourceMaterial.slice(0, 20000);
    send(lesson, buildSessionConfig(settings.model, lesson.definition, lesson.characterId, "text", lesson.learnerSettings, lesson.sourceMaterial, lesson.kevinLearningStarted));
    if (lesson.child?.stdin.writable) lesson.child.stdin.write(JSON.stringify({ kind: "settings", feedbackDirectness: lesson.learnerSettings.feedbackDirectness }) + "\n");
    return res.json({ ok: true });
  });
  router.post("/lessons/:id/end", (req, res) => { const lesson = lessons.get(req.params.id); if (lesson) void end(lesson); return res.json({ ok: true }); });
  return { router, close: () => Promise.all([...lessons.values()].map(end)) };
}
