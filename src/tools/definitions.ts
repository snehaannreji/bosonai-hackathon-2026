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

export function lessonToolDefinitions(_concepts: { id: string; label: string }[]) {
  return [{ type: "function", name: "update_understanding",
    description: "Call after every human statement that teaches or asserts a topic fact, even if it is only one short sentence, and after an answer to your direct question. Quote the human's exact words. Always set concept to topic_fact; the app independently checks which lesson concepts the explanation supports. Do not choose a status yourself. Reassurance alone is not evidence. If rejected, ask a natural follow-up rather than looping. Never narrate this action or read tool details aloud.",
    parameters: { type: "object", properties: {
      concept: { type: "string", enum: ["topic_fact"], description: "Always use topic_fact; generated lesson concepts are assessed independently." },
      evidence: { type: "string", description: "A verbatim quote from the human's explanation." },
    }, required: ["concept", "evidence"], additionalProperties: false },
  }];
}
