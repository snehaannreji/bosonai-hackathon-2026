export const SPEECH_EMOTIONS = [
  "anger",
  "sadness",
  "amusement",
  "contentment",
  "contemplation",
  "surprise",
] as const;

export type SpeechEmotion = (typeof SPEECH_EMOTIONS)[number];

const SPOKEN_EMOTION_LABEL = /^\s*\[(?:(?:a bit|slightly|very|really|deeply|mildly|quite)\s+)?(?:angry|anger|sad|sadness|disappointed|disappointment|amused|amusement|content|contentment|contemplative|contemplation|surprised|surprise|curious|curiosity|afraid|fearful|fear|excited|excitedly|hopeful|confused|confusion|frustrated|frustration|proud|pride|relieved|relief|disgusted|disgust|affectionate|affection|elated|elation)(?:\s+(?:voice|tone|mood|feeling))?\]\s*/i;
const CONTROL_TAG = /<\|(?:emotion|style|prosody|sfx):[a-z_]+\|>/gi;

export function cleanSpokenTranscript(text: string): string {
  return text.replace(CONTROL_TAG, "").replace(SPOKEN_EMOTION_LABEL, "").trimStart();
}

export function isSpeechEmotion(value: unknown): value is SpeechEmotion {
  return typeof value === "string" && SPEECH_EMOTIONS.includes(value as SpeechEmotion);
}

export function chooseSpeechEmotion(random = Math.random): SpeechEmotion | null {
  const selection = random() * 12;
  if (selection < 6) return null;
  const emotionSelection = selection - 6;
  if (emotionSelection < 2) return "anger";
  if (emotionSelection < 4) return "sadness";
  if (emotionSelection < 4.5) return "amusement";
  if (emotionSelection < 5) return "contentment";
  if (emotionSelection < 5.5) return "contemplation";
  return "surprise";
}

export function buildTaggedSpeechInput(text: string, emotion: SpeechEmotion): string {
  const delivery = emotion === "anger"
    ? "<|style:shouting|>"
    : emotion === "sadness"
      ? "<|sfx:crying|>"
      : emotion === "contemplation"
        ? "<|prosody:pause|>"
        : "";
  return `<|emotion:${emotion}|>${delivery}${text.trim()}`;
}
