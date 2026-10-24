/** Keep Baby Yoda's generated speech short, broken, and still understandable. */
export function formatBabySpeech(reply: string): string {
  const text = reply
    .replace(/<\|[^|]+\|>/g, " ")
    .replace(/\b(?:mm+|hmm+|ba-?ba|ba|ah+|eh+)\b/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const words = (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? []).slice(0, 10);

  // If the model follows the baby-style direction too literally, keep a small
  // spoken thought instead of generating a clip made only of vocal noises.
  if (words.length < 6) {
    const fallback = ["Little one", "learning", "I am", "teach me more"];
    for (const word of fallback.join(" ").split(" ")) {
      if (words.length >= 8) break;
      words.push(word);
    }
  }

  // The baby-babble reference supplies the vocal texture. Don't add fake
  // onomatopoeia as spoken text; split the reply into short imperfect chunks.
  const fragments: string[] = [];
  for (let index = 0; index < words.length; index += 3) {
    fragments.push(words.slice(index, index + 3).join(" "));
  }
  return `${fragments.join(", ")}.`;
}
