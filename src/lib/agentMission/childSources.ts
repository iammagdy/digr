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

/**
 * The capabilities whose rows are the PEOPLE of ONE company: a name, usually a job title and a profile (employee lists, employee finders, the company's founders, a company's contacts). `people.search` joins them only for an endpoint that takes a company's
 * website, page or name (`acceptedLinks`). An e-mail LISTER (`companies.emails.list`: «the addresses found on a domain») is NOT among them: its rows are mailboxes, and most of the mailboxes of a small company are info@, sales@ or webmaster@ with no name at all
 * (live, 2026-10-31: eight of nine rows). A mailbox lister serves the company's own e-mails; the people come from a people source and their e-mail and phone are separate steps.
 */
export const PEOPLE_OF_COMPANY_CAPABILITIES: ReadonlySet<string> = new Set(["companies.employees", "companies.employees.list", "companies.employees.search", "people.employees.search", "linkedin.company.people", "companies.founders", "people.organization_contacts", "people.search"]);
/** The capabilities that list the MAILBOXES of a company's domain (role and personal addresses together). */
export const MAILBOX_LISTER_CAPABILITIES: ReadonlySet<string> = new Set(["companies.emails.list", "companies.emails.role"]);
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

export interface PeopleSource { id: string; accepts: LinkField[]; usdPerItem: number; /** What the list is ordered by: the price per item over the expected success rate (a source that often gives nothing ranks lower than its price says). */ effectiveUsd: number }

const rankedOf = (group: CatalogEndpoint[], catalog: TregCatalog, now: number): RankedSource[] => rankEndpoints(group, catalog, new Map(), now).ranked;

/** The people sources of a company that this account may buy, cheapest first. */
export function peopleSourcesForCompanies(catalog: TregCatalog, isAllowed: (id: string) => boolean, now = Date.now()): PeopleSource[] {
  const group = catalog.endpoints.filter((e) => e.capability && PEOPLE_OF_COMPANY_CAPABILITIES.has(e.capability) && isAllowed(e.id) && acceptedLinks(e).length > 0);
  return rankedOf(group, catalog, now).map((r) => ({ id: r.id, accepts: acceptedLinks(catalog.byId.get(r.id)!), usdPerItem: r.usdPerItem, effectiveUsd: r.effectiveUsd }));
}

/** The catalog's platform keys of a companies step and of a people step (catalog metadata, the planner's understanding uses them). */
export const COMPANIES_PLATFORM = "companies";
export const PEOPLE_PLATFORM = "people";
/** THE REQUEST'S STRUCTURE (DT-20261118-03 PR-7, Megz D-0086: never its words): a people step whose parent is a companies step, as the planner understood the request. */
export function asksPeopleOfCompanies(steps: ReadonlyArray<{ key: string; parent: string | null; platform: string }>): boolean {
  return steps.some((s) => s.parent !== null && s.platform === PEOPLE_PLATFORM && steps.find((p) => p.key === s.parent)?.platform === COMPANIES_PLATFORM);
}
/** The same structure with its facts, as the planning model wrote them (its own titles and the count per company it read, never a word list): what the plan check needs to treat the people of the companies as a step. */
/** A step is the PEOPLE of another step's items by what its tool IS (a people-of-company capability of the catalog), whatever platform key the model gave it (the catalog files these tools under «companies», «people» and «linkedin»). */
export const isPeopleOfCompanyStep = (s: { platform: string; capability?: string | null }): boolean => s.platform === PEOPLE_PLATFORM || (typeof s.capability === "string" && PEOPLE_OF_COMPANY_CAPABILITIES.has(s.capability));
/**
 * WHAT THE CUSTOMER ASKED ABOUT THE PEOPLE OF THE COMPANIES, as the planning model answered it in its REQUIRED `people_of_companies` field (DT-20261118-08): whether they were asked, the people as
 * the customer named them, the count per company the model read (digits, the dual or words; 0 = none given) and the person contacts asked. Code acts on this answer even when the model wrote no
 * people step (live after #575: «شركتين مقاولات … ومسؤولي الإدارة فيهم بأرقامهم الشخصية» got no people step). Code never reads the customer's words for it.
 */
export interface PeopleOfCompaniesAsk { asked: boolean; title_ar: string; per_company: number | null; contact_kinds: Array<"email" | "phone"> }
export function peopleOfCompaniesAskOf(raw: unknown): PeopleOfCompaniesAsk {
  const o = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const per = typeof o.per_company === "number" && Number.isInteger(o.per_company) && o.per_company > 0 ? o.per_company : null;
  const kinds = Array.isArray(o.contact_kinds) ? [...new Set(o.contact_kinds.filter((k): k is "email" | "phone" => k === "email" || k === "phone"))] : [];
  return { asked: o.asked === true, title_ar: typeof o.title_ar === "string" ? o.title_ar.trim().slice(0, 60) : "", per_company: per, contact_kinds: kinds };
}
export interface UnderstoodPeople { noun_ar: string; parent_ar: string; per_parent: number | null; contact_kinds?: Array<"email" | "phone"> }
/** The people of the companies as the planner understood them: the people step it wrote, else its required answer (the parent is then the first top-level step it wrote). The answer's count and contacts complete a step that has none. */
export function understoodPeopleOf(steps: ReadonlyArray<{ key: string; title_ar: string; parent: string | null; platform: string; capability?: string | null; count: { per_parent: number | null } }>, ask?: PeopleOfCompaniesAsk | null): UnderstoodPeople | null {
  const extra = ask?.asked ? { contact_kinds: ask.contact_kinds } : {};
  for (const s of steps) {
    const parent = s.parent !== null && isPeopleOfCompanyStep(s) ? steps.find((p) => p.key === s.parent) : undefined;
    // the parent of a people step is the companies step by structure; its own platform key is not read (a companies step may be a map search or a business directory)
    if (parent) return { noun_ar: s.title_ar, parent_ar: parent.title_ar, per_parent: s.count.per_parent ?? (ask?.asked ? ask.per_company : null), ...extra };
  }
  if (!ask?.asked) return null;
  const top = steps.find((s) => s.parent === null);
  if (!top) return null;
  return { noun_ar: ask.title_ar || "الأشخاص", parent_ar: top.title_ar, per_parent: ask.per_company, ...extra };
}

/** What a person row of a source gives the e-mail and phone finders: a professional page (a LinkedIn profile), a name, a domain. Read from the catalog's own field names and example answer (values like «linkedin.com/in/…»), never from the request. */
export type PersonIdentifier = "linkedin" | "name" | "domain";
const PROFILE_KEY = /^(person_)?linkedin(_?url)?$|^linkedinurl$|^profile_?url$/i;
const PERSON_NAME_KEY = /^(full_?name|first_?name|last_?name|name)$/i;
const NOT_THE_PERSON = /company|organi[sz]ation|employer|org$/i;
export function personIdentifiersOf(endpoint: CatalogEndpoint): PersonIdentifier[] {
  const out = new Set<PersonIdentifier>();
  const look = (key: string, value: unknown, underCompany: boolean): void => {
    if (typeof value === "string" && /linkedin\.[a-z.]+\/in\//i.test(value)) out.add("linkedin");
    if (underCompany || NOT_THE_PERSON.test(key)) return;
    if (PROFILE_KEY.test(key)) out.add("linkedin");
    else if (PERSON_NAME_KEY.test(key)) out.add("name");
    else if (/^(domain|website)$/i.test(key)) out.add("domain");
  };
  const walk = (node: unknown, depth: number, underCompany: boolean): void => {
    if (depth > 6 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node.slice(0, 3)) walk(x, depth + 1, underCompany); return; }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) { look(k, v, underCompany); walk(v, depth + 1, underCompany || NOT_THE_PERSON.test(k)); }
  };
  for (const [k, v] of Object.entries(endpoint.item_fields ?? {})) look(k, (v as { example?: unknown } | undefined)?.example, false);
  walk((endpoint as unknown as { example_response_trimmed?: unknown }).example_response_trimmed, 0, false);
  return (["linkedin", "name", "domain"] as const).filter((x) => out.has(x));
}
/** A people source's rank by what it gives the finders: a profile 0, a name or a domain 1, nothing 2. */
export const identifierTier = (gives: ReadonlyArray<PersonIdentifier>): number => (gives.includes("linkedin") ? 0 : gives.length > 0 ? 1 : 2);
/** The people sources of a company, ranked by catalog metadata only: what their rows give the finders, then the price over the expected rate. */
export function rankedPeopleSources(catalog: TregCatalog, isAllowed: (id: string) => boolean, now = Date.now()): Array<PeopleSource & { gives: PersonIdentifier[] }> {
  const list = peopleSourcesForCompanies(catalog, isAllowed, now).map((p) => ({ ...p, gives: personIdentifiersOf(catalog.byId.get(p.id)!) }));
  return list.map((p, i) => ({ p, i })).sort((a, b) => identifierTier(a.p.gives) - identifierTier(b.p.gives) || a.i - b.i).map((x) => x.p);
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
/** «رئيسي / رئيسية / رئيسيين» is the adjective «main» («التعليقات الرئيسية»), not a chief: the stem «رئيس» names a person only in «رئيس / رئيسة / رؤساء» (S11: the live comments stage was read as a people stage because of it). */
const MAIN_ADJECTIVE = normalizeText("رئيسي");
export const isPeopleNoun = (noun: string): boolean => {
  const w = normalizeText(String(noun ?? "")).replace(/^(?:ال|لل)/, "");
  if (w.startsWith(MAIN_ADJECTIVE)) return false;
  return PEOPLE_STEMS.some((s) => w.startsWith(normalizeText(s)));
};

/**
 * The sources that can carry out a step the plan has no stage for: for the people of a company, the people sources (cheapest first); an empty list for any other step (the check then trusts the model's reason, as before).
 */
export function childStepSourcesFor(noun: string, catalog: TregCatalog, isAllowed: (id: string) => boolean, now = Date.now()): PeopleSource[] {
  return isPeopleNoun(noun) ? peopleSourcesForCompanies(catalog, isAllowed, now) : [];
}
