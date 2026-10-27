import { randomUUID } from "node:crypto";
import { categoryOf, mayUseSensitive, policyRuleOf, policyVerdict, type AccountAccess } from "../treg/dataPolicy";

/**
 * Who may reach the SENSITIVE data category, and the audit of every sensitive call (owner decision, enforced by code).
 *
 *  - Allowed: the admin, and customer accounts the admin marked «verified business» (table `verified_business_accounts`, see docs/proposals/agent-loop/05_sensitive_access.sql).
 *    Until that table exists nobody is verified, so the sensitive category is admin-only: the code works without the SQL.
 *  - A customer account must give a PURPOSE (short free text) before the plan is approved; it is stored on the plan item and written to the audit row.
 *  - Every sensitive call writes ONE audit row (table `sensitive_lookup_audit`): account, endpoint and its category (internal, never shown to a customer), the looked-up
 *    value MASKED, the purpose, the job id, the time and the cost. The row is written BEFORE the call (outcome «pending») and completed after it.
 *  - A customer account has a daily limit of `SENSITIVE_DAILY_LIMIT` lookups (UTC day); the next one is refused before any request. The admin is limited by cost
 *    (`ADMIN_LOOKUP_DAILY_CAP_USD`, see adminLookup.ts), not by count.
 *  - When the audit row cannot be written (the table is not applied yet) a CUSTOMER lookup is refused; an ADMIN lookup goes ahead and a structured log line carries the
 *    same masked fields.
 */
export const SENSITIVE_DAILY_LIMIT = 50;
export const SENSITIVE_AUDIT_TABLE = "sensitive_lookup_audit";
export const VERIFIED_BUSINESS_TABLE = "verified_business_accounts";
export const MIN_PURPOSE_CHARS = 5;

export const PURPOSE_QUESTION_ID = "sensitive_purpose";
export const PURPOSE_QUESTION_AR = "ما الغرض من استخدام هذه البيانات؟ اكتب جملة قصيرة (مثلًا: التواصل مع عميل محتمل لخدمة أقدمها).";
export const PURPOSE_REQUIRED_AR = "الغرض من الاستخدام مطلوب قبل اعتماد هذه الخدمة؛ اكتبه في جملة قصيرة، ولم يُحجز أي رصيد.";
export const SENSITIVE_LIMIT_AR = "بلغ حسابك الحد اليومي لهذا النوع من الاستعلامات؛ يمكنك المتابعة غدًا، ولم يُخصم أي رصيد.";
export const SENSITIVE_AUDIT_UNAVAILABLE_AR = "تعذّر تسجيل هذا الاستعلام الآن فلم يُنفَّذ؛ حاول لاحقًا، ولم يُخصم أي رصيد.";

/** What the audit row says about the looked-up value, without the value: a phone keeps its last 3 digits, an email its domain, a link its host, anything else only its length. */
export function maskLookupValue(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const email = /^[^@\s]+@([^@\s]+\.[^@\s]+)$/.exec(text);
  if (email) return `*@${email[1].toLowerCase()}`;
  const digits = text.replace(/[^\d]/g, "");
  if (/^[+\d\s().-]{7,}$/.test(text) && digits.length >= 7) return `***${digits.slice(-3)}`;
  const url = /^(?:https?:\/\/)?([^/\s]+)\/?/i.exec(text);
  if (url && /\./.test(url[1]) && /\//.test(text.replace(/^https?:\/\//i, ""))) return `${url[1].toLowerCase()}/***`;
  return `***(${text.length})`;
}

/** The kind of sensitive endpoint, for the audit row (internal: never shown to a customer). */
export function sensitiveCategoryLabel(endpointId: string): string {
  const rule = policyRuleOf(endpointId);
  const labels: Record<string, string> = {
    S1_personal_contact: "personal_contact",
    S2_reverse_lookup: "reverse_lookup",
    S3_identity_resolve: "identity_resolve",
    S4_person_lookup: "person_lookup",
    S5_enrich_by_email: "enrich_by_email",
    S6_advertising_ids: "advertising_ids",
    S7_personality: "personality",
    S8_home_address_family: "home_address",
  };
  return (rule && labels[rule]) || (categoryOf(endpointId) === "sensitive" ? "sensitive" : "other");
}

/** The audit's value of a call: the first parameter that carries what is being looked up (a phone, an email, a profile link, a name), masked. */
export function auditValueOfParams(params: Record<string, unknown> | null | undefined): string {
  const p = params || {};
  const keys = ["phone", "phone_number", "phoneNumber", "mobile", "email", "email_address", "emailAddress", "linkedin_url", "linkedinUrl", "profile_url", "url", "username", "handle", "full_name", "name", "domain", "q", "query"];
  for (const key of keys) {
    const v = p[key];
    if (typeof v === "string" && v.trim()) return maskLookupValue(v);
    if (typeof v === "number") return maskLookupValue(String(v));
  }
  return "";
}

export interface SensitiveAuditRow {
  id: string;
  created_at: string;
  account_id: string;
  is_admin: boolean;
  endpoint_id: string;
  endpoint_category: string;
  masked_value: string;
  purpose: string;
  job_id: string | null;
  cost_usd: number | null;
  outcome: "pending" | "called" | "failed" | "refused_access" | "refused_purpose" | "refused_limit" | "refused_audit";
}

const utcDayStart = (now: Date): string => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

/** The access of an account: the admin comes from the session role, «verified business» from the table the admin fills. A missing table or an error means NOT verified. */
export async function resolveAccountAccess(client: any, userId: string, hints: { isAdmin?: boolean } = {}): Promise<AccountAccess> {
  let isAdmin = hints.isAdmin === true;
  if (!isAdmin && client?.auth?.admin?.getUserById && userId) {
    try {
      const { data } = await client.auth.admin.getUserById(userId);
      isAdmin = data?.user?.app_metadata?.role === "admin";
    } catch { /* not an admin */ }
  }
  let verifiedBusiness = false;
  if (!isAdmin && userId && typeof client?.from === "function") {
    try {
      const { data, error } = await client.from(VERIFIED_BUSINESS_TABLE).select("verified").eq("user_id", userId).maybeSingle();
      verifiedBusiness = !error && data?.verified === true;
    } catch { verifiedBusiness = false; }
  }
  return { isAdmin, verifiedBusiness };
}

/** Sensitive lookups this account made today (UTC), or null when the audit table cannot be read. */
export async function countSensitiveLookupsToday(client: any, accountId: string, now: Date = new Date()): Promise<number | null> {
  if (typeof client?.from !== "function") return null;
  try {
    const { data, error } = await client.from(SENSITIVE_AUDIT_TABLE).select("id,outcome").eq("account_id", accountId).gte("created_at", utcDayStart(now)).lt("created_at", new Date(new Date(utcDayStart(now)).getTime() + 86_400_000).toISOString());
    if (error || !Array.isArray(data)) return null;
    return data.filter((r: any) => r.outcome === "pending" || r.outcome === "called" || r.outcome === "failed").length;
  } catch { return null; }
}

export async function writeSensitiveAudit(client: any, row: SensitiveAuditRow): Promise<boolean> {
  if (typeof client?.from !== "function") return false;
  try {
    const { error } = await client.from(SENSITIVE_AUDIT_TABLE).insert(row);
    return !error;
  } catch { return false; }
}

async function completeSensitiveAudit(client: any, id: string, patch: Partial<Pick<SensitiveAuditRow, "cost_usd" | "outcome">>): Promise<void> {
  if (typeof client?.from !== "function") return;
  try { await client.from(SENSITIVE_AUDIT_TABLE).update(patch).eq("id", id); } catch { /* the row was written before the call; its completion is best effort */ }
}

export type SensitiveRefusal = "blocked" | "sensitive_not_allowed" | "purpose_required" | "daily_limit" | "audit_unavailable";

export interface SensitiveCallInput<T> {
  client: any;
  account: { userId: string; access: AccountAccess };
  endpointId: string;
  /** What is looked up (a parameter map): only its MASKED form is ever stored. */
  params: Record<string, unknown>;
  purpose?: string | null;
  jobId?: string | null;
  now?: Date;
  /** Makes the call (the gateway) after every check passed; returns what it cost so the audit row can say. */
  call: () => Promise<{ result: T; costUsd: number; ok: boolean }>;
}

export type SensitiveCallOutcome<T> = { ok: true; result: T; auditId: string; auditWritten: boolean } | { ok: false; refused: SensitiveRefusal; auditId: string };

/**
 * ONE sensitive call, behind every check, with its audit row. Order: policy (blocked never; sensitive only for an allowed account) → purpose (customer accounts) →
 * daily limit (customer accounts) → audit row written → the call → the audit row completed with the cost.
 */
export async function runSensitiveCall<T>(input: SensitiveCallInput<T>): Promise<SensitiveCallOutcome<T>> {
  const now = input.now ?? new Date();
  const { client, account, endpointId } = input;
  const id = `sla_${randomUUID().replace(/-/g, "")}`;
  const base: Omit<SensitiveAuditRow, "outcome" | "cost_usd"> = {
    id,
    created_at: now.toISOString(),
    account_id: account.userId,
    is_admin: account.access.isAdmin === true,
    endpoint_id: endpointId,
    endpoint_category: sensitiveCategoryLabel(endpointId),
    masked_value: auditValueOfParams(input.params),
    purpose: String(input.purpose ?? "").trim().slice(0, 300),
    job_id: input.jobId ?? null,
  };
  const refuse = async (refused: SensitiveRefusal, outcome: SensitiveAuditRow["outcome"] | null): Promise<SensitiveCallOutcome<T>> => {
    if (outcome) await writeSensitiveAudit(client, { ...base, cost_usd: 0, outcome });
    return { ok: false, refused, auditId: id };
  };

  const verdict = policyVerdict(endpointId, account.access);
  if (!verdict.allowed) return refuse(verdict.reason, verdict.category === "sensitive" ? "refused_access" : null);
  if (verdict.category !== "sensitive") {
    // not a sensitive endpoint: no audit, no limit, just the call
    const out = await input.call();
    return { ok: true, result: out.result, auditId: id, auditWritten: false };
  }
  const isAdmin = account.access.isAdmin === true;
  if (!isAdmin && base.purpose.length < MIN_PURPOSE_CHARS) return refuse("purpose_required", "refused_purpose");
  if (!isAdmin) {
    const today = await countSensitiveLookupsToday(client, account.userId, now);
    if (today === null) return refuse("audit_unavailable", null);
    if (today >= SENSITIVE_DAILY_LIMIT) return refuse("daily_limit", "refused_limit");
  }
  const written = await writeSensitiveAudit(client, { ...base, cost_usd: null, outcome: "pending" });
  if (!written) {
    if (!isAdmin) return refuse("audit_unavailable", null);
    console.warn(JSON.stringify({ tag: "sensitive_audit_unavailable", auditId: id, accountId: base.account_id, endpointId, category: base.endpoint_category, maskedValue: base.masked_value, jobId: base.job_id }));
  }
  let out: { result: T; costUsd: number; ok: boolean };
  try {
    out = await input.call();
  } catch (err) {
    await completeSensitiveAudit(client, id, { cost_usd: 0, outcome: "failed" });
    throw err;
  }
  await completeSensitiveAudit(client, id, { cost_usd: Number(Math.max(0, out.costUsd).toFixed(6)), outcome: out.ok ? "called" : "failed" });
  return { ok: true, result: out.result, auditId: id, auditWritten: written };
}

/** What a refusal says to a customer (Arabic only, no provider, endpoint or category). */
export function sensitiveRefusalAr(refused: SensitiveRefusal): string {
  switch (refused) {
    case "sensitive_not_allowed": return "هذه الخدمة متاحة لحسابات الأعمال الموثّقة فقط؛ تواصل مع الدعم لتوثيق حسابك، ولم يُحجز أي رصيد.";
    case "purpose_required": return PURPOSE_REQUIRED_AR;
    case "daily_limit": return SENSITIVE_LIMIT_AR;
    case "audit_unavailable": return SENSITIVE_AUDIT_UNAVAILABLE_AR;
    default: return "هذه الخدمة غير متاحة حاليًا؛ ولم يُحجز أي رصيد.";
  }
}

export { mayUseSensitive };
