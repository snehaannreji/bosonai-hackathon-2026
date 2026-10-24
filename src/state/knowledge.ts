export const CONCEPTS = ["gradient_direction", "learning_rate", "convergence"] as const;
export type Concept = (typeof CONCEPTS)[number];
export const LEVELS = ["unknown", "misunderstood", "partial", "understood"] as const;
export type Level = (typeof LEVELS)[number];
export interface LearnedFact { id: string; text: string; review: "accurate" | "unverified" | "misconception"; origin?: "conversation" | "instructor-notes"; sourceId?: string; conceptId?: string | null; questionContext?: string; groundTruth?: string; teachingComplete?: boolean; independentTopicFact?: boolean }
export interface Understanding { status: Level; evidence: string; sourceId?: string; reason?: string; criteriaMet?: string[]; belief?: string; beliefAccuracy?: LearnedFact["review"]; groundTruth?: string; learnedFacts?: LearnedFact[]; taughtGuideFactIds?: string[] }
export type KnowledgeState = Record<string, Understanding>;
export interface ToolResult { summary: string; error?: string; state?: KnowledgeState }
export const LABELS: Record<Concept, string> = {
  gradient_direction: "Gradient direction", learning_rate: "Learning rate", convergence: "Convergence",
};
export function initialKnowledge(): KnowledgeState {
  return {
    gradient_direction: { status: "unknown", evidence: "No explanation yet." },
    learning_rate: { status: "unknown", evidence: "No explanation yet." },
    convergence: { status: "unknown", evidence: "No explanation yet." },
  };
}
const normalize = (s: string) => s.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9.\-]+/g, " ").trim();

/** Conservative, English-only prototype rubric. Check the observed human turn,
 * never a model's self-reported confidence. This is a learning simulation,
 * not a general semantic grader; see README for supported examples/limits. */
export function assessEvidence(concept: Concept, text: string): { checks: number; misconception: boolean } {
  const s = normalize(text);
  if (concept === "gradient_direction") {
    const up = /(?:gradient (?:points? |is |gives? |shows? )?(?:in |toward |towards |the |direction of |of )*(?:steepest |fastest )?(?:increase|ascent|uphill))|(?:gradient.{0,40}steepest (?:increase|ascent))/.test(s);
    const down = /(?:negative gradient|opposite (?:to )?(?:the )?gradient|subtract (?:the )?(?:learning rate times (?:the )?)?gradient).{0,80}(?:decrease|downhill|descen|reduce|lower)/.test(s);
    const misconception = /(?<!negative )gradient points? (?:toward|towards|to|at) (?:the )?(?:minimum|lowest)/.test(s)
      || /(?:negative gradient.{0,30}(?:increase|uphill)|gradient (?:does not|doesn't|never) point.{0,30}(?:increase|uphill)|negative gradient.{0,25}(?:does not|doesn't|never).{0,25}(?:decrease|downhill|lower))/.test(s);
    return { checks: Number(up) + Number(down), misconception };
  }
  if (concept === "learning_rate") {
    const step = /learning rate.{0,70}(?:step size|size of (?:each |the )?step|scales? (?:the )?(?:gradient|update))/.test(s);
    const tradeoff = /(?:large|big|high).{0,50}(?:overshoot|diverge|oscillat)/.test(s) && /(?:small|low).{0,50}(?:slow|tiny)/.test(s);
    const misconception = /(?:larger|bigger|higher).{0,20}(?:always|guarantees).{0,30}(?:better|converg|faster)|learning rate.{0,20}(?:does not|doesn't|never).{0,20}(?:step size|scales)/.test(s);
    return { checks: Number(step) + Number(tradeoff), misconception };
  }
  const settling = /(?:converg|convergence).{0,70}(?:loss|updates?|steps?).{0,40}(?:stabili|stop changing|small|settle|level)/.test(s);
  const caveat = /(?:small|zero|tiny).{0,35}gradient.{0,80}(?:not|doesn't|does not|isn't|is not).{0,35}(?:guarantee|global|minimum)/.test(s);
  const misconception = /convergence.{0,30}(?:always|guarantees).{0,30}global minimum/.test(s);
  return { checks: Number(settling) + Number(caveat), misconception };
}

export class KnowledgeTracker {
  private state = initialKnowledge();
  private humanTurns = new Map<string, string>();
  constructor(private onChange?: (state: KnowledgeState) => void) {}
  snapshot(): KnowledgeState { return structuredClone(this.state); }
  observeHuman(id: string, text: string) { if (text.trim()) this.humanTurns.set(id, text); }
  reset() { this.state = initialKnowledge(); this.humanTurns.clear(); this.onChange?.(this.snapshot()); }
  update(args: Record<string, unknown>): ToolResult {
    const { concept, evidence } = args;
    const requestedStatus = args.status;
    const reject = (error: string, summary: string): ToolResult => ({ error, summary, state: this.snapshot() });
    if (!CONCEPTS.includes(concept as Concept) || (requestedStatus !== undefined && !LEVELS.includes(requestedStatus as Level)) || typeof evidence !== "string" || evidence.length > 2000) {
      return reject("invalid_arguments", "Use a valid concept and a short verbatim quote from the human.");
    }
    const quote = normalize(evidence);
    const source = [...this.humanTurns].reverse().find(([, text]) => quote.length >= 15 && normalize(text).includes(quote));
    if (!source) return reject("ungrounded_evidence", "That quote is not in a transcribed human turn yet. Ask for an explanation or retry after transcription arrives.");
    const c = concept as Concept;
    const result = assessEvidence(c, source[1]);
    // The public tool supplies concept + evidence only. Derive the label from
    // observed evidence rather than asking the voice model to self-grade.
    // Explicit labels remain supported for internal transition tests/fixtures
    // and must pass the exact same evidence gates below.
    const status = requestedStatus ?? (result.misconception ? "misunderstood" : result.checks >= 2 ? "understood" : result.checks === 1 ? "partial" : null);
    if (!status) return reject("insufficient_evidence", "No clear conceptual evidence yet. Ask for an explanation or an example.");
    if (status === "understood" && (result.checks < 2 || result.misconception)) {
      return reject("insufficient_evidence", "Understanding needs both rubric points and no conflicting misconception. Ask a short follow-up instead.");
    }
    if (status === "partial" && (result.checks < 1 || result.misconception)) return reject("insufficient_evidence", "No clear correct explanation for this concept yet.");
    if (status === "misunderstood" && !result.misconception) return reject("insufficient_evidence", "The observed turn does not establish this misconception.");
    if (status === "unknown") return reject("invalid_transition", "Use a new lesson to reset. Unknown cannot overwrite observed evidence.");
    this.state = { ...this.state, [c]: { status: status as Level, evidence: source[1], sourceId: source[0] } };
    this.onChange?.(this.snapshot());
    return { summary: `${LABELS[c]} is now ${status}. Continue as Maya; do not read the dashboard aloud.`, state: this.snapshot() };
  }
}
