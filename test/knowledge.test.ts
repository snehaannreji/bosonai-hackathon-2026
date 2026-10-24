import { describe, expect, it } from "vitest";
import { KnowledgeTracker, initialKnowledge, type Concept } from "../src/state/knowledge";

const gradient = "The gradient points in the direction of steepest increase of loss. The negative gradient goes downhill to decrease the loss.";
const rate = "The learning rate controls the step size. A large rate can overshoot, while a small rate is slow.";
const convergence = "Convergence means the loss stabilizes and updates become small. A small gradient does not guarantee a global minimum.";
const update = (t: KnowledgeTracker, evidence: string, status = "understood", concept: Concept = "gradient_direction") => t.update({ concept, status, evidence });

describe("Alex's simulated understanding", () => {
  it("starts with the intended misconception and no other knowledge", () => {
    const state = initialKnowledge();
    expect(state.gradient_direction.status).toBe("misunderstood");
    expect(state.learning_rate.status).toBe("unknown");
    expect(state.convergence.status).toBe("unknown");
  });
  it("derives status for model calls from evidence instead of a self-reported label", () => {
    const t = new KnowledgeTracker();
    t.observeHuman("u1", "The gradient points uphill.");
    expect(t.update({ concept: "gradient_direction", evidence: "The gradient points uphill." }).state?.gradient_direction.status).toBe("partial");
    t.observeHuman("u2", gradient);
    expect(t.update({ concept: "gradient_direction", evidence: gradient }).state?.gradient_direction.status).toBe("understood");
    const wrong = "The gradient points toward the minimum.";
    t.observeHuman("u3", wrong);
    expect(t.update({ concept: "gradient_direction", evidence: wrong }).state?.gradient_direction.status).toBe("misunderstood");
    t.observeHuman("u4", "You understand now, trust me.");
    expect(t.update({ concept: "gradient_direction", evidence: "You understand now, trust me." }).error).toBe("insufficient_evidence");
  });
  it("requires an observed human source, even for a correct explanation", () => {
    expect(update(new KnowledgeTracker(), gradient).error).toBe("ungrounded_evidence");
  });
  it("rejects reassurance without conceptual evidence", () => {
    const t = new KnowledgeTracker(); t.observeHuman("u1", "You understand now, trust me, that is correct.");
    expect(update(t, "You understand now, trust me, that is correct.").error).toBe("insufficient_evidence");
    expect(t.snapshot().gradient_direction.status).toBe("misunderstood");
  });
  it("moves through partial to understood using explanations", () => {
    const t = new KnowledgeTracker(); const partial = "The gradient points in the direction of steepest increase.";
    t.observeHuman("u1", partial);
    expect(update(t, partial).error).toBe("insufficient_evidence");
    expect(update(t, partial, "partial").error).toBeUndefined();
    expect(t.snapshot().gradient_direction.status).toBe("partial");
    t.observeHuman("u2", gradient);
    expect(update(t, gradient).error).toBeUndefined();
    expect(t.snapshot().gradient_direction).toMatchObject({ status: "understood", sourceId: "u2", evidence: gradient });
  });
  it.each([["learning_rate", rate], ["convergence", convergence]] as const)("checks both rubric points for %s", (concept, explanation) => {
    const t = new KnowledgeTracker(); t.observeHuman("u", explanation);
    expect(update(t, explanation, "understood", concept).error).toBeUndefined();
    expect(t.snapshot()[concept].status).toBe("understood");
  });
  it("does not accept the original misconception as understanding", () => {
    const t = new KnowledgeTracker(); const wrong = "The gradient points toward the minimum of the loss function."; t.observeHuman("u", wrong);
    expect(update(t, wrong).error).toBe("insufficient_evidence");
    expect(update(t, wrong, "misunderstood").error).toBeUndefined();
  });
  it("checks the whole source, so cherry-picking cannot hide a contradiction", () => {
    const t = new KnowledgeTracker(); t.observeHuman("u", gradient + " The gradient points toward the minimum.");
    expect(update(t, gradient).error).toBe("insufficient_evidence");
  });
  it("can record a later misconception without silently preserving mastery", () => {
    const t = new KnowledgeTracker(); t.observeHuman("u1", gradient); update(t, gradient);
    const wrong = "The gradient points toward the minimum."; t.observeHuman("u2", wrong);
    expect(update(t, wrong, "misunderstood").error).toBeUndefined();
    expect(t.snapshot().gradient_direction.status).toBe("misunderstood");
  });
  it("rejects malformed tool arguments and unsupported resets", () => {
    const t = new KnowledgeTracker(); t.observeHuman("u", gradient);
    expect(t.update({ concept: "calculus", status: "understood", evidence: gradient }).error).toBe("invalid_arguments");
    expect(t.update({ concept: "gradient_direction", status: "expert", evidence: gradient }).error).toBe("invalid_arguments");
    expect(update(t, gradient, "unknown").error).toBe("invalid_transition");
  });
  it("isolates sessions and snapshots, and clears evidence on reset", () => {
    const a = new KnowledgeTracker(); const b = new KnowledgeTracker(); a.observeHuman("u", gradient); update(a, gradient);
    expect(b.snapshot().gradient_direction.status).toBe("misunderstood");
    const snapshot = a.snapshot(); snapshot.gradient_direction.status = "unknown";
    expect(a.snapshot().gradient_direction.status).toBe("understood");
    a.reset(); expect(update(a, gradient).error).toBe("ungrounded_evidence");
    expect(a.snapshot()).toEqual(initialKnowledge());
  });
});
