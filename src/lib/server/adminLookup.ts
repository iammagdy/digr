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

export type LookupKind = "phone" | "email";

export function classifyLookupInput(raw: unknown): { kind: LookupKind; value: string } | null {
  const text = String(raw ?? "").trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(text)) return { kind: "email", value: text.toLowerCase() };
  const digits = text.replace(/[^\d]/g, "");
  if (/^[+\d\s().-]{7,20}$/.test(text) && digits.length >= 7 && digits.length <= 15) return { kind: "phone", value: `${text.startsWith("+") ? "+" : ""}${digits}` };
  return null;
}

export interface LookupCandidate { id: string; paramName: string; costUsd: number; estimateUsd: number; okRate: number | null }

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
    out.push({ id: e.id, paramName: param, costUsd: cost.usd, estimateUsd: callEstimateUsd(cost, 1), okRate: typeof ok === "number" ? ok : null });
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

export type AdminLookupOutcome =
  | { ok: true; endpointId: string; costUsd: number; identity: ReturnType<typeof extractIdentity>; found: boolean; depth: number; hasDeeper: boolean; spentTodayUsd: number; capUsd: number }
  | { ok: false; reason: "bad_input" | "no_endpoint" | "daily_cap" | "no_deeper" | "failed" | "audit_unavailable"; spentTodayUsd: number; capUsd: number; costUsd?: number; hasDeeper?: boolean };

const utcDayStart = (now: Date): string => `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;

export async function readAdminLookupSpendToday(client: any, now: Date = new Date()): Promise<number | null> {
  if (typeof client?.from !== "function") return null;
  try {
    const { data, error } = await client.from("provider_costs").select("cost_usd,capability,created_at").eq("capability", ADMIN_LOOKUP_COST_MARKER).gte("created_at", utcDayStart(now)).lt("created_at", new Date(new Date(utcDayStart(now)).getTime() + 86_400_000).toISOString());
    if (error || !Array.isArray(data)) return null;
    return data.reduce((s: number, r: any) => s + Math.max(0, Number(r.cost_usd) || 0), 0);
  } catch { return null; }
}

const MEMORY = { day: new Map<string, number>() };
export function resetAdminLookupMemoryForTesting(): void { MEMORY.day.clear(); }

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
  const candidates = lookupCandidates(parsed.kind, catalog, input.policyRule ?? policyRuleOf);
  if (candidates.length === 0) return { ok: false, reason: "no_endpoint", spentTodayUsd: spentBefore, capUsd };
  const depth = Math.max(0, Math.floor(input.depth ?? 0));
  if (depth >= candidates.length) return { ok: false, reason: "no_deeper", spentTodayUsd: spentBefore, capUsd, hasDeeper: false };
  const chosen = candidates[depth];
  if (spentBefore + chosen.estimateUsd > capUsd + 1e-9) return { ok: false, reason: "daily_cap", spentTodayUsd: spentBefore, capUsd, hasDeeper: depth + 1 < candidates.length };

  const endpoint = catalog.byId.get(chosen.id)!;
  const call = input.call ?? executeTregCall;
  const jobId = `${ADMIN_LOOKUP_JOB_PREFIX}${randomUUID().replace(/-/g, "")}`;
  const budget = createJobCallBudget({ ceilingUsd: Math.max(0, capUsd - spentBefore), spentUsd: 0 });
  const out = await runSensitiveCall<TregCallResult>({
    client: input.client, account: { userId: input.adminId, access: { isAdmin: true, verifiedBusiness: false } }, endpointId: chosen.id, params: { [chosen.paramName]: parsed.value }, purpose: "admin reverse lookup", jobId, now,
    call: async () => {
      const r = await call({ endpointId: chosen.id, method: endpoint.method === "GET" ? "GET" : "POST", params: { [chosen.paramName]: parsed.value }, userId: input.adminId, jobId, stepId: "lookup", page: 1,
        routeMaxCostUsd: Number(Math.max(chosen.estimateUsd, 0.001).toFixed(6)), timeoutMs: 15_000, endpointScope: endpoint.scope, callBudget: budget, callEstimateUsd: chosen.estimateUsd, sensitiveAccess: { allowed: true } });
      return { result: r, costUsd: Math.max(0, r.costMicro || 0) / 1_000_000, ok: r.ok };
    },
  });
  if (!out.ok) return { ok: false, reason: out.refused === "audit_unavailable" ? "audit_unavailable" : "failed", spentTodayUsd: spentBefore, capUsd };
  const result = out.result;
  const costUsd = Math.max(0, result.costMicro || 0) / 1_000_000;
  MEMORY.day.set(day, (MEMORY.day.get(day) ?? 0) + costUsd);
  if (costUsd > 0 && typeof input.client?.from === "function") {
    try { await input.client.from("provider_costs").insert({ job_id: jobId, provider: "treg", units: 1, cost_usd: Number(costUsd.toFixed(6)), is_estimate: false, capability: ADMIN_LOOKUP_COST_MARKER, status: result.ok ? "ok" : "failed", duration_ms: Math.round(result.latencyMs || 0), created_at: now.toISOString() }); } catch { /* the in-memory day counter above still holds the cap for this process */ }
  }
  const hasDeeper = depth + 1 < candidates.length;
  if (!result.ok) return { ok: false, reason: result.budgetStopped ? "daily_cap" : "failed", spentTodayUsd: spentBefore + costUsd, capUsd, costUsd, hasDeeper };
  const reading = readShape(result.data, hintsOf(endpoint));
  const identity = extractIdentity(reading.rows[0]);
  return { ok: true, endpointId: chosen.id, costUsd, identity, found: Boolean(identity.name || identity.company || identity.title || identity.profileUrl), depth, hasDeeper, spentTodayUsd: spentBefore + costUsd, capUsd };
}
