import { MISCONCEPTION_FREQUENCY, type StudentSettings } from "./student";

/** Stable content sampling keeps the offline fixture occasional without a turn-number pattern. */
export function misconceptionKey(text: string, student: StudentSettings): string {
  let hash = student.id === "maya" ? 2166136261 : 2246822519;
  for (const character of text.normalize("NFKC").toLocaleLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `${student.id}-${(hash >>> 0).toString(36)}`;
}

export function shouldSurfaceMisconception(text: string, student: StudentSettings): boolean {
  if (text.trim().length < 35) return false;
  const bucket = Number.parseInt(misconceptionKey(text, student).split("-")[1], 36) % 10_000;
  return bucket < MISCONCEPTION_FREQUENCY[student.level] * 10_000;
}

export function soundsLikeCorrection(text: string): boolean {
  return /\b(no|not|actually|instead|depends|however|but|unless|incorrect|wrong|correction|rather)\b/iu.test(text);
}
