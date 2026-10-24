import type { KnowledgeState, ToolResult } from "./knowledge";
import { CRITERIA_IDS, type EvidenceAssessor, type HumanTurn, type LessonDefinition } from "./lesson";

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const isBareConfirmation = (text: string) => /^(?:yes|right|correct|exactly|good job|you understand(?: now)?|you got it|trust me|that is correct|you are correct)(?: (?:yes|right|correct|exactly|now|trust me|that is correct|you understand|you got it))*$/.test(normalize(text));

export function initialTopicKnowledge(lesson: LessonDefinition | null): KnowledgeState {
  return Object.fromEntries((lesson?.concepts ?? []).map(concept => [concept.id, {
    status: concept.initialBelief ? "misunderstood" : "unknown",
    evidence: concept.initialBelief ? `Alex’s starting hunch: ${concept.initialBelief}` : "Waiting for your explanation.",
  }]));
}

/** Concept-independent evidence gates plus a separate, topic-aware assessment.
 * Alex cannot self-award mastery or invent quotes from unobserved human turns. */
export class TopicKnowledgeTracker {
  private state: KnowledgeState;
  private turns = new Map<string, string>();
  private revision = 0;
  private cache = new Map<string, ReturnType<EvidenceAssessor>>();
  constructor(private lesson: LessonDefinition, private assess: EvidenceAssessor, private onChange?: (state: KnowledgeState) => void) { this.state = initialTopicKnowledge(lesson); }
  snapshot(): KnowledgeState { return structuredClone(this.state); }
  observeHuman(id: string, text: string) {
    if (text.trim() && this.turns.get(id) !== text) { this.turns.set(id, text.slice(0, 8000)); this.revision++; }
  }
  reset() { this.revision++; this.state = initialTopicKnowledge(this.lesson); this.turns.clear(); this.cache.clear(); this.onChange?.(this.snapshot()); }
  async update(args: Record<string, unknown>): Promise<ToolResult> {
    const reject = (error: string, summary: string): ToolResult => ({ error, summary, state: this.snapshot() });
    const concept = this.lesson.concepts.find(item => item.id === args.concept);
    if (!concept || typeof args.evidence !== "string" || args.evidence.length > 2000) return reject("invalid_arguments", "Use a concept ID from this lesson and a short verbatim quote from the human.");
    const quote = normalize(args.evidence);
    const source = [...this.turns].reverse().find(([, text]) => quote.length >= 8 && normalize(text).includes(quote));
    if (!source) return reject("ungrounded_evidence", "That quote is not in the human transcript yet. Ask a follow-up, or retry after transcription arrives.");
    if (isBareConfirmation(source[1])) return reject("insufficient_evidence", "Reassurance is not an explanation. Ask for the idea, reasoning, or an example.");
    const revision = this.revision;
    const turns: HumanTurn[] = [...this.turns].slice(-8).map(([id, text]) => ({ id, text: text.slice(0, 2000) }));
    const cacheKey = JSON.stringify([concept.id, turns]);
    let assessment = this.cache.get(cacheKey);
    if (!assessment) { assessment = this.assess({ concept, turns, quote: args.evidence }); this.cache.set(cacheKey, assessment); }
    let result;
    try { result = await assessment; }
    catch { this.cache.delete(cacheKey); return reject("assessment_unavailable", "The evidence check is unavailable. Keep learning and try the update again next turn."); }
    if (revision !== this.revision) return reject("stale_evidence", "A newer explanation arrived during the check. Use the updated human transcript next turn.");
    const matched = [...new Set(result.matchedCriteria)].filter(id => (CRITERIA_IDS as readonly string[]).includes(id));
    const status = result.misconception ? "misunderstood" : matched.length >= 2 ? "understood" : matched.length === 1 ? "partial" : null;
    if (!status) return reject("insufficient_evidence", result.reason || "No substantive explanation for this concept yet.");
    this.state = { ...this.state, [concept.id]: { status, evidence: source[1], sourceId: source[0], reason: result.reason, criteriaMet: matched } };
    this.onChange?.(this.snapshot());
    return { summary: `${concept.label} is now ${status}. ${result.reason} Continue as Alex, with a short question or teach-back; do not announce the dashboard update.`, state: this.snapshot() };
  }
}

/** Local UI fixture only. It does not judge factual correctness. */
export const mockAssessor: EvidenceAssessor = async ({ quote }) => ({ matchedCriteria: quote.length >= 80 ? [...CRITERIA_IDS] : quote.length >= 25 ? [CRITERIA_IDS[0]] : [], misconception: false, reason: "Simulated evidence check in local mock mode." });
