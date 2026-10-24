import type { SpeechEmotion } from "./speechTags";

export interface EmotionAcknowledgment {
  type: "client.emotion_acknowledgment";
  emotion: "anger" | "sadness";
  acknowledged: boolean;
  teacherTranscript: string;
}

const RECOGNITION_CUES =
  /\b(?:you (?:sound|seem|feel|are|look)|you['’]re|i (?:hear|can hear|see|can see|understand|notice)|that (?:sounds|seems)|it makes sense that|must be|i['’]?m sorry|sorry (?:you|that)|thanks for telling me|acknowledge|(?:do not|don['’]t|please don['’]t|stop) (?:get|be|feel|sound|act) (?:so )?)\b/i;
const ANGER_BEHAVIOR_CUES =
  /\b(?:(?:please\s+)?(?:do not|don['’]?t|stop)\s+(?:raise\s+(?:your\s+)?voice|(?:shout|yell)(?:ing)?)|lower\s+(?:your\s+)?voice)\b/i;
const EMOTION_WORDS = {
  anger: /\b(?:angry|anger|mad|frustrated|frustrating|upset|irritated|irritating|annoyed|furious)\b/i,
  sadness: /\b(?:sad|sadness|disappointed|disappointing|down|hurt|upset|sorry)\b/i,
} as const;

export function isEmotionAcknowledged(emotion: "anger" | "sadness", text: string): boolean {
  return (RECOGNITION_CUES.test(text) && EMOTION_WORDS[emotion].test(text))
    || (emotion === "anger" && ANGER_BEHAVIOR_CUES.test(text));
}

export class EmotionAcknowledgmentTracker {
  private pending: Array<{ emotion: "anger" | "sadness"; studentItemId?: string }> = [];

  constructor(private readonly onResult: (result: EmotionAcknowledgment) => void) {}

  noteEmotion(emotion: SpeechEmotion, studentItemId?: string): void {
    if (emotion === "anger" || emotion === "sadness") this.pending.push({ emotion, studentItemId });
  }

  observeTeacher(text: string): void {
    if (!text.trim() || !this.pending.length) return;
    const pending = this.pending.shift()!;
    const { emotion, studentItemId } = pending;
    this.onResult({
      type: "client.emotion_acknowledgment",
      emotion,
      acknowledged: isEmotionAcknowledged(emotion, text),
      teacherTranscript: text,
      ...(studentItemId ? { studentItemId } : {}),
    });
  }
}
