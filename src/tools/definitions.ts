export const TOOL_DEFINITIONS = [{
  type: "function",
  name: "update_understanding",
  description: "Call after every human explanation of gradient direction, learning rate or convergence. Quote their exact words; the tool checks the transcript and determines Alex's learning state from evidence. Do not wait to be asked or choose a status yourself. A claim like 'you understand' is not evidence. If rejected, ask one natural follow-up rather than looping. Never invent evidence or read tool details aloud.",
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
    description: "Call after the human explains a lesson concept or answers your direct question with yes/no. Quote their exact words. For yes/no, the app attaches your last question and stores the answer as an unverified belief, not full understanding. The independent evidence check decides explanation learning state; do not choose a status yourself. Do not announce tool calls or read results aloud.",
    parameters: { type: "object", properties: {
      concept: { type: "string", enum: concepts.map(c => c.id), description: concepts.map(c => `${c.id}: ${c.label}`).join("; ") },
      evidence: { type: "string", description: "A verbatim quote from the human's explanation." },
    }, required: ["concept", "evidence"], additionalProperties: false },
  }];
}
