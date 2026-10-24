import { describe, expect, it, vi } from "vitest";
import { EmotionAcknowledgmentTracker } from "../src/realtime/emotionAcknowledgment";

describe("student emotion acknowledgment tracking", () => {
  it("records when the teacher acknowledges the student's anger", () => {
    const onResult = vi.fn();
    const tracker = new EmotionAcknowledgmentTracker(onResult);
    tracker.noteEmotion("anger");
    tracker.observeTeacher("I hear that you're frustrated. Let's try another way.");
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      emotion: "anger",
      acknowledged: true,
      teacherTranscript: "I hear that you're frustrated. Let's try another way.",
    }));
  });

  it("counts a direct request not to be angry as acknowledging the emotion", () => {
    const onResult = vi.fn();
    const tracker = new EmotionAcknowledgmentTracker(onResult);
    tracker.noteEmotion("anger", "student-response-1");
    tracker.observeTeacher("Yes, do not get angry.");
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      emotion: "anger",
      acknowledged: true,
      studentItemId: "student-response-1",
    }));
  });

  it("counts requests to lower the student's voice as acknowledging anger", () => {
    const onResult = vi.fn();
    const tracker = new EmotionAcknowledgmentTracker(onResult);
    tracker.noteEmotion("anger");
    tracker.observeTeacher("Please don't raise your voice.");
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      emotion: "anger",
      acknowledged: true,
    }));

    const sadnessTracker = new EmotionAcknowledgmentTracker(onResult);
    sadnessTracker.noteEmotion("sadness");
    sadnessTracker.observeTeacher("Please don't raise your voice.");
    expect(onResult).toHaveBeenLastCalledWith(expect.objectContaining({
      emotion: "sadness",
      acknowledged: false,
    }));
  });

  it("records when the teacher does not acknowledge sadness", () => {
    const onResult = vi.fn();
    const tracker = new EmotionAcknowledgmentTracker(onResult);
    tracker.noteEmotion("sadness");
    tracker.observeTeacher("Canada has ten provinces.");
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      emotion: "sadness",
      acknowledged: false,
    }));
  });

  it("ignores non-emotional replies and waits for the next teacher turn", () => {
    const onResult = vi.fn();
    const tracker = new EmotionAcknowledgmentTracker(onResult);
    tracker.noteEmotion("anger");
    tracker.noteEmotion("contentment");
    tracker.observeTeacher("I can hear you're angry.");
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ emotion: "anger", acknowledged: true }));
  });

  it("keeps emotion tracking independent when another emotion is heard before a response", () => {
    const onResult = vi.fn();
    const tracker = new EmotionAcknowledgmentTracker(onResult);
    tracker.noteEmotion("anger", "anger-1");
    tracker.noteEmotion("sadness", "sadness-2");
    tracker.observeTeacher("Quebec");
    tracker.observeTeacher("I can hear that you're sad.");
    expect(onResult).toHaveBeenNthCalledWith(1, expect.objectContaining({
      emotion: "anger",
      acknowledged: false,
      studentItemId: "anger-1",
    }));
    expect(onResult).toHaveBeenNthCalledWith(2, expect.objectContaining({
      emotion: "sadness",
      acknowledged: true,
      studentItemId: "sadness-2",
    }));
  });
});
