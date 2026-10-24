export const TOOL_DEFINITIONS = [{
  type: "function",
  name: "update_understanding",
  description: "Call after every human explanation of gradient direction, learning rate or convergence. Quote their exact words; the tool checks the transcript and determines the student's learning state from evidence. Do not wait to be asked or choose a status yourself. A claim like 'you understand' is not evidence. If rejected, ask one natural follow-up rather than looping. Never invent evidence or read tool details aloud.",
  parameters: {
    type: "object",
    properties: {
      concept: { type: "string", enum: ["gradient_direction", "learning_rate", "convergence"] },
      evidence: { type: "string", description: "Verbatim quote from a human explanation, not your own reply." },
    },
    required: ["concept", "evidence"],
    additionalProperties: false,
  },
}] as const;

export function lessonToolDefinitions(concepts: { id: string; label: string }[]) {
  return [{ type: "function", name: "update_understanding",
    description: "Silently call after the human explains a lesson concept, before you speak. Quote their exact words. An independent evidence check decides the learning state; do not choose a status yourself. Reassurance alone is not evidence. If rejected, ask a natural follow-up rather than looping. Never narrate this action or say 'let me update my understanding'; after the result, respond naturally without reading tool details aloud.",
    parameters: { type: "object", properties: {
      concept: { type: "string", enum: concepts.map(c => c.id), description: concepts.map(c => `${c.id}: ${c.label}`).join("; ") },
      evidence: { type: "string", description: "A verbatim quote from the human's explanation." },
    }, required: ["concept", "evidence"], additionalProperties: false },
  }];
}
