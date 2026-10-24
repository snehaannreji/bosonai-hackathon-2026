import type { KnowledgeState, ToolResult } from "./knowledge";
import { CRITERIA_IDS, type EvidenceAssessor, type HumanTurn, type LessonDefinition } from "./lesson";

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const isBareConfirmation = (text: string) => /^(?:yes|right|correct|exactly|good job|you understand(?: now)?|you got it|trust me|that is correct|you are correct)(?: (?:yes|right|correct|exactly|now|trust me|that is correct|you understand|you got it))*$/.test(normalize(text));

export function initialTopicKnowledge(lesson: LessonDefinition | null): KnowledgeState {
  if (!lesson) return {};
  return Object.fromEntries(lesson.concepts.map(concept => {
    const status = lesson.familiarity >= 75
      ? "understood"
      : lesson.familiarity >= 20
        ? "partial"
        : concept.initialBelief ? "misunderstood" : "unknown";
    return [concept.id, {
      status,
      evidence: `Starting familiarity set to ${lesson.familiarity}% for this simulation; not independently assessed.${concept.initialBelief ? ` Alex’s starting hunch: ${concept.initialBelief}` : ""}`,
    }];
  }));
}

/** Concept-independent evidence gates plus a separate, topic-aware assessment.
 * Alex cannot self-award mastery or invent quotes from unobserved human turns. */
export class TopicKnowledgeTracker {
  private state: KnowledgeState;
  private turns = new Map<string, { text: string; questionContext?: string }>();
  private revision = 0;
  private cache = new Map<string, ReturnType<EvidenceAssessor>>();
  constructor(private lesson: LessonDefinition, private assess: EvidenceAssessor, private onChange?: (state: KnowledgeState) => void) { this.state = initialTopicKnowledge(lesson); }
  snapshot(): KnowledgeState { return structuredClone(this.state); }
  observeHuman(id: string, text: string, questionContext?: string) {
    if (text.trim() && this.turns.get(id)?.text !== text) {
      this.turns.set(id, { text: text.slice(0, 8000), questionContext: questionContext?.slice(0, 500) });
      this.revision++;
    }
  }
  reset() { this.revision++; this.state = initialTopicKnowledge(this.lesson); this.turns.clear(); this.cache.clear(); this.onChange?.(this.snapshot()); }
  async update(args: Record<string, unknown>): Promise<ToolResult> {
    const reject = (error: string, summary: string): ToolResult => ({ error, summary, state: this.snapshot() });
    const concept = this.lesson.concepts.find(item => item.id === args.concept);
    if (!concept || typeof args.evidence !== "string" || args.evidence.length > 2000) return reject("invalid_arguments", "Use a concept ID from this lesson and a short verbatim quote from the human.");
    const quote = normalize(args.evidence);
    const source = [...this.turns].reverse().find(([, turn]) =>
      (quote.length >= 8 && normalize(turn.text).includes(quote))
      || (isBareYesNo(turn.text) && quote === normalize(turn.text) && Boolean(turn.questionContext)),
    );
    if (!source) return reject("ungrounded_evidence", "That quote is not in the human transcript yet. Ask a follow-up, or retry after transcription arrives.");
    const [sourceId, sourceTurn] = source;
    if (isBareYesNo(sourceTurn.text) && sourceTurn.questionContext) {
      const current = this.state[concept.id];
      const answer = normalize(sourceTurn.text);
      const belief = `Alex asked “${sourceTurn.questionContext}” and the teacher answered “${sourceTurn.text.trim()}.” This is an unverified working belief.`;
      this.state = {
        ...this.state,
        [concept.id]: { ...current, evidence: sourceTurn.text, sourceId, belief },
      };
      this.onChange?.(this.snapshot());
      return {
        summary: this.lesson.familiarity < 25
          ? `Record the teacher's ${answer} as your current working belief for ${concept.label}; it is not independently verified. Respond naturally and ask a brief follow-up.`
          : `Record the teacher's ${answer} to your question about ${concept.label}. Treat it as a claim, not proof; respond based on your familiarity and ask a follow-up if needed.`,
        state: this.snapshot(),
      };
    }
    if (isBareConfirmation(sourceTurn.text)) return reject("insufficient_evidence", "Reassurance is not an explanation. Ask for the idea, reasoning, or an example.");
    const belief = this.lesson.familiarity < 25
      ? `Current working belief from teacher: ${sourceTurn.text.slice(0, 500)} (not independently verified).`
      : undefined;
    if (belief) {
      this.state = { ...this.state, [concept.id]: { ...this.state[concept.id], belief } };
      this.onChange?.(this.snapshot());
    }
    const revision = this.revision;
    const turns: HumanTurn[] = [...this.turns].slice(-8).map(([id, turn]) => ({ id, text: turn.text.slice(0, 2000) }));
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
    this.state = {
      ...this.state,
      [concept.id]: {
        ...this.state[concept.id],
        status,
        evidence: sourceTurn.text,
        sourceId,
        reason: result.reason,
        criteriaMet: matched,
      },
    };
    this.onChange?.(this.snapshot());
    return { summary: `${concept.label} is now ${status}. ${result.reason} Continue as Alex, with a short question or teach-back; do not announce the dashboard update.`, state: this.snapshot() };
  }

}

export const isBareYesNo = (text: string) => /^(?:yes|yeah|yep|no|nope|nah|right|exactly|correct|that's right|that is right|not really|i think so)$/i.test(text.trim().replace(/[.!?]+$/u, ""));

/** Local UI fixture only. It does not judge factual correctness. */
export const mockAssessor: EvidenceAssessor = async ({ quote }) => ({ matchedCriteria: quote.length >= 80 ? [...CRITERIA_IDS] : quote.length >= 25 ? [CRITERIA_IDS[0]] : [], misconception: false, reason: "Simulated evidence check in local mock mode." });
