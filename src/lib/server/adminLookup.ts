import { randomUUID } from "node:crypto";
import { executeTregCall, type TregCallOptions, type TregCallResult } from "../../functions/shared/tregClient";
import { createJobCallBudget } from "./callBudget";
import { runSensitiveCall } from "./sensitiveAccess";
import { loadTregCatalog, type CatalogEndpoint, type TregCatalog } from "../treg/catalog";
import { categoryOf, policyRuleOf } from "../treg/dataPolicy";
import { hintsOf, readShape } from "../treg/shapeReader";
import { callEstimateUsd, unitCost } from "../modelPlanner/pricing";

/**
 * The ADMIN REVERSE LOOKUP: the admin types a phone number or an email address; code runs the CHEAPEST suitable reverse-lookup endpoint first, and a stronger (costlier) one only when
 * the admin asks for a deeper search. It shows name, company, title and profile link, and the real cost in USD (this screen is admin-only). No customer points are used. The cost is
 * recorded in provider_costs with capability «admin_lookup», every lookup is written to the same audit log as every sensitive call, and a daily cost cap stops the day's spending.
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

export interface LookupCandidate { id: string; paramName: string; costUsd: number; estimateUsd: number; okRate: number | null; /** The countries the catalog's own text limits this endpoint to (["US"] for «a US phone number»), or null when it states none. */ countries: string[] | null }

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

/** The reverse-lookup endpoints for this kind of input, cheapest first (priceable ones only). */
export function lookupCandidates(kind: LookupKind, catalog: TregCatalog = loadTregCatalog(), policyRule: (id: string) => string | null): LookupCandidate[] {
  const out: LookupCandidate[] = [];
  for (const e of catalog.endpoints) {
    if (categoryOf(e.id) !== "sensitive") continue;
    const rule = policyRule(e.id);
    if (!rule || !REVERSE_RULES.has(rule)) continue;
    const phoneEndpoint = /phone|mobile/i.test(e.id);
    if (kind === "phone" ? !phoneEndpoint : phoneEndpoint) continue;
    const cost = unitCost(e, catalog);
    const param = paramFor(e, kind);
    if (!cost || !param) continue;
    if (e.inputs.some((i) => i.required && i.name !== param)) continue; // needs more than the one value the admin typed
    const ok = (e.observed as { ok_rate?: number } | null)?.ok_rate;
    out.push({ id: e.id, paramName: param, costUsd: cost.usd, estimateUsd: callEstimateUsd(cost, 1), okRate: typeof ok === "number" ? ok : null, countries: kind === "phone" ? endpointCountries(e) : null });
  }
  return out.sort((a, b) => a.costUsd - b.costUsd || (b.okRate ?? 0) - (a.okRate ?? 0) || a.id.localeCompare(b.id));
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

/** Name, company, title and profile link read from the first row of an answer (admin screen only). */
export function extractIdentity(row: Record<string, unknown> | undefined): { name: string; company: string; title: string; profileUrl: string } {
  if (!row) return { name: "", company: "", title: "", profileUrl: "" };
  const first = pick(row, /^(first_?name|given_?name)$/i, isText), last = pick(row, /^(last_?name|family_?name|surname)$/i, isText);
  return {
    name: pick(row, /^(full_?name|name|display_?name|person_?name)$/i, isText) || [first, last].filter(Boolean).join(" "),
    company: pick(row, /^(company|company_?name|employer|organi[sz]ation|current_?company)$/i, isText),
    title: pick(row, /^(title|job_?title|headline|position|current_?title|role)$/i, isText),
    profileUrl: pick(row, /(linkedin|profile)_?(url|link)?$|^url$|^link$/i, isLink),
  };
}

/** What one attempt did, for the admin screen only. */
export interface LookupAttempt {
  endpointId: string;
  outcome: "found" | "no_data" | "failed" | "skipped_country" | "cap";
  costUsd: number;
  /** English, internal: why it was skipped or what went wrong. */
  note: string;
}

export type AdminLookupOutcome =
  | { ok: true; endpointId: string; costUsd: number; identity: ReturnType<typeof extractIdentity>; found: boolean; depth: number; hasDeeper: boolean; spentTodayUsd: number; capUsd: number; attempts: LookupAttempt[] }
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

/**
 * Runs the lookup. Starting at the endpoint `depth`, the candidates that cover the number's country (read from the catalog's own text: «a US phone number» is not tried for +20) are
 * tried one after another, cheapest first, until one FINDS the person; a call that answers «no data» or fails moves on to the next, while the day's cap allows. The attempts and their
 * real cost are returned for the admin screen (this screen is admin-only; a customer never sees them).
 */
export async function runAdminLookup(input: {
  client: any; adminId: string; text: string; depth?: number; catalog?: TregCatalog; call?: (o: TregCallOptions) => Promise<TregCallResult>; now?: Date; policyRule?: (id: string) => string | null;
}): Promise<AdminLookupOutcome> {
  const now = input.now ?? new Date();
  const capUsd = ADMIN_LOOKUP_DAILY_CAP_USD;
  const day = now.toISOString().slice(0, 10);
  const fromDb = await readAdminLookupSpendToday(input.client, now);
  const spentBefore = Math.max(fromDb ?? 0, MEMORY.day.get(day) ?? 0);
  const parsed = classifyLookupInput(input.text);
  if (!parsed) return { ok: false, reason: "bad_input", spentTodayUsd: spentBefore, capUsd };
  const catalog = input.catalog ?? loadTregCatalog();
  const all = lookupCandidates(parsed.kind, catalog, input.policyRule ?? policyRuleOf);
  if (all.length === 0) return { ok: false, reason: "no_endpoint", spentTodayUsd: spentBefore, capUsd };
  const depth = Math.max(0, Math.floor(input.depth ?? 0));
  if (depth >= all.length) return { ok: false, reason: "no_deeper", spentTodayUsd: spentBefore, capUsd, hasDeeper: false };
  const country = parsed.kind === "phone" ? phoneCountry(input.text) : null;
  const attempts: LookupAttempt[] = [];
  let spent = spentBefore;
  let total = 0;
  const call = input.call ?? executeTregCall;
  let last: { chosen: LookupCandidate; identity: ReturnType<typeof extractIdentity>; index: number } | null = null;

  for (let index = depth; index < all.length; index += 1) {
    const chosen = all[index];
    if (!coversCountry(chosen.countries, country)) { attempts.push({ endpointId: chosen.id, outcome: "skipped_country", costUsd: 0, note: `limited to ${chosen.countries?.join("/")} by the catalog; the number is ${country}` }); continue; }
    if (spent + chosen.estimateUsd > capUsd + 1e-9) { attempts.push({ endpointId: chosen.id, outcome: "cap", costUsd: 0, note: "the day's cap would be passed" }); break; }
    const endpoint = catalog.byId.get(chosen.id)!;
    const jobId = `${ADMIN_LOOKUP_JOB_PREFIX}${randomUUID().replace(/-/g, "")}`;
    const budget = createJobCallBudget({ ceilingUsd: Math.max(0, capUsd - spent), spentUsd: 0 });
    const out = await runSensitiveCall<TregCallResult>({
      client: input.client, account: { userId: input.adminId, access: { isAdmin: true, verifiedBusiness: false } }, endpointId: chosen.id, params: { [chosen.paramName]: parsed.value }, purpose: ADMIN_LOOKUP_PURPOSE, jobId, now,
      call: async () => {
        const r = await call({ endpointId: chosen.id, method: endpoint.method === "GET" ? "GET" : "POST", params: { [chosen.paramName]: parsed.value }, userId: input.adminId, jobId, stepId: "lookup", page: 1,
          routeMaxCostUsd: Number(Math.max(chosen.estimateUsd, 0.001).toFixed(6)), timeoutMs: 15_000, endpointScope: endpoint.scope, callBudget: budget, callEstimateUsd: chosen.estimateUsd, sensitiveAccess: { allowed: true } });
        return { result: r, costUsd: Math.max(0, r.costMicro || 0) / 1_000_000, ok: r.ok };
      },
    });
    if (!out.ok) {
      if (out.refused === "audit_unavailable") return { ok: false, reason: "audit_unavailable", spentTodayUsd: spent, capUsd, attempts };
      attempts.push({ endpointId: chosen.id, outcome: "failed", costUsd: 0, note: `refused: ${String(out.refused)}` });
      continue;
    }
    const result = out.result;
    const costUsd = Math.max(0, result.costMicro || 0) / 1_000_000;
    spent += costUsd; total += costUsd;
    MEMORY.day.set(day, (MEMORY.day.get(day) ?? 0) + costUsd);
    if (!result.ok) {
      attempts.push({ endpointId: chosen.id, outcome: "failed", costUsd, note: result.budgetStopped ? "stopped by the day's cap" : `HTTP ${result.httpStatus}${result.errorDetails ? `: ${String(result.errorDetails).slice(0, 100)}` : ""}` });
      if (result.budgetStopped) break;
      continue;
    }
    const reading = readShape(result.data, hintsOf(endpoint));
    const identity = extractIdentity(reading.rows[0]);
    const found = Boolean(identity.name || identity.company || identity.title || identity.profileUrl);
    attempts.push({ endpointId: chosen.id, outcome: found ? "found" : "no_data", costUsd, note: found ? "" : "the source answered with no data" });
    last = { chosen, identity, index };
    if (found) break;
  }
  const answered = attempts.some((a) => a.outcome === "found" || a.outcome === "no_data");
  if (!last || !answered) {
    const capped = attempts.some((a) => a.outcome === "cap");
    if (capped && !attempts.some((a) => a.outcome === "failed")) return { ok: false, reason: "daily_cap", spentTodayUsd: spent, capUsd, costUsd: total, hasDeeper: false, attempts };
    if (attempts.every((a) => a.outcome === "skipped_country")) return { ok: false, reason: "no_endpoint", spentTodayUsd: spent, capUsd, attempts };
    return { ok: false, reason: attempts.some((a) => a.outcome === "failed") ? "failed" : "no_endpoint", spentTodayUsd: spent, capUsd, costUsd: total, hasDeeper: false, attempts };
  }
  const found = attempts.some((a) => a.outcome === "found");
  return { ok: true, endpointId: last.chosen.id, costUsd: total, identity: last.identity, found, depth: last.index, hasDeeper: !found && last.index + 1 < all.length, spentTodayUsd: spent, capUsd, attempts };
}
