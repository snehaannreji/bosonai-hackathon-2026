/** SDK protocol fixtures, not real recognition or latency benchmarks. */
import { describe, expect, it, vi } from "vitest";
import { FinishReason, GenerateContentResponse, type GenerateContentParameters } from "@google/genai";
import { analyzeBoardImage, readVisionSettings, vertexError } from "../server/vision";
const value = { description: "Fixture description", changes: [], visible_text: [], uncertainties: [] };
const settings = { project: "test-project", location: "global", model: "gemini-3.5-flash-lite" };
describe("Vertex ADC whiteboard provider", () => {
  it("uses the SDK with one JPEG, structured output, minimal thinking and no API key", async () => {
    const response = new GenerateContentResponse();
    response.candidates = [{ finishReason: FinishReason.STOP, content: { parts: [{ text: JSON.stringify(value) }] } }];
    const generate = vi.fn(async (_input: GenerateContentParameters) => response);
    const result = await analyzeBoardImage(settings, "/9j/fixture", 7, "previous", new AbortController().signal, generate);
    expect(generate).toHaveBeenCalledOnce();
    const input = generate.mock.calls[0][0];
    expect(input.model).toBe("gemini-3.5-flash-lite");
    expect(input.config?.thinkingConfig?.thinkingLevel).toBe("MINIMAL");
    expect(input.config?.responseMimeType).toBe("application/json");
    expect(input.contents).toMatchObject([{ parts: [{ inlineData: { mimeType: "image/jpeg", data: "/9j/fixture" } }, { text: expect.stringContaining("Previous observation") }] }]);
    expect(result.observation).toEqual({ ...value, revision: 7 });
    expect(result.provider).toBe("vertex");
  });
  it("does not require or read a GEMINI_API_KEY", () => {
    expect(readVisionSettings({ GOOGLE_CLOUD_PROJECT: "configured-project", GEMINI_API_KEY: "unused" })).toEqual({ project: "configured-project", location: "global", model: "gemini-3.5-flash-lite" });
  });
  it("diagnoses ADC, IAM, disabled APIs and model access without exposing raw SDK errors", async () => {
    const signal = new AbortController().signal;
    await expect(analyzeBoardImage({ ...settings, project: "" }, "x", 1, "", signal)).rejects.toThrow("GOOGLE_CLOUD_PROJECT");
    const fail = vi.fn(async () => { throw Object.assign(new Error("private raw SDK body"), { status: 403 }); });
    await expect(analyzeBoardImage(settings, "x", 1, "", signal, fail)).rejects.toThrow("Vertex AI User");
    expect(vertexError(new Error("invalid_grant: private token"))).toContain("ADC");
    expect(vertexError(new Error("SERVICE_DISABLED"))).toContain("aiplatform.googleapis.com");
    expect(vertexError(Object.assign(new Error("private"), { status: 404 }))).toContain("no provider switch");
    expect(vertexError(Object.assign(new Error("private"), { status: 429 }))).not.toContain("private");
    expect(vertexError(Object.assign(new Error("private"), { status: 504 }))).toContain("not an ADC authentication rejection");
  });
});
