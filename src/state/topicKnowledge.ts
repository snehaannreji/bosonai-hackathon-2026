import type { KnowledgeState, LearnedFact, ToolResult } from "./knowledge";
import { CRITERIA_IDS, type EvidenceAssessor, type HumanTurn, type LessonDefinition } from "./lesson";
import { studentName } from "./student";

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const isBareConfirmation = (text: string) => /^(?:yes|right|correct|exactly|good job|you understand(?: now)?|you got it|trust me|that is correct|you are correct)(?: (?:yes|right|correct|exactly|now|trust me|that is correct|you understand|you got it))*$/.test(normalize(text));
const isDeclarativeFact = (text: string) => {
  const trimmed = text.trim();
  const words = normalize(trimmed).split(" ").filter(Boolean);
  return words.length >= 4
    && !/[?？]/u.test(trimmed)
    && !/^(?:what|who|when|where|why|how|can|could|would|do|does|did|is|are|was|were|will|should|please|tell|explain|describe|teach|show)\b/iu.test(trimmed);
};
const isShortAnswerToQuestion = (text: string, questionContext?: string) => {
  if (!questionContext || /[?？]/u.test(text)) return false;
  const answer = normalize(text);
  const words = answer.split(" ").filter(Boolean);
  return words.length >= 2
    && words.length <= 8
    && !/^(?:i don t know|i do not know|not sure|no idea|i can t remember|i cannot remember)$/u.test(answer);
};
const formatLearnedFact = (text: string, questionContext?: string) =>
  questionContext ? `Q: ${questionContext}\nA: ${text.trim()}` : text;

export function initialTopicKnowledge(lesson: LessonDefinition | null): KnowledgeState {
  return Object.fromEntries((lesson?.concepts ?? []).map(concept => [concept.id, {
    status: concept.initialBelief ? "misunderstood" : "unknown",
    evidence: concept.initialBelief ? `${lesson?.studentName ?? studentName(lesson?.student)}’s starting hunch: ${concept.initialBelief}` : "No facts taught yet.",
  }]));
}

/** Concept-independent evidence gates plus a separate, topic-aware assessment.
 * The student cannot self-award mastery or invent quotes from unobserved human turns. */
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
    const topicFactUpdate = args.concept === "topic_fact";
    const concept = topicFactUpdate
      ? { id: "topic_fact", label: "Topic facts", goal: `Record facts taught about ${this.lesson.topic}.`, criteria: ["Record the fact taught.", "Record how the student understands it."] as [string, string], initialBelief: null }
      : this.lesson.concepts.find(item => item.id === args.concept);
    if (!concept || typeof args.evidence !== "string" || args.evidence.length > 2000) return reject("invalid_arguments", "Use topic_fact and a short verbatim quote from the human.");
    const quote = normalize(args.evidence);
    const source = [...this.turns].reverse().find(([, turn]) =>
      (quote.length >= 8 && normalize(turn.text).includes(quote))
      || (isBareYesNo(turn.text) && quote === normalize(turn.text) && Boolean(turn.questionContext)),
    );
    if (!source) return reject("ungrounded_evidence", "That quote is not in the human transcript yet. Ask a follow-up, or retry after transcription arrives.");
    const [sourceId, sourceTurn] = source;
    if (isBareYesNo(sourceTurn.text) && sourceTurn.questionContext) {
      const stateKey = topicFactUpdate ? "taught_facts" : concept.id;
      const current = this.state[stateKey] ?? { status: "unknown" as const, evidence: "No facts taught yet." };
      const answer = normalize(sourceTurn.text);
      const name = this.lesson.studentName ?? studentName(this.lesson.student);
      const belief = `${name} asked “${sourceTurn.questionContext}” and the teacher answered “${sourceTurn.text.trim()}.” This is an unverified working belief.`;
      const fact = makeLearnedFact(`turn:${sourceId}`, `Q: ${sourceTurn.questionContext}\nA: ${sourceTurn.text.trim()}`, "unverified", undefined, { origin: "conversation", sourceId, conceptId: topicFactUpdate ? null : concept.id });
      this.state = {
        ...this.state,
        [stateKey]: { ...current, evidence: sourceTurn.text, sourceId, belief, beliefAccuracy: "unverified", learnedFacts: appendLearnedFacts(current.learnedFacts, [fact]) },
      };
      this.onChange?.(this.snapshot());
      return {
        summary: this.lesson.familiarity < 25
          ? `Record the teacher's ${answer} as your current working belief; it is not independently verified. Respond naturally and ask a brief follow-up.`
          : `Record the teacher's ${answer} as a claim, not proof; respond based on facts established in this conversation and ask a follow-up if needed.`,
        state: this.snapshot(),
      };
    }
    if (isBareConfirmation(sourceTurn.text)) return reject("insufficient_evidence", "Reassurance is not an explanation. Ask for the idea, reasoning, or an example.");
    const belief = this.lesson.familiarity < 25
      ? `${sourceTurn.questionContext ? `In response to “${sourceTurn.questionContext}”, ` : ""}current working belief from teacher: ${sourceTurn.text.slice(0, 500)}`
      : undefined;
    if (belief) {
      const beliefKey = topicFactUpdate ? "taught_facts" : concept.id;
      const current = this.state[beliefKey] ?? { status: "unknown" as const, evidence: "No facts taught yet." };
      this.state = { ...this.state, [beliefKey]: { ...current, belief } };
      this.onChange?.(this.snapshot());
    }
    const revision = this.revision;
    const turns: HumanTurn[] = [...this.turns].slice(-8).map(([id, turn]) => {
      const context = turn.questionContext ? `Student asked: ${turn.questionContext}\nTeacher answered: ` : "";
      return { id, text: context + turn.text.slice(0, Math.max(0, 2000 - context.length)) };
    });
    const cacheKey = JSON.stringify([concept.id, turns]);
    let assessment = this.cache.get(cacheKey);
    if (!assessment) { assessment = this.assess({ concept, lessonConcepts: this.lesson.concepts, turns, quote: args.evidence }); this.cache.set(cacheKey, assessment); }
    let result;
    try { result = await assessment; }
    catch {
      this.cache.delete(cacheKey);
      const stateKey = topicFactUpdate ? "taught_facts" : concept.id;
      const current = this.state[stateKey] ?? { status: "unknown" as const, evidence: "No facts taught yet." };
      const fact = makeLearnedFact(`turn:${sourceId}`, sourceTurn.text, "unverified", undefined, { origin: "conversation", sourceId, conceptId: topicFactUpdate ? null : concept.id });
      this.state = { ...this.state, [stateKey]: { ...current, evidence: sourceTurn.text, sourceId, learnedFacts: appendLearnedFacts(current.learnedFacts, [fact]) } };
      this.onChange?.(this.snapshot());
      return reject("assessment_unavailable", "The evidence check is unavailable. Keep learning and try the update again next turn.");
    }
    if (revision !== this.revision) return reject("stale_evidence", "A newer explanation arrived during the check. Use the updated human transcript next turn.");
    const matchedConcepts = topicFactUpdate ? (result.matchedConcepts ?? []).filter(match =>
      this.lesson.concepts.some(item => item.id === match.conceptId)
      && match.matchedCriteria.some(id => (CRITERIA_IDS as readonly string[]).includes(id)),
    ) : [];
    const matched = [...new Set(result.matchedCriteria)].filter(id => (CRITERIA_IDS as readonly string[]).includes(id));
    const status = topicFactUpdate ? null : result.misconception ? "misunderstood" : matched.length >= 2 ? "understood" : matched.length === 1 ? "partial" : null;
    const factReview = result.misconception || result.factAccuracy === "incorrect"
      ? "misconception"
      : result.factAccuracy === "accurate" ? "accurate" : "unverified";
    const shortAnswer = topicFactUpdate && isShortAnswerToQuestion(sourceTurn.text, sourceTurn.questionContext);
    const topicFactTaught = Boolean(result.topicFactTaught || (topicFactUpdate && (isDeclarativeFact(sourceTurn.text) || shortAnswer)));
    const factText = formatLearnedFact(sourceTurn.text, sourceTurn.questionContext);
    const factMatchesConcept = matchedConcepts.some(match => match.matchedCriteria.length > 0);
    const fact = makeLearnedFact(`turn:${sourceId}`, factText, factReview, result.misconception ? result.groundTruth : undefined, {
      origin: "conversation",
      sourceId,
      conceptId: topicFactUpdate ? null : concept.id,
      questionContext: sourceTurn.questionContext,
      teachingComplete: Boolean(status || topicFactTaught || result.independentFactTaught || result.taughtGuideFacts?.length || result.matchedConcepts?.some(match => match.matchedCriteria.length > 0)),
      independentTopicFact: Boolean(topicFactUpdate && topicFactTaught && !result.taughtGuideFacts?.length && !factMatchesConcept),
    });
    const taughtNotes = (result.taughtGuideFacts ?? []).map(guideFact =>
      makeLearnedFact(`note:${guideFact.id}`, guideFact.text, factReview, result.misconception ? result.groundTruth : undefined, {
        origin: "instructor-notes",
        sourceId,
        conceptId: null,
        teachingComplete: true,
      }),
    );
    const stateKey = topicFactUpdate ? "taught_facts" : concept.id;
    const current = this.state[stateKey] ?? { status: "unknown" as const, evidence: "No facts taught yet." };
    const taughtGuideFactIds = [...new Set([...(current.taughtGuideFactIds ?? []), ...(result.taughtGuideFactIds ?? [])])];
    this.state = {
      ...this.state,
      [stateKey]: {
        ...current,
        evidence: factText,
        sourceId,
        learnedFacts: appendLearnedFacts(current.learnedFacts, [fact, ...taughtNotes]),
        taughtGuideFactIds,
        ...(belief ? { beliefAccuracy: factReview } : {}),
        ...(result.misconception && result.groundTruth ? { groundTruth: result.groundTruth.slice(0, 500) } : {}),
      },
    };
    if (topicFactUpdate) {
      for (const match of matchedConcepts) {
        const matchedConcept = this.lesson.concepts.find(item => item.id === match.conceptId);
        if (!matchedConcept) continue;
        const criteria = [...new Set(match.matchedCriteria)].filter(id => (CRITERIA_IDS as readonly string[]).includes(id));
        const matchedStatus = result.misconception ? "misunderstood" : criteria.length >= 2 ? "understood" : criteria.length === 1 ? "partial" : null;
        if (!matchedStatus) continue;
        const previous = this.state[matchedConcept.id];
        this.state[matchedConcept.id] = {
          ...previous,
          status: matchedStatus,
          evidence: factText,
          sourceId,
          reason: result.reason,
          criteriaMet: criteria,
          ...(result.misconception && result.groundTruth ? { groundTruth: result.groundTruth.slice(0, 500) } : {}),
        };
      }
    }
    this.onChange?.(this.snapshot());
    if (topicFactUpdate && (topicFactTaught || taughtNotes.length > 0 || result.independentFactTaught || matchedConcepts.some(match => match.matchedCriteria.length > 0))) {
      const updatedConceptLabels = matchedConcepts.map(match => this.lesson.concepts.find(item => item.id === match.conceptId)?.label).filter(Boolean);
      const matchedSummary = updatedConceptLabels.length ? ` Matched lesson concepts: ${updatedConceptLabels.join(", ")}.` : "";
      return { summary: `Recorded the stated fact${taughtNotes.length ? ` and covered ${taughtNotes.length} instructor note fact${taughtNotes.length === 1 ? "" : "s"}` : ""}.${matchedSummary} Its accuracy is ${factReview === "unverified" ? "unverified" : factReview === "accurate" ? "instructor-checked" : "flagged for instructor review"}. Respond naturally to the fact and continue the conversation in your own words.`, state: this.snapshot() };
    }
    if (!status && taughtNotes.length > 0) {
      return { summary: `${taughtNotes.length} instructor note fact${taughtNotes.length === 1 ? " was" : "s were"} covered. The broader concept has not yet met its learning criteria.`, state: this.snapshot() };
    }
    if (!status && result.independentFactTaught) {
      return { summary: `An independent topic fact was recorded as taught. ${concept.label} remains ${current.status} because its lesson criteria were not met.`, state: this.snapshot() };
    }
    if (!status) return reject("insufficient_evidence", "No substantive explanation for this concept yet.");
    this.state = {
      ...this.state,
      [concept.id]: {
        ...this.state[concept.id],
        status,
        reason: result.reason,
        groundTruth: result.misconception ? result.groundTruth?.slice(0, 500) || undefined : undefined,
        criteriaMet: matched,
      },
    };
    this.onChange?.(this.snapshot());
    return { summary: `${concept.label} is now ${status}. ${result.reason} Continue as ${this.lesson.studentName ?? studentName(this.lesson.student)}, with a short question or teach-back; do not announce the dashboard update.`, state: this.snapshot() };
  }

}

export const isBareYesNo = (text: string) => /^(?:yes|yeah|yep|no|nope|nah|right|exactly|correct|that's right|that is right|not really|i think so)$/i.test(text.trim().replace(/[.!?]+$/u, ""));

function makeLearnedFact(
  id: string,
  text: string,
  review: LearnedFact["review"],
  groundTruth?: string,
  metadata: Pick<LearnedFact, "origin" | "sourceId" | "conceptId" | "questionContext" | "teachingComplete" | "independentTopicFact"> = {},
): LearnedFact {
  return { id, text, review, ...metadata, ...(review === "misconception" && groundTruth ? { groundTruth: groundTruth.slice(0, 500) } : {}) };
}

function appendLearnedFacts(facts: LearnedFact[] = [], additions: LearnedFact[]): LearnedFact[] {
  const updated = [...facts];
  for (const fact of additions) {
    const index = updated.findIndex(existing => existing.id === fact.id);
    if (index < 0) updated.push(fact);
    else updated[index] = fact;
  }
  return updated;
}

/** Local UI fixture only. It does not judge factual correctness. */
export const mockAssessor: EvidenceAssessor = async ({ quote, concept, lessonConcepts = [] }) => ({
  matchedCriteria: concept.id === "topic_fact" ? [] : quote.length >= 80 ? [...CRITERIA_IDS] : quote.length >= 25 ? [CRITERIA_IDS[0]] : [],
  matchedConcepts: concept.id === "topic_fact"
    ? lessonConcepts.map(item => ({ conceptId: item.id, matchedCriteria: quote.length >= 80 ? [...CRITERIA_IDS] : quote.length >= 25 ? [CRITERIA_IDS[0]] : [] }))
    : [],
  misconception: false,
  reason: "Simulated evidence check in local mock mode.",
  factAccuracy: "uncertain",
  independentFactTaught: quote.length >= 25,
  topicFactTaught: quote.length >= 25,
});

/** Keep instructor-only assessment details out of the student's model context. */
export function studentToolFeedback(lesson: LessonDefinition, result: ToolResult): string {
  if (result.error === "ungrounded_evidence" || result.error === "invalid_arguments") {
    return "The quoted words are not confirmed in the human's transcript. Do not claim they were recorded or learned. Stay in character and ask the human to clarify or repeat.";
  }
  if (lesson.familiarity < 25) {
    return "You are a beginner. Treat the human's explanation as your provisional working belief, even if it seems surprising. Do not correct, fact-check, contradict, or reveal any counterclaim. After acknowledging a taught fact, end your reply with one brief, specific open-ended follow-up question about that fact; do not repeat a generic opener. The independent instructor check is private; do not mention or use its result.";
  }
  if (result.error) {
    return "The learning update did not succeed. The independent instructor check is private; do not reveal or cite its result. Respond in character based on your own starting familiarity and ask one natural follow-up.";
  }
  return "The independent instructor check is private; do not reveal or cite its result. Respond naturally to the taught fact and end with one brief, specific open-ended follow-up question about it. Do not repeat a generic opener.";
}
