import { toArabicDigits } from "../../arabicDigits";

/**
 * STAGE 4, S5: THE ARABIC COUNT OF A NOUN, the same rule as `pointsAr` (src/lib/pointsFormat.ts): one «خانة واحدة», two «خانتان» (both words, no digits), three to ten «٣ خانات» (the plural), eleven and more «١١ خانة» (the singular).
 * Each form carries the words that agree with the count (the adjective, the verb). Digits are Arabic-Indic, never grouped. Pure.
 */
export interface CountForms { one: string; two: string; few: string; many: string }

export function countedAr(count: number, forms: CountForms): string {
  const k = Math.abs(Math.trunc(Number(count)));
  if (k === 1) return forms.one;
  if (k === 2) return forms.two;
  return `${toArabicDigits(k)} ${k >= 3 && k <= 10 ? forms.few : forms.many}`;
}
