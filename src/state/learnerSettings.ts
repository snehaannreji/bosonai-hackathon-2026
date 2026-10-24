export interface LearnerSettings {
  knowledgeLevel: number;
  feedbackDirectness: number;
}

export const DEFAULT_LEARNER_SETTINGS: LearnerSettings = {
  knowledgeLevel: 25,
  feedbackDirectness: 35,
};

export function learnerSettingLabel(value: number, low: string, high: string): string {
  if (value < 34) return low;
  if (value > 66) return high;
  return "Balanced";
}
