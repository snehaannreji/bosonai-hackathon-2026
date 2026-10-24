import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { Router, type Response } from "express";
import type { LessonService } from "./lessons";
import type { LessonDefinition } from "../src/state/lesson";
import { catalogCache } from "../src/realtime/catalogCache";
import { avatarForStudent, configureAvatarCatalog, parseAvatarCatalog, selectLessonAvatar } from "../src/realtime/avatarCatalog";
import { normalizeStudent } from "../src/state/student";
import { AccessToken } from "livekit-server-sdk";
import { AvatarToolBridge } from "../src/realtime/avatarToolBridge";
import { buildSessionConfig } from "../src/realtime/sessionConfig";
import { readRealtimeSettings } from "../src/realtime/runtimeConfig";
import { userTextItem, responseCreate, type ClientEvent } from "../src/realtime/events";

type StreamMessage = { kind: string; [key: string]: unknown };
interface Lesson {
  id: string; room: string; avatarId: string; audioRenderer: "realtime" | "tagged-tts"; child: ChildProcessWithoutNullStreams | null;
  definition?: LessonDefinition; avatarSessionId?: string; listeners: Set<Response>; history: StreamMessage[];
  bridge: AvatarToolBridge; ready: boolean; ending: boolean; timer: ReturnType<typeof setTimeout>;
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
  const base = (process.env.BOSON_BASE_URL ?? "https://api.boson.ai").replace(/\/$/, "");
  const settings = readRealtimeSettings(process.env);
  const python = process.env.AVATAR_PYTHON || resolve(
    ".venv-avatar",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
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
    return parseAvatarCatalog(await upstream.json());
  });
  const availableAvatars = async () => configureAvatarCatalog(await loadCatalog(), process.env.BOSON_AVATAR_ID, {
    maya: process.env.BOSON_MAYA_AVATAR_ID?.trim() || "",
    kai: process.env.BOSON_KAI_AVATAR_ID?.trim() || "",
  });
  router.get("/presets", async (_req, res) => {
    if (!apiKey) return res.status(503).json({ error: "Add BOSON_API_KEY to .env first." });
    try { return res.json(await availableAvatars()); }
    catch (error) { return res.status(502).json({ error: error instanceof Error ? error.message : "Could not reach Boson’s avatar catalog." }); }
  });
  router.post("/lessons", async (req, res) => {
    const missing = livekitMissing(process.env);
    if (!apiKey || missing.length) return res.status(503).json({ error: `Talking avatars need ${!apiKey ? "BOSON_API_KEY and " : ""}${missing.length ? missing.join(", ") : "LiveKit Cloud settings"} in .env. Restart npm run dev after adding them.` });
    if (!validateLivekitCloudUrl(process.env.LIVEKIT_URL!)) return res.status(400).json({ error: "LIVEKIT_URL must be your wss://project.livekit.cloud URL." });
    const audioRenderer = req.body?.audioRenderer === "tagged-tts" ? "tagged-tts" : "realtime";
    const definition = typeof req.body?.lessonId === "string" ? lessonService.get(req.body.lessonId) : undefined;
    if (req.body?.lessonId && !definition) return res.status(404).json({ error: "This lesson expired. Start a new lesson." });
    let catalog;
    try { catalog = await availableAvatars(); }
    catch { return res.status(502).json({ error: "Could not verify available avatars with Boson. Retry avatar setup." }); }
    let avatarId: string;
    try { avatarId = selectLessonAvatar(catalog, req.body?.avatarId ?? (definition ? avatarForStudent(catalog, normalizeStudent(definition.student)) : undefined)); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Choose an available Boson avatar." }); }
    if (lessons.size) return res.status(409).json({ error: "A talking-avatar lesson is already running. End that lesson first." });
    const check = spawnSync(python, [resolve("avatar/agent.py"), "--check"], { timeout: 20000, encoding: "utf8" });
    if (check.status !== 0) return res.status(503).json({ error: "The avatar Python agent is not installed. Run npm run avatar:setup (Python 3.10+), then try again." });
    const id = randomUUID();
    const room = `teachback-${id}`;
    const lesson = { id, room, avatarId, audioRenderer, definition, child: null, listeners: new Set(), history: [], ready: false, ending: false } as unknown as Lesson;
    lesson.bridge = new AvatarToolBridge({ onEvent: event => publish(lesson, { kind: "server_event", event }), onKnowledge: state => publish(lesson, { kind: "knowledge", state }), send: event => send(lesson, event) }, definition, definition ? lessonService.assessor(definition) : undefined);
    lesson.timer = setTimeout(() => void end(lesson), 120000); // unused browser reservation
    lessons.set(id, lesson);
    try {
      const token = new AccessToken(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!, { identity: "user", ttl: 900 });
      token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: false });
      return res.json({ id, avatarId, url: process.env.LIVEKIT_URL, token: await token.toJwt() });
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
    const child = spawn(python, [resolve("avatar/agent.py"), "--managed"], { env: { ...process.env, BOSON_API_KEY: apiKey!, TEACHBACK_ROOM: lesson.room, TEACHBACK_AVATAR_ID: lesson.avatarId, TEACHBACK_AUDIO_RENDERER: lesson.audioRenderer, TEACHBACK_SESSION_CONFIG: JSON.stringify(buildSessionConfig(settings.model, lesson.definition)), PYTHONUNBUFFERED: "1" }, stdio: "pipe" });
    lesson.child = child;
    // Never forward process environment, stderr or credentials into browser logs.
    child.stderr.on("data", () => {});
    createInterface({ input: child.stdout }).on("line", line => {
      let message: StreamMessage;
      try { message = JSON.parse(line); } catch { return; }
      if (message.kind === "avatar_session" && typeof message.id === "string") lesson.avatarSessionId = message.id;
      else if (lesson.ending) return;
      else if (message.kind === "server_event" && message.event && typeof message.event === "object") lesson.bridge.handle(message.event as { type: string });
      else if (message.kind === "ready") { lesson.ready = true; publish(lesson, message); }
      else if (message.kind === "error") error(lesson, typeof message.message === "string" ? message.message : "Avatar agent failed.");
      else if (message.kind === "activity" || message.kind === "emotion" || message.kind === "tts_error") publish(lesson, message);
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
  router.post("/lessons/:id/end", (req, res) => { const lesson = lessons.get(req.params.id); if (lesson) void end(lesson); return res.json({ ok: true }); });
  return { router, close: () => Promise.all([...lessons.values()].map(end)) };
}
