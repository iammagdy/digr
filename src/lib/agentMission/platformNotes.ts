/**
 * THE HONEST SENTENCE ABOUT A DEAR PLATFORM, built by code onto the plan card (owner decision 2026-10-29): a platform whose data is reached in a costly way is still served, the price on the card is the real one, and the customer is told in
 * one plain sentence why it is higher. No source name, no technical word. The platform is read from the sources the stages use (the endpoint ids name it).
 */
const DEAR_PLATFORMS: ReadonlyArray<{ re: RegExp; sentenceAr: string }> = [
  { re: /facebook/i, sentenceAr: "الجمع من فيسبوك أعلى تكلفة من المنصات الأخرى بسبب طريقة الوصول إلى بياناته، ولهذا يظهر سعره أعلى؛ والقرار لك." },
];

export function platformCostNotesAr(stages: ReadonlyArray<{ endpoint_id: string }>): string[] {
  const out: string[] = [];
  for (const p of DEAR_PLATFORMS) if (stages.some((s) => p.re.test(s.endpoint_id)) && !out.includes(p.sentenceAr)) out.push(p.sentenceAr);
  return out;
}
