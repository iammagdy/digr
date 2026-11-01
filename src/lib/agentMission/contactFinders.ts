import type { CatalogEndpoint, TregCatalog } from "../treg/catalog";
import { EMAIL_FINDER_CAPABILITIES } from "./contactSampling";
import { requestWantsContacts, verifyContactValue, type ContactKind } from "./contacts";
import { isPeopleStage, nameKeysOf } from "./people";
import { PHONE_CAPABILITIES } from "./peopleCheck";
import { rankEndpoints, type StatsMap } from "./sourceRanking";

/**
 * THE CONTACT FINDER STEPS, BY CODE. Live test 2026-11-01 (A1 msn_7a8b…, A2 msn_020c…): 14 decision makers delivered, every e-mail and phone cell empty. The approved plans had two stages (companies, people); the people stage maps `email: ''` and `phone: ''`
 * and nothing in the plan or in the job looked an e-mail or a phone up (the planner was told a finder it had not sampled left the cells «filled only if found during the approved job», and the job never looked). Owner direction: whenever the customer asks
 * for an e-mail, a phone or any contact field for PEOPLE, the approved plan MUST contain the finder step(s); a planning-sample cap limits sampling only. So the step is not the planner's to plan or to drop: for every delivered people stage the plan check adds one
 * step per asked kind, ranked cheapest first from the catalog, and the engine runs it after the stages (agent/src/engine/contacts.ts). The step fills CELLS of the person who was already delivered; it adds no row, so the delivered count and the charge are untouched.
 */
export type FinderKind = "email" | "phone";
export interface FinderInput { name: string; required: boolean }
/** A finder the catalog offers, with what it needs to be called (so the engine can tell, per person, which finders it can call). */
export interface FinderInfo { id: string; usd: number; inputs: FinderInput[] }
export interface ContactStep {
  kind: FinderKind;
  /** The people stage whose persons are enriched. */
  stage_key: string;
  /** The cell that gets the value, and the cell that says whether it is verified. */
  column_key: string;
  status_key: string;
  /** What one person is expected to cost this step (USD): the cheapest ranked finder's price. It is part of the price by code (plan.ts `stagePriceInputs`), and it caps what the step may spend (engine). */
  per_person_usd: number;
  /** The finders this account may buy, cheapest first (at most FINDERS_PER_STEP). */
  finders: FinderInfo[];
}

export const CONTACT_STATUS_VERIFIED_AR = "موثّق";
export const CONTACT_STATUS_UNVERIFIED_AR = "غير موثّق";
/** The most finders one person is tried with, per kind (the first that finds a value ends it). */
export const FINDERS_PER_STEP = 3;
export const statusKeyOf = (columnKey: string): string => `${columnKey}_status`;
const KIND_OF: Record<FinderKind, ContactKind> = { email: "work_email", phone: "phone" };
const DEFAULT_COLUMN: Record<FinderKind, { key: string; title_ar: string }> = { email: { key: "email", title_ar: "الإيميل" }, phone: { key: "phone", title_ar: "رقم التليفون" } };

/** The inputs a person gives a finder: the professional page, the name (whole, first, last), the company's domain and name. A finder that needs anything else (a webhook, a stored id) is not used. */
const INPUT_KINDS: ReadonlyArray<{ kind: "linkedin" | "name" | "first" | "last" | "domain" | "company"; test: RegExp }> = [
  { kind: "linkedin", test: /^(person_)?linkedin(_?url)?$|^linkedin_?handle$|^profile_?url$|^url$/i },
  { kind: "first", test: /^first_?name$/i },
  { kind: "last", test: /^last_?name$/i },
  { kind: "name", test: /^(full_?)?name$/i },
  { kind: "domain", test: /^(company_?)?(domain|url|website)$|^domain_?or_?company$/i },
  { kind: "company", test: /^company(_?name)?$/i },
];
const inputKindOf = (name: string): (typeof INPUT_KINDS)[number]["kind"] | null => INPUT_KINDS.find((k) => k.test.test(name))?.kind ?? null;

/** The finders of a kind this account may buy, cheapest first by the same ranking as every source (measured cost where it exists, the catalog otherwise). Only finders that answer at once and need only what a person row gives. */
export function finderSourcesOf(kind: FinderKind, catalog: TregCatalog, isAllowed: (id: string) => boolean, stats: StatsMap = new Map(), now = Date.now()): FinderInfo[] {
  const caps = kind === "email" ? EMAIL_FINDER_CAPABILITIES : PHONE_CAPABILITIES;
  const usable = (e: CatalogEndpoint): boolean => !e.async && e.inputs.filter((i) => i.required).every((i) => inputKindOf(i.name) !== null) && e.inputs.some((i) => inputKindOf(i.name) !== null);
  const group = catalog.endpoints.filter((e) => e.capability && caps.has(e.capability) && isAllowed(e.id) && usable(e));
  return rankEndpoints(group, catalog, stats, now).ranked.slice(0, FINDERS_PER_STEP).map((r) => {
    const e = catalog.byId.get(r.id)!;
    return { id: r.id, usd: Number(r.usdPerItem) > 0 ? Number(r.usdPerItem) : 0.000001, inputs: e.inputs.map((i) => ({ name: i.name, required: i.required })) };
  });
}

/** The steps a plan needs: one per asked kind for every DELIVERED people stage. `finders(kind)` is the catalog's ranked list (empty: the step is still there, with nothing to call, and the file says nothing was found). */
export function buildContactSteps(
  stages: ReadonlyArray<{ key: string; title_ar: string; parent_key: string | null; deliver: boolean; role_preference?: unknown; columns: ReadonlyArray<{ key: string; kind?: string }> }>,
  requestText: string | undefined,
  finders: (kind: FinderKind) => FinderInfo[],
): ContactStep[] {
  const wants = requestWantsContacts(requestText);
  const out: ContactStep[] = [];
  for (const st of stages) {
    if (!st.deliver || !isPeopleStage(st)) continue;
    for (const kind of ["email", "phone"] as const) {
      const marked = st.columns.find((c) => c.kind === KIND_OF[kind]);
      if (!(kind === "email" ? wants.email : wants.phone) && !marked) continue;
      const list = finders(kind);
      const column_key = marked?.key ?? DEFAULT_COLUMN[kind].key;
      out.push({ kind, stage_key: st.key, column_key, status_key: statusKeyOf(column_key), per_person_usd: list[0]?.usd ?? 0, finders: list });
    }
  }
  return out;
}

/** The stage columns with the step's contact column (added when the planner left it out) and, right after it, the Arabic status column. A plan without steps is returned as it is. Idempotent. */
export function withContactColumns<C extends { key: string; title_ar: string; kind?: ContactKind; status_of?: string }>(stageKey: string, columns: ReadonlyArray<C>, steps: ReadonlyArray<ContactStep> | undefined): C[] {
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
  }
  return out;
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
const GOOD_STATUS = /^(valid|verified|deliverable|ok|safe|good)$/i;
const BAD_STATUS = /^(invalid|undeliverable|risky|unknown|catch_?all|accept_?all|disposable|bounce|bad)$/i;

/** The value a finder's answer carries, and whether it is verified: found by walking the answer (an object, a list of objects, nested `data`); a MASKED value (stars) is no value. verified = it passes the code check (a plausible address on a company domain, a phone of 7 to 15 digits) and the source does not say otherwise. */
export function foundContactIn(kind: FinderKind, page: unknown): FoundContact | null {
  const keys = kind === "email" ? EMAIL_KEYS : PHONE_KEYS;
  let sourceStatus: "good" | "bad" | null = null;
  const seen: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 4 || node === null || node === undefined) return;
    if (Array.isArray(node)) { for (const x of node.slice(0, 5)) { if (typeof x === "string" && kind === "email" && x.includes("@")) seen.push(x); else walk(x, depth + 1); } return; }
    if (typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (keys.test(k) && (typeof v === "string" || typeof v === "number")) { const t = text(v); if (t) seen.push(t); }
      else if (kind === "email" && /^(verification|email_status|status|verified|deliverability|validity)$/i.test(k)) {
        const s = typeof v === "object" && v !== null ? text((v as Record<string, unknown>).status) : text(v);
        if (v === true || GOOD_STATUS.test(s)) sourceStatus = sourceStatus ?? "good"; else if (v === false || BAD_STATUS.test(s)) sourceStatus = "bad";
      } else if (typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(page, 0);
  const raw = seen.find((v) => !v.includes("*") && (kind === "email" ? v.includes("@") : v.replace(/\D/g, "").length >= 7));
  if (!raw) return null;
  const checked = verifyContactValue(KIND_OF[kind], raw);
  if (checked) return { value: checked, status: sourceStatus === "bad" ? "unverified" : "verified" };
  return { value: kind === "email" ? raw.replace(/^mailto:/i, "").trim().toLowerCase() : raw.trim(), status: "unverified" };
}

export const contactStatusAr = (s: "verified" | "unverified"): string => (s === "verified" ? CONTACT_STATUS_VERIFIED_AR : CONTACT_STATUS_UNVERIFIED_AR);
