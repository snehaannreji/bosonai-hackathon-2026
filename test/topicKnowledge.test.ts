import { describe, expect, it, vi } from "vitest";
import { TopicKnowledgeTracker, initialTopicKnowledge, studentToolFeedback } from "../src/state/topicKnowledge";
import { mockLesson, normalizeStudentName, normalizeTopic, type EvidenceAssessment, type EvidenceAssessor, type LessonDefinition } from "../src/state/lesson";
import { buildSessionConfig, studentPrompt } from "../src/realtime/sessionConfig";

const lesson: LessonDefinition = { ...mockLesson("Photosynthesis"), id: "photosynthesis", mock: false };
const explanation = "Plants use light energy to turn carbon dioxide and water into glucose, storing chemical energy and releasing oxygen.";
const accepted = { matchedCriteria: ["criterion_1", "criterion_2"], misconception: false, reason: "Both parts are explained with a mechanism.", factAccuracy: "accurate" as const };
const args = { concept: "concept_1", evidence: explanation };

describe("arbitrary-topic lesson state", () => {
  it("normalizes topics without assuming English or gradient descent", () => {
    expect(normalizeTopic("  French  past tense  ")).toBe("French past tense");
    expect(normalizeTopic("光合作用")).toBe("光合作用");
    expect(() => normalizeTopic(" ")).toThrow("between 2 and 160");
    expect(() => normalizeTopic("x".repeat(161))).toThrow();
  });
  it("validates custom student names and uses them in the student prompt", () => {
    expect(normalizeStudentName("  Morgan  ")).toBe("Morgan");
    expect(() => normalizeStudentName("")).toThrow("name between 1 and 40");
    expect(() => normalizeStudentName("x".repeat(41))).toThrow("1 and 40");
    const prompt = studentPrompt({ ...lesson, studentName: "Morgan" });
    expect(prompt).toContain('You are "Morgan", a student');
    expect(prompt).not.toContain("You are Alex");
  });
  it("keeps generated lesson concepts out of the student's prompt and tool agenda", () => {
    const prompt = studentPrompt({ ...lesson, familiarity: 50 });
    expect(prompt).toContain("Photosynthesis"); expect(prompt).not.toContain("gradient");
    expect(prompt).toContain("sound increasingly angry and impatient with each consecutive failed update");
    expect(prompt).toContain("sound increasingly angry and impatient");
    expect(prompt).toContain("Direct the anger at the teacher's explanation or teaching approach");
    expect(prompt).toContain("Do not threaten, demean, or use slurs");
    expect(prompt).toContain("Do not claim you learned it unless the tool confirms progress");
    expect(prompt).not.toContain("Lesson concepts and starting hunches");
    expect(prompt).toContain("blank knowledge state");
    expect(prompt).toContain("end your reply with one brief, specific open-ended follow-up question about that fact");
    expect(prompt).toContain("never repeat it or say you are curious about the topic");
    expect(prompt).toContain("Do not describe yourself as curious");
    expect(prompt).not.toContain("curious student");
    expect(prompt).toContain("then ask the required specific follow-up about each fact taught");
    expect(prompt).toContain("Express the chosen emotion only through vocal delivery");
    expect(prompt).toContain("Never output emotion labels, bracketed stage directions, markup, or control tokens");
    expect(prompt).toContain("use anger on about 1 in 3 replies");
    expect(prompt).toContain("sadness on about 1 in 3");
    expect(prompt).toContain("Vary intensity from subtle to intense");
    expect(prompt).toContain("Vary intensity from subtle to intense");
    expect(prompt).toContain("Let anger sound forceful when appropriate");
    expect(prompt).toContain("Let sadness sound slower and lower-pitched when appropriate");
    expect(prompt).toContain("never start with a label such as '[disappointed]'");
    expect(prompt).toContain("no more than about 1 in 6 replies");
    expect(prompt).toContain("Never use 'I'm feeling a bit curious' as a stock opener");
    expect(prompt).toContain("otherwise convey the emotion in the voice, not by talking about it");
    expect(prompt).toContain("Surprise is only for something genuinely unexpected");
    expect(prompt).toContain("do not say 'I'm a bit surprised' as a generic reaction");
    const novicePrompt = studentPrompt({ ...lesson, familiarity: 0 });
    expect(novicePrompt).toContain("Never correct, fact-check, contradict");
    expect(novicePrompt).toContain("instructor-only ground-truth check");
    expect(novicePrompt).toContain("Do not become angry");
    expect(novicePrompt).not.toContain("sound increasingly angry and impatient");
    const config = buildSessionConfig("model-fixture", lesson).session as { tools: { parameters: { properties: { concept: { enum: string[] } } } }[] };
    expect(config.tools[0].parameters.properties.concept.enum).toEqual(["topic_fact"]);
    expect(Object.keys(initialTopicKnowledge(lesson))).toEqual(["concept_1", "concept_2", "concept_3"]);
  });
  it("sets the starting knowledge map from the chosen familiarity without treating it as evidence", () => {
    const noFamiliarity = { ...lesson, familiarity: 0 };
    const someFamiliarity = { ...lesson, familiarity: 50 };
    const fullFamiliarity = { ...lesson, familiarity: 100 };
    expect(initialTopicKnowledge(noFamiliarity).concept_1).toMatchObject({ status: "unknown" });
    expect(initialTopicKnowledge(someFamiliarity).concept_1).toMatchObject({ status: "unknown", evidence: "No facts taught yet." });
    expect(initialTopicKnowledge(fullFamiliarity).concept_1).toMatchObject({ status: "unknown", evidence: "No facts taught yet." });
    expect(initialTopicKnowledge(noFamiliarity).concept_1).toMatchObject({ status: "unknown", evidence: "No facts taught yet." });
  });
  it("stores topic facts separately and matches them privately to generated concepts", async () => {
    const claim = "Canada has the longest coastline.";
    const tracker = new TopicKnowledgeTracker(lesson, async () => ({
      matchedCriteria: [],
      matchedConcepts: [{ conceptId: "concept_2", matchedCriteria: ["criterion_1"] }],
      misconception: false,
      reason: "The fact matches one private concept criterion.",
      factAccuracy: "accurate",
      independentFactTaught: false,
    }));
    tracker.observeHuman("u-topic", claim);

    const result = await tracker.update({ concept: "topic_fact", evidence: claim });

    expect(result.error).toBeUndefined();
    expect(result.state?.taught_facts?.learnedFacts).toMatchObject([
      { id: "turn:u-topic", text: claim, conceptId: null, teachingComplete: true },
    ]);
    expect(result.state?.concept_2).toMatchObject({ status: "partial", evidence: claim });
    expect(result.state?.concept_1.status).toBe("unknown");
  });
  it("records a taught fact even when it matches no generated concept or uploaded note", async () => {
    const claim = "The northern lights are caused by charged particles interacting with Earth's atmosphere.";
    const tracker = new TopicKnowledgeTracker(lesson, async () => ({
      matchedCriteria: [],
      matchedConcepts: [],
      misconception: false,
      reason: "A new topic fact was taught.",
      factAccuracy: "accurate",
      independentFactTaught: true,
      topicFactTaught: true,
    }));
    tracker.observeHuman("u-independent-topic", claim);

    const result = await tracker.update({ concept: "topic_fact", evidence: claim });

    expect(result.error).toBeUndefined();
    expect(result.state?.taught_facts?.learnedFacts).toMatchObject([
      { text: claim, review: "accurate", teachingComplete: true, independentTopicFact: true, conceptId: null },
    ]);
  });
  it("logs a short declarative fact even when the evaluator says it is not a substantive explanation", async () => {
    const claim = "It is the country with the larest coastline";
    const tracker = new TopicKnowledgeTracker(lesson, async () => ({
      matchedCriteria: [],
      matchedConcepts: [],
      misconception: false,
      reason: "No substantive explanation for this concept yet.",
      factAccuracy: "uncertain",
      independentFactTaught: false,
      topicFactTaught: false,
    }));
    tracker.observeHuman("u-short-fact", claim);

    const result = await tracker.update({ concept: "topic_fact", evidence: claim });

    expect(result.error).toBeUndefined();
    expect(result.summary).toContain("accuracy is unverified");
    expect(result.state?.taught_facts?.learnedFacts).toMatchObject([
      { id: "turn:u-short-fact", text: claim, review: "unverified", teachingComplete: true, independentTopicFact: true },
    ]);
  });
  it("records a concise answer to a question and passes its context to the private concept check", async () => {
    const assess = vi.fn(async ({ turns }: Parameters<EvidenceAssessor>[0]) => {
      expect(turns.at(-1)?.text).toContain("Student asked: What are the two official languages?");
      expect(turns.at(-1)?.text).toContain("Teacher answered: English and French");
      return {
        matchedCriteria: [],
        matchedConcepts: [{ conceptId: "concept_2", matchedCriteria: ["criterion_1"] }],
        misconception: false,
        reason: "The answer identifies both official languages.",
        factAccuracy: "uncertain" as const,
        topicFactTaught: false,
      };
    });
    const tracker = new TopicKnowledgeTracker(lesson, assess);
    tracker.observeHuman("u-languages", "English and French", "What are the two official languages?");

    const result = await tracker.update({ concept: "topic_fact", evidence: "English and French" });

    expect(result.error).toBeUndefined();
    expect(result.state?.taught_facts?.learnedFacts).toMatchObject([
      {
        id: "turn:u-languages",
        text: "Q: What are the two official languages?\nA: English and French",
        questionContext: "What are the two official languages?",
        review: "unverified",
        teachingComplete: true,
        independentTopicFact: false,
      },
    ]);
    expect(result.state?.concept_2).toMatchObject({
      status: "partial",
      evidence: "Q: What are the two official languages?\nA: English and French",
    });
    expect(assess).toHaveBeenCalledTimes(1);
  });
  it("does not label a question-answer fact as independent when it matched a lesson concept", async () => {
    const tracker = new TopicKnowledgeTracker(lesson, async () => ({
      matchedCriteria: [],
      matchedConcepts: [{ conceptId: "concept_2", matchedCriteria: ["criterion_1"] }],
      misconception: false,
      reason: "The answer matched the concept.",
      factAccuracy: "accurate",
      independentFactTaught: true,
      topicFactTaught: true,
    }));
    tracker.observeHuman("u-answer", "English and French", "What are the two official languages?");

    const result = await tracker.update({ concept: "topic_fact", evidence: "English and French" });

    expect(result.state?.taught_facts?.learnedFacts).toMatchObject([
      {
        text: "Q: What are the two official languages?\nA: English and French",
        independentTopicFact: false,
      },
    ]);
  });
  it("records a yes/no reply against the selected student's immediately preceding question", async () => {
    const assess = vi.fn(async () => accepted);
    const tracker = new TopicKnowledgeTracker({ ...lesson, familiarity: 0, studentName: "Claire" }, assess);
    tracker.observeHuman("u1", "yes", "Does the blue line represent a river?");
    const result = await tracker.update({ concept: "concept_2", evidence: "yes" });
    expect(result.error).toBeUndefined();
    expect(result.state?.concept_2).toMatchObject({
      status: "unknown",
      evidence: "yes",
      belief: expect.stringContaining("Claire asked “Does the blue line represent a river?”"),
    });
    expect(result.state?.concept_2.belief).not.toContain("Alex asked");
    expect(assess).not.toHaveBeenCalled();
  });
  it("does not treat an out-of-context yes/no as learning evidence", async () => {
    const assess = vi.fn(async () => accepted);
    const tracker = new TopicKnowledgeTracker(lesson, assess);
    tracker.observeHuman("u1", "no");
    expect((await tracker.update({ concept: "concept_1", evidence: "no" })).error).toBe("ungrounded_evidence");
    expect(assess).not.toHaveBeenCalled();
  });
  it("marks a novice's true claim as accurate without changing their receptive roleplay", async () => {
    const claim = "The Eiffel Tower is in North America.";
    const tracker = new TopicKnowledgeTracker({ ...lesson, familiarity: 0 }, async () => ({
      matchedCriteria: [],
      misconception: false,
      reason: "The claim is factually accurate.",
      factAccuracy: "accurate",
    }));
    tracker.observeHuman("u-true", claim);
    const result = await tracker.update({ concept: "concept_1", evidence: claim });
    expect(result.state?.concept_1).toMatchObject({
      belief: expect.stringContaining(claim),
      beliefAccuracy: "accurate",
      learnedFacts: [{ id: "turn:u-true", text: claim, review: "accurate", origin: "conversation", sourceId: "u-true", conceptId: "concept_1" }],
    });
    expect(result.summary).not.toContain("factually accurate");
    expect(studentToolFeedback({ ...lesson, familiarity: 0 }, result)).not.toContain("factually accurate");
  });
  it("automatically accumulates instructor-validated note facts as taught", async () => {
    const firstClaim = "Sylvania is the capital of Freedonia because it was designated as the national seat.";
    const secondClaim = "The capital is near the coast and serves as the main administrative center.";
    const assess = vi.fn()
      .mockResolvedValueOnce({ matchedCriteria: [], misconception: false, reason: "The explanation covers a note.", factAccuracy: "accurate", taughtGuideFactIds: ["guide-1"], taughtGuideFacts: [{ id: "guide-1", text: "Sylvania is the capital of Freedonia.", conceptId: "concept_1" }] })
      .mockResolvedValueOnce({ matchedCriteria: [], misconception: false, reason: "The explanation covers another note.", factAccuracy: "accurate", taughtGuideFactIds: ["guide-2"], taughtGuideFacts: [{ id: "guide-2", text: "The capital serves as the national seat.", conceptId: "concept_1" }] });
    const tracker = new TopicKnowledgeTracker(lesson, assess);
    tracker.observeHuman("u-guide-1", firstClaim);
    const first = await tracker.update({ concept: "concept_1", evidence: firstClaim });
    expect(first.error).toBeUndefined();
    expect(first.state?.concept_1.taughtGuideFactIds).toEqual(["guide-1"]);
    expect(first.state?.concept_1.learnedFacts).toMatchObject([
      { id: "turn:u-guide-1", text: firstClaim, origin: "conversation", teachingComplete: true },
      { id: "note:guide-1", text: "Sylvania is the capital of Freedonia.", origin: "instructor-notes", sourceId: "u-guide-1", conceptId: null, review: "accurate", teachingComplete: true },
    ]);

    tracker.observeHuman("u-guide-2", secondClaim);
    const second = await tracker.update({ concept: "concept_1", evidence: secondClaim });
    expect(second.state?.concept_1.taughtGuideFactIds).toEqual(["guide-1", "guide-2"]);
    expect(second.state?.concept_1.learnedFacts).toHaveLength(4);
    expect(second.state?.concept_1.learnedFacts?.filter(fact => fact.origin === "instructor-notes")).toHaveLength(2);
  });
  it("records a substantive independent topic fact as taught without requiring a lesson criterion", async () => {
    const independentFact = "Canada holds the world record for the longest total coastline, stretching over 202,080 km and touching the Atlantic, Pacific, and Arctic Oceans.";
    const tracker = new TopicKnowledgeTracker(lesson, async () => ({
      matchedCriteria: [],
      misconception: false,
      reason: "A relevant independent fact was taught, though it does not match this concept's criteria.",
      factAccuracy: "accurate",
      independentFactTaught: true,
    }));
    tracker.observeHuman("u-independent", independentFact);

    const result = await tracker.update({ concept: "concept_1", evidence: independentFact });

    expect(result.error).toBeUndefined();
    expect(result.summary).toContain("recorded as taught");
    expect(result.summary).toContain("remains unknown");
    expect(result.state?.concept_1).toMatchObject({
      status: "unknown",
      learnedFacts: [{ id: "turn:u-independent", text: independentFact, review: "accurate", origin: "conversation", sourceId: "u-independent", conceptId: "concept_1", teachingComplete: true }],
    });
  });
  it("updates lesson criteria and multiple note facts from the same explanation", async () => {
    const explanation = "Canada has the longest coastline, touching the Atlantic, Pacific, and Arctic Oceans. It also has more lakes than any other country.";
    const tracker = new TopicKnowledgeTracker(lesson, async () => ({
      matchedCriteria: ["criterion_1"],
      misconception: false,
      reason: "The explanation covers a lesson criterion and two instructor note facts.",
      factAccuracy: "accurate",
      taughtGuideFactIds: ["guide-1", "guide-2"],
      taughtGuideFacts: [
        { id: "guide-1", text: "Canada has the world's longest coastline.", conceptId: "concept_1" },
        { id: "guide-2", text: "Canada has more lakes than any other country.", conceptId: "concept_1" },
      ],
    }));
    tracker.observeHuman("u-combined", explanation);

    const result = await tracker.update({ concept: "concept_1", evidence: explanation });

    expect(result.error).toBeUndefined();
    expect(result.state?.concept_1.status).toBe("partial");
    expect(result.state?.concept_1.taughtGuideFactIds).toEqual(["guide-1", "guide-2"]);
    expect(result.state?.concept_1.learnedFacts).toMatchObject([
      { id: "turn:u-combined", teachingComplete: true },
      { id: "note:guide-1", teachingComplete: true },
      { id: "note:guide-2", teachingComplete: true },
    ]);
  });
  it("keeps a novice's incorrect claim as their belief while isolating instructor ground truth", async () => {
    const claim = "Photosynthesis consumes oxygen and produces carbon dioxide.";
    const correction = "Photosynthesis uses carbon dioxide and releases oxygen.";
    const tracker = new TopicKnowledgeTracker({ ...lesson, familiarity: 0 }, async () => ({
      matchedCriteria: [],
      misconception: true,
      reason: "The gases are reversed.",
      factAccuracy: "incorrect",
      groundTruth: correction,
    }));
    tracker.observeHuman("u1", claim);
    const result = await tracker.update({ concept: "concept_1", evidence: claim });
    expect(result.state?.concept_1).toMatchObject({
      status: "misunderstood",
      belief: expect.stringContaining(claim),
      groundTruth: correction,
      beliefAccuracy: "misconception",
      learnedFacts: [{ id: "turn:u1", text: claim, review: "misconception", groundTruth: correction }],
    });
    expect(result.summary).not.toContain(correction);
    expect(studentToolFeedback({ ...lesson, familiarity: 0 }, result)).toContain("Do not correct, fact-check, contradict");
    expect(studentToolFeedback({ ...lesson, familiarity: 0 }, result)).not.toContain(correction);
  });
  it("keeps a novice's claim as a belief even when it does not yet meet a learning criterion", async () => {
    const claim = "A map scale is just a decorative line.";
    const tracker = new TopicKnowledgeTracker({ ...lesson, familiarity: 0 }, async () => ({
      matchedCriteria: [],
      misconception: false,
      reason: "No criteria demonstrated yet.",
      factAccuracy: "uncertain",
    }));
    tracker.observeHuman("u1", claim);
    const result = await tracker.update({ concept: "concept_1", evidence: claim });
    expect(result.error).toBe("insufficient_evidence");
    expect(result.state?.concept_1.belief).toContain(claim);
    expect(result.state?.concept_1.learnedFacts).toMatchObject([{ text: claim, review: "unverified", teachingComplete: false }]);
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
