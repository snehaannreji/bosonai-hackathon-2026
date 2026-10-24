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

export function lessonToolDefinitions(_concepts: { id: string; label: string }[]) {
  return [{ type: "function", name: "update_understanding",
    description: "Call after every human statement that teaches or asserts a topic fact, even if it is only one short sentence with no explanation, and after an answer to your direct question. The student begins with a blank knowledge state: never follow a lesson-concept checklist or prompt the teacher to cover generated concepts. For every update, set concept to topic_fact and quote the human's exact words. The app records a clear factual statement as taught even if the assessor finds no substantial explanation or concept match; factual accuracy remains separately assessed and can be unverified. The instructor check privately matches taught facts to generated concepts and notes when applicable; you do not select a concept. For yes/no, the app attaches your last question and stores the answer as an unverified belief. Do not choose a status yourself or announce tool calls.",
    parameters: { type: "object", properties: {
      concept: { type: "string", enum: ["topic_fact"], description: "Always use topic_fact; generated concepts are private assessment categories." },
      evidence: { type: "string", description: "A verbatim quote from the human's explanation." },
    }, required: ["concept", "evidence"], additionalProperties: false },
  }];
}
