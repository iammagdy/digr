import { formatAr } from "../../arabicDigits";
import { countAr, type ItemNoun } from "../itemNoun";

/**
 * STAGE 2 S11 (docs/STAGE-2.md, wording review): a number with its noun, by the rule of the LAST TWO DIGITS for 100 and above (the shared `countAr` of itemNoun.ts writes «١٠٠ تعليقًا»;
 * Arabic says «١٠٠ تعليق»). Below 100 it is `countAr` unchanged. Used by the Stage 2 sentences only: the shared function and every surface that uses it stay as they are.
 *   last two digits 0, 1, 2 -> the singular («١٠٠ تعليق», «١٠١ تعليق», «٢٠٢ تعليق»); 3 to 10 -> the plural («١٠٣ تعليقات»); 11 to 99 -> the accusative singular («١١١ تعليقًا»).
 */
export function nounCountAr(n: number, noun: ItemNoun): string {
  const c = Math.max(0, Math.floor(Number(n) || 0));
  if (c < 100) return countAr(c, noun);
  const tail = c % 100;
  const word = tail <= 2 ? noun.singular : tail <= 10 ? noun.plural : noun.tamyiz;
  return `${formatAr(c)} ${word}`;
}
