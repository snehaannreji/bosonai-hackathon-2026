// Exact hackathon preview ID from Boson Opening 2026 slides 7 and 17.
// A live session with the team key accepted it and reported this model.
// Explicit overrides remain supported; there is no automatic fallback.
export const DEFAULT_REALTIME_MODEL = "higgs-realtime-1.5-preview";
export const DEFAULT_REALTIME_URL = "wss://api.boson.ai/v1/realtime";

export interface RealtimeSettings { model: string; websocketUrl: string }
export interface RealtimeCredentials extends RealtimeSettings { value: string }

/** Called on the server/probe only. Never pass secret environment fields to UI. */
export function readRealtimeSettings(env: Record<string, string | undefined>): RealtimeSettings {
  return {
    model: env.BOSON_REALTIME_MODEL?.trim() || DEFAULT_REALTIME_MODEL,
    websocketUrl: env.BOSON_REALTIME_URL?.trim() || DEFAULT_REALTIME_URL,
  };
}

export function buildRealtimeUrl(settings: RealtimeSettings): string {
  if (!settings.model.trim()) throw new Error("A Boson Realtime model is required.");
  const url = new URL(settings.websocketUrl);
  if (url.protocol !== "wss:") throw new Error("Use a secure wss:// Boson Realtime endpoint.");
  // Set instead of append: the URL and session.update must always agree.
  url.searchParams.set("model", settings.model);
  return url.toString();
}
