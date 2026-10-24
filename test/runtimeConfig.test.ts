import { describe, expect, it } from "vitest";
import { buildRealtimeUrl, readRealtimeSettings } from "../src/realtime/runtimeConfig";
import { buildSessionConfig } from "../src/realtime/sessionConfig";

describe("Boson early-access model routing", () => {
  it("defaults to the exact hackathon preview ID verified in a live session", () => {
    expect(readRealtimeSettings({})).toEqual({ model: "higgs-realtime-1.5-preview", websocketUrl: "wss://api.boson.ai/v1/realtime" });
  });
  it("routes an explicit early-access override consistently in the URL and session", () => {
    // Deliberately a fixture ID, not a claim about Boson's private model names.
    const settings = readRealtimeSettings({ BOSON_REALTIME_MODEL: " early-access-fixture ", BOSON_REALTIME_URL: "wss://example.test/v1/realtime?model=old&feature=test", BOSON_API_KEY: "server-only-secret" });
    const url = new URL(buildRealtimeUrl(settings));
    expect(url.searchParams.getAll("model")).toEqual(["early-access-fixture"]);
    expect(url.searchParams.get("feature")).toBe("test");
    expect((buildSessionConfig(settings.model).session as { model: string }).model).toBe("early-access-fixture");
    expect(JSON.stringify(settings)).not.toContain("server-only-secret");
  });
  it("rejects invalid routing instead of substituting a different model", () => {
    expect(() => buildRealtimeUrl({ model: "", websocketUrl: "wss://example.test/realtime" })).toThrow("model");
    expect(() => buildRealtimeUrl({ model: "early-access-fixture", websocketUrl: "http://example.test/realtime" })).toThrow("wss://");
  });
});
