import { sectorEnglishWords } from "../entities";
import { countryOfRequestText } from "../places";
import type { B2BAsk } from "./b2bAsk";
import type { B2BCard } from "./b2bCards";

/**
 * STAGE 3, PART A: THE COMPANIES SEARCH'S REQUEST, BY CODE, from the Ask and the card's `request` paths (b2bCards.ts). The country is the one the words NAME («في مصر»), else the NATIONALITY word
 * («شركات مصرية» -> EG, owner decision 6): an INPUT the source is asked with, never a rule over the rows (no stage of a code-built plan carries a filter; tests/stage3-b2b-plan.test.ts). This is the
 * one Stage 3 file the golden G1 guard allows to read `countryOfRequestText` (tests/golden-r2-request-country-not-a-filter.test.ts). The sector words are the English words of entities.ts.
 * Null when the card has no request paths, or when neither a country nor a sector can be sent (a search with no input would list any company). Pure.
 */
export function b2bSearchCountry(ask: Pick<B2BAsk, "country">, requestText: string): string | null {
  return ask.country ?? countryOfRequestText(requestText);
}

const put = (into: Record<string, unknown>, path: ReadonlyArray<string>, value: unknown): void => {
  let node = into;
  path.slice(0, -1).forEach((k) => { if (typeof node[k] !== "object" || node[k] === null) node[k] = {}; node = node[k] as Record<string, unknown>; });
  node[path[path.length - 1]] = value;
};

export function b2bCompaniesRequest(ask: Pick<B2BAsk, "country" | "sector">, requestText: string, card: B2BCard): Record<string, unknown> | null {
  const spec = card.request;
  if (!spec || card.role !== "companies.search") return null;
  const country = spec.country ? b2bSearchCountry(ask, requestText) : null;
  const sector = spec.sector ? [...new Set(ask.sector.flatMap((w) => sectorEnglishWords(w)))] : [];
  if (!country && sector.length === 0) return null;
  const params: Record<string, unknown> = {};
  if (country && spec.country) put(params, spec.country, [country]);
  if (sector.length > 0 && spec.sector) put(params, spec.sector, sector);
  return { ...params, ...structuredClone(spec.fixed ?? {}) };
}
