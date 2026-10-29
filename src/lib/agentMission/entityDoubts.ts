import { normalizeText } from "./relevance";
import { placeEntry, placesInText } from "./places";

/**
 * A COMPANY ROW THAT LOOKS LIKE A COMPANY OF THE TRADE AND PLACE ASKED FOR, BUT ITS OWN TEXT SAYS OTHERWISE. The live retest of 2026-10-29 («٥٠ شركة مقاولات في مصر») delivered «Big 5 Construct Egypt» (a trade show: «Find new business opportunities in Egypt's USD 570 billion construction
 * market»), «serious construction "sc",,11-50,seriouscons.com» (a broken CSV line as a name; the description of a law firm in Seattle), «FCC Construction & Development» (the description of a discussion site), «fibrex construction group» (head office in Abu Dhabi), «cpc egypt» (a Saudi
 * company's description): every one of them has a word of the trade in its text and was accepted by the sector rule.
 *
 * Code never DECIDES such a row: it sends it to the model check (which may exclude it; an excluded row stays admin-only and the charge follows what is delivered). A doubt is raised when
 *   - the name is a broken line of a spreadsheet (a comma, then a size band or a web address or an empty field), so the other fields of the item may be another company's;
 *   - the description names a place of ANOTHER country and none of the wanted one (a head office abroad);
 *   - the description says what the body is, and it is not a company of a trade (a law firm, a news or discussion site, a trade show).
 * Pure: no I/O.
 */
export type DoubtReason = "name_debris" | "other_place" | "other_kind";

/** A name column holds a line of a spreadsheet: a comma followed by an empty field, a size band («11-50», «51-200», «201-500», «1000+»), or a web address at the end. */
const DEBRIS = /,\s*,|,\s*\d{1,5}\s*[-–]\s*\d{1,5}\b|,\s*\d{1,6}\+|,\s*(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/?\s*$/i;

/** True when a name is a broken spreadsheet line. */
export const nameHasDebris = (name: unknown): boolean => typeof name === "string" && name.includes(",") && DEBRIS.test(name);

/** The real name inside a broken line: the part before the first comma, with the quotation marks of the line taken off. Null when there is nothing left. */
export function cleanedName(name: string): string | null {
  const first = name.split(",")[0].replace(/["“”„‟«»]/g, " ").replace(/\s+/g, " ").trim();
  return first.length >= 2 ? first : null;
}

/** Words of a text that say what a body IS when it is not a company of a trade: a law office, a news or discussion site, a trade show, a marketplace or a job board. */
const OTHER_KIND = [
  "law firm", "law office", "law offices", "attorney", "attorneys", "lawyer", "lawyers", "solicitors", "legal services", "legal counsel", "مكتب محاماة", "محامون", "محاماة",
  "discussion site", "discussion forum", "message board", "online community", "blog", "news site", "news website", "news portal", "newspaper", "magazine", "مدونة", "موقع اخباري", "صحيفة",
  "trade show", "tradeshow", "exhibition", "exhibitions", "expo", "conference", "summit", "business opportunities", "معرض", "مؤتمر",
  "job board", "job portal", "recruitment agency", "staffing agency", "online marketplace", "marketplace", "directory of",
];
const KIND_RE = new Map<string, RegExp>();
const kindRegex = (word: string): RegExp => {
  let re = KIND_RE.get(word);
  if (!re) { re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${normalizeText(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s_-]+")}(?![\\p{L}\\p{N}])`, "u"); KIND_RE.set(word, re); }
  return re;
};

const textOf = (item: Record<string, unknown>, keys: ReadonlyArray<string>): string => keys.map((k) => (item[k] === null || item[k] === undefined || typeof item[k] === "object" ? "" : String(item[k]))).join(" \n ");

export interface DoubtInput {
  /** The mapped fields that hold the name, and the fields that describe the company (a description, an about text). */
  nameKeys: ReadonlyArray<string>;
  descriptionKeys: ReadonlyArray<string>;
  /** The places (places.ts keys) the card promises; none: no place doubt. */
  wantedPlaces: ReadonlyArray<string>;
}

/** The first reason an item of an entity stage should be looked at by the model check although the rule accepts it, or null. */
export function entityDoubt(item: Record<string, unknown>, input: DoubtInput): DoubtReason | null {
  if (input.nameKeys.some((k) => nameHasDebris(item[k]))) return "name_debris";
  const description = textOf(item, input.descriptionKeys);
  if (!description.trim()) return null;
  const text = normalizeText(description);
  // the description names another country (or a city of one) and none of the wanted places: the company's own text puts it somewhere else
  if (input.wantedPlaces.length > 0) {
    const wantedCountries = new Set(input.wantedPlaces.map((k) => placeEntry(k)?.country).filter((c): c is string => Boolean(c)));
    const named = placesInText(description);
    if (named.length > 0 && named.every((e) => !wantedCountries.has(e.country))) return "other_place";
  }
  return OTHER_KIND.some((w) => kindRegex(w).test(text)) ? "other_kind" : null;
}
