import { detectCountryFromText, isCompanyRowMatchingLocation } from "../planParameters";
import { companyAddressMatches, regionMatches } from "../server/researchRelevanceGate";

/**
 * The COUNTRY GATE of the model path, deterministic and the same rules as the old path (`isCompanyRowMatchingLocation` for companies, `regionMatches` and
 * `companyAddressMatches` for people): when the customer's own words name a country (or a city that names one), a company or person row of another country is never delivered
 * and never charged. Rows of a model plan have the source's own field names, so a row is first read into the shape those rules know (location, address, country, website…).
 *
 *  - COMPANY rows need positive evidence of the country (its address, location, country, site domain or description): a company with no sign of the country is not delivered,
 *    exactly as on the old path.
 *  - PERSON rows are refused only when the row names ANOTHER country (the person's own address or their company's address); a person with no country data contradicts nothing.
 */
export interface RequestCountry { canonicalEnglish: string; arabicLabel: string }

export const OUT_OF_COUNTRY_AR = "خارج النطاق الجغرافي المطلوب";

/** The country the customer's own words name, or null. */
export function countryOfRequest(customerText: string): RequestCountry | null {
  const found = detectCountryFromText(String(customerText ?? ""));
  return found ? { canonicalEnglish: found.canonicalEnglish, arabicLabel: found.arabicLabel } : null;
}

type Obj = Record<string, unknown>;

function leaves(value: unknown, path: string, out: Array<[string, string]>, depth = 0): void {
  if (depth > 4 || value === null || value === undefined) return;
  if (typeof value === "string") { if (value.trim()) out.push([path, value.trim()]); return; }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) { for (const v of value.slice(0, 8)) leaves(v, path, out, depth + 1); return; }
  if (typeof value === "object") for (const [k, v] of Object.entries(value as Obj)) leaves(v, path ? `${path}.${k}` : k, out, depth + 1);
}

const COUNTRY_KEY = /(^|[._])(country|country_code|countrycode|nation|nationality)([._]|$)/i;
const PLACE_KEY = /(location|address|city|region|state|hq|headquarter|place)/i;
const COMPANY_PREFIX = /(company|employer|organi[sz]ation|org|lastcompany|currentcompany)/i;
const SITE_KEY = /(website|domain|site|homepage)/i;
const DESC_KEY = /(description|about|summary|headline|bio|specialt)/i;

/** A row, read into the fields the old rules know. Keys are matched by name; nothing is guessed from values except the site's host. */
export function geoViewOf(raw: Obj): Record<string, string> {
  const flat: Array<[string, string]> = [];
  leaves(raw, "", flat);
  const pick = (test: (path: string) => boolean) => flat.filter(([p]) => test(p)).map(([, v]) => v).join("; ");
  const own = (p: string) => !COMPANY_PREFIX.test(p);
  const country = pick((p) => own(p) && COUNTRY_KEY.test(p));
  const place = pick((p) => own(p) && PLACE_KEY.test(p) && !COUNTRY_KEY.test(p));
  const companyPlace = pick((p) => COMPANY_PREFIX.test(p) && (PLACE_KEY.test(p) || COUNTRY_KEY.test(p)));
  const website = pick((p) => SITE_KEY.test(p) && !/linkedin/i.test(p));
  const linkedin = flat.filter(([, v]) => /linkedin\.com/i.test(v)).map(([, v]) => v).join("; ");
  const description = pick((p) => DESC_KEY.test(p));
  return { country, location: [place, country].filter(Boolean).join("; "), address: place, company_address: companyPlace, website, linkedin_url: linkedin, description };
}

export function rowMatchesCountry(raw: Obj, country: RequestCountry, entity: "company" | "person"): boolean {
  const view = geoViewOf(raw);
  if (entity === "company") return isCompanyRowMatchingLocation({ ...view, location: [view.location, view.company_address].filter(Boolean).join("; ") }, country.canonicalEnglish);
  if (!regionMatches(view, country.canonicalEnglish)) return false;
  return !view.company_address || companyAddressMatches(view.company_address, country.canonicalEnglish);
}

/** The row gate of a step: only the FIRST step of a plan (the listing or the only step) holds company or person rows to the customer's country. */
export function countryRowGate(country: RequestCountry | null | undefined, entity: "company" | "person" | null | undefined): ((raw: Obj) => boolean) | undefined {
  if (!country || !entity) return undefined;
  return (raw) => rowMatchesCountry(raw, country, entity);
}
