import { describe, expect, it } from "vitest";
import { emotionDashboardRecords } from "../src/realtime/emotionDashboard";
import type { LogEntry } from "../src/realtime/RealtimeClient";

const entry = (id: number, type: string, raw: unknown): LogEntry => ({
  id,
  type,
  raw,
  at: id,
  dir: "info",
});

describe("emotion dashboard records", () => {
  it("pairs student anger with the teacher acknowledgment and transcript", () => {
    const records = emotionDashboardRecords([
      entry(1, "client.emotion_used", { emotion: "anger", transcript: "I can't make sense of this.", tags: "<|emotion:anger|><|style:shouting|>", item_id: "response-1" }),
      entry(2, "client.emotion_acknowledgment", { emotion: "anger", acknowledged: true, teacherTranscript: "I hear that you're frustrated.", studentItemId: "response-1" }),
    ]);
    expect(records).toEqual([{
      id: "response-1",
      emotion: "anger",
      studentTranscript: "I can't make sense of this.",
      tags: "<|emotion:anger|><|style:shouting|>",
      acknowledged: true,
      teacherTranscript: "I hear that you're frustrated.",
      at: 1,
    }]);
  });

  it("keeps sadness without a teacher response as awaiting acknowledgment", () => {
    const records = emotionDashboardRecords([
      entry(1, "client.emotion_used", { emotion: "sadness", transcript: "I still don't understand.", emotionId: "response-2" }),
    ]);
    expect(records[0]).toMatchObject({
      emotion: "sadness",
      studentTranscript: "I still don't understand.",
      acknowledged: null,
      teacherTranscript: null,
    });
  });

  it("records when the next teacher turn does not acknowledge the emotion", () => {
    const records = emotionDashboardRecords([
      entry(1, "client.emotion_used", { emotion: "sadness", item_id: "response-2" }),
      entry(2, "client.emotion_acknowledgment", { emotion: "sadness", acknowledged: false, teacherTranscript: "The lesson is about provinces." }),
    ]);
    expect(records[0]).toMatchObject({ emotion: "sadness", acknowledged: false });
  });

  it("rechecks the transcript with the current acknowledgment rules", () => {
    const records = emotionDashboardRecords([
      entry(1, "client.emotion_used", { emotion: "anger", item_id: "response-1" }),
      entry(2, "client.emotion_acknowledgment", {
        emotion: "anger",
        acknowledged: false,
        teacherTranscript: "Yes, do not get angry.",
        studentItemId: "response-1",
      }),
    ]);
    expect(records[0].acknowledged).toBe(true);
  });

  it("does not show other emotions or unrelated log entries", () => {
    expect(emotionDashboardRecords([
      entry(1, "client.emotion_used", { emotion: "surprise" }),
      entry(2, "client.emotion_acknowledgment", { emotion: "anger", acknowledged: false }),
    ])).toEqual([]);
  });
});
