/** Actual provider image observations -> SAME Boson session -> spoken answers.
 * --transport-only validates instruction ACKs without pretending to test vision. */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildSessionConfig } from "../src/realtime/sessionConfig";
import { buildRealtimeUrl, type RealtimeCredentials } from "../src/realtime/runtimeConfig";
import { userTextItem, responseCreate, type ServerEvent } from "../src/realtime/events";
import { VisualContextChannel } from "../src/whiteboard/contextChannel";
import { WHITEBOARD_POLICY, type VisualObservation } from "../src/whiteboard/observations";

const args = process.argv.slice(2), base = process.env.TEACHBACK_LOCAL_URL ?? "http://localhost:5173";
const transportOnly = args.includes("--transport-only");
const output = args.includes("--out") ? args[args.indexOf("--out") + 1] : "captures/whiteboard-fallback-probe.json";
const imageIndex = args.indexOf("--images");
const images = imageIndex < 0 ? [] : args.slice(imageIndex + 1).slice(0, args.slice(imageIndex + 1).findIndex(a => a.startsWith("--")) < 0 ? undefined : args.slice(imageIndex + 1).findIndex(a => a.startsWith("--")));
async function local<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, body === undefined ? { signal: AbortSignal.timeout(15000) } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `Local HTTP ${response.status}`);
  return data as T;
}
async function main() {
  if (!transportOnly && images.length !== 3) throw new Error("Provide three real JPEGs with --images circle.jpg circle-arrow.jpg arrow-only.jpg, or use --transport-only.");
  const status = await local<{ configured: boolean; model: string; reason: string }>("/api/vision/status");
  if (!transportOnly && !status.configured) throw new Error(status.reason);
  const credential = await local<RealtimeCredentials>("/api/token");
  const instructions = "You are Maya, a curious student. Answer the human's question about the latest whiteboard observation in one short sentence. " + WHITEBOARD_POLICY;
  const ws = new WebSocket(buildRealtimeUrl(credential), ["realtime", `bai-client-secret.${credential.value}`]);
  const channel = new VisualContextChannel(instructions, event => ws.send(JSON.stringify(event)));
  let session = "", model = "", responses = 0, done = 0, audioChunks = 0;
  const transcripts: string[] = [];
  const waiters = new Set<() => void>();
  let failure: Error | null = null;
  const until = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error("Boson response/ack timed out.")); }, 20000);
    const check = () => { if (failure || predicate()) { clearTimeout(timer); waiters.delete(check); if (failure) reject(failure); else resolve(); } };
    waiters.add(check); check();
  });
  ws.addEventListener("open", () => {
    const config = buildSessionConfig(credential.model);
    config.session = { ...config.session as object, tools: [], instructions };
    ws.send(JSON.stringify(config));
  });
  ws.addEventListener("message", event => {
    const data = JSON.parse(String(event.data)) as ServerEvent;
    channel.handle(data);
    if (data.type === "session.created") { const s = data.session as { id: string; model: string }; session = s.id; model = s.model; }
    if (data.type === "session.updated" && (data.session as { id?: string })?.id !== session) failure = new Error("The session ID changed unexpectedly.");
    if (data.type === "response.created") responses++;
    if (data.type === "response.done") done++;
    if (data.type === "response.output_audio.delta") audioChunks++;
    if (data.type === "response.output_audio_transcript.done") transcripts.push(String(data.transcript));
    if (data.type === "error") failure = new Error("Boson rejected an event; inspect the verified protocol.");
    for (const check of waiters) check();
  });
  ws.addEventListener("error", () => { failure = new Error("Boson connection failed."); for (const check of waiters) check(); });
  const result: Record<string, unknown> = { at: new Date().toISOString(), transportOnly, realVisionOutputs: !transportOnly, measurements: [] };
  const measurements: unknown[] = [];
  try {
    await until(() => Boolean(session));
    if (transportOnly) {
      const pending = await channel.update({ revision: 1, status: "pending" });
      if (responses !== 0) throw new Error("A context update triggered an unsolicited response.");
      ws.send(JSON.stringify(userTextItem("Introduce yourself and ask one short teaching question."))); ws.send(JSON.stringify(responseCreate()));
      await until(() => audioChunks > 0);
      const updatedDuringGeneration = done === 0;
      const cleared = await channel.update({ revision: 2, status: "cleared" });
      await until(() => done >= 1);
      measurements.push({ pendingAckMs: pending.ackMs, clearAckMs: cleared.ackMs, updatedDuringGeneration, sameSession: true, unsolicitedResponses: responses - 1 });
    } else {
      let previous = "";
      for (let i = 0; i < images.length; i++) {
        const revision = i + 1, start = performance.now();
        await channel.update({ revision, status: "pending" });
        const sentAt = performance.now();
        const analysis = await local<{ observation: VisualObservation; analysisMs: number }>("/api/vision/analyze", { revision, image: readFileSync(images[i]).toString("base64"), previous });
        const requestMs = performance.now() - sentAt;
        const receipt = await channel.update({ revision, status: "observed", observation: analysis.observation });
        measurements.push({ revision, observation: analysis.observation, providerMs: analysis.analysisMs, requestMs, contextAckMs: receipt.ackMs, totalWithoutBrowserCaptureMs: performance.now() - start });
        previous = analysis.observation.description;
        const target = done + 1;
        const question = i === 0 ? "What is visible on the board?" : i === 1 ? "What changed on the board?" : "Is the circle still visible? What remains?";
        ws.send(JSON.stringify(userTextItem(question))); ws.send(JSON.stringify(responseCreate()));
        await until(() => done >= target);
      }
    }
    Object.assign(result, { model, visionModel: status.model, measurements, transcripts, audioChunks, responses, passed: !failure });
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } finally { channel.close(); ws.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Whiteboard probe failed."); process.exitCode = 1; });
