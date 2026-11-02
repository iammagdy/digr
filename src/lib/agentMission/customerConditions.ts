import { isEnabled, type StageFilter } from "./filters";
import { languageLabelAr, languageOfTextAr } from "./languageLabel";
import { placeVerdict } from "./places";

/**
 * DOES A RESULT MATCH THE CUSTOMER'S COUNTRY AND LANGUAGE (S7; docs/S1-LIVE-FINDINGS.md, live 2026-11-02 ~13:06): the most-engaged order applies only among the results that match them. Only the conditions the customer asked for count (a place and a language filter of the card, enabled).
 *  - the place: the row's own place fields (the filter's fields) carry evidence of it; no evidence is NOT a match (it is never assumed, and the source's «region» input is a request to the source, not a proof);
 *  - the language: the language the source gives when it gives one (a code or an Arabic word), else the script of the row's text (code, never a model).
 * A match is an ORDER, never a filter: nothing is removed for it. Pure.
 */
export function matchesCustomerConditions(row: Record<string, unknown>, filters: ReadonlyArray<StageFilter>, textKeys: ReadonlyArray<string>): boolean {
  for (const f of filters.filter(isEnabled)) {
    if (f.kind === "place" && (f.places ?? []).length > 0) {
      const fields = [...(f.fields ?? []), ...(f.field ? [f.field] : [])];
      if (placeVerdict(f.places!, row, [...new Set(fields)]) !== "pass") return false;
    } else if (f.kind === "language" && f.lang) {
      const own = Object.entries(row).find(([k, v]) => /^(lang|language|text_language|post_language)$/i.test(k) && typeof v === "string" && v.trim() !== "")?.[1] as string | undefined;
      const label = own !== undefined ? String(languageLabelAr(own)) : languageOfTextAr(textKeys.map((k) => row[k]).filter((v) => typeof v === "string").join(" "));
      const wantArabic = /^ar/i.test(f.lang);
      if (wantArabic ? label !== "العربية" : label === "العربية") return false;
    }
  }
  return true;
}

/** True when the card promises a country or a language (an enabled place or language filter). */
export const conditionsAsked = (filters: ReadonlyArray<StageFilter>): boolean => filters.filter(isEnabled).some((f) => (f.kind === "place" && (f.places ?? []).length > 0) || (f.kind === "language" && Boolean(f.lang)));
