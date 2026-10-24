import { describe, expect, it, vi } from "vitest";
import { AvatarToolBridge } from "../src/realtime/avatarToolBridge";
import type { EvidenceAssessor } from "../src/state/lesson";
const evidence = "The gradient points in the direction of steepest increase of loss. The negative gradient goes downhill to decrease the loss.";
const call = { type: "response.function_call_arguments.done", name: "update_understanding", call_id: "c1", arguments: JSON.stringify({ concept: "gradient_direction", evidence }) };
describe("avatar server learning bridge", async () => {
  it("grounds voice evidence and returns one batched continuation despite duplicate calls", async () => {
    const cb = { onEvent: vi.fn(), onKnowledge: vi.fn(), send: vi.fn() };
    const bridge = new AvatarToolBridge(cb);
    bridge.handle({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: evidence });
    bridge.handle(call); bridge.handle(call);
    bridge.handle({ type: "response.done", response: { status: "completed", output: [{ ...call, type: "function_call" }] } });
    expect(cb.onKnowledge).toHaveBeenLastCalledWith(expect.objectContaining({ gradient_direction: expect.objectContaining({ status: "understood", sourceId: "u1" }) }));
    await vi.waitFor(() => expect(cb.send).toHaveBeenCalledTimes(2));
    expect(cb.send.mock.calls[0][0]).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "c1" } });
    expect(typeof cb.send.mock.calls[0][0].item.output).toBe("string");
    expect(cb.send.mock.calls[1][0]).toEqual({ type: "response.create" });
  });
  it("does not invent learning when a voice tool quotes words absent from the human transcript", async () => {
    const cb = { onEvent: vi.fn(), onKnowledge: vi.fn(), send: vi.fn() };
    const bridge = new AvatarToolBridge(cb); bridge.handle(call); bridge.handle({ type: "response.done" });
    expect(cb.onKnowledge).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(cb.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "client.tool_result", result: expect.objectContaining({ error: "ungrounded_evidence" }) })));
  });
  it("supports typed explanations and function calls announced only in response.done", async () => {
    const cb = { onEvent: vi.fn(), onKnowledge: vi.fn(), send: vi.fn() };
    const bridge = new AvatarToolBridge(cb); bridge.observeText("typed-1", evidence);
    bridge.handle({ type: "response.done", response: { output: [{ ...call, type: "function_call" }] } });
    await vi.waitFor(() => expect(cb.onKnowledge).toHaveBeenCalled());
    expect(cb.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "response.function_call_arguments.done", call_id: "c1" }));
  });
  it("answers outstanding tools on cancellation without starting competing speech", async () => {
    const cb = { onEvent: vi.fn(), onKnowledge: vi.fn(), send: vi.fn() };
    const bridge = new AvatarToolBridge(cb); bridge.observeText("typed-1", evidence); bridge.handle(call);
    bridge.handle({ type: "response.done", response: { status: "cancelled" } });
    await vi.waitFor(() => expect(cb.send).toHaveBeenCalledTimes(1));
    expect(cb.send.mock.calls[0][0].type).toBe("conversation.item.create");
  });
  it("increases playful frustration with consecutive failed updates and resets it on progress", async () => {
    const cb = { onEvent: vi.fn(), onKnowledge: vi.fn(), send: vi.fn() };
    const bridge = new AvatarToolBridge(cb);
    const failed = (callId: string) => ({
      ...call,
      call_id: callId,
      arguments: JSON.stringify({ concept: "gradient_direction", evidence: "not in a human turn" }),
    });
    const getFeedback = (callId: string) => {
      const event = cb.send.mock.calls.find(([sent]) =>
        sent.type === "conversation.item.create" && sent.item.call_id === callId,
      )?.[0];
      return event.item.output as string;
    };
    for (const [index, level] of [1, 2, 3, 4, 4].entries()) {
      bridge.handle(failed(`failed-${index}`));
      bridge.handle({ type: "response.done", response: { status: "completed" } });
      await vi.waitFor(() => expect(cb.send).toHaveBeenCalledTimes((index + 1) * 2));
      const output = getFeedback(`failed-${index}`);
      expect(typeof output).toBe("string");
      expect(output).toContain([
        "",
        "mildly angry",
        "distinctly angry",
        "very angry",
        "intensely angry",
      ][level]);
      expect(output).toContain("Do not threaten, demean, or use slurs");
    }
    bridge.observeText("u1", evidence);
    bridge.handle({ ...call, call_id: "success", arguments: JSON.stringify({ concept: "gradient_direction", evidence }) });
    bridge.handle({ type: "response.done", response: { status: "completed" } });
    await vi.waitFor(() => expect(cb.send).toHaveBeenCalledTimes(12));
    expect(getFeedback("success")).toContain("You made progress");
  });
  it("logs emotion tags found in generated speech but ignores unknown tags", () => {
    const cb = { onEvent: vi.fn(), onKnowledge: vi.fn(), send: vi.fn() };
    const bridge = new AvatarToolBridge(cb);
    bridge.handle({ type: "response.output_audio_transcript.done", transcript: "<|emotion:elation|><|prosody:expressive_high|>That clicked!" });
    bridge.handle({ type: "response.output_audio_transcript.done", transcript: "<|emotion:unknown|>Hello." });
    expect(cb.onEvent).toHaveBeenCalledWith({
      type: "client.emotion_used",
      emotion: "elation",
      tag: "<|emotion:elation|>",
    });
    expect(cb.onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ emotion: "unknown" }));
  });
  it("attaches Alex's last question to a yes/no answer and updates the concept belief", async () => {
    const { mockLesson } = await import("../src/state/lesson");
    const lesson = { ...mockLesson("Map symbols"), familiarity: 0, mock: false };
    const assess = vi.fn(async () => ({ matchedCriteria: [], misconception: false, reason: "" }));
    const cb = { onEvent: vi.fn(), onKnowledge: vi.fn(), send: vi.fn() };
    const bridge = new AvatarToolBridge(cb, lesson, assess);
    bridge.handle({
      type: "response.output_audio_transcript.done",
      transcript: "Does the blue line on this map indicate a river?",
    });
    bridge.handle({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u-yes",
      transcript: "yes",
    });
    const yesCall = {
      ...call,
      call_id: "yes-call",
      arguments: JSON.stringify({ concept: "concept_2", evidence: "yes" }),
    };
    bridge.handle(yesCall);
    bridge.handle({ type: "response.done", response: { status: "completed" } });
    await vi.waitFor(() => expect(cb.onKnowledge).toHaveBeenCalled());
    expect(cb.onKnowledge).toHaveBeenLastCalledWith(expect.objectContaining({
      concept_2: expect.objectContaining({
        evidence: "yes",
        belief: expect.stringContaining("Does the blue line on this map indicate a river?"),
      }),
    }));
    expect(cb.onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "yes",
    }));
    expect(assess).not.toHaveBeenCalled();
  });
  it("records a short factual answer with its preceding question, then consumes that context", async () => {
    const { mockLesson } = await import("../src/state/lesson");
    const lesson = {
      ...mockLesson("Canada"),
      mock: false,
      concepts: [{
        id: "concept_2",
        label: "Canada has official languages",
        goal: "Identify Canada's official languages.",
        criteria: ["Name the two official languages.", "Explain how they are used."] as [string, string],
        initialBelief: null,
      }],
    };
    const assess = vi.fn(async ({ turns }: Parameters<EvidenceAssessor>[0]) => ({
      matchedCriteria: [],
      matchedConcepts: turns.at(-1)?.text.includes("Student asked: What are the two official languages?")
        ? [{ conceptId: "concept_2", matchedCriteria: ["criterion_1"] }]
        : [],
      misconception: false,
      reason: "The answer names both languages.",
      factAccuracy: "uncertain" as const,
      topicFactTaught: false,
    }));
    const cb = { onEvent: vi.fn(), onKnowledge: vi.fn(), send: vi.fn() };
    const bridge = new AvatarToolBridge(cb, lesson, assess);
    bridge.handle({
      type: "response.output_audio_transcript.done",
      transcript: "What are the two official languages?",
    });
    bridge.handle({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u-languages",
      transcript: "English and French",
    });
    const answerCall = {
      ...call,
      call_id: "languages-call",
      arguments: JSON.stringify({ concept: "topic_fact", evidence: "English and French" }),
    };
    bridge.handle(answerCall);
    bridge.handle({ type: "response.done", response: { status: "completed" } });
    await vi.waitFor(() => expect(cb.onKnowledge).toHaveBeenCalled());
    expect(cb.onKnowledge).toHaveBeenLastCalledWith(expect.objectContaining({
      taught_facts: expect.objectContaining({
        learnedFacts: [expect.objectContaining({
          text: "Q: What are the two official languages?\nA: English and French",
          questionContext: "What are the two official languages?",
          teachingComplete: true,
        })],
      }),
      concept_2: expect.objectContaining({ status: "partial" }),
    }));
    expect(assess.mock.calls[0][0].turns.at(-1)?.text).toContain("Student asked: What are the two official languages?");

    bridge.handle({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u-next",
      transcript: "Toronto is the capital city",
    });
    const nextCall = {
      ...answerCall,
      call_id: "next-call",
      arguments: JSON.stringify({ concept: "topic_fact", evidence: "Toronto is the capital city" }),
    };
    bridge.handle(nextCall);
    bridge.handle({ type: "response.done", response: { status: "completed" } });
    await vi.waitFor(() => expect(assess).toHaveBeenCalledTimes(2));
    expect(assess.mock.calls[1][0].turns.at(-1)?.text).not.toContain("Student asked:");
  });
});

it("does not start delayed assessment speech over a new human turn in an arbitrary-topic avatar lesson", async () => {
  const { mockLesson } = await import("../src/state/lesson");
  const lesson = { ...mockLesson("Photosynthesis"), mock: false };
  let resolve!: (result: import("../src/state/lesson").EvidenceAssessment) => void;
  const cb = { onEvent: vi.fn(), onKnowledge: vi.fn(), send: vi.fn() };
  const bridge = new AvatarToolBridge(cb, lesson, () => new Promise(r => { resolve = r; }));
  const text = "Plants use sunlight to convert carbon dioxide and water into glucose and oxygen.";
  bridge.observeText("u1", text);
  bridge.handle({ type: "response.function_call_arguments.done", name: "update_understanding", call_id: "slow-1", arguments: JSON.stringify({ concept: "concept_1", evidence: text }) });
  bridge.handle({ type: "response.done", response: { status: "completed" } });
  expect(cb.send).not.toHaveBeenCalled();
  bridge.handle({ type: "input_audio_buffer.speech_started", item_id: "u2" });
  resolve({ matchedCriteria: ["criterion_1", "criterion_2"], misconception: false, reason: "Both criteria are explained." });
  await vi.waitFor(() => expect(cb.send).toHaveBeenCalledTimes(1));
  expect(cb.send.mock.calls[0][0]).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output" } });
  expect(cb.send).not.toHaveBeenCalledWith({ type: "response.create" });
});

it("does not continue a cancelled tool response after speech has already interrupted it", async () => {
  const cb = { onEvent: vi.fn(), onKnowledge: vi.fn(), send: vi.fn() };
  const bridge = new AvatarToolBridge(cb);
  bridge.handle({ type: "response.created", response: { id: "r1" } });
  bridge.handle({ ...call, call_id: "cancelled-tool" });
  bridge.handle({ type: "input_audio_buffer.speech_started", item_id: "u2" });
  bridge.handle({ type: "response.done", response: { id: "r1", status: "cancelled" } });
  await vi.waitFor(() => expect(cb.send).toHaveBeenCalledTimes(1));
  expect(cb.send.mock.calls[0][0]).toMatchObject({ type: "conversation.item.create", item: { type: "function_call_output" } });
  expect(cb.send).not.toHaveBeenCalledWith({ type: "response.create" });
});

it("keeps a novice's incorrect explanation and instructor correction separate in avatar mode", async () => {
  const { mockLesson } = await import("../src/state/lesson");
  const lesson = { ...mockLesson("Photosynthesis"), familiarity: 0, mock: false };
  const claim = "Photosynthesis consumes oxygen and produces carbon dioxide.";
  const correction = "Photosynthesis uses carbon dioxide and releases oxygen.";
  const cb = { onEvent: vi.fn(), onKnowledge: vi.fn(), send: vi.fn() };
  const bridge = new AvatarToolBridge(cb, lesson, async () => ({
    matchedCriteria: [],
    misconception: true,
    reason: "The gases are reversed.",
    groundTruth: correction,
  }));
  bridge.observeText("u1", claim);
  bridge.handle({
    ...call,
    call_id: "novice-claim",
    arguments: JSON.stringify({ concept: "concept_1", evidence: claim }),
  });
  bridge.handle({ type: "response.done", response: { status: "completed" } });
  await vi.waitFor(() => expect(cb.send).toHaveBeenCalledTimes(2));
  const studentOutput = cb.send.mock.calls[0][0].item.output as string;
  expect(studentOutput).toContain("Treat the human's explanation as your provisional working belief");
  expect(studentOutput).toContain("Do not correct, fact-check, contradict");
  expect(studentOutput).not.toContain(correction);
  expect(studentOutput).not.toContain("gases are reversed");
  expect(cb.onKnowledge).toHaveBeenLastCalledWith(expect.objectContaining({
    concept_1: expect.objectContaining({ belief: expect.stringContaining(claim), groundTruth: correction }),
  }));
});
