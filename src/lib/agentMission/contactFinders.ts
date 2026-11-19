import type { CatalogEndpoint, TregCatalog } from "../treg/catalog";
import { EMAIL_FINDER_CAPABILITIES } from "./contactSampling";
import { requestWantsContacts, verifyContactValue, type ContactKind } from "./contacts";
import { isPeopleStage, nameKeysOf } from "./people";
import { PHONE_CAPABILITIES } from "./peopleCheck";
import { unitCost } from "../modelPlanner/pricing";
import { PHONE_TYPE_COLUMN_AR, phoneTypeKeyOf } from "./phoneValidation";
import { SOURCE_DEMOTE_FACTOR, expectedCost, sourceHealth, type StatsMap } from "./sourceRanking";
import { finderHitRate } from "./finderStats";
import { MAILBOX_LISTER_CAPABILITIES } from "./childSources";
import { isCompanyStage } from "./entities";
import { emailOnOtherDomain } from "./emailVerification";
import { isRoleMailbox } from "./people";
import { isPersonalMailDomain } from "../multiProvider/policy";
import { COMPANY_EMAIL_STATUS_TITLE_AR, COMPANY_EMAIL_TITLE_AR } from "./taskContracts";

/**
 * THE CONTACT FINDER STEPS, BY CODE. Live test 2026-11-01 (A1 msn_7a8b…, A2 msn_020c…): 14 decision makers delivered, every e-mail and phone cell empty. The approved plans had two stages (companies, people); the people stage maps `email: ''` and `phone: ''`
 * and nothing in the plan or in the job looked an e-mail or a phone up (the planner was told a finder it had not sampled left the cells «filled only if found during the approved job», and the job never looked). Owner direction: whenever the customer asks
 * for an e-mail, a phone or any contact field for PEOPLE, the approved plan MUST contain the finder step(s); a planning-sample cap limits sampling only. So the step is not the planner's to plan or to drop: for every delivered people stage the plan check adds one
 * step per asked kind, ranked cheapest first from the catalog, and the engine runs it after the stages (agent/src/engine/contacts.ts). The step fills CELLS of the person who was already delivered; it adds no row, so the delivered count and the charge are untouched.
 */
export type FinderKind = "email" | "phone";
export interface FinderInput { name: string; required: boolean }
/** A finder the catalog offers, with what it needs to be called (so the engine can tell, per person, which finders it can call). */
export interface FinderInfo { id: string; usd: number; inputs: FinderInput[]; /** `success`: the provider bills only an answer that carries the value (a miss is free); `call`: every call is billed. Absent (a plan stored before): `call`, the cautious reading. */ bill?: "success" | "call" }
export interface ContactStep {
  kind: FinderKind;
  /** The people stage whose persons are enriched. */
  stage_key: string;
  /** The cell that gets the value, and the cell that says whether it is verified. */
  column_key: string;
  status_key: string;
  /** What one person is expected to cost this step (USD): the cheapest ranked finder's price, the assumed share of the fallback finder (FALLBACK_MISS_SHARE) and, for an e-mail, the verifier for the share of people an address is found for (EMAIL_FOUND_SHARE). It is part of the price by code (plan.ts `stagePriceInputs`), and it caps what the step may spend (engine). */
  per_person_usd: number;
  /** WHAT ONE PERSON MAY COST AT MOST (USD): every finder of the chain, the verifier (or the company-phone search and the validator) each at its full price. It is the step's CAP per person (engine/contacts.ts), so every delivered person can go through the whole chain; absent (a plan stored before): per_person_usd. */
  max_person_usd?: number;
  /** The finders this account may buy, cheapest first (at most FINDERS_PER_STEP). */
  finders: FinderInfo[];
  /** E-MAIL steps: the verifiers this account may buy, cheapest first (at most FINDERS_PER_STEP). A found or given address goes through them; «موثّق» only when one says deliverable (emailVerification.ts). */
  verifiers?: FinderInfo[];
  /** PHONE steps: the validators this account may buy, cheapest first. Every phone goes through them; «موثّق» only when one says the number is valid and local (phoneValidation.ts). */
  validators?: FinderInfo[];
  /** PHONE steps: the map searches that give a COMPANY's phone, cheapest first, used when no personal phone was found (one lookup per company). */
  company_phone?: FinderInfo[];
  /** The next ranked finders for this kind. Asked only after the primary pass; up to FINDERS_PER_STEP additional calls per person within the primary chain ceiling. */
  alternates?: FinderInfo[];
  /** PHONE steps (DT-20261118-05 item 4c): the catalog's profile lookup (a person's name and company → the professional page), asked first for a person without one, inside the same price for one person; not priced. */
  profile_lookup?: FinderInfo[];
  /** PHONE steps: the cell that says whose number it is, «شخصي» / «رقم الشركة» / «فاكس». */
  type_key?: string;
  /** Set on a step of the COMPANY (audit 2026-11, taskContracts.ts): `stage_key` is the stage whose rows are the companies; the e-mail step looks up the company's own role mailbox (`finders` are mailbox listers), the phone step the company's HQ phone (`company_phone` are the map searches). Absent: a step of the people of a stage. */
  level?: "company";
  /** A company e-mail step of a COMPANIES-ONLY request (no people under the companies): its two columns are added by withContactColumns (a companies and people delivery gets them from taskContracts.ts). */
  own_columns?: true;
}

export const CONTACT_STATUS_VERIFIED_AR = "موثّق";
export const CONTACT_STATUS_UNVERIFIED_AR = "غير موثّق";

export const EMAIL_LABEL_PERSONAL_AR = "إيميل شخصي";
export const EMAIL_LABEL_COMPANY_AR = "إيميل الشركة";
export const EMAIL_LABEL_SHARED_AR = "إيميل مشترك";
export const PHONE_TYPE_FAX_AR = "فاكس";
export const EMAIL_LABEL_DOMAIN_AR = "إيميل على نطاق الشركة";

/**
 * A label appended to a contact's status cell (e.g. «غير موثّق — إيميل شخصي»).
 * Idempotent: does not append the label if it is already present.
 */
export function labelledStatus(status: string, label: string): string {
  const trimmed = status.trim();
  if (!trimmed) return label.trim();
  const cleanLabel = label.trim();
  const parts = trimmed.split(" — ").map((p) => p.trim());
  if (parts.includes(cleanLabel)) return trimmed;
  return `${trimmed} — ${cleanLabel}`;
}

/** The status verdict before any label or note (e.g. «موثّق» from «موثّق — إيميل مشترك»). */
export function statusHead(s: string): string {
  const trimmed = s.trim();
  const idx = trimmed.indexOf(" — ");
  if (idx === -1) return trimmed;
  return trimmed.slice(0, idx).trim();
}
/** The most finders one person is tried with, per kind (the first that finds a value ends it). */
export const FINDERS_PER_STEP = 3;

/** The distinct, stored person alternates covered by the second pass and its attempt resolution. */
export function personAlternatesOf(step: Pick<ContactStep, "finders" | "alternates">): FinderInfo[] {
  const seen = new Set(step.finders.map((finder) => finder.id));
  const alternates: FinderInfo[] = [];
  for (const finder of step.alternates ?? []) {
    if (seen.has(finder.id)) continue;
    alternates.push(finder);
    seen.add(finder.id);
    if (alternates.length === FINDERS_PER_STEP) break;
  }
  return alternates;
}

export const statusKeyOf = (columnKey: string): string => `${columnKey}_status`;
const KIND_OF: Record<FinderKind, ContactKind> = { email: "work_email", phone: "phone" };
const DEFAULT_COLUMN: Record<FinderKind, { key: string; title_ar: string }> = { email: { key: "email", title_ar: "الإيميل" }, phone: { key: "phone", title_ar: "رقم التليفون" } };

/** The inputs a person gives a finder (a bare `url` input is NOT one: it takes an article, not a profile): the professional page, the name (whole, first, last), the company's domain and name. A finder that needs anything else (a webhook, a stored id) is not used. */
// DT-20261118-05 item 4: the person's WORK E-MAIL is an input too (a phone finder that looks the number up from it), and «companyOrDomain» is the company's domain (the catalog's profile lookup)
const INPUT_KINDS: ReadonlyArray<{ kind: "linkedin" | "name" | "first" | "last" | "domain" | "company" | "email"; test: RegExp }> = [
  { kind: "linkedin", test: /^(person_)?linkedin(_?url)?$|^profile_?url$/i },
  { kind: "first", test: /^first_?name$/i },
  { kind: "last", test: /^last_?name$/i },
  { kind: "name", test: /^(full_?)?name$/i },
  { kind: "domain", test: /^(company_?)?(domain|website)$|^company_?url$|^company_?domain$|^domain_?or_?company$|^company_?or_?domain$/i },
  { kind: "company", test: /^company(_?name)?$/i },
  { kind: "email", test: /^(work_?)?e-?mail$/i },
];
const inputKindOf = (name: string): (typeof INPUT_KINDS)[number]["kind"] | null => INPUT_KINDS.find((k) => k.test.test(name))?.kind ?? null;

/**
 * THE HELPERS OF A STEP (finders, verifiers, validators), RANKED AND PRICED BY WHAT ONE CALL REALLY COSTS. The general source ranking divides a per-call price by the rows a call is expected to give (a list source returns many); a lookup returns ONE answer, so that division
 * under-prices a call that bills per call five-fold (quickenrich's 0.004834 became 0.00097) and the step's cap and the plan's price rested on it. Here the price is the catalog's price of one call (a routed endpoint at its dearest sibling), health and success rate come from the
 * general ranking, and the order is price over success rate, cheapest first, ties by id.
 */
export function rankedHelpers(group: ReadonlyArray<CatalogEndpoint>, catalog: TregCatalog, stats: StatsMap, now: number, options: { rank?: (id: string, usd: number) => number; maxUsd?: number; offset?: number } = {}): FinderInfo[] {
  const seen = new Set<string>();
  const list: Array<{ key: number; info: FinderInfo }> = [];
  for (const e of group) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const health = sourceHealth(stats.get(e.id), now);
    if (health.state === "skipped") continue;
    const own = unitCost(e, catalog)?.usd ?? (typeof e.cost?.usd === "number" ? e.cost.usd : null);
    if (own === null) continue; // no usable price: not offered
    // a FREE call is priced at a token amount (never zero: the budget checks and the price carry a figure), and still ranks first
    const usd = own > 0 ? own : 0.000001;
    if (options.maxUsd !== undefined && usd > options.maxUsd) continue; // a call dearer than the ceiling is not part of the chain
    const successRate = expectedCost(e, catalog, stats.get(e.id)).successRate;
    list.push({ key: (options.rank ? options.rank(e.id, usd) : usd / successRate) * (health.state === "demoted" ? SOURCE_DEMOTE_FACTOR : 1), info: { id: e.id, usd, bill: e.cost?.type === "per_success" || e.cost?.type === "free" ? "success" : "call", inputs: e.inputs.map((i) => ({ name: i.name, required: i.required })) } });
  }
  const from = options.offset ?? 0;
  return list.sort((a, b) => a.key - b.key || a.info.id.localeCompare(b.info.id)).slice(from, from + FINDERS_PER_STEP).map((x) => x.info);
}

/**
 * A FINDER OF A CHAIN COSTS AT MOST THIS MUCH A CALL (USD). The live catalog holds finders that bill every call at 0.1 USD (enrichlayer) or a hit at 0.0445 (tomba phone): with a chain of three and ten people one job could take a large share of the provider's daily cap (0.80 USD) on lookups alone.
 * Above the ceiling a finder is not part of the step; the plan then prices and caps the chain without it. It limits the CHAIN only (the cap and the price are derived from the chain), never the customer's quantity.
 */
export const FALLBACK_FINDER_MAX_USD = 0.02;
/** A PERSON-PHONE finder may cost up to this much a call (Megz D-0085: «ارفعه لـ٥ سنت»): the person's own phone is core (D-0084), and the finders that find it more often cost more. The chain is still chosen by catalog capability, price and measured rate only. */
export const PHONE_FINDER_MAX_USD = 0.05;
/** What a FOUND value costs: the price of a call over the measured share of calls that find one (finderStats.ts); finders are ranked by it, cheapest first. */
export const finderRankKey = (f: { id: string; usd: number }, kind: FinderKind): number => f.usd / finderHitRate(f.id, kind);

/** The finders of a kind this account may buy, cheapest first (the helper ranking above). Only finders that answer at once and need only what a person row gives. */
export function finderSourcesOf(kind: FinderKind, catalog: TregCatalog, isAllowed: (id: string) => boolean, stats: StatsMap = new Map(), now = Date.now(), offset = 0): FinderInfo[] {
  const caps = kind === "email" ? EMAIL_FINDER_CAPABILITIES : PHONE_CAPABILITIES;
  const usable = (e: CatalogEndpoint): boolean => !e.async && e.inputs.filter((i) => i.required).every((i) => inputKindOf(i.name) !== null) && e.inputs.some((i) => inputKindOf(i.name) !== null);
  const group = catalog.endpoints.filter((e) => e.capability && caps.has(e.capability) && isAllowed(e.id) && usable(e));
  return rankedHelpers(group, catalog, stats, now, { rank: (id, usd) => finderRankKey({ id, usd }, kind), maxUsd: kind === "phone" ? PHONE_FINDER_MAX_USD : FALLBACK_FINDER_MAX_USD, offset });
}

/** THE NEXT RANKED FINDERS of a kind (DT-20261118-05 item 4b): the same catalog group, ranking and ceiling as finderSourcesOf, after its first FINDERS_PER_STEP. People still missing a value after the primary chain may be asked by these. */
export function alternateFinderSourcesOf(kind: FinderKind, catalog: TregCatalog, isAllowed: (id: string) => boolean, stats: StatsMap = new Map(), now = Date.now()): FinderInfo[] {
  return finderSourcesOf(kind, catalog, isAllowed, stats, now, FINDERS_PER_STEP);
}

/** The catalog capability of a PROFILE LOOKUP: a person's name and company in, the person's professional page out. */
export const PROFILE_LOOKUP_CAPABILITY = "people.profile.url";
/** THE PROFILE LOOKUPS of the catalog (DT-20261118-05 item 4c): synchronous, every required input one a person row gives, at most the phone ceiling, cheapest first. */
export function profileLookupSourcesOf(catalog: TregCatalog, isAllowed: (id: string) => boolean, stats: StatsMap = new Map(), now = Date.now()): FinderInfo[] {
  const usable = (e: CatalogEndpoint): boolean => e.capability === PROFILE_LOOKUP_CAPABILITY && !e.async && e.inputs.filter((i) => i.required).every((i) => inputKindOf(i.name) !== null) && e.inputs.some((i) => inputKindOf(i.name) !== null);
  return rankedHelpers(catalog.endpoints.filter((e) => isAllowed(e.id) && usable(e)), catalog, stats, now, { maxUsd: PHONE_FINDER_MAX_USD });
}

/**
 * THE MOST NODES ONE WALK OF A PROVIDER'S ANSWER VISITS (QA #575 FAIL 1): the guard against a huge or self-referencing answer is a node count and a seen-set, never a depth (a page may sit under any number of unnamed objects).
 * The walk keeps its own stack, so a deeply nested answer cannot overflow the call stack.
 */
export const ANSWER_WALK_MAX_NODES = 20_000;
/** Every node under `root` in document order (depth first, each object once), at most ANSWER_WALK_MAX_NODES; `enter(node)` false keeps the walk out of that object's values. */
function* answerNodes(root: unknown, enter: (node: object) => boolean = () => true): Generator<unknown> {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];
  let budget = ANSWER_WALK_MAX_NODES;
  while (stack.length > 0 && budget > 0) {
    const node = stack.pop();
    budget -= 1;
    if (node !== null && typeof node === "object") {
      if (seen.has(node)) continue;
      seen.add(node);
    }
    yield node;
    if (node === null || typeof node !== "object" || !enter(node)) continue;
    const values = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    for (let i = values.length - 1; i >= 0; i -= 1) stack.push(values[i]);
  }
}

/** The professional page in a lookup's answer: the first value anywhere in it that is a person's LinkedIn page («/in/…»), given with https://. */
export function profileUrlIn(page: unknown): string | null {
  for (const node of answerNodes(page)) {
    if (typeof node !== "string") continue;
    const m = LINKEDIN_PERSON.exec(node.trim());
    if (m) return /^https?:\/\//i.test(m[0]) ? m[0] : `https://${m[0]}`;
  }
  return null;
}

/** The key a stored person row keeps the professional page under when the planner's columns have no place for it (never a column of the file). */
export const SOURCE_PROFILE_KEY = "_profile";
/**
 * THE PERSON'S PROFESSIONAL PAGE FROM THE SOURCE'S OWN ANSWER (DT-20261118-05 item 4a): a people source often gives the page one level down (`person.URLs.linkedin`, `linkedinURL`, `socials`) and the planner's mapping may leave it out. Every object of the raw answer that
 * names a person is read for a LinkedIn page among its own values and its nested objects that name nobody; a mapped person without a page gets the one given for the same name. No field-name list: a value is a page by what it is.
 */
export function withSourceProfiles<R extends Record<string, unknown>>(page: unknown, rows: ReadonlyArray<R>, nameKeys: ReadonlyArray<string>): R[] {
  const key = (n: string): string => n.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const nameOf = (o: Record<string, unknown>): string => text(o.full_name) || text(o.fullName) || text(o.name) || [text(o.first_name ?? o.firstName), text(o.last_name ?? o.lastName)].filter(Boolean).join(" ");
  // the person's own page: among the person object's values at ANY depth, never inside a nested object that names somebody else (QA #575 FAIL 1: three unnamed levels down was cut off)
  const own = (o: Record<string, unknown>): string | null => {
    for (const v of answerNodes(o, (n) => n === o || Array.isArray(n) || !nameOf(n as Record<string, unknown>))) if (typeof v === "string" && LINKEDIN_PERSON.test(v.trim())) return profileUrlIn(v);
    return null;
  };
  const byName = new Map<string, string>();
  for (const node of answerNodes(page)) {
    if (!isObj(node)) continue;
    const inner = isObj(node.person) ? node.person : null;
    const name = nameOf(node) || (inner ? nameOf(inner) : "");
    const url = name ? own(node) ?? (inner ? own(inner) : null) : null;
    if (name && url && !byName.has(key(name))) byName.set(key(name), url);
  }
  if (byName.size === 0) return [...rows];
  return rows.map((r) => {
    if (Object.values(r).some((v) => LINKEDIN_PERSON.test(text(v)))) return r;
    const name = nameKeys.map((k) => text(r[k])).filter(Boolean).join(" ");
    const url = name ? byName.get(key(name)) : undefined;
    return url ? { ...r, [SOURCE_PROFILE_KEY]: url } : r;
  });
}

/** The e-mail verifiers of the catalog this account may buy, cheapest first (the same ranking as every source): direct and synchronous (a routed one bills a range, an asynchronous one needs polling), taking only the address, with a known price. */
export function verifierSourcesOf(catalog: TregCatalog, isAllowed: (id: string) => boolean, stats: StatsMap = new Map(), now = Date.now()): FinderInfo[] {
  const usable = (e: CatalogEndpoint): boolean => e.capability === "people.email.verify" && e.kind === "direct" && !e.async && typeof e.cost?.usd === "number" && e.inputs.filter((i) => i.required).every((i) => /^e-?mail$/i.test(i.name)) && e.inputs.some((i) => /^e-?mail$/i.test(i.name));
  const group = catalog.endpoints.filter((e) => isAllowed(e.id) && usable(e));
  return rankedHelpers(group, catalog, stats, now);
}

/**
 * WHAT THE STEP'S PRICE RESTS ON: the MEASURED hit rate of each finder of the chain (finderStats.ts, from the platform's call log; the earlier guessed shares FALLBACK_MISS_SHARE 0.1 and EMAIL_FOUND_SHARE 0.8 are gone). A person goes down the ranked finders until one gives a value: the expected
 * cost of a finder is its price x the share of persons that reach it x (its hit rate when the provider bills a HIT only, 1 when it bills every call); the verifier is bought for the share of persons an address was found for. The CAP (`max_person_usd`) is the whole chain at full price for every
 * person, so no delivered decision maker is left without the dearer finder by the luck of the first person's hit.
 */
export function chainExpectation(list: ReadonlyArray<FinderInfo>, kind: FinderKind): { costUsd: number; missShare: number } {
  let reach = 1;
  let costUsd = 0;
  for (const f of list) {
    const hit = finderHitRate(f.id, kind);
    costUsd += reach * (f.bill === "success" ? hit : 1) * f.usd;
    reach *= 1 - hit;
  }
  return { costUsd, missShare: reach };
}

/**
 * What a chain of helpers is PRICED at per use: the dearest of its first `depth` members. Depth 1 (the default) prices the member that is expected to answer; a fallback member is bought only inside the step's cap and the job budget (the engine checks both before every call), so a
 * fallback that does not fit is not called. The e-mail verifiers are priced at depth 2: the owner's benchmark found a FREE verifier (contactout) answering HTTP 429, and a free first member would otherwise leave the plan without the money for the paid one that takes over.
 */
export const chainPriceUsd = (list: ReadonlyArray<FinderInfo> | undefined, depth = 1): number => Math.max(0, ...(list ?? []).slice(0, depth).map((f) => f.usd));
/** How many of the first e-mail verifiers the step's price covers (see chainPriceUsd). */
export const VERIFIER_PRICE_DEPTH = 2;

/** The helpers of a step besides its finders, from the catalog (empty when there are none). */
export interface ContactAids { verifiers?: FinderInfo[]; validators?: FinderInfo[]; company_phone?: FinderInfo[]; alternates?: FinderInfo[]; profile_lookup?: FinderInfo[] }

/** The phone validators of the catalog this account may buy, cheapest first: direct and synchronous, taking only a number (and the country hint of a national one). */
export function validatorSourcesOf(catalog: TregCatalog, isAllowed: (id: string) => boolean, stats: StatsMap = new Map(), now = Date.now()): FinderInfo[] {
  const numberInput = /^(telephone_number|phone_number|msisdn|phone|number)$/i;
  const hint = /^(input_format|output_format|country_code|phone\.country_hint|country_hint|region)$/i;
  const usable = (e: CatalogEndpoint): boolean => e.capability === "people.phone.verify" && e.kind === "direct" && !e.async && typeof e.cost?.usd === "number" && e.inputs.filter((i) => i.required).every((i) => numberInput.test(i.name) || hint.test(i.name)) && e.inputs.some((i) => numberInput.test(i.name));
  return rankedHelpers(catalog.endpoints.filter((e) => isAllowed(e.id) && usable(e)), catalog, stats, now);
}

/** The map searches of the catalog that give a company's phone (a place for a query), cheapest first: they take a query (and a country or a location), nothing else required. */
export function companyPhoneSourcesOf(catalog: TregCatalog, isAllowed: (id: string) => boolean, stats: StatsMap = new Map(), now = Date.now()): FinderInfo[] {
  const query = /^(q|query|keyword)$/i;
  const hint = /^(country|gl|location)$/i;
  const usable = (e: CatalogEndpoint): boolean => e.capability === "google.serp.maps" && !e.async && typeof e.cost?.usd === "number" && e.inputs.some((i) => query.test(i.name) && !/array/i.test(String(i.type ?? ""))) && e.inputs.filter((i) => i.required).every((i) => query.test(i.name) || hint.test(i.name));
  return rankedHelpers(catalog.endpoints.filter((e) => isAllowed(e.id) && usable(e)), catalog, stats, now);
}

/** The steps a plan needs: one per asked kind for every DELIVERED people stage. `finders(kind)` is the catalog's ranked list (empty: the step is still there, with nothing to call, and the file says nothing was found). `aids(kind)` are its other helpers (the e-mail verifiers), priced into the step. */
export function buildContactSteps(
  stages: ReadonlyArray<{ key: string; title_ar: string; parent_key: string | null; deliver: boolean; role_preference?: unknown; columns: ReadonlyArray<{ key: string; kind?: string }> }>,
  requestText: string | undefined,
  finders: (kind: FinderKind) => FinderInfo[],
  aids?: (kind: FinderKind) => ContactAids,
): ContactStep[] {
  const wants = requestWantsContacts(requestText);
  const out: ContactStep[] = [];
  for (const st of stages) {
    if (!st.deliver || !isPeopleStage(st)) continue;
    for (const kind of ["email", "phone"] as const) {
      const marked = st.columns.find((c) => c.kind === KIND_OF[kind]);
      if (!(kind === "email" ? wants.email : wants.phone) && !marked) continue;
      const list = finders(kind);
      const help = aids?.(kind) ?? {};
      const verifiers = kind === "email" && help.verifiers && help.verifiers.length > 0 ? help.verifiers : undefined;
      const validators = kind === "phone" && help.validators && help.validators.length > 0 ? help.validators : undefined;
      // D-0084: the company-row phone is never copied into a person's step; D-0119 only allows an office/fax answer from the person's phone finder
      const company_phone: FinderInfo[] | undefined = undefined;
      const column_key = marked?.key ?? DEFAULT_COLUMN[kind].key;
      // what one person is EXPECTED to cost (the price): the chain of finders by measured hit rates, then for an e-mail the verifier for those an address was found for, for a phone the company-phone search for those no personal number was found for (one search per company: an upper bound) and
      // the validator every phone goes through. What one person may cost AT MOST (the cap): every finder of the chain, the verifier or the company-phone search and the validator, each at its full price.
      const chain = chainExpectation(list, kind);
      const verifierUsd = verifiers ? chainPriceUsd(verifiers, VERIFIER_PRICE_DEPTH) : 0;
      const companyUsd = company_phone ? chainPriceUsd(company_phone, FINDERS_PER_STEP) : 0;
      const validatorUsd = validators ? chainPriceUsd(validators) : 0;
      const perPerson = chain.costUsd + (1 - chain.missShare) * verifierUsd + chain.missShare * companyUsd + validatorUsd;
      const maxPerson = list.reduce((n, f) => n + f.usd, 0) + verifierUsd + companyUsd + validatorUsd;
      out.push({ kind, stage_key: st.key, column_key, status_key: statusKeyOf(column_key), per_person_usd: perPerson, max_person_usd: Math.max(perPerson, maxPerson), finders: list, ...(verifiers ? { verifiers } : {}), ...(validators ? { validators } : {}), ...(company_phone ? { company_phone } : {}), ...(kind === "phone" ? { type_key: phoneTypeKeyOf(column_key) } : {}), ...(help.alternates && help.alternates.length > 0 ? { alternates: help.alternates } : {}), ...(kind === "phone" && help.profile_lookup && help.profile_lookup.length > 0 ? { profile_lookup: help.profile_lookup } : {}) });
    }
  }
  return out;
}

/** A stage's e-mail column, known by STRUCTURE (D-0086: never by the words of its title): marked kind «work_email», or keyed as an e-mail. */
export const isEmailColumn = (c: { key: string; kind?: string }): boolean => c.kind === "work_email" || /mail/i.test(c.key);
/** The stage columns with the step's contact column (added when the planner left it out) and, right after it, the Arabic status column. A plan without steps is returned as it is. Idempotent. */
export function withContactColumns<C extends { key: string; title_ar: string; kind?: ContactKind; status_of?: string; type_of?: string }>(stageKey: string, columns: ReadonlyArray<C>, steps: ReadonlyArray<ContactStep> | undefined): C[] {
  // (a step of the COMPANY has its own columns, taskContracts.ts: it never adds a person's e-mail or phone column to the company's stage)
  const mine = (steps ?? []).filter((s) => s.stage_key === stageKey && s.level === undefined);
  // THE COMPANY'S OWN E-MAIL OF A COMPANIES-ONLY REQUEST: its two columns are added here when the stage holds no e-mail column (a companies and people delivery gets them from taskContracts.ts)
  const companyEmail = (steps ?? []).find((s) => s.stage_key === stageKey && s.level === "company" && s.kind === "email" && s.own_columns === true);
  if (companyEmail && !columns.some(isEmailColumn)) return [...withContactColumns(stageKey, columns, mine), { key: companyEmail.column_key, title_ar: COMPANY_EMAIL_TITLE_AR } as C, { key: companyEmail.status_key, title_ar: COMPANY_EMAIL_STATUS_TITLE_AR, status_of: companyEmail.column_key } as C];
  if (mine.length === 0) return [...columns];
  let out: C[] = [...columns];
  for (const s of mine) {
    if (!out.some((c) => c.key === s.column_key)) out.push({ key: s.column_key, title_ar: DEFAULT_COLUMN[s.kind].title_ar, kind: KIND_OF[s.kind] } as C);
    out = out.map((c) => (c.key === s.column_key && c.kind === undefined ? { ...c, kind: KIND_OF[s.kind] } : c));
    if (!out.some((c) => c.key === s.status_key)) {
      const at = out.findIndex((c) => c.key === s.column_key);
      const base = out[at].title_ar;
      out.splice(at + 1, 0, { key: s.status_key, title_ar: `حالة توثيق ${base}`, status_of: s.column_key } as C);
    }
    // a phone says whose number it is, right after its status: «شخصي» or «رقم الشركة»
    if (s.type_key && !out.some((c) => c.key === s.type_key)) {
      const at = out.findIndex((c) => c.key === s.status_key);
      out.splice(at + 1, 0, { key: s.type_key, title_ar: PHONE_TYPE_COLUMN_AR, type_of: s.column_key } as C);
    }
  }
  return out;
}

/** The call parameters of a verifier for an address (the input named like an e-mail). */
export function verifierParamsFor(verifier: FinderInfo, email: string): Record<string, string> | null {
  const input = verifier.inputs.find((i) => /^e-?mail$/i.test(i.name));
  return input ? { [input.name]: email } : null;
}

/** What one person gives a finder. */
export interface PersonFacts { linkedin: string | null; name: string | null; first: string | null; last: string | null; domain: string | null; company: string | null; /** the person's work e-mail (DT-20261118-05 item 4: a phone finder looks the number up from it) */ email?: string | null }

// DT-20261118-03: a profile written without its scheme («linkedin.com/in/…», as some people sources give it) is the same profile; it is given to a finder with https://
const LINKEDIN_PERSON = /^(https?:\/\/)?([a-z]{2,3}\.)?linkedin\.[a-z.]+\/in\/[^\s?#]+/i;
const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").replace(/[​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();
const bareDomain = (v: unknown): string | null => { const t = text(v); if (!t || /linkedin\./i.test(t)) return null; const d = t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0]; return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d) ? d.toLowerCase() : null; };

/** The facts of a person row (and of its company's row): decided by code from the values, not from the planner's key names alone. */
export function personFactsOf(row: Record<string, unknown>, columns: ReadonlyArray<{ key: string; title_ar?: string; kind?: string }>, parent: Record<string, unknown> | null, allowEmail: (address: string) => boolean = () => true): PersonFacts {
  const profile = Object.values(row).map(text).find((v) => LINKEDIN_PERSON.test(v)) ?? null;
  const linkedin = profile === null ? null : /^https?:\/\//i.test(profile) ? profile : `https://${profile}`;
  const name = nameKeysOf(columns).map((k) => text(row[k])).filter(Boolean).join(" ").trim() || null;
  const parts = name ? name.split(/\s+/) : [];
  const domainKey = (r: Record<string, unknown> | null): string | null => { if (!r) return null; for (const [k, v] of Object.entries(r)) if (/(website|domain|site|url)/i.test(k)) { const d = bareDomain(v); if (d) return d; } return null; };
  const companyOf = (r: Record<string, unknown> | null): string | null => { if (!r) return null; for (const [k, v] of Object.entries(r)) if (/^(company|company_name|name)$/i.test(k) && text(v)) return text(v); return null; };
  const email = columns.filter((c) => isEmailColumn(c)).map((c) => text(row[c.key]).replace(/^mailto:/i, "").toLowerCase()).find((v) => emailValueTypeOf(v) === "professional" && allowEmail(v)) ?? null;
  return { linkedin, name, first: parts.length > 1 ? parts[0] : null, last: parts.length > 1 ? parts.slice(1).join(" ") : null, domain: domainKey(row) ?? domainKey(parent), company: text(row.company) || companyOf(parent), ...(email ? { email } : {}) };
}

/** The call parameters of a finder for a person, or null when the person lacks what the finder REQUIRES (it is then skipped for this person). At least one identifying input must be filled. */
/** `forPerson` false: a COMPANY lookup (the company e-mail listers take only the domain), where no person identifier is required. */
export function finderParamsFor(finder: FinderInfo, p: PersonFacts, forPerson = true): Record<string, string> | null {
  const value: Record<ReturnType<typeof inputKindOf> & string, string | null> = { linkedin: p.linkedin, name: p.name, first: p.first, last: p.last, domain: p.domain, company: p.company, email: p.email ?? null };
  const params: Record<string, string> = {};
  for (const i of finder.inputs) {
    const k = inputKindOf(i.name);
    const v = k ? value[k] : null;
    // a «name» input takes the whole name only when the finder has no first/last pair of its own (the whole name is also enough for the pair's finders, which split it)
    if (v) params[i.name] = v; else if (i.required) return null;
  }
  // A PERSON FINDER NEEDS A PERSON (BUG HUNTER Gate 1 delta, PR-2c): a call with only the company's domain or name is a paid call about nobody; at least a profile or a name must go with it
  if (forPerson && !finder.inputs.some((i) => params[i.name] !== undefined && ["linkedin", "name", "first", "last", "email"].includes(inputKindOf(i.name) ?? ""))) return null;
  return Object.keys(params).length > 0 ? params : null;
}

/** The inputs a finder REQUIRES that this person lacks (all its known inputs when none is filled): why it was not tried for this person. Empty when it can be called. */
export function missingInputsFor(finder: FinderInfo, p: PersonFacts): string[] {
  if (finderParamsFor(finder, p) !== null) return [];
  const value: Record<string, string | null> = { linkedin: p.linkedin, name: p.name, first: p.first, last: p.last, domain: p.domain, company: p.company, email: p.email ?? null };
  const required = finder.inputs.filter((i) => i.required && !value[inputKindOf(i.name) ?? ""]).map((i) => i.name);
  return required.length > 0 ? required : finder.inputs.filter((i) => inputKindOf(i.name) !== null).map((i) => i.name);
}

export interface FoundContact { value: string; status: "verified" | "unverified" }
const EMAIL_KEYS = /^(work_?)?e-?mail(_address)?$/i;
// DT-20261118-03 (D-0084): every phone answer shape found in the example answers of the catalog's person-phone finders (employee_phone, mobile_number, phone_numbers[].number, intl/e164_format, phones[].phoneNumber); the catalog gives no typed output field for most of them
const PHONE_KEYS = /^((mobile|direct|work|employee|personal)_?)?(phone|tel|mobile)(_?numbers?)?$|^phones$|^(intl|e164)_?format$/i;
/** A number inside a phone container (phone_numbers[].number, phones[].phoneNumber): «number» alone is never a phone key. */
const PHONE_ITEM_KEYS = /^(number|phone_?number|value)$/i;
/** A PHONE CONTAINER is known by a whole word of its key, snake_case or camelCase («phones», «mobilePhone», «telephone_numbers»): «hotel», «intelligence», «telemetry» only contain the letters (BUG HUNTER Gate 2 P2). */
const PHONE_CONTAINER_WORD = /^(phones?|mobiles?|tel|telephones?|phonenumbers?|cellphones?)$/i;
const isPhoneContainerKey = (k: string): boolean => k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").split(/[^A-Za-z0-9]+/).some((w) => PHONE_CONTAINER_WORD.test(w));
/** Whose number it is NOT (BUG HUNTER Gate 1 delta P1, D-0084): a fax, an office or switchboard line, the company's or employer's, by the key it sits under or the type the finder gives it. */
const NOT_PERSONAL_KEY = /fax|company|office|employer|organi[sz]ation|head_?quarter|\bhq\b|^hq|switchboard|reception|main_?(line|phone|number)/i;
const NOT_PERSONAL_TYPE = /^(fax|office|switchboard|reception|company|main|hq)$/i;
/** A phone written as a bare string inside a list (phone: ["+1…"], data: [["+1…"]]): international form only (a leading +), never a date, a postal code or an id. */
const PHONE_LIKE = /^\+\d[\d\s().-]{6,19}$/;
/** A value that is nothing but an address (optionally a mailto: link). */
const ADDRESS_ONLY = /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/;
const GOOD_STATUS = /^(valid|verified|deliverable|ok|safe|good)$/i;
const BAD_STATUS = /^(invalid|undeliverable|risky|unknown|catch_?all|accept_?all|disposable|bounce|bad)$/i;

export interface OfficeLine { value: string; type: "company" | "fax" }

export interface ContactDetail {
  found: FoundContact | null;
  personalAlso: string | null;
  officeLine: OfficeLine | null;
  rejected: number;
  numberTyped: number;
  scanTruncated: boolean;
}

const PHONE_SCAN_KEY = /(^|_)(phones?|tel|telephones?|mobiles?|cell|gsm|whatsapp|msisdn)(_|$)/i;
const NON_CONTACT_KEY = /(^|_)(ids?|uuid|zip|postal|postcode|date|time|timestamp|year|price|amount|score|count|created|updated|registration|tracking|reference|ein|sku|longitude|latitude|ip)(_|$)|_at$/i;
const DATE_OR_DECIMAL = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$|^\d+[.]\d+$|^(?:\d{1,3}[.]){3}\d{1,3}$/;
const FALLBACK_PHONE = /^(\+\d|0\d)[\d\s().-]{6,17}$/;
const normalizeKey = (key: string): string => key.replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
const nonPersonalKey = (key: string): boolean => NOT_PERSONAL_KEY.test(key) || /(^|_)(home|business)(_|$)/i.test(key);
const phoneRank = (label: string): number => /^(mobile|cell|direct|work|business)$/i.test(label) ? 0 : /^(home|other)$/i.test(label) ? 2 : 1;
const phoneShape = (raw: string, minimum = 7): boolean => {
  const digits = raw.replace(/\D/g, "");
  return /^[+\d(][\d\s().-]*$/.test(raw) && !DATE_OR_DECIMAL.test(raw) && digits.length >= minimum && digits.length <= 15;
};

interface PhonePath { container: boolean; recognised: boolean; phoneKey: boolean; office: boolean; fax: boolean; rank: number }

function phoneDetailIn(page: unknown): ContactDetail {
  const detail: ContactDetail = { found: null, personalAlso: null, officeLine: null, rejected: 0, numberTyped: 0, scanTruncated: false };
  let bestRank = Infinity;
  let leaves = 0;
  const root: PhonePath = { container: false, recognised: false, phoneKey: false, office: false, fax: false, rank: 1 };
  const read = (node: unknown, path: PhonePath, scan: boolean, listItem: boolean): void => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    const raw = text(node);
    if (!raw) return;
    if (scan && typeof node === "number") {
      if (!path.recognised && /^\d{8,15}$/.test(raw)) detail.numberTyped += 1;
      return;
    }
    if (!scan && !path.recognised && !(listItem && PHONE_LIKE.test(raw))) return;
    if (scan && (path.recognised || !FALLBACK_PHONE.test(raw) || !(path.phoneKey || raw.startsWith("+")) || !phoneShape(raw, 8))) return;
    if (!phoneShape(raw)) { detail.rejected += 1; return; }
    if (path.office) {
      detail.officeLine ??= { value: raw, type: path.fax ? "fax" : "company" };
    } else if (path.rank < bestRank) {
      const checked = scan ? null : verifyContactValue("phone", raw);
      detail.found = { value: checked ?? raw, status: checked ? "verified" : "unverified" };
      bestRank = path.rank;
    }
  };
  const walk = (node: unknown, depth: number, path: PhonePath, scan: boolean, listItem = false): void => {
    if (node === null || node === undefined) return;
    if (depth > 6) { if (scan) detail.scanTruncated = true; return; }
    if (scan && leaves >= 40) { detail.scanTruncated = true; return; }
    if (Array.isArray(node)) {
      for (const item of scan ? node : node.slice(0, 8)) {
        walk(item, depth + 1, path, scan, true);
        if (scan && detail.scanTruncated && leaves >= 40) break;
      }
      return;
    }
    if (typeof node !== "object") {
      if (scan) leaves += 1;
      read(node, path, scan, listItem);
      return;
    }
    const row = node as Record<string, unknown>;
    const label = text(row.type ?? row.line_type ?? row.kind ?? row.label);
    const office = path.office || NOT_PERSONAL_TYPE.test(label);
    const fax = path.fax || /^fax$/i.test(label);
    for (const [rawKey, value] of Object.entries(row)) {
      const key = normalizeKey(rawKey);
      if (NON_CONTACT_KEY.test(key) || /^(type|line_type|kind|label)$/.test(key)) continue;
      const officeKey = office || nonPersonalKey(key);
      const faxKey = fax || /fax/i.test(key);
      const phoneKey = PHONE_SCAN_KEY.test(key);
      const container = isPhoneContainerKey(key);
      const recognised = PHONE_KEYS.test(key) || (path.container && PHONE_ITEM_KEYS.test(key)) ||
        (officeKey && (phoneKey || faxKey || (nonPersonalKey(key) && /(^|_)(numbers?|lines?)(_|$)/.test(key))));
      walk(value, depth + 1, { container: path.container || container, recognised, phoneKey: path.phoneKey || phoneKey,
        office: officeKey, fax: faxKey, rank: label ? phoneRank(label) : path.rank }, scan);
      if (scan && detail.scanTruncated && leaves >= 40) break;
    }
  };
  walk(page, 0, root, false);
  if (!detail.found && !detail.officeLine) walk(page, 0, root, true);
  return detail;
}

/** The value a finder's answer carries, with detail for ranking, notes and rejects. */
export function foundContactDetailIn(kind: FinderKind, page: unknown): ContactDetail {
  if (kind === "phone") return phoneDetailIn(page);
  const detail: ContactDetail = { found: null, personalAlso: null, officeLine: null, rejected: 0, numberTyped: 0, scanTruncated: false };
  let sourceStatus: "good" | "bad" | null = null;
  const seen: string[] = [];
  const loose: string[] = [];
  const stray: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 8)) {
        if (typeof item === "string" && item.includes("@")) seen.push(item);
        else walk(item, depth + 1);
      }
      return;
    }
    if (typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (EMAIL_KEYS.test(key) && (typeof value === "string" || typeof value === "number")) {
        const raw = text(value);
        if (raw) seen.push(raw);
      } else if (typeof value === "string" && /mail/i.test(key) && !/status|valid|verif|deliver|score|quality|domain|provider/i.test(key)) {
        const raw = text(value);
        if (raw) loose.push(raw);
      } else if (typeof value === "string" && ADDRESS_ONLY.test(value.trim().replace(/^mailto:/i, ""))) {
        stray.push(text(value));
      } else if (/^(verification|email_status|status|verified|deliverability|validity)$/i.test(key)) {
        const status = typeof value === "object" && value !== null ? text((value as Record<string, unknown>).status) : text(value);
        if (value === true || GOOD_STATUS.test(status)) sourceStatus = sourceStatus ?? "good";
        else if (value === false || BAD_STATUS.test(status)) sourceStatus = "bad";
      } else if (typeof value === "object") walk(value, depth + 1);
    }
  };
  walk(page, 0);
  let bestRank = Infinity;
  let best: string | null = null;
  let personal: string | null = null;
  for (const value of [...seen, ...loose, ...stray]) {
    const type = emailValueTypeOf(value);
    if (type === "invalid") { detail.rejected += 1; continue; }
    if (type === "personal_mailbox") personal ??= value;
    const rank = type === "professional" ? 0 : 2;
    if (rank < bestRank) { bestRank = rank; best = value; }
  }
  if (best !== null) {
    const checked = verifyContactValue("work_email", best);
    detail.found = checked ? { value: checked, status: sourceStatus === "bad" ? "unverified" : "verified" } :
      { value: best.replace(/^mailto:/i, "").trim().toLowerCase(), status: "unverified" };
    if (bestRank === 0 && personal) detail.personalAlso = personal.replace(/^mailto:/i, "").trim().toLowerCase();
  }
  return detail;
}

/** The value a finder's answer carries, and whether it is verified: found by walking the answer (an object, a list of objects, nested `data`); a MASKED value (stars) is no value. verified = it passes the code check (a plausible address on a company domain, a phone of 7 to 15 digits) and the source does not say otherwise. */
export function foundContactIn(kind: FinderKind, page: unknown): FoundContact | null {
  return foundContactDetailIn(kind, page).found;
}

export const contactStatusAr = (s: "verified" | "unverified"): string => (s === "verified" ? CONTACT_STATUS_VERIFIED_AR : CONTACT_STATUS_UNVERIFIED_AR);

/**
 * PHASE 5: THE TYPE OF AN E-MAIL A PERSON FINDER RETURNED. A named address on a company's own domain (mina.naguib@orascom-em.com.eg) is a PROFESSIONAL address: the b2b_contact service.
 * An address on a free consumer mailbox provider (gmail.com, outlook.com, yahoo.*, icloud.com …: multiProvider/policy.ts) is a PRIVATE MAILBOX, whatever finder returned it: it belongs to
 * the sensitive category (data policy S1, personal contact), so it is never written in a work-email cell. A value that is not an address at all is invalid.
 */
export type EmailValueType = "professional" | "personal_mailbox" | "invalid";
export function emailValueTypeOf(value: unknown): EmailValueType {
  const t = String(value ?? "").trim().replace(/^mailto:/i, "").toLowerCase();
  const at = t.lastIndexOf("@");
  if (at <= 0 || !ADDRESS_ONLY.test(t) || t.includes("*")) return "invalid";
  return isPersonalMailDomain(t.slice(at + 1)) ? "personal_mailbox" : "professional";
}


// ------------------------------------------------------------------------------------------------ the company's own e-mail and HQ phone (audit 2026-11, reference A columns 5 and 6)

/** The mailbox listers of the catalog this account may buy, cheapest first: direct and synchronous, taking only a domain (a company's website), with a known price. They list the addresses found on a domain; the company's own role mailbox is picked from the answer (`companyMailboxIn`). */
export function mailboxListerSourcesOf(catalog: TregCatalog, isAllowed: (id: string) => boolean, stats: StatsMap = new Map(), now = Date.now()): FinderInfo[] {
  const domainInput = /^(?:domain|domains|website|domain_?or_?company)$/i;
  const usable = (e: CatalogEndpoint): boolean => !e.async && e.kind === "direct" && typeof e.cost?.usd === "number" && e.inputs.filter((i) => i.required).every((i) => domainInput.test(i.name)) && e.inputs.some((i) => domainInput.test(i.name));
  const group = catalog.endpoints.filter((e) => e.capability && MAILBOX_LISTER_CAPABILITIES.has(e.capability) && isAllowed(e.id) && usable(e));
  return rankedHelpers(group, catalog, stats, now, { maxUsd: FALLBACK_FINDER_MAX_USD });
}

/** The role mailboxes a company is most often written to on, best first (the owner's «الإيميل العام للشركة»: info@, contact@, sales@). */
const COMPANY_MAILBOX_ORDER: ReadonlyArray<string> = ["info", "contact", "contactus", "sales", "office", "hello", "enquiries", "inquiries", "admin", "support", "customercare", "customerservice", "marketing", "service", "mail", "reception"];

/** Every address in an answer (a list of mailboxes, nested `data`), lower case, once each. */
function addressesIn(page: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || node === undefined) return;
    if (typeof node === "string") { const t = text(node).replace(/^mailto:/i, "").toLowerCase(); if (ADDRESS_ONLY.test(t) && !t.includes("*") && !out.includes(t)) out.push(t); return; }
    if (Array.isArray(node)) { for (const x of node.slice(0, 80)) walk(x, depth + 1); return; }
    if (typeof node === "object") for (const v of Object.values(node as Record<string, unknown>)) walk(v, depth + 1);
  };
  walk(page, 0);
  return out;
}

/** THE COMPANY'S OWN MAILBOX in the answer of a lister (or any page): a role mailbox (info@, contact@, sales@) on the company's domain, the order above first. Never a person's address, never another domain's. Null when the answer has none. */
export function companyMailboxIn(page: unknown, companyDomain: string | null): string | null {
  const own = addressesIn(page).filter((e) => isRoleMailbox(e) && !emailOnOtherDomain(e, companyDomain));
  if (own.length === 0) return null;
  const rank = (e: string): number => { const local = e.split("@")[0].replace(/[._\-+\d]/g, ""); const at = COMPANY_MAILBOX_ORDER.indexOf(local); return at >= 0 ? at : COMPANY_MAILBOX_ORDER.length; };
  return [...own].sort((a, b) => rank(a) - rank(b))[0];
}

/** An address on the company's domain from a page, when no role mailbox was found. */
export function companyDomainAddressIn(page: unknown, companyDomain: string | null): string | null {
  if (!companyDomain || !companyDomain.trim()) return null;
  const list = addressesIn(page);
  for (const e of list) {
    if (!emailOnOtherDomain(e, companyDomain)) return e;
  }
  return null;
}

export const COMPANY_EMAIL_KEY = "company_email";
export const COMPANY_PHONE_KEY = "company_phone";

/**
 * THE COMPANY STEPS, BY CODE: for every delivered company stage that has a delivered people stage under it (the reference's «companies and their decision makers»), an e-mail step (the listers, cheapest first, then the e-mail verifiers; found anywhere, a role mailbox goes to the company's e-mail
 * and is verified «موثّق» / «غير موثّق») and a phone step (the map searches, only for a company whose own data has no phone). Priced by code like the people's steps: the expected cost per company is the first lister and the verifier, and the CAP of one company is the same (a dearer fallback never runs past it).
 * No step when the catalog offers nothing for a kind.
 */
export function buildCompanySteps(
  stages: ReadonlyArray<{ key: string; title_ar: string; parent_key: string | null; deliver: boolean; role_preference?: unknown }>,
  listers: ReadonlyArray<FinderInfo>,
  aids: (kind: FinderKind) => ContactAids,
  wants: { email: boolean; hasEmailColumn?: (stageKey: string) => boolean } = { email: false },
): ContactStep[] {
  const out: ContactStep[] = [];
  for (const st of stages) {
    if (!st.deliver || st.parent_key !== null || !isCompanyStage(st)) continue;
    const withPeople = stages.some((p) => p.deliver && p.parent_key === st.key && isPeopleStage(p));
    if (!withPeople && (!wants.email || wants.hasEmailColumn?.(st.key) === true)) continue;
    if (listers.length > 0) {
      const verifiers = aids("email").verifiers;
      const verifierUsd = verifiers && verifiers.length > 0 ? chainPriceUsd(verifiers, VERIFIER_PRICE_DEPTH) : 0;
      const perCompany = listers[0].usd + verifierUsd;
      out.push({ kind: "email", level: "company", stage_key: st.key, column_key: COMPANY_EMAIL_KEY, status_key: statusKeyOf(COMPANY_EMAIL_KEY), per_person_usd: perCompany, max_person_usd: perCompany, finders: listers.slice(0, FINDERS_PER_STEP), ...(verifiers && verifiers.length > 0 ? { verifiers } : {}), ...(withPeople ? {} : { own_columns: true as const }) });
    }
    const maps = aids("phone").company_phone;
    if (withPeople && maps && maps.length > 0) {
      const first = chainPriceUsd(maps, 1);
      out.push({ kind: "phone", level: "company", stage_key: st.key, column_key: COMPANY_PHONE_KEY, status_key: statusKeyOf(COMPANY_PHONE_KEY), per_person_usd: first, max_person_usd: Math.max(first, chainPriceUsd(maps, FINDERS_PER_STEP)), finders: [], company_phone: maps });
    }
  }
  return out;
}
