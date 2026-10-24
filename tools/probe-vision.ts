/** Safe discovery/control experiment. Uses only the starter's verified events.
 * Does NOT test guessed image/video fields, publish an orphan LiveKit track,
 * or pass descriptions of a drawing as a substitute for image data. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildSessionConfig } from "../src/realtime/sessionConfig";
import { buildRealtimeUrl, type RealtimeCredentials } from "../src/realtime/runtimeConfig";
import { userTextItem, responseCreate } from "../src/realtime/events";
import { visionCapability } from "../src/whiteboard/visionCapability";

const base = process.env.TEACHBACK_LOCAL_URL ?? "http://localhost:5173";
const output = process.argv[process.argv.indexOf("--out") + 1] && process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1] : "captures/whiteboard-vision-probe.json";
async function main() {
  const response = await fetch(base + "/api/token", { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Local credential endpoint returned HTTP ${response.status}.`);
  const credentials = await response.json() as RealtimeCredentials;
  const report = {
    at: new Date().toISOString(), ...visionCapability(credentials.model),
    result: "blocked_missing_private_video_protocol", reportedModel: "", sessionKeys: [] as string[],
    inputAudioKeys: [] as string[], advertisedVisualKeys: [] as string[],
    audioChunks: 0, controlTranscript: "", controlOnly: true,
    imageOrVideoFramesSent: 0, recognitionTestRun: false,
    recognitionLatencyMs: null, updatesWhileSpeaking: null, interruptionsTested: false, avatarTested: false,
  };
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(buildRealtimeUrl(credentials), ["realtime", `bai-client-secret.${credentials.value}`]);
    let ready = false, settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); ws.close();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Discovery/control session timed out.")), 35000);
    ws.addEventListener("open", () => {
      const config = buildSessionConfig(credentials.model);
      config.session = { ...config.session as object, tools: [], instructions: "You are a concise conversational student. Never claim to see visual content without actual visual input. Keep replies brief." };
      ws.send(JSON.stringify(config));
    });
    ws.addEventListener("message", event => {
      const data = JSON.parse(String(event.data));
      if ((data.type === "session.created" || data.type === "session.updated") && !ready) {
        ready = true;
        const session = data.session ?? {};
        report.reportedModel = session.model ?? "";
        report.sessionKeys = Object.keys(session).sort();
        report.inputAudioKeys = Object.keys(session.audio?.input ?? {}).sort();
        report.advertisedVisualKeys = report.sessionKeys.filter(key => /video|vision|image|camera/i.test(key));
        ws.send(JSON.stringify(userTextItem("Do you currently receive any visual input? Describe only what you can actually see, or say you cannot see it. Do not guess.")));
        ws.send(JSON.stringify(responseCreate()));
      }
      if (data.type === "response.output_audio.delta") report.audioChunks++;
      if (data.type === "response.output_audio_transcript.done") report.controlTranscript = data.transcript;
      if (data.type === "response.done") finish();
      if (data.type === "error") finish(new Error(`Boson rejected the control session (${String(data.error?.code ?? "request_failed")}).`));
    });
    ws.addEventListener("error", () => finish(new Error("Boson WebSocket connection failed.")));
    ws.addEventListener("close", () => { if (!settled) finish(new Error("Boson closed the control session early.")); });
  });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ ...report, elapsedMs: Date.now() - started }, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  console.log(`Saved ${output}. Negative control only: no visual recognition or video transport was tested.`);
  process.exitCode = 2; // Explicitly blocked, even when the audio control succeeds.
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Vision probe failed."); process.exitCode = 1; });
