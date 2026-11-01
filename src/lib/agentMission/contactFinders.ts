import type { CatalogEndpoint, TregCatalog } from "../treg/catalog";
import { EMAIL_FINDER_CAPABILITIES } from "./contactSampling";
import { requestWantsContacts, verifyContactValue, type ContactKind } from "./contacts";
import { isPeopleStage, nameKeysOf } from "./people";
import { PHONE_CAPABILITIES } from "./peopleCheck";
import { unitCost } from "../modelPlanner/pricing";
import { PHONE_TYPE_COLUMN_AR, phoneTypeKeyOf } from "./phoneValidation";
import { SOURCE_DEMOTE_FACTOR, expectedCost, sourceHealth, type StatsMap } from "./sourceRanking";
import { finderHitRate } from "./finderStats";

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
  /** PHONE steps: the cell that says whose number it is, «شخصي» / «رقم الشركة». */
  type_key?: string;
}

export const CONTACT_STATUS_VERIFIED_AR = "موثّق";
export const CONTACT_STATUS_UNVERIFIED_AR = "غير موثّق";
/** The most finders one person is tried with, per kind (the first that finds a value ends it). */
export const FINDERS_PER_STEP = 3;
export const statusKeyOf = (columnKey: string): string => `${columnKey}_status`;
const KIND_OF: Record<FinderKind, ContactKind> = { email: "work_email", phone: "phone" };
const DEFAULT_COLUMN: Record<FinderKind, { key: string; title_ar: string }> = { email: { key: "email", title_ar: "الإيميل" }, phone: { key: "phone", title_ar: "رقم التليفون" } };

/** The inputs a person gives a finder (a bare `url` input is NOT one: it takes an article, not a profile): the professional page, the name (whole, first, last), the company's domain and name. A finder that needs anything else (a webhook, a stored id) is not used. */
const INPUT_KINDS: ReadonlyArray<{ kind: "linkedin" | "name" | "first" | "last" | "domain" | "company"; test: RegExp }> = [
  { kind: "linkedin", test: /^(person_)?linkedin(_?url)?$|^profile_?url$/i },
  { kind: "first", test: /^first_?name$/i },
  { kind: "last", test: /^last_?name$/i },
  { kind: "name", test: /^(full_?)?name$/i },
  { kind: "domain", test: /^(company_?)?(domain|website)$|^company_?url$|^company_?domain$|^domain_?or_?company$/i },
  { kind: "company", test: /^company(_?name)?$/i },
];
const inputKindOf = (name: string): (typeof INPUT_KINDS)[number]["kind"] | null => INPUT_KINDS.find((k) => k.test.test(name))?.kind ?? null;

/**
 * THE HELPERS OF A STEP (finders, verifiers, validators), RANKED AND PRICED BY WHAT ONE CALL REALLY COSTS. The general source ranking divides a per-call price by the rows a call is expected to give (a list source returns many); a lookup returns ONE answer, so that division
 * under-prices a call that bills per call five-fold (quickenrich's 0.004834 became 0.00097) and the step's cap and the plan's price rested on it. Here the price is the catalog's price of one call (a routed endpoint at its dearest sibling), health and success rate come from the
 * general ranking, and the order is price over success rate, cheapest first, ties by id.
 */
function rankedHelpers(group: ReadonlyArray<CatalogEndpoint>, catalog: TregCatalog, stats: StatsMap, now: number): FinderInfo[] {
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
    const successRate = expectedCost(e, catalog, stats.get(e.id)).successRate;
    list.push({ key: (usd / successRate) * (health.state === "demoted" ? SOURCE_DEMOTE_FACTOR : 1), info: { id: e.id, usd, bill: e.cost?.type === "per_success" || e.cost?.type === "free" ? "success" : "call", inputs: e.inputs.map((i) => ({ name: i.name, required: i.required })) } });
  }
  return list.sort((a, b) => a.key - b.key || a.info.id.localeCompare(b.info.id)).slice(0, FINDERS_PER_STEP).map((x) => x.info);
}

/** The finders of a kind this account may buy, cheapest first (the helper ranking above). Only finders that answer at once and need only what a person row gives. */
export function finderSourcesOf(kind: FinderKind, catalog: TregCatalog, isAllowed: (id: string) => boolean, stats: StatsMap = new Map(), now = Date.now()): FinderInfo[] {
  const caps = kind === "email" ? EMAIL_FINDER_CAPABILITIES : PHONE_CAPABILITIES;
  const usable = (e: CatalogEndpoint): boolean => !e.async && e.inputs.filter((i) => i.required).every((i) => inputKindOf(i.name) !== null) && e.inputs.some((i) => inputKindOf(i.name) !== null);
  const group = catalog.endpoints.filter((e) => e.capability && caps.has(e.capability) && isAllowed(e.id) && usable(e));
  return rankedHelpers(group, catalog, stats, now);
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
export interface ContactAids { verifiers?: FinderInfo[]; validators?: FinderInfo[]; company_phone?: FinderInfo[] }

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
      const company_phone = kind === "phone" && help.company_phone && help.company_phone.length > 0 ? help.company_phone : undefined;
      const column_key = marked?.key ?? DEFAULT_COLUMN[kind].key;
      // what one person is EXPECTED to cost (the price): the chain of finders by measured hit rates, then for an e-mail the verifier for those an address was found for, for a phone the company-phone search for those no personal number was found for (one search per company: an upper bound) and
      // the validator every phone goes through. What one person may cost AT MOST (the cap): every finder of the chain, the verifier or the company-phone search and the validator, each at its full price.
      const chain = chainExpectation(list, kind);
      const verifierUsd = verifiers ? chainPriceUsd(verifiers, VERIFIER_PRICE_DEPTH) : 0;
      const companyUsd = company_phone ? chainPriceUsd(company_phone, FINDERS_PER_STEP) : 0;
      const validatorUsd = validators ? chainPriceUsd(validators) : 0;
      const perPerson = chain.costUsd + (1 - chain.missShare) * verifierUsd + chain.missShare * companyUsd + validatorUsd;
      const maxPerson = list.reduce((n, f) => n + f.usd, 0) + verifierUsd + companyUsd + validatorUsd;
      out.push({ kind, stage_key: st.key, column_key, status_key: statusKeyOf(column_key), per_person_usd: perPerson, max_person_usd: Math.max(perPerson, maxPerson), finders: list, ...(verifiers ? { verifiers } : {}), ...(validators ? { validators } : {}), ...(company_phone ? { company_phone } : {}), ...(kind === "phone" ? { type_key: phoneTypeKeyOf(column_key) } : {}) });
    }
  }
  return out;
}

/** The stage columns with the step's contact column (added when the planner left it out) and, right after it, the Arabic status column. A plan without steps is returned as it is. Idempotent. */
export function withContactColumns<C extends { key: string; title_ar: string; kind?: ContactKind; status_of?: string; type_of?: string }>(stageKey: string, columns: ReadonlyArray<C>, steps: ReadonlyArray<ContactStep> | undefined): C[] {
  const mine = (steps ?? []).filter((s) => s.stage_key === stageKey);
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
export interface PersonFacts { linkedin: string | null; name: string | null; first: string | null; last: string | null; domain: string | null; company: string | null }

const LINKEDIN_PERSON = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.[a-z.]+\/in\/[^\s?#]+/i;
const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").replace(/[​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();
const bareDomain = (v: unknown): string | null => { const t = text(v); if (!t || /linkedin\./i.test(t)) return null; const d = t.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0]; return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d) ? d.toLowerCase() : null; };

/** The facts of a person row (and of its company's row): decided by code from the values, not from the planner's key names alone. */
export function personFactsOf(row: Record<string, unknown>, columns: ReadonlyArray<{ key: string; title_ar?: string; kind?: string }>, parent: Record<string, unknown> | null): PersonFacts {
  const linkedin = Object.values(row).map(text).find((v) => LINKEDIN_PERSON.test(v)) ?? null;
  const name = nameKeysOf(columns).map((k) => text(row[k])).filter(Boolean).join(" ").trim() || null;
  const parts = name ? name.split(/\s+/) : [];
  const domainKey = (r: Record<string, unknown> | null): string | null => { if (!r) return null; for (const [k, v] of Object.entries(r)) if (/(website|domain|site|url)/i.test(k)) { const d = bareDomain(v); if (d) return d; } return null; };
  const companyOf = (r: Record<string, unknown> | null): string | null => { if (!r) return null; for (const [k, v] of Object.entries(r)) if (/^(company|company_name|name)$/i.test(k) && text(v)) return text(v); return null; };
  return { linkedin, name, first: parts.length > 1 ? parts[0] : null, last: parts.length > 1 ? parts.slice(1).join(" ") : null, domain: domainKey(row) ?? domainKey(parent), company: text(row.company) || companyOf(parent) };
}

/** The call parameters of a finder for a person, or null when the person lacks what the finder REQUIRES (it is then skipped for this person). At least one identifying input must be filled. */
export function finderParamsFor(finder: FinderInfo, p: PersonFacts): Record<string, string> | null {
  const value: Record<ReturnType<typeof inputKindOf> & string, string | null> = { linkedin: p.linkedin, name: p.name, first: p.first, last: p.last, domain: p.domain, company: p.company };
  const params: Record<string, string> = {};
  for (const i of finder.inputs) {
    const k = inputKindOf(i.name);
    const v = k ? value[k] : null;
    // a «name» input takes the whole name only when the finder has no first/last pair of its own (the whole name is also enough for the pair's finders, which split it)
    if (v) params[i.name] = v; else if (i.required) return null;
  }
  return Object.keys(params).length > 0 ? params : null;
}

export interface FoundContact { value: string; status: "verified" | "unverified" }
const EMAIL_KEYS = /^(work_?)?e-?mail(_address)?$/i;
const PHONE_KEYS = /^((mobile|direct|work)_?)?(phone|tel)(_?number)?$|^mobile$/i;
/** A value that is nothing but an address (optionally a mailto: link). */
const ADDRESS_ONLY = /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/;
const GOOD_STATUS = /^(valid|verified|deliverable|ok|safe|good)$/i;
const BAD_STATUS = /^(invalid|undeliverable|risky|unknown|catch_?all|accept_?all|disposable|bounce|bad)$/i;

/** The value a finder's answer carries, and whether it is verified: found by walking the answer (an object, a list of objects, nested `data`); a MASKED value (stars) is no value. verified = it passes the code check (a plausible address on a company domain, a phone of 7 to 15 digits) and the source does not say otherwise. */
export function foundContactIn(kind: FinderKind, page: unknown): FoundContact | null {
  const keys = kind === "email" ? EMAIL_KEYS : PHONE_KEYS;
  let sourceStatus: "good" | "bad" | null = null;
  const seen: string[] = [];
  // LESS SURE FINDS, taken only when no key named like an address gave one: any key with «mail» in its name, then any value that IS an address (live 2026-11-01: a finder BILLED a hit and the cell stayed empty, because the key was not one of the few names above)
  const loose: string[] = [];
  const stray: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || node === undefined) return;
    if (Array.isArray(node)) { for (const x of node.slice(0, 8)) { if (typeof x === "string" && kind === "email" && x.includes("@")) seen.push(x); else walk(x, depth + 1); } return; }
    if (typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (keys.test(k) && (typeof v === "string" || typeof v === "number")) { const t = text(v); if (t) seen.push(t); }
      else if (kind === "email" && typeof v === "string" && /mail/i.test(k) && !/status|valid|verif|deliver|score|quality|domain|provider/i.test(k) && v.includes("@")) { const t = text(v); if (t) loose.push(t); }
      else if (kind === "email" && typeof v === "string" && ADDRESS_ONLY.test(v.trim().replace(/^mailto:/i, ""))) { stray.push(text(v)); }
      else if (kind === "email" && /^(verification|email_status|status|verified|deliverability|validity)$/i.test(k)) {
        const s = typeof v === "object" && v !== null ? text((v as Record<string, unknown>).status) : text(v);
        if (v === true || GOOD_STATUS.test(s)) sourceStatus = sourceStatus ?? "good"; else if (v === false || BAD_STATUS.test(s)) sourceStatus = "bad";
      } else if (typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(page, 0);
  const usable = (v: string): boolean => !v.includes("*") && (kind === "email" ? v.includes("@") : v.replace(/\D/g, "").length >= 7);
  const raw = [...seen, ...loose, ...stray].find(usable);
  if (!raw) return null;
  const checked = verifyContactValue(KIND_OF[kind], raw);
  if (checked) return { value: checked, status: sourceStatus === "bad" ? "unverified" : "verified" };
  return { value: kind === "email" ? raw.replace(/^mailto:/i, "").trim().toLowerCase() : raw.trim(), status: "unverified" };
}

export const contactStatusAr = (s: "verified" | "unverified"): string => (s === "verified" ? CONTACT_STATUS_VERIFIED_AR : CONTACT_STATUS_UNVERIFIED_AR);
