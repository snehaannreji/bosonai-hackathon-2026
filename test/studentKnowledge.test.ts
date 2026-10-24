import { describe, expect, it } from "vitest";
import { createKnowledgeTracker } from "../src/state/createKnowledgeTracker";
import { StudentKnowledge, knowledgeInstructions } from "../src/state/studentKnowledge";
import { mockLesson, type EvidenceAssessment, type EvidenceAssessor } from "../src/state/lesson";
import { initialTopicKnowledge } from "../src/state/topicKnowledge";
import { studentPrompt } from "../src/realtime/sessionConfig";

const accepted: EvidenceAssessment = { matchedCriteria: [], matchedConcepts: [{ conceptId: "concept_1", matchedCriteria: ["criterion_1"] }], misconception: false, reason: "Private evaluator reason", factAccuracy: "accurate", topicFactTaught: true };
const lesson = { ...mockLesson("Neural networks"), mock: false };
function tracker(assess: EvidenceAssessor = async () => accepted) { return createKnowledgeTracker(undefined, lesson, assess); }
async function teach(t: ReturnType<typeof tracker>, id: string, text: string) { t.observeHuman(id, text); return t.update({ concept: "topic_fact", evidence: text }); }

describe("earned student knowledge", () => {
  it("A/B: questions and topic announcements do not teach expert facts", async () => {
    const t = tracker();
    await teach(t, "title", "I'm going to teach you neural networks.");
    await teach(t, "question", "What's the derivative of the sigmoid function?");
    expect(t.student!.snapshot().facts).toEqual([]);
    expect(t.student!.snapshot().stage).toBe("unknown");
    expect(t.student!.review("What is a neural network?").allowed).toBe(true);
    expect(t.student!.review("How does backpropagation use activation functions?").allowed).toBe(false);
    expect(t.student!.prepare({ text: "The derivative is sigmoid(x) * (1 - sigmoid(x)).", evidence_ids: [] }).approved_text).toContain("not sure");
  });
  it("C/D: advances only from taught explanations and leaves untaught learning rate unavailable", async () => {
    const t = tracker();
    await teach(t, "one", "Gradient descent means moving downhill to make the loss smaller.");
    expect(t.student!.snapshot().stage).toBe("partial"); // one private criterion was evidenced
    expect(t.student!.review("So the goal is to make the loss smaller?" ).allowed).toBe(true);
    await teach(t, "two", "A loss function measures how wrong our current guess is.");
    await teach(t, "three", "The gradient points in the direction where the loss increases fastest.");
    const snapshot = t.student!.snapshot();
    expect(snapshot.facts).toHaveLength(3);
    expect(snapshot.allowed_terms).toContain("gradient");
    expect(snapshot.allowed_terms).not.toContain("rate");
    expect(t.student!.review("The learning rate controls step size.").allowed).toBe(false);
    expect(t.student!.review("If the gradient points where loss increases, should we move the opposite way?").allowed).toBe(true);
    expect(snapshot.concepts.some(c => c.relationships.length > 0)).toBe(true);
  });
  it("E: keeps wrong teacher beliefs while evaluator corrections remain private", async () => {
    const correction = "The gradient points uphill, while the negative gradient points downhill.";
    const t = tracker(async () => ({ ...accepted, misconception: true, factAccuracy: "incorrect", reason: "The global optimum is not guaranteed.", groundTruth: correction,
      taughtGuideFacts: [{ id: "secret", text: "Backpropagation applies the chain rule.", conceptId: null }] }));
    const result = await teach(t, "wrong", "The gradient points toward the minimum.");
    expect(JSON.stringify(result.state)).toContain(correction);
    const student = t.student!.snapshot();
    expect(student.facts[0].text).toBe("The gradient points toward the minimum.");
    expect(JSON.stringify(student)).not.toContain(correction);
    expect(JSON.stringify(student)).not.toContain("Backpropagation");
    expect(JSON.stringify(student)).not.toContain("global optimum");
    expect(student.stage).toBe("introduced");
    expect(t.student!.review("The gradient points uphill.").allowed).toBe(true); // lexical guard alone is not a semantic truth checker
  });
  it("F/G: blocks diagrams before teaching, allows grounded primitives afterward and rejects untaught labels", async () => {
    const t = tracker();
    const diagram = { evidence_ids: [], intent: "Draw a neural network with backpropagation", shapes: [{ id: "n", tool: "circle", points: [{ x: .2, y: .2 }, { x: .3, y: .3 }] }] };
    expect(t.student!.authorizeDrawing("draw_shapes", diagram).allowed).toBe(false);
    await teach(t, "nodes", "A neural network has connected nodes. We can draw its nodes as circles joined by lines.");
    const earned = { ...diagram, evidence_ids: ["teacher:nodes"], intent: "Draw the neural network as circles connected by lines" };
    expect(t.student!.authorizeDrawing("draw_shapes", earned)).toMatchObject({ allowed: true, args: { shapes: diagram.shapes } });
    expect(t.student!.authorizeDrawing("draw_shapes", { ...earned, intent: "Draw backpropagation" }).allowed).toBe(false);
    expect(t.student!.authorizeDrawing("draw_text", { ...earned, shapes: [{ text: "sigmoid derivative" }] }).allowed).toBe(false);
    expect(t.student!.authorizeDrawing("draw_path", { ...earned, evidence_ids: ["invented"] }).allowed).toBe(false);
    expect(t.student!.authorizeDrawing("plot_function", { ...earned, intent: "Draw a curve" }).allowed).toBe(false);
    expect(t.student!.authorizeDrawing("get_whiteboard", {}).allowed).toBe(true);
  });
  it("H: isolates new lessons and clears facts, terminology and demonstrations on reset", async () => {
    const t = tracker(); await teach(t, "old", "A neural network has connected nodes.");
    const other = new StudentKnowledge(mockLesson("Roman history"));
    expect(other.snapshot().facts).toEqual([]); expect(other.snapshot().allowed_terms).not.toContain("neural");
    t.reset(); expect(t.student!.snapshot().stage).toBe("unknown"); expect(t.student!.snapshot().facts).toEqual([]);
  });
  it("never seeds a sophisticated belief or exposes unknown rubric terminology at any pace/style", () => {
    const privateLesson = { ...lesson, familiarity: 100, concepts: [{ id: "secret", label: "Backpropagation", goal: "Apply the chain rule", criteria: ["Derivative of sigmoid", "Chain rule"] as [string, string], initialBelief: "Gradient points toward minimum" }] };
    const t = new StudentKnowledge(privateLesson);
    expect(initialTopicKnowledge(privateLesson).secret.status).toBe("unknown");
    const prompt = knowledgeInstructions(studentPrompt(privateLesson), t.snapshot());
    expect(prompt).not.toContain("Backpropagation"); expect(prompt).not.toContain("Derivative of sigmoid");
    expect(prompt).not.toContain("Gradient points toward minimum");
    expect(t.snapshot()).toMatchObject({ stage: "unknown", concepts: [], facts: [], allowed_terms: [] });
  });
  it("cannot bootstrap knowledge by asking an expert leading question and getting yes", async () => {
    const t = tracker();
    t.observeHuman("yes", "yes", "Does sigmoid differentiation use the chain rule?");
    await t.update({ concept: "topic_fact", evidence: "yes" });
    expect(t.student!.snapshot().facts).toEqual([]);
  });
  it("supports introduced, partial, and teacher-confirmed demonstrated understanding", async () => {
    const t = tracker(async () => ({ ...accepted, matchedConcepts: [] }));
    await teach(t, "first", "A neural network has connected nodes.");
    expect(t.student!.snapshot().stage).toBe("introduced");
    const prepared = t.student!.prepare({ text: "A neural network has connected nodes.", evidence_ids: ["teacher:first"] });
    expect(prepared).toMatchObject({ allowed: true });
    t.observeHuman("confirm", "yes"); await t.update({ concept: "topic_fact", evidence: "yes" });
    // No automatic mastery from time, tools or a correct evaluator answer.
    t.student!.applyAssessment(t.snapshot());
    expect(t.student!.snapshot().stage).toBe("understood");
  });
});

it("unlocks an explained drawing immediately without a model assessment tool or mastery", () => {
  const memory = new StudentKnowledge(lesson);
  expect(memory.authorizeDrawing("draw_shapes", { intent: "Sketch a neural network" }).allowed).toBe(false);
  memory.observeHuman("explanation", "A neural network is made of circles joined by lines.");
  expect(memory.snapshot().stage).toBe("introduced");
  expect(memory.authorizeDrawing("draw_shapes", { intent: "I'll sketch a minimal neural network layout", shapes: [{ id: "a", tool: "circle" }] })).toMatchObject({ allowed: true });
  expect(memory.authorizeDrawing("draw_shapes", { intent: "Draw neural backpropagation", evidence_ids: [] }).allowed).toBe(false);
  memory.applyAssessment(initialTopicKnowledge(lesson));
  expect(memory.authorizeDrawing("draw_shapes", { intent: "Sketch a neural network", evidence_ids: [] }).allowed).toBe(true);
});

it("learns conditional explanations and concrete drawing instructions while rejecting bare requests", () => {
  const memory = new StudentKnowledge(lesson);
  for (const [i, text] of ["Draw a neural network with backpropagation.", "Now draw a neural network.", "I want you to draw a neural network with backpropagation.", "Can you draw backpropagation?", "I'm going to teach you neural networks."].entries()) memory.observeHuman(`request${i}`, text);
  expect(memory.snapshot().facts).toEqual([]);
  memory.observeHuman("conditional", "When you draw a neural network, circles represent nodes and lines connect the circles.");
  memory.observeHuman("procedural", "Draw two circles on the left and connect them with a line on the right.");
  expect(memory.snapshot().facts.map(f => f.sourceId)).toEqual(["conditional", "procedural"]);
  expect(memory.authorizeDrawing("draw_shapes", { intent: "Sketch the neural network with connected circles" }).allowed).toBe(true);
});

it("checks diagram labels independently of speech limits and distinguishes citation errors from knowledge gaps", () => {
  const memory = new StudentKnowledge(lesson);
  memory.observeHuman("u1", "A neural network has nodes connected by lines.");
  const shapes = [{ id: "labels", tool: "text", text: "A. B. C. D. E.\nx₁ → x₂" }];
  const args = { intent: "Sketch an annotated layout of the neural network", shapes };
  expect(memory.authorizeDrawing("draw_text", args)).toMatchObject({ allowed: true, args: { shapes } });
  expect(memory.authorizeDrawing("draw_text", { ...args, evidence_ids: ["u1"] }).allowed).toBe(true);
  expect(memory.authorizeDrawing("draw_text", { ...args, evidence_ids: ["invented"] })).toMatchObject({ error: "invalid_drawing_evidence" });
  expect(memory.authorizeDrawing("draw_text", { shapes })).toMatchObject({ error: "invalid_drawing_intent" });
  expect(memory.authorizeDrawing("draw_text", { ...args, shapes: [{ text: "sigmoid derivative" }] })).toMatchObject({ error: "untaught_drawing" });
});

it("learns short answers to grounded questions and not expert leading questions", () => {
  const memory = new StudentKnowledge(lesson);
  memory.observeHuman("question", "What is a neural network?");
  memory.observeHuman("answer", "Connected nodes", "What is a neural network?");
  expect(memory.snapshot().facts).toHaveLength(1);
  expect(memory.authorizeDrawing("draw_shapes", { intent: "Draw connected nodes" }).allowed).toBe(true);
  memory.observeHuman("yes", "yes", "Does sigmoid differentiation use the chain rule?");
  expect(memory.snapshot().facts).toHaveLength(1);
});
