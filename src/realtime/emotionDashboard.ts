import type { LogEntry } from "./RealtimeClient";
import { isEmotionAcknowledged } from "./emotionAcknowledgment";

export interface EmotionDashboardRecord {
  id: string;
  emotion: "anger" | "sadness";
  studentTranscript: string | null;
  tags: string | null;
  acknowledged: boolean | null;
  teacherTranscript: string | null;
  at: number;
}

export function emotionDashboardRecords(entries: LogEntry[]): EmotionDashboardRecord[] {
  const records: EmotionDashboardRecord[] = [];
  for (const entry of entries) {
    if (entry.type === "client.emotion_used" && entry.raw && typeof entry.raw === "object") {
      const raw = entry.raw as { emotion?: unknown; tag?: unknown; tags?: unknown; item_id?: unknown; transcript?: unknown };
      if (raw.emotion !== "anger" && raw.emotion !== "sadness") continue;
      records.push({
        id: typeof raw.item_id === "string" ? raw.item_id : `${entry.id}`,
        emotion: raw.emotion,
        studentTranscript: typeof raw.transcript === "string" ? raw.transcript : null,
        tags: typeof raw.tags === "string" ? raw.tags : typeof raw.tag === "string" ? raw.tag : null,
        acknowledged: null,
        teacherTranscript: null,
        at: entry.at,
      });
      continue;
    }
    if (entry.type !== "client.emotion_acknowledgment" || !entry.raw || typeof entry.raw !== "object") continue;
    const raw = entry.raw as { emotion?: unknown; acknowledged?: unknown; teacherTranscript?: unknown; studentItemId?: unknown };
    if ((raw.emotion !== "anger" && raw.emotion !== "sadness") || typeof raw.acknowledged !== "boolean") continue;
    const record = typeof raw.studentItemId === "string"
      ? records.find(item => item.id === raw.studentItemId && item.emotion === raw.emotion && item.acknowledged === null)
      : [...records].reverse().find(item => item.emotion === raw.emotion && item.acknowledged === null);
    if (!record) continue;
    record.teacherTranscript = typeof raw.teacherTranscript === "string" ? raw.teacherTranscript : null;
    record.acknowledged = record.teacherTranscript
      ? isEmotionAcknowledged(record.emotion, record.teacherTranscript)
      : raw.acknowledged;
  }
  return records.reverse();
}
