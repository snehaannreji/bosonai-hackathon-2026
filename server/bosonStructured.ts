import { buildRealtimeUrl, readRealtimeSettings } from "../src/realtime/runtimeConfig";

/** Structured calls use the same supported Boson Realtime socket/tool protocol
 * as the conversation. No extra provider or invented text REST endpoint. */
type StructuredTool = { name: string; description: string; parameters: object };
let pending: Promise<unknown> = Promise.resolve();
export function bosonStructured(apiKey: string, instructions: string, input: string, tool: StructuredTool): Promise<Record<string, unknown>> {
  // Keep side-channel planning/assessment calls from exhausting realtime
  // concurrency while the student's live conversation remains connected.
  const result = pending.then(() => runStructured(apiKey, instructions, input, tool));
  pending = result.catch(() => {});
  return result;
}
async function runStructured(apiKey: string, instructions: string, input: string, tool: StructuredTool): Promise<Record<string, unknown>> {
  const base = (process.env.BOSON_BASE_URL ?? "https://api.boson.ai").replace(/\/$/, "");
  const response = await fetch(`${base}/v1/realtime/client_secrets`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ expires_after: { seconds: 60 } }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Boson session request failed (${response.status}).`);
  const credential = await response.json() as { value?: string };
  if (!credential.value) throw new Error("Boson returned no temporary credential.");
  const settings = readRealtimeSettings(process.env);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(buildRealtimeUrl(settings), ["realtime", `bai-client-secret.${credential.value}`]);
    let settled = false;
    let requested = false;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return; settled = true; clearTimeout(timer);
      ws.close(); if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error("Boson took too long preparing the lesson. Try again.")), 30000);
    const result = (raw: unknown) => {
      try { const parsed = JSON.parse(String(raw)); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); finish(undefined, parsed); }
      catch { finish(new Error("Boson returned an invalid structured response. Try again.")); }
    };
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "session.update", session: { model: settings.model, instructions, output_modalities: ["text"], tools: [{ type: "function", ...tool }], tool_choice: "auto" } })));
    ws.addEventListener("message", event => {
      if (settled) return;
      let data: Record<string, unknown>;
      try { data = JSON.parse(String(event.data)); } catch { return; }
      if ((data.type === "session.created" || data.type === "session.updated") && !requested) {
        requested = true;
        ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: input }] } }));
        ws.send(JSON.stringify({ type: "response.create" }));
      }
      if (data.type === "response.function_call_arguments.done" && data.name === tool.name) result(data.arguments);
      if (data.type === "response.done") {
        const output = (data.response as { output?: { type?: string; name?: string; arguments?: string }[] } | undefined)?.output ?? [];
        const call = output.find(item => item.type === "function_call" && item.name === tool.name);
        if (call) result(call.arguments);
        else if (!settled) finish(new Error("Boson did not return a lesson assessment. Try again."));
      }
      if (data.type === "error") finish(new Error("Boson could not prepare this lesson. Check access and retry."));
    });
    ws.addEventListener("error", () => finish(new Error("Could not connect to Boson for lesson preparation.")));
    ws.addEventListener("close", () => { if (!settled) finish(new Error("Boson closed the lesson-planning connection.")); });
  });
}
