import { describe, expect, it } from "vitest";
import { buildTaggedSpeechInput, chooseSpeechEmotion, isSpeechEmotion } from "../src/realtime/speechTags";

describe("tagged Higgs TTS input", () => {
  it("adds supported emotion, style, and prosody cues before the spoken text", () => {
    expect(buildTaggedSpeechInput("I cannot believe it.", "anger")).toBe(
      "<|emotion:anger|><|style:shouting|>I cannot believe it.",
    );
    expect(buildTaggedSpeechInput("That is difficult.", "sadness")).toBe(
      "<|emotion:sadness|><|sfx:crying|>That is difficult.",
    );
    expect(buildTaggedSpeechInput("Let me think.", "contemplation")).toBe(
      "<|emotion:contemplation|><|prosody:pause|>Let me think.",
    );
  });

  it("chooses an emotion from the supported set and rejects unknown values", () => {
    expect(chooseSpeechEmotion(() => 0)).toBe("anger");
    expect(chooseSpeechEmotion(() => 0.34)).toBe("sadness");
    expect(chooseSpeechEmotion(() => 0.99)).toBe("surprise");
    expect(isSpeechEmotion("sadness")).toBe(true);
    expect(isSpeechEmotion("curiosity")).toBe(false);
  });
});
