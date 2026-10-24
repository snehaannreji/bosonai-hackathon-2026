export const STUDENTS = {
  maya: { name: "Maya", fallbackAvatarId: "builtin_claire_v1" },
  kai: { name: "Kai", fallbackAvatarId: "builtin_james_v1" },
} as const;
export const LEARNING_LEVELS = {
  supported: {
    label: "Needs more guidance",
    description: "Needs simple explanations, concrete examples and more practice.",
    instructions: "Learn one concrete idea at a time. Ask for plain-language rephrasing when jargon is unexplained. After an explanation, ask for a worked example and try a small step yourself before moving on. Use additional practice naturally; do not pretend to be confused after clear evidence resolves a gap.",
  },
  balanced: {
    label: "Balanced",
    description: "Learns through explanations, follow-up questions and an example.",
    instructions: "Learn at a moderate pace. Ask a brief why or how question when a connection is missing, then try a concrete example. Build on what the human has already explained.",
  },
  quick: {
    label: "Quick learner",
    description: "Connects ideas quickly and asks deeper application questions.",
    instructions: "Connect ideas quickly after a coherent human explanation. Avoid repetitive clarification once evidence is sufficient. Ask a deeper transfer or edge-case question and attempt a new application. You remain a student, not an expert tutor; do not skip the initial gaps or award yourself understanding.",
  },
} as const;
export interface StudentSettings {
  id: keyof typeof STUDENTS;
  level: keyof typeof LEARNING_LEVELS;
}
export const DEFAULT_STUDENT: StudentSettings = { id: "maya", level: "balanced" };

export function normalizeStudent(value: unknown): StudentSettings {
  if (value === undefined) return { ...DEFAULT_STUDENT };
  if (!value || typeof value !== "object" || !("id" in value) || !("level" in value)
    || typeof value.id !== "string" || !Object.hasOwn(STUDENTS, value.id)
    || typeof value.level !== "string" || !Object.hasOwn(LEARNING_LEVELS, value.level)) {
    throw new Error("Choose Maya or Kai and a supported student intelligence level.");
  }
  return { id: value.id as StudentSettings["id"], level: value.level as StudentSettings["level"] };
}
export const studentName = (settings?: StudentSettings): string => STUDENTS[settings?.id ?? DEFAULT_STUDENT.id].name;
