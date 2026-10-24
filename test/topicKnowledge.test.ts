import { describe, expect, it, vi } from "vitest";
import { TopicKnowledgeTracker, initialTopicKnowledge } from "../src/state/topicKnowledge";
import { mockLesson, normalizeTopic, type EvidenceAssessment, type EvidenceAssessor, type LessonDefinition } from "../src/state/lesson";
import { buildSessionConfig, studentPrompt } from "../src/realtime/sessionConfig";

const lesson: LessonDefinition = { ...mockLesson("Photosynthesis"), id: "photosynthesis", mock: false };
const explanation = "Plants use light energy to turn carbon dioxide and water into glucose, storing chemical energy and releasing oxygen.";
const accepted = { matchedCriteria: ["criterion_1", "criterion_2"], misconception: false, reason: "Both parts are explained with a mechanism." };
const args = { concept: "concept_1", evidence: explanation };

describe("arbitrary-topic lesson state", () => {
  it("normalizes topics without assuming English or gradient descent", () => {
    expect(normalizeTopic("  French  past tense  ")).toBe("French past tense");
    expect(normalizeTopic("光合作用")).toBe("光合作用");
    expect(() => normalizeTopic(" ")).toThrow("between 2 and 160");
    expect(() => normalizeTopic("x".repeat(161))).toThrow();
  });
  it("builds the student's prompt and tool enum from the selected lesson only", () => {
    const prompt = studentPrompt(lesson);
    expect(prompt).toContain("Photosynthesis"); expect(prompt).not.toContain("gradient");
    expect(prompt).toContain("sound increasingly angry and impatient with each consecutive failed update");
    expect(prompt).toContain("sound increasingly angry and impatient");
    expect(prompt).toContain("Direct the anger at the teacher's explanation or teaching approach");
    expect(prompt).toContain("Do not threaten, demean, or use slurs");
    expect(prompt).toContain("Do not claim you learned it unless the tool confirms progress");
    const config = buildSessionConfig("model-fixture", lesson).session as { tools: { parameters: { properties: { concept: { enum: string[] } } } }[] };
    expect(config.tools[0].parameters.properties.concept.enum).toEqual(lesson.concepts.map(c => c.id));
    expect(Object.keys(initialTopicKnowledge(lesson))).toEqual(["concept_1", "concept_2", "concept_3"]);
  });
  it("sets the starting knowledge map from the chosen familiarity without treating it as evidence", () => {
    const noFamiliarity = { ...lesson, familiarity: 0 };
    const someFamiliarity = { ...lesson, familiarity: 50 };
    const fullFamiliarity = { ...lesson, familiarity: 100 };
    expect(initialTopicKnowledge(noFamiliarity).concept_1).toMatchObject({ status: "unknown" });
    expect(initialTopicKnowledge(someFamiliarity).concept_1).toMatchObject({ status: "partial", evidence: expect.stringContaining("not independently assessed") });
    expect(initialTopicKnowledge(fullFamiliarity).concept_1).toMatchObject({ status: "understood", evidence: expect.stringContaining("100%") });
  });
  it("records a yes/no reply against Alex's immediately preceding question as an unverified belief", async () => {
    const assess = vi.fn(async () => accepted);
    const tracker = new TopicKnowledgeTracker({ ...lesson, familiarity: 0 }, assess);
    tracker.observeHuman("u1", "yes", "Does the blue line represent a river?");
    const result = await tracker.update({ concept: "concept_2", evidence: "yes" });
    expect(result.error).toBeUndefined();
    expect(result.state?.concept_2).toMatchObject({
      status: "unknown",
      evidence: "yes",
      belief: expect.stringContaining("Does the blue line represent a river?"),
    });
    expect(assess).not.toHaveBeenCalled();
  });
  it("does not treat an out-of-context yes/no as learning evidence", async () => {
    const assess = vi.fn(async () => accepted);
    const tracker = new TopicKnowledgeTracker(lesson, assess);
    tracker.observeHuman("u1", "no");
    expect((await tracker.update({ concept: "concept_1", evidence: "no" })).error).toBe("ungrounded_evidence");
    expect(assess).not.toHaveBeenCalled();
  });
  it("keeps a novice's incorrect teacher claim as an unverified belief while retaining the misconception result", async () => {
    const claim = "Blue lines on every map always mean rivers.";
    const tracker = new TopicKnowledgeTracker({ ...lesson, familiarity: 0 }, async () => ({
      matchedCriteria: [],
      misconception: true,
      reason: "The claim is too broad.",
    }));
    tracker.observeHuman("u1", claim);
    const result = await tracker.update({ concept: "concept_1", evidence: claim });
    expect(result.state?.concept_1).toMatchObject({
      status: "misunderstood",
      belief: expect.stringContaining(claim),
    });
  });
  it("keeps a novice's claim as a belief even when it does not yet meet a learning criterion", async () => {
    const claim = "A map scale is just a decorative line.";
    const tracker = new TopicKnowledgeTracker({ ...lesson, familiarity: 0 }, async () => ({
      matchedCriteria: [],
      misconception: false,
      reason: "No criteria demonstrated yet.",
    }));
    tracker.observeHuman("u1", claim);
    const result = await tracker.update({ concept: "concept_1", evidence: claim });
    expect(result.error).toBe("insufficient_evidence");
    expect(result.state?.concept_1.belief).toContain(claim);
  });
  it("requires actual observed human evidence before calling the independent assessor", async () => {
    const assess = vi.fn(async (_input: Parameters<EvidenceAssessor>[0]) => accepted); const tracker = new TopicKnowledgeTracker(lesson, assess);
    expect((await tracker.update(args)).error).toBe("ungrounded_evidence"); expect(assess).not.toHaveBeenCalled();
    tracker.observeHuman("u1", explanation);
    expect((await tracker.update(args)).state?.concept_1.status).toBe("understood");
    expect(assess).toHaveBeenCalledWith(expect.objectContaining({ concept: lesson.concepts[0], turns: [{ id: "u1", text: explanation }] }));
  });
  it("rejects bare reassurance without asking the assessor or awarding learning", async () => {
    const assess = vi.fn(async (_input: Parameters<EvidenceAssessor>[0]) => accepted); const tracker = new TopicKnowledgeTracker(lesson, assess);
    const evidence = "You understand now, trust me, that is correct."; tracker.observeHuman("u1", evidence);
    expect((await tracker.update({ concept: "concept_1", evidence })).error).toBe("insufficient_evidence");
    expect(assess).not.toHaveBeenCalled(); expect(tracker.snapshot().concept_1.status).toBe("unknown");
  });
  it("ignores model-selected mastery and derives partial from independently matched criteria", async () => {
    const tracker = new TopicKnowledgeTracker(lesson, async () => ({ ...accepted, matchedCriteria: ["criterion_1"] }));
    tracker.observeHuman("u1", explanation);
    expect((await tracker.update({ ...args, status: "understood" })).state?.concept_1.status).toBe("partial");
  });
  it("cannot promote mastery using invented criterion IDs", async () => {
    const tracker = new TopicKnowledgeTracker(lesson, async () => ({ ...accepted, matchedCriteria: ["made_up", "criterion_1", "criterion_1"] }));
    tracker.observeHuman("u1", explanation);
    expect((await tracker.update(args)).state?.concept_1.status).toBe("partial");
  });
  it("evaluates the whole recent explanation, so quoted fragments cannot hide contradictions", async () => {
    const assess = vi.fn(async (_input: Parameters<EvidenceAssessor>[0]) => ({ ...accepted, misconception: true, reason: "The full explanation contains a conflicting mechanism." }));
    const tracker = new TopicKnowledgeTracker(lesson, assess);
    tracker.observeHuman("u1", explanation + " Plants actually get all their food from the soil.");
    expect((await tracker.update(args)).state?.concept_1.status).toBe("misunderstood");
    expect(assess.mock.calls[0][0].turns[0].text).toContain("soil");
  });
  it("combines recent turns for gradual learning and deduplicates repeated assessments", async () => {
    const assess = vi.fn(async (_input: Parameters<EvidenceAssessor>[0]) => accepted); const tracker = new TopicKnowledgeTracker(lesson, assess);
    tracker.observeHuman("u1", "Photosynthesis is how plants store energy."); tracker.observeHuman("u2", explanation);
    await tracker.update(args); await tracker.update(args);
    expect(assess).toHaveBeenCalledTimes(1); expect(assess.mock.calls[0][0].turns).toHaveLength(2);
  });
  it("discards a slow assessment after a newer human explanation", async () => {
    let resolve!: (result: EvidenceAssessment) => void;
    const tracker = new TopicKnowledgeTracker(lesson, () => new Promise(r => { resolve = r; }));
    tracker.observeHuman("u1", explanation); const pending = tracker.update(args);
    tracker.observeHuman("u2", "Actually, let me clarify the energy source."); resolve(accepted);
    expect((await pending).error).toBe("stale_evidence"); expect(tracker.snapshot().concept_1.status).toBe("unknown");
  });
  it("keeps subjects isolated and invalidates pending evidence when reset", async () => {
    const a = new TopicKnowledgeTracker(lesson, async () => accepted);
    const b = new TopicKnowledgeTracker({ ...lesson, id: "music", topic: "Jazz improvisation" }, async () => accepted);
    a.observeHuman("u1", explanation); await a.update(args);
    expect((await b.update(args)).error).toBe("ungrounded_evidence");
    a.reset(); expect(a.snapshot()).toEqual(initialTopicKnowledge(lesson)); expect((await a.update(args)).error).toBe("ungrounded_evidence");
  });
  it("retains state on provider failure and permits retrying", async () => {
    const assess = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(accepted);
    const tracker = new TopicKnowledgeTracker(lesson, assess); tracker.observeHuman("u1", explanation);
    expect((await tracker.update(args)).error).toBe("assessment_unavailable");
    expect(tracker.snapshot().concept_1.status).toBe("unknown");
    expect((await tracker.update(args)).state?.concept_1.status).toBe("understood");
  });
  it("grounds non-Latin quotes without stripping their content", async () => {
    const tracker = new TopicKnowledgeTracker({ ...lesson, topic: "光合作用" }, async () => accepted);
    const evidence = "植物利用阳光把二氧化碳和水转化为葡萄糖，并且释放氧气。";
    tracker.observeHuman("u1", evidence);
    expect((await tracker.update({ concept: "concept_1", evidence })).state?.concept_1.status).toBe("understood");
  });
});
