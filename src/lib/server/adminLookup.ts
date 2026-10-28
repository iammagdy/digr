import { randomUUID } from "node:crypto";
import { executeTregCall, type TregCallOptions, type TregCallResult } from "../../functions/shared/tregClient";
import { createJobCallBudget } from "./callBudget";
import { runSensitiveCall } from "./sensitiveAccess";
import { loadTregCatalog, type CatalogEndpoint, type TregCatalog } from "../treg/catalog";
import { categoryOf, policyRuleOf } from "../treg/dataPolicy";
import { hintsOf, readShape } from "../treg/shapeReader";
import { callEstimateUsd, unitCost } from "../modelPlanner/pricing";
import { COMPANY_DOMAIN_ONLY_ENDPOINTS, EMAIL_REVERSE_ORDER, NO_WATERFALL_ENDPOINTS, PHONE_REVERSE_ORDER, US_ONLY_PHONE_ENDPOINTS, isCompanyDomainEmail } from "../treg/reverseOrder";
import { isUsefulIdentity, mergeFields, type LookupFields } from "../adminLookupResult";

/**
 * The ADMIN REVERSE LOOKUP: the admin types a phone number or an email address. The order of the endpoints comes from live evidence (src/lib/treg/reverseOrder.ts): an e-mail goes through
 * the e-mail list in order and stops at the first USEFUL answer («بحث أعمق» continues and merges the fields of the next answers, each field keeping its source); a phone number runs only
 * the FREE endpoints by default, and a paid one only after the admin confirmed its price (with a warning when its coverage of the number's country is unproven). It shows name, company,
 * title, profile link and country, and the real cost in USD (this screen is admin-only). No customer points are used. Every lookup is written to the same audit log as every sensitive call,
 * and a daily cost cap stops the day's spending.
 */
export const ADMIN_LOOKUP_DAILY_CAP_USD = 2;
export const ADMIN_LOOKUP_COST_MARKER = "admin_lookup";
export const ADMIN_LOOKUP_JOB_PREFIX = "adminlookup_";
/** The purpose every admin lookup carries in the audit log (the day's admin spend is read back from the rows that carry it). */
export const ADMIN_LOOKUP_PURPOSE = "admin reverse lookup";

export type LookupKind = "phone" | "email";

export function classifyLookupInput(raw: unknown): { kind: LookupKind; value: string } | null {
  const text = String(raw ?? "").trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(text)) return { kind: "email", value: text.toLowerCase() };
  const digits = text.replace(/[^\d]/g, "");
  if (/^[+\d\s().-]{7,20}$/.test(text) && digits.length >= 7 && digits.length <= 15) return { kind: "phone", value: `${text.startsWith("+") ? "+" : ""}${digits}` };
  return null;
}

export interface LookupCandidate { id: string; paramName: string; costUsd: number; estimateUsd: number; okRate: number | null; /** The countries the catalog's own text limits this endpoint to (["US"] for «a US phone number»), or null when it states none. */ countries: string[] | null; /** Costs money (a free endpoint costs nothing and may run without a confirmation). */ paid: boolean }

/** Calling codes of the countries the admin is likely to look up (longest match first); «US» covers +1. */
const CALLING_CODES: Array<[string, string]> = [["971", "AE"], ["966", "SA"], ["962", "JO"], ["965", "KW"], ["974", "QA"], ["973", "BH"], ["968", "OM"], ["961", "LB"], ["964", "IQ"], ["963", "SY"], ["967", "YE"], ["970", "PS"], ["212", "MA"], ["213", "DZ"], ["216", "TN"], ["218", "LY"], ["249", "SD"], ["20", "EG"], ["44", "GB"], ["33", "FR"], ["49", "DE"], ["91", "IN"], ["90", "TR"], ["39", "IT"], ["34", "ES"], ["1", "US"]];

/** The country of a phone number written with its international prefix («+20…», «0020…»); null when the number carries none (a local number: the country is not guessed). */
export function phoneCountry(value: string): string | null {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  const international = String(value ?? "").trim().startsWith("+") ? digits : digits.startsWith("00") ? digits.slice(2) : null;
  if (!international) return null;
  for (const [code, country] of CALLING_CODES) if (international.startsWith(code)) return country;
  return null;
}

/** The countries a catalog endpoint is limited to, read from its own words («Look up a professional profile from a US phone number»). Null when its text names no limit. */
export function endpointCountries(e: Pick<CatalogEndpoint, "name" | "summary" | "inputs">): string[] | null {
  const text = [e.name, e.summary, ...e.inputs.map((i) => i.note)].filter(Boolean).join(" . ");
  if (/\b(?:US|U\.S\.|USA|United States)(?:-based)?\s+(?:phone|mobile|number|numbers|only)\b|\b(?:phone|mobile)\s+numbers?\s+(?:in|of|from)\s+the\s+(?:US|United States)\b|\bUS(?:\/Canada)?\s+(?:and Canada\s+)?only\b/i.test(text)) return ["US"];
  return null;
}

/** Can this endpoint serve a number of this country? Unknown country (a local number) or no stated limit: yes. */
export function coversCountry(countries: string[] | null, country: string | null): boolean {
  if (!countries || !country) return true;
  return countries.includes(country) || (countries.includes("US") && country === "CA");
}

const REVERSE_RULES = new Set(["S2_reverse_lookup", "S3_identity_resolve", "S5_enrich_by_email", "S4_person_lookup"]);

function paramFor(endpoint: CatalogEndpoint, kind: LookupKind): string | null {
  const strings = endpoint.inputs.filter((i) => /^(string|str|url|any)?$/i.test(String(i.type ?? "")) || i.type === null);
  const required = strings.filter((i) => i.required);
  const byName = (re: RegExp) => (required.length > 0 ? required : strings).find((i) => re.test(i.name));
  const hit = kind === "phone" ? byName(/phone|mobile|number|msisdn/i) : byName(/e-?mail/i);
  if (hit) return hit.name;
  return required.length === 1 ? required[0].name : null;
}

/**
 * The reverse-lookup endpoints for this kind of input IN THE ORDER LIVE EVIDENCE GAVE (src/lib/treg/reverseOrder.ts): the listed ones first, in their order; any other priceable reverse-lookup
 * endpoint the catalog gained since comes after them, cheapest first. Only the endpoints that need nothing but the one value the admin typed are listed.
 */
export function lookupCandidates(kind: LookupKind, catalog: TregCatalog = loadTregCatalog(), policyRule: (id: string) => string | null = policyRuleOf): LookupCandidate[] {
  const build = (e: CatalogEndpoint): LookupCandidate | null => {
    // a catalog price of exactly 0 (a free endpoint, which the planner cannot SELL) is fine for the admin's own lookup
    const free = e.cost?.usd === 0 && e.cost?.failed_or_empty_billed !== undefined && !(e.kind === "routed");
    const cost = free ? { usd: 0, unit: "call" as const, basis: "catalog" as const } : unitCost(e, catalog);
    const param = paramFor(e, kind);
    if (!cost || !param) return null;
    if (e.inputs.some((i) => i.required && i.name !== param)) return null; // needs more than the one value the admin typed
    const ok = (e.observed as { ok_rate?: number } | null)?.ok_rate;
    return { id: e.id, paramName: param, costUsd: cost.usd, estimateUsd: free ? 0 : callEstimateUsd(cost, 1), okRate: typeof ok === "number" ? ok : null, countries: kind === "phone" ? endpointCountries(e) : null, paid: cost.usd > 0 };
  };
  const listed = kind === "phone" ? PHONE_REVERSE_ORDER : EMAIL_REVERSE_ORDER;
  const out: LookupCandidate[] = [];
  for (const id of listed) { const e = catalog.byId.get(id); const c = e ? build(e) : null; if (c) out.push(c); }
  const others: LookupCandidate[] = [];
  for (const e of catalog.endpoints) {
    if (listed.includes(e.id) || categoryOf(e.id) !== "sensitive") continue;
    const rule = policyRule(e.id);
    if (!rule || !REVERSE_RULES.has(rule)) continue;
    const phoneEndpoint = /phone|mobile/i.test(e.id);
    if (kind === "phone" ? !phoneEndpoint : phoneEndpoint) continue;
    const c = build(e);
    if (c) others.push(c);
  }
  others.sort((a, b) => a.costUsd - b.costUsd || (b.okRate ?? 0) - (a.okRate ?? 0) || a.id.localeCompare(b.id));
  return [...out, ...others];
}

/** What the screen shows for one candidate before anything runs. */
export interface LookupPlanEntry {
  id: string; paramName: string; usd: number; paid: boolean;
  /** auto: runs by itself; confirm: runs only after the admin confirmed its price; skipped: not for this input. */
  state: "auto" | "confirm" | "skipped";
  /** Arabic, for the screen: why it is skipped. */
  skipReasonAr?: string;
  /** Arabic: the warning shown with the price (coverage of the number's country unproven, or a US-only service for a number elsewhere). */
  warningAr?: string;
}

/** The plan for one input: every candidate in order with its state. A free-mailbox address skips the company-only endpoint; a paid phone endpoint waits for the admin's confirmation; the US-only one is never automatic. */
export function lookupPlan(kind: LookupKind, value: string, catalog: TregCatalog = loadTregCatalog(), policyRule: (id: string) => string | null = policyRuleOf): LookupPlanEntry[] {
  const country = kind === "phone" ? phoneCountry(value) : null;
  return lookupCandidates(kind, catalog, policyRule).map((c): LookupPlanEntry => {
    const base = { id: c.id, paramName: c.paramName, usd: c.estimateUsd, paid: c.paid };
    if (kind === "email") {
      if (COMPANY_DOMAIN_ONLY_ENDPOINTS.includes(c.id) && !isCompanyDomainEmail(value)) return { ...base, state: "skipped", skipReasonAr: "يجيب عن الشركات فقط، وهذا بريد على نطاق عام (outlook وgmail وأمثالهما)" };
      return { ...base, state: "auto" };
    }
    if (!coversCountry(c.countries, country)) return { ...base, state: "skipped", skipReasonAr: `هذه الخدمة محدودة بحسب كتالوجها بأرقام ${c.countries?.join("/")}` };
    const usOnly = US_ONLY_PHONE_ENDPOINTS.includes(c.id);
    const proven = Boolean(country && c.countries?.includes(country)) || (usOnly && country === "US");
    const warningAr = usOnly && country !== "US"
      ? "هذه الخدمة للأرقام الأمريكية، ولا تُشغَّل تلقائيًا لرقم من خارج أمريكا؛ تغطيتها لدولة هذا الرقم غير مثبتة"
      : !proven && c.paid ? "تغطية هذه الخدمة لدولة هذا الرقم غير مثبتة" : undefined;
    if (!c.paid) return { ...base, state: "auto" };
    return { ...base, state: "confirm", ...(warningAr ? { warningAr } : {}) };
  });
}

const pick = (row: Record<string, unknown>, re: RegExp, valid: (v: unknown) => boolean): string => {
  const walk = (value: unknown, depth: number): string => {
    if (depth > 3 || value === null || typeof value !== "object") return "";
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (re.test(k) && valid(v)) return String(v).slice(0, 160);
    }
    for (const v of Object.values(value as Record<string, unknown>)) { const found = walk(v, depth + 1); if (found) return found; }
    return "";
  };
  return walk(row, 0);
};
const isText = (v: unknown) => typeof v === "string" && v.trim().length > 0;
const isLink = (v: unknown) => typeof v === "string" && /^https?:\/\//i.test(v.trim());

/** Name, company, title, profile link and country read from the first row of an answer (admin screen only). A brand record (branddev) is about the COMPANY: its title is the company's name, never a job title. */
export function extractIdentity(row: Record<string, unknown> | undefined, endpointId = ""): { name: string; company: string; title: string; profileUrl: string; country: string } {
  if (!row) return { name: "", company: "", title: "", profileUrl: "", country: "" };
  const country = pick(row, /^(country|country_?name|country_?code|location_?country)$/i, isText);
  if (/^branddev\./.test(endpointId)) {
    return { name: "", company: pick(row, /^(title|name|brand_?name|company_?name|company)$/i, isText), title: "", profileUrl: pick(row, /^(linkedin|linkedin_?url|url|domain)$/i, isLink), country };
  }
  const first = pick(row, /^(first_?name|given_?name)$/i, isText), last = pick(row, /^(last_?name|family_?name|surname)$/i, isText);
  return {
    name: pick(row, /^(full_?name|name|display_?name|person_?name)$/i, isText) || [first, last].filter(Boolean).join(" "),
    company: pick(row, /^(company|company_?name|employer|organi[sz]ation|current_?company)$/i, isText),
    title: pick(row, /^(title|job_?title|headline|position|current_?title|role)$/i, isText),
    profileUrl: pick(row, /(linkedin|profile)_?(url|link)?$|^url$|^link$/i, isLink),
    country,
  };
}

/** What one attempt did, for the admin screen only. */
export interface LookupAttempt {
  endpointId: string;
  outcome: "found" | "no_data" | "failed" | "skipped_country" | "skipped" | "needs_confirmation" | "cap";
  costUsd: number;
  /** English, internal: why it was skipped or what went wrong. */
  note: string;
}

type Identity = ReturnType<typeof extractIdentity>;

export type AdminLookupOutcome =
  | { ok: true; endpointId: string; costUsd: number; identity: Identity; fields: LookupFields; found: boolean; depth: number; hasDeeper: boolean; spentTodayUsd: number; capUsd: number; attempts: LookupAttempt[] }
  | { ok: false; reason: "bad_input" | "no_endpoint" | "daily_cap" | "no_deeper" | "failed" | "audit_unavailable"; spentTodayUsd: number; capUsd: number; costUsd?: number; hasDeeper?: boolean; attempts?: LookupAttempt[] };

const utcDayStart = (now: Date): string => `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;

/**
 * What the admin lookups spent today (UTC), from the audit log: every lookup writes its real cost there (provider_costs cannot hold it: its job id must be a real job). Null when the
 * log cannot be read.
 */
export async function readAdminLookupSpendToday(client: any, now: Date = new Date()): Promise<number | null> {
  if (typeof client?.from !== "function") return null;
  try {
    const { data, error } = await client.from("sensitive_lookup_audit").select("cost_usd,purpose,is_admin,created_at").eq("purpose", ADMIN_LOOKUP_PURPOSE).gte("created_at", utcDayStart(now)).lt("created_at", new Date(new Date(utcDayStart(now)).getTime() + 86_400_000).toISOString());
    if (error || !Array.isArray(data)) return null;
    return data.reduce((s: number, r: any) => s + Math.max(0, Number(r.cost_usd) || 0), 0);
  } catch { return null; }
}

const MEMORY = { day: new Map<string, number>() };
export function resetAdminLookupMemoryForTesting(): void { MEMORY.day.clear(); }

type CallFn = (o: TregCallOptions) => Promise<TregCallResult>;

export type AttemptResult =
  | { ok: true; attempt: LookupAttempt; identity: Identity; fields: LookupFields; found: boolean; spentTodayUsd: number; capUsd: number }
  | { ok: false; reason: "bad_input" | "unknown_endpoint" | "skipped" | "needs_confirmation" | "daily_cap" | "audit_unavailable" | "refused"; attempt?: LookupAttempt; priceUsd?: number; warningAr?: string; spentTodayUsd: number; capUsd: number };

/**
 * ONE attempt: one endpoint of the plan for this input. A skipped endpoint is never called; a paid phone endpoint is called only when `confirmedUsd` is at least its catalog price (the admin
 * saw the price and the warning); the day's cap, the audit row and the sensitive-access checks all apply. The fields of the answer are merged INTO `previous` (an earlier field is never replaced).
 */
export async function runLookupAttempt(input: {
  client: any; adminId: string; text: string; endpointId: string; confirmedUsd?: number; previous?: LookupFields; catalog?: TregCatalog; call?: CallFn; now?: Date; policyRule?: (id: string) => string | null;
}): Promise<AttemptResult> {
  const now = input.now ?? new Date();
  const capUsd = ADMIN_LOOKUP_DAILY_CAP_USD;
  const day = now.toISOString().slice(0, 10);
  const fromDb = await readAdminLookupSpendToday(input.client, now);
  const spent = Math.max(fromDb ?? 0, MEMORY.day.get(day) ?? 0);
  const parsed = classifyLookupInput(input.text);
  if (!parsed) return { ok: false, reason: "bad_input", spentTodayUsd: spent, capUsd };
  const catalog = input.catalog ?? loadTregCatalog();
  const plan = lookupPlan(parsed.kind, parsed.value, catalog, input.policyRule ?? policyRuleOf);
  const entry = plan.find((p) => p.id === input.endpointId);
  const endpoint = catalog.byId.get(input.endpointId);
  if (!entry || !endpoint) return { ok: false, reason: "unknown_endpoint", spentTodayUsd: spent, capUsd };
  const skippedAttempt = (outcome: LookupAttempt["outcome"], note: string): LookupAttempt => ({ endpointId: entry.id, outcome, costUsd: 0, note });
  if (entry.state === "skipped") return { ok: false, reason: "skipped", attempt: skippedAttempt(/US|limited/.test(entry.skipReasonAr ?? "") ? "skipped_country" : "skipped", entry.skipReasonAr ?? "skipped"), spentTodayUsd: spent, capUsd };
  if (entry.state === "confirm" && !(Number(input.confirmedUsd) >= entry.usd - 1e-9)) return { ok: false, reason: "needs_confirmation", attempt: skippedAttempt("needs_confirmation", "a paid phone endpoint runs only after the admin confirmed its price"), priceUsd: entry.usd, ...(entry.warningAr ? { warningAr: entry.warningAr } : {}), spentTodayUsd: spent, capUsd };
  if (spent + entry.usd > capUsd + 1e-9) return { ok: false, reason: "daily_cap", attempt: skippedAttempt("cap", "the day's cap would be passed"), spentTodayUsd: spent, capUsd };

  const call = input.call ?? executeTregCall;
  const jobId = `${ADMIN_LOOKUP_JOB_PREFIX}${randomUUID().replace(/-/g, "")}`;
  const budget = createJobCallBudget({ ceilingUsd: Math.max(0, capUsd - spent), spentUsd: 0 });
  const value = parsed.value;
  const out = await runSensitiveCall<TregCallResult>({
    client: input.client, account: { userId: input.adminId, access: { isAdmin: true, verifiedBusiness: false } }, endpointId: entry.id, params: { [entry.paramName]: value }, purpose: ADMIN_LOOKUP_PURPOSE, jobId, now,
    call: async () => {
      const r = await call({ endpointId: entry.id, method: endpoint.method === "GET" ? "GET" : "POST", params: { [entry.paramName]: value }, userId: input.adminId, jobId, stepId: "lookup", page: 1,
        routeMaxCostUsd: Number(Math.max(entry.usd, 0.001).toFixed(6)), timeoutMs: 15_000, endpointScope: endpoint.scope, callBudget: budget, callEstimateUsd: entry.usd, sensitiveAccess: { allowed: true },
        ...(NO_WATERFALL_ENDPOINTS.includes(entry.id) ? { routeWaterfall: false } : {}) });
      return { result: r, costUsd: Math.max(0, r.costMicro || 0) / 1_000_000, ok: r.ok };
    },
  });
  if (!out.ok) {
    if (out.refused === "audit_unavailable") return { ok: false, reason: "audit_unavailable", spentTodayUsd: spent, capUsd };
    return { ok: false, reason: "refused", attempt: skippedAttempt("failed", `refused: ${String(out.refused)}`), spentTodayUsd: spent, capUsd };
  }
  const result = out.result;
  const costUsd = Math.max(0, result.costMicro || 0) / 1_000_000;
  MEMORY.day.set(day, (MEMORY.day.get(day) ?? 0) + costUsd);
  const spentAfter = spent + costUsd;
  if (!result.ok) {
    const attempt: LookupAttempt = { endpointId: entry.id, outcome: "failed", costUsd, note: result.budgetStopped ? "stopped by the day's cap" : `HTTP ${result.httpStatus}${result.errorDetails ? `: ${String(result.errorDetails).slice(0, 100)}` : ""}` };
    return { ok: true, attempt, identity: extractIdentity(undefined), fields: input.previous ?? {}, found: false, spentTodayUsd: spentAfter, capUsd };
  }
  const reading = readShape(result.data, hintsOf(endpoint));
  const identity = extractIdentity(reading.rows[0], entry.id);
  const found = isUsefulIdentity(identity);
  const attempt: LookupAttempt = { endpointId: entry.id, outcome: found ? "found" : "no_data", costUsd, note: found ? "" : "the source answered with no data" };
  return { ok: true, attempt, identity, fields: found ? mergeFields(input.previous, entry.id, identity) : input.previous ?? {}, found, spentTodayUsd: spentAfter, capUsd };
}

/**
 * The whole lookup in one call (the route's default when the screen does not drive the attempts one by one). The automatic candidates of the plan are tried IN ORDER, starting at the `depth`-th,
 * until one gives a USEFUL answer; the paid phone endpoints and the skipped ones are never tried here (they need the admin's confirmation, which only the attempt-by-attempt screen can give).
 * A «بحث أعمق» passes the fields found so far: the answers that follow are merged into them.
 */
export async function runAdminLookup(input: {
  client: any; adminId: string; text: string; depth?: number; previous?: LookupFields; catalog?: TregCatalog; call?: CallFn; now?: Date; policyRule?: (id: string) => string | null;
}): Promise<AdminLookupOutcome> {
  const now = input.now ?? new Date();
  const capUsd = ADMIN_LOOKUP_DAILY_CAP_USD;
  const day = now.toISOString().slice(0, 10);
  const fromDb = await readAdminLookupSpendToday(input.client, now);
  const spentBefore = Math.max(fromDb ?? 0, MEMORY.day.get(day) ?? 0);
  const parsed = classifyLookupInput(input.text);
  if (!parsed) return { ok: false, reason: "bad_input", spentTodayUsd: spentBefore, capUsd };
  const catalog = input.catalog ?? loadTregCatalog();
  const policyRule = input.policyRule ?? policyRuleOf;
  const all = lookupPlan(parsed.kind, parsed.value, catalog, policyRule);
  if (all.length === 0) return { ok: false, reason: "no_endpoint", spentTodayUsd: spentBefore, capUsd };
  const depth = Math.max(0, Math.floor(input.depth ?? 0));
  if (depth >= all.length) return { ok: false, reason: "no_deeper", spentTodayUsd: spentBefore, capUsd, hasDeeper: false };
  const attempts: LookupAttempt[] = [];
  let fields: LookupFields = input.previous ?? {};
  let total = 0;
  let spent = spentBefore;
  let lastIndex = depth - 1;
  let found = false;
  let lastIdentity: Identity = extractIdentity(undefined);
  let lastEndpoint = all[depth].id;
  let sawAnswer = false;
  for (let index = depth; index < all.length; index += 1) {
    const entry = all[index];
    lastIndex = index;
    if (entry.state === "skipped") { attempts.push({ endpointId: entry.id, outcome: /خدمة محدودة/.test(entry.skipReasonAr ?? "") ? "skipped_country" : "skipped", costUsd: 0, note: entry.skipReasonAr ?? "skipped" }); continue; }
    if (entry.state === "confirm") { attempts.push({ endpointId: entry.id, outcome: "needs_confirmation", costUsd: 0, note: "paid: runs only after the admin confirmed its price" }); continue; }
    const r = await runLookupAttempt({ client: input.client, adminId: input.adminId, text: input.text, endpointId: entry.id, previous: fields, catalog, call: input.call, now, policyRule });
    if (!r.ok) {
      if (r.reason === "audit_unavailable") return { ok: false, reason: "audit_unavailable", spentTodayUsd: spent, capUsd, attempts };
      if (r.attempt) attempts.push(r.attempt);
      if (r.reason === "daily_cap") break;
      continue;
    }
    attempts.push(r.attempt);
    total += r.attempt.costUsd;
    spent = r.spentTodayUsd;
    if (r.attempt.outcome !== "failed") sawAnswer = true;
    lastEndpoint = entry.id; lastIdentity = r.found ? r.identity : lastIdentity;
    fields = r.fields;
    if (r.found) { found = true; break; }
  }
  if (!sawAnswer) {
    const capped = attempts.some((a) => a.outcome === "cap");
    if (capped && !attempts.some((a) => a.outcome === "failed")) return { ok: false, reason: "daily_cap", spentTodayUsd: spent, capUsd, costUsd: total, hasDeeper: false, attempts };
    if (attempts.every((a) => a.outcome === "skipped" || a.outcome === "skipped_country" || a.outcome === "needs_confirmation")) return { ok: false, reason: "no_endpoint", spentTodayUsd: spent, capUsd, attempts };
    return { ok: false, reason: attempts.some((a) => a.outcome === "failed") ? "failed" : "no_endpoint", spentTodayUsd: spent, capUsd, costUsd: total, hasDeeper: false, attempts };
  }
  const hasDeeper = all.slice(lastIndex + 1).some((e) => e.state === "auto");
  return { ok: true, endpointId: lastEndpoint, costUsd: total, identity: lastIdentity, fields, found: found || Object.keys(fields).length > 0, depth: lastIndex, hasDeeper, spentTodayUsd: spent, capUsd, attempts };
}
