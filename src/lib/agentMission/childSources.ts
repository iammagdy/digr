import type { CatalogEndpoint, TregCatalog } from "../treg/catalog";
import { normalizeText } from "./relevance";
import { rankEndpoints, type RankedSource } from "./sourceRanking";

/**
 * THE PEOPLE OF A COMPANY, FROM THE CATALOG, BY CODE («ومن كل شركة اتنين من المديرين»). A step that asks for people per company needs two sources that LINK: the company source must give a field the people source accepts as its input (a website or a
 * domain, a company page link, the company's name, or an id of the same provider). Live retest of 2026-10-29: the planner took the cheapest company source (it gives the website and the page link), then declared the managers' step «unserved» although
 * the catalog has several people sources that take a company's website; the very first agent mission had served it (aviato company search + aviato company employees). So:
 *   - `peopleSourcesForCompanies` lists the people sources, cheapest first, with the company field each one accepts;
 *   - `linkableCompanySources` lists the company sources that give a field one of them accepts;
 *   - `childStepSourcesFor` is what the plan check asks before it accepts «this step has no source»: it answers with the sources that CAN serve the step.
 * Pure: the catalog and a predicate («may this account be sold this source?») in, plain facts out.
 */
/** The card's sentence when a company's people are asked for through every field of the company the source can take (its page, its website, its name). */
export const PEOPLE_FALLBACK_LINE_AR = "نطلب موظفي كل شركة بأول ما يتوفر لها من بياناتها: صفحتها على لينكدإن أو موقعها الإلكتروني أو اسمها، فلا تُستبعد شركة لمجرد أنه لا صفحة لها.";
export type LinkField = "domain" | "linkedin" | "name" | "id";

/** The capabilities whose rows are the people of ONE company. */
export const PEOPLE_OF_COMPANY_CAPABILITIES: ReadonlySet<string> = new Set(["companies.employees", "companies.employees.list", "companies.employees.search", "people.employees.search", "linkedin.company.people", "companies.emails.list"]);
const COMPANY_SEARCH_CAPABILITY = "companies.search";

const DOMAIN_INPUT = /^(?:domain|domains|company_domains?|company_domain|website|domainOrCompany)$/i;
const LINKEDIN_INPUT = /^(?:linkedinURL|company_linkedins?|company_linkedin_url|company_profile_url)$/i;
const NAME_INPUT = /^(?:company|company_name)$/i;

/** The company field(s) a people source takes as its input. */
export function acceptedLinks(endpoint: CatalogEndpoint): LinkField[] {
  const out = new Set<LinkField>();
  for (const i of endpoint.inputs) {
    if (DOMAIN_INPUT.test(i.name)) out.add("domain");
    else if (LINKEDIN_INPUT.test(i.name)) out.add("linkedin");
    else if (NAME_INPUT.test(i.name)) out.add("name");
    else if (i.name === "id") out.add("id");
  }
  return [...out];
}

const SOCIAL = /facebook|twitter|instagram|youtube|crunchbase|tiktok|github/i;
/** The company fields a company source gives (from the item fields of its catalog entry). */
export function providedLinks(endpoint: CatalogEndpoint): LinkField[] {
  const keys = Object.keys(endpoint.item_fields ?? {});
  const out = new Set<LinkField>();
  for (const k of keys) {
    if (/linkedin/i.test(k)) out.add("linkedin");
    else if (SOCIAL.test(k)) continue;
    else if (/website|domain|^urls?$|site/i.test(k)) { out.add("domain"); if (/^urls?$/i.test(k)) out.add("linkedin"); }
    else if (/^(?:name|company_?name|title)$/i.test(k)) out.add("name");
    else if (k === "id") out.add("id");
  }
  return [...out];
}

/** The field through which a company source feeds a people source, or null when they do not link (an id links only inside one provider). */
export function linkBetween(company: CatalogEndpoint, people: CatalogEndpoint): LinkField | null {
  const accepts = acceptedLinks(people);
  const gives = providedLinks(company);
  for (const f of ["domain", "linkedin", "name"] as const) if (accepts.includes(f) && gives.includes(f)) return f;
  return accepts.includes("id") && gives.includes("id") && company.provider === people.provider ? "id" : null;
}

export interface PeopleSource { id: string; accepts: LinkField[]; usdPerItem: number }

const rankedOf = (group: CatalogEndpoint[], catalog: TregCatalog, now: number): RankedSource[] => rankEndpoints(group, catalog, new Map(), now).ranked;

/** The people sources of a company that this account may buy, cheapest first. */
export function peopleSourcesForCompanies(catalog: TregCatalog, isAllowed: (id: string) => boolean, now = Date.now()): PeopleSource[] {
  const group = catalog.endpoints.filter((e) => e.capability && PEOPLE_OF_COMPANY_CAPABILITIES.has(e.capability) && isAllowed(e.id) && acceptedLinks(e).length > 0);
  return rankedOf(group, catalog, now).map((r) => ({ id: r.id, accepts: acceptedLinks(catalog.byId.get(r.id)!), usdPerItem: r.usdPerItem }));
}

/** The company sources (company search) that give a field some people source accepts, cheapest first: each with the people sources it feeds. */
export function linkableCompanySources(catalog: TregCatalog, isAllowed: (id: string) => boolean, now = Date.now()): Array<{ id: string; usdPerItem: number; feeds: Array<{ people: string; via: LinkField }> }> {
  const people = peopleSourcesForCompanies(catalog, isAllowed, now).map((p) => catalog.byId.get(p.id)!);
  const group = catalog.endpoints.filter((e) => e.capability === COMPANY_SEARCH_CAPABILITY && isAllowed(e.id));
  const out: Array<{ id: string; usdPerItem: number; feeds: Array<{ people: string; via: LinkField }> }> = [];
  for (const r of rankedOf(group, catalog, now)) {
    const company = catalog.byId.get(r.id)!;
    const feeds = people.flatMap((p) => { const via = linkBetween(company, p); return via ? [{ people: p.id, via }] : []; });
    if (feeds.length > 0) out.push({ id: r.id, usdPerItem: r.usdPerItem, feeds });
  }
  return out;
}

/** Stems of the nouns that name the PEOPLE of a company («موظفين», «المديرين», «مسؤولين», «صناع القرار»), compared after normalizing and without «ال». */
const PEOPLE_STEMS = ["موظف", "مدير", "مدرا", "مسول", "مسوول", "مسيول", "مسئول", "مسؤول", "اشخاص", "شخص", "صانع", "صناع", "قيادي", "رئيس", "تنفيذي", "مؤسس", "اداري", "عضو", "اعضاء", "مسمي"];
export const isPeopleNoun = (noun: string): boolean => {
  const w = normalizeText(String(noun ?? "")).replace(/^(?:ال|لل)/, "");
  return PEOPLE_STEMS.some((s) => w.startsWith(normalizeText(s)));
};

/**
 * The sources that can carry out a step the plan has no stage for: for the people of a company, the people sources (cheapest first); an empty list for any other step (the check then trusts the model's reason, as before).
 */
export function childStepSourcesFor(noun: string, catalog: TregCatalog, isAllowed: (id: string) => boolean, now = Date.now()): PeopleSource[] {
  return isPeopleNoun(noun) ? peopleSourcesForCompanies(catalog, isAllowed, now) : [];
}
