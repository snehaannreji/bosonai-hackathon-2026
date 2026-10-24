/** Normalize a banana shout only when the model chose to say one. */
export function formatKevinSpeech(reply: string): string {
  return reply.trim().replace(/\bbananas?\b/giu, "Banana!");
}

/** Deliberately vary Kevin's pre-focus reactions so the playful mode is audible. */
export function kevinPlayModeReply(turn: number): string {
  const replies = ["Banana!", "Ha ha ha!", "Bello! Hee hee!", "Banana! Hee hee!", "Bello! Bello!", "Ha ha ha!"];
  return replies[Math.abs(turn) % replies.length];
}

/** Match the spoken/typed cue that switches Kevin from play to learning. */
export function isKevinConcentrationCommand(text: string): boolean {
  return /\bkevin\b[\s,.:;!?-]*(?:you|u)\s+need\s+to\s+concentrate\b/i.test(text);
}
