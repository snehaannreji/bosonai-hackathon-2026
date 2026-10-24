import { describe, expect, it } from "vitest";
import { dispatch } from "../src/tools/registry";
import { KnowledgeTracker } from "../src/state/knowledge";
import { CLIENT_TOOL_RESULT, emptyTranscript, toList, transcriptReducer } from "../src/state/transcriptStore";
describe("learning tool dispatch", () => {
  it("returns errors for unknown tools and missing lesson context", async () => {
    expect((await dispatch("web_search", {})).error).toBe("unknown_tool");
    expect((await dispatch("update_understanding", {})).error).toBe("missing_context");
  });
  it("passes grounded evidence through the same dispatcher used by the model", async () => {
    const t = new KnowledgeTracker(); const evidence = "The gradient points uphill."; t.observeHuman("u", evidence);
    const result = await dispatch("update_understanding", { concept: "gradient_direction", status: "partial", evidence }, t);
    expect(result.state?.gradient_direction.status).toBe("partial");
  });
  it("shows a failed update in the transcript without losing its call id", () => {
    let state = transcriptReducer(emptyTranscript, { type: "response.function_call_arguments.done", call_id: "c1", name: "update_understanding", arguments: "{}" }, 1);
    state = transcriptReducer(state, { type: CLIENT_TOOL_RESULT, call_id: "c1", result: { error: "insufficient_evidence", summary: "Ask for an example." }, ms: 1 }, 2);
    expect(toList(state)[0]).toMatchObject({ kind: "tool", status: "error", callId: "c1" });
  });
});
