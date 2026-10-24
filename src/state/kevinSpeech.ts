/** Normalize a banana shout only when the model chose to say one. */
export function formatKevinSpeech(reply: string): string {
  return reply.trim().replace(/\bbananas?\b/giu, "Banana!");
}

/** Match the spoken/typed cue that switches Kevin from play to learning. */
export function isKevinConcentrationCommand(text: string): boolean {
  return /\bkevin\b[\s,.:;!?-]*(?:you|u)\s+need\s+to\s+concentrate\b/i.test(text);
}
