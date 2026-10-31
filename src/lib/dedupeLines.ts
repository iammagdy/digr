import { normalizeText } from "./agentMission/relevance";

/**
 * Display-only de-duplication of the short Arabic lines a card lists («كيف فهمنا طلبك»): a line that says what an earlier line already says is not shown again.
 * «identical» = the same words once punctuation, diacritics, the forms of alef / ya / ta marbuta and digits are normalised; «near-identical» = the same words but one or two
 * (a line that only adds a full stop or a connecting word). The first line is kept, in its original order; nothing is rewritten.
 */
const words = (line: string): string[] => normalizeText(line).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

function similar(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return a.length === b.length;
  // two lines that carry different numbers say different things, however many words they share
  const numbers = (ws: string[]) => ws.filter((w) => /\d/.test(w)).sort().join("|");
  if (numbers(a) !== numbers(b)) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared += 1;
  const union = setA.size + setB.size - shared;
  return shared / union >= 0.8;
}

export function dedupeNearIdentical(lines: readonly string[]): string[] {
  const kept: Array<{ line: string; words: string[] }> = [];
  for (const line of lines) {
    const w = words(line);
    if (w.length === 0) continue;
    if (kept.some((k) => similar(k.words, w))) continue;
    kept.push({ line, words: w });
  }
  return kept.map((k) => k.line);
}
