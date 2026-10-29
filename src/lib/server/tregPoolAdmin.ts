import { randomUUID } from "node:crypto";
import { cleanKey, last4Of, validateKeyShape } from "./providerKeyCrypto";
import { resolveLegacyProviderKey } from "./providerKeys";
import type { FetchLike } from "./providerStatus";
import { readProviderKeySettings } from "./providerKeyAdmin";
import type { TregKeyPool } from "./tregKeyPool";
import { checkPoolKey, runPoolHealth, type HealthRunResult } from "./tregPoolHealth";
import { encryptPoolKey } from "./tregPoolCrypto";

/**
 * Everything the admin «مجمّع مفاتيح TREG» section reads and does (docs/proposals/treg-key-pool/README.md). Admin only: the route verifies the role first and every SQL
 * function verifies it again from the auth record. A key enters here only as a pasted string, is validated against TREG BEFORE anything is saved (a rejected key is never
 * stored), is encrypted in this process with the Vault key, and is never returned, logged, put in an error, an audit line or an e-mail: screens get the last 4 characters.
 */
export const MSG = {
  sqlNotReady: "تحديث قاعدة البيانات الخاص بمجمّع المفاتيح لم يُطبَّق بعد. لم يتغير شيء.",
  encryptionUnavailable: "تعذّرت قراءة مفتاح التشفير من الخزنة، لذلك لا يمكن حفظ مفتاح الآن. لم يُحفظ شيء.",
  rejected: "رفض المزود هذا المفتاح، لذلك لم يُحفظ.",
  unreachable: "تعذر الاتصال بالمزود للتحقق من المفتاح، لذلك لم يُحفظ. حاول بعد قليل.",
  unexpected: "ردّ المزود بشكل غير متوقع أثناء التحقق، لذلك لم يُحفظ المفتاح.",
  duplicate: "هذا المفتاح مضاف بالفعل.",
  tooMany: "محاولات كثيرة لتغيير المفاتيح. انتظر بضع دقائق ثم حاول مرة أخرى.",
  failed: "تعذّر تنفيذ الطلب الآن. لم يتغير شيء.",
  notAdmin: "هذا الإجراء مخصص للمسؤولين فقط.",
  invalidRequest: "طلب غير صالح.",
  noMainAvailable: "لا يوجد مفتاح حالي يمكن اعتماده؛ الصق المفتاح الرئيسي يدويًا.",
  added: "تم التحقق من المفتاح وحفظه مشفّرًا.",
  adopted: "اعتُمد المفتاح الحالي كمفتاح رئيسي (نُسخ على الخادم ولم يظهر في أي شاشة).",
  replaced: "تم التحقق من المفتاح الجديد وحفظه مشفّرًا.",
  removed: "حُذف المفتاح.",
  activated: "فُعّل المفتاح: تستخدمه المنصة كلها (الموقع والعامل) من الطلب التالي خلال ثوانٍ.",
  chainSaved: "حُفظ ترتيب السلسلة. المفتاح الرئيسي يبقى الأخير دائمًا.",
  rolloutOn: "شُغّل المجمّع: المنصة كلها تستخدم المفتاح النشط من الجدول.",
  rolloutOff: "أُوقف المجمّع: عادت المنصة إلى المفتاح الحالي كما كانت قبله (خلال ثوانٍ).",
  settingsSaved: "حُفظ الحد الأدنى للرصيد.",
  refreshed: "تم الفحص.",
} as const;

export interface PoolActionOutcome { ok: boolean; reason: string; messageAr: string; status: number; keyId?: string; number?: number; last4?: string | null }
export interface PoolAdminDeps { client: any; pool: TregKeyPool; fetchFn?: FetchLike; now?: () => number }

// ---- attempt limiter for the actions that take a key (per server instance: slows mistakes and abuse) ------------------------------------
const attempts = new Map<string, number[]>();
export const POOL_KEY_CHANGE_LIMIT = { max: 12, windowMs: 10 * 60_000 };
export function __resetPoolLimiter(): void { attempts.clear(); }
function tooMany(adminId: string, now: number): boolean {
  const recent = (attempts.get(adminId) || []).filter((t) => now - t < POOL_KEY_CHANGE_LIMIT.windowMs);
  if (recent.length >= POOL_KEY_CHANGE_LIMIT.max) { attempts.set(adminId, recent); return true; }
  attempts.set(adminId, [...recent, now]);
  return false;
}

const isMissingFn = (e: any) => /PGRST202|42883|42P01|PGRST205|could not find the function|does not exist|schema cache/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`);

async function rpc(deps: PoolAdminDeps, name: string, args: Record<string, unknown>): Promise<{ data: any; error: any }> {
  try { return await deps.client.rpc(name, args); } catch (e) { return { data: null, error: e }; }
}

/** The outcome of an admin function (`{success, error, error_ar}`) as an action outcome. */
function fromFunction(name: string, res: { data: any; error: any }, okMessage: string, extra: Partial<PoolActionOutcome> = {}): PoolActionOutcome {
  if (res.error) {
    if (isMissingFn(res.error)) return { ok: false, reason: "sql_not_ready", messageAr: MSG.sqlNotReady, status: 409 };
    console.error(`[treg_pool:${name}_failed] code=${String(res.error?.code || "unknown")}`);
    return { ok: false, reason: "failed", messageAr: MSG.failed, status: 500 };
  }
  if (res.data?.success !== true) {
    const reason = String(res.data?.error || "failed");
    return { ok: false, reason, messageAr: reason === "not_admin" ? MSG.notAdmin : (typeof res.data?.error_ar === "string" && res.data.error_ar) || MSG.failed, status: reason === "not_admin" ? 403 : 400 };
  }
  return { ok: true, reason: "ok", messageAr: okMessage, status: 200, ...extra };
}

const validUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const labelOf = (v: unknown): string | null => { const t = typeof v === "string" ? v.trim() : ""; return t.length >= 1 && t.length <= 60 ? t : null; };

// ---- the overview ---------------------------------------------------------------------------------------------------------------------

export interface PoolKeyView {
  id: string; number: number; label: string; isMain: boolean; inChain: boolean; chainPosition: number; isActive: boolean;
  last4: string | null; accountEmail: string | null;
  status: "unknown" | "connected" | "error" | "revoked" | "out_of_balance"; statusReason: string | null; statusCheckedAt: string | null;
  balanceUsd: number | null; balanceCheckedAt: string | null;
  spend: { calls: number; usd: number; todayUsd: number; lastCallAt: string | null };
}
export interface PoolOverview {
  ready: boolean;
  rolloutOn: boolean;
  activeKeyId: string | null;
  generation: number;
  minBalanceUsd: number;
  lastHealthRunAt: string | null;
  keys: PoolKeyView[];
  events: Array<{ at: string; kind: string; keyNumber: number | null; keyLabel: string | null; toKeyNumber: number | null; toKeyLabel: string | null; reason: string | null; source: string | null }>;
  legacy: { source: string; last4: string | null };
  workerEnvLast4: string | null;
  workerSeenAt: string | null;
  workerMismatch: boolean;
  noticesAr: string[];
  health?: HealthRunResult;
}

const microToUsd = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v / 1_000_000 : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) / 1_000_000 : null);
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export async function loadPoolOverview(deps: PoolAdminDeps, options: { refresh?: boolean } = {}): Promise<PoolOverview> {
  const empty: PoolOverview = {
    ready: false, rolloutOn: false, activeKeyId: null, generation: 0, minBalanceUsd: 0.01, lastHealthRunAt: null, keys: [], events: [],
    legacy: { source: "none", last4: null }, workerEnvLast4: null, workerSeenAt: null, workerMismatch: false, noticesAr: [],
  };
  const legacy = await resolveLegacyProviderKey("treg").catch(() => null);
  empty.legacy = { source: legacy?.source ?? "none", last4: legacy?.last4 ?? null };

  let health: HealthRunResult | undefined;
  if (options.refresh) {
    const settings = await readProviderKeySettings(deps.client).catch(() => null);
    health = await runPoolHealth({ client: deps.client, pool: deps.pool, fetchFn: deps.fetchFn, now: deps.now, mainOrgId: settings?.tregOrgId ?? null, source: "admin", budgetMs: 40_000 });
  }

  const ov = await rpc(deps, "treg_pool_overview", {});
  if (ov.error || !ov.data?.state) {
    return { ...empty, noticesAr: [isMissingFn(ov.error) ? MSG.sqlNotReady : "تعذّرت قراءة مجمّع المفاتيح الآن."] };
  }
  const spendRes = await rpc(deps, "treg_pool_spend", {});
  const spendBy = new Map<number, { calls: number; usd: number; todayUsd: number; lastCallAt: string | null }>();
  for (const r of Array.isArray(spendRes.data) ? spendRes.data : []) spendBy.set(Number(r.key_number), { calls: num(r.calls), usd: num(r.spend_usd), todayUsd: num(r.spend_today_usd), lastCallAt: r.last_call_at ?? null });

  const state = ov.data.state;
  const keys: PoolKeyView[] = (Array.isArray(ov.data.keys) ? ov.data.keys : []).map((k: any) => ({
    id: String(k.id), number: Number(k.number), label: String(k.label), isMain: Boolean(k.is_main), inChain: Boolean(k.in_chain), chainPosition: Number(k.chain_position) || 0,
    isActive: state.active_key_id === k.id, last4: k.last4 ?? null, accountEmail: k.account_email ?? null,
    status: ["connected", "error", "revoked", "out_of_balance"].includes(k.status) ? k.status : "unknown", statusReason: k.status_reason ?? null, statusCheckedAt: k.status_checked_at ?? null,
    balanceUsd: microToUsd(k.balance_micro), balanceCheckedAt: k.balance_checked_at ?? null,
    spend: spendBy.get(Number(k.number)) ?? { calls: 0, usd: 0, todayUsd: 0, lastCallAt: null },
  }));
  const main = keys.find((k) => k.isMain);
  const workerEnvLast4: string | null = state.worker_env_last4 ?? null;
  const workerMismatch = Boolean(main?.last4 && workerEnvLast4 && main.last4 !== workerEnvLast4);

  const noticesAr: string[] = [];
  if (!main) noticesAr.push("لا يوجد مفتاح رئيسي بعد. اضغط «اعتماد المفتاح الحالي كمفتاح رئيسي» قبل تشغيل المجمّع.");
  if (workerMismatch) noticesAr.push(`المتغير TREG_TOKEN على Heroku (ينتهي بـ ${workerEnvLast4}) ليس هو المفتاح الرئيسي في الجدول (ينتهي بـ ${main?.last4}). يستخدمه العامل فقط عند إيقاف المجمّع أو تعذّر قراءة القاعدة.`);
  if (health && !health.ok) noticesAr.push(health.problem === "sql_not_ready" ? "ملف التحديث ٠٦ (قراءة المفاتيح للفحص) لم يُطبَّق بعد، لذلك لم يجرِ الفحص." : health.problem === "encryption_unavailable" ? MSG.encryptionUnavailable : "تعذّرت قراءة المفاتيح للفحص الآن.");

  return {
    ready: true, rolloutOn: Boolean(state.rollout_on), activeKeyId: state.active_key_id ?? null, generation: num(state.generation),
    minBalanceUsd: (microToUsd(state.min_balance_micro) ?? 0.01), lastHealthRunAt: state.last_health_run_at ?? null, keys,
    events: (Array.isArray(ov.data.events) ? ov.data.events : []).map((e: any) => ({ at: e.at, kind: e.kind, keyNumber: e.key_number ?? null, keyLabel: e.key_label ?? null, toKeyNumber: e.to_key_number ?? null, toKeyLabel: e.to_key_label ?? null, reason: e.reason ?? null, source: e.source ?? null })),
    legacy: { source: legacy?.source ?? "none", last4: legacy?.last4 ?? null }, workerEnvLast4, workerSeenAt: state.worker_seen_at ?? null, workerMismatch, noticesAr, ...(health ? { health } : {}),
  };
}

// ---- actions -----------------------------------------------------------------------------------------------------------------------------

/** Checks a candidate key with TREG before anything is saved. */
async function vetKey(deps: PoolAdminDeps, key: string, orgId?: string | null): Promise<{ ok: true; result: Awaited<ReturnType<typeof checkPoolKey>> } | { ok: false; outcome: PoolActionOutcome }> {
  const result = await checkPoolKey(key, { fetchFn: deps.fetchFn, orgId: orgId ?? null });
  if (result.status === "revoked") return { ok: false, outcome: { ok: false, reason: "rejected", messageAr: MSG.rejected, status: 422 } };
  if (result.status === null) return { ok: false, outcome: { ok: false, reason: "unreachable", messageAr: MSG.unreachable, status: 502 } };
  if (result.status === "error") return { ok: false, outcome: { ok: false, reason: "unexpected", messageAr: MSG.unexpected, status: 502 } };
  return { ok: true, result };
}

async function recordAdminCheck(deps: PoolAdminDeps, keyId: string, r: Awaited<ReturnType<typeof checkPoolKey>>): Promise<void> {
  await rpc(deps, "treg_pool_record_check", { p_key_id: keyId, p_status: r.status, p_reason: r.reason, p_balance_micro: r.balanceMicro, p_email: r.email, p_source: "admin" });
}

async function saveNewKey(deps: PoolAdminDeps, input: { adminId: string; label: string; key: string; isMain: boolean }): Promise<PoolActionOutcome> {
  const enc = await deps.pool.encryptionKey();
  if (!enc) return { ok: false, reason: "encryption_unavailable", messageAr: MSG.encryptionUnavailable, status: 503 };
  const settings = input.isMain ? await readProviderKeySettings(deps.client).catch(() => null) : null;
  const vet = await vetKey(deps, input.key, settings?.tregOrgId);
  if (!vet.ok) return vet.outcome;
  const last4 = last4Of(input.key);
  if (!last4) return { ok: false, reason: "invalid_key", messageAr: "المفتاح غير صالح.", status: 400 };

  // the same key twice: same last 4 and the same account (or an account the provider did not name)
  const current = await rpc(deps, "treg_pool_overview", {});
  if (!current.error) {
    const same = (Array.isArray(current.data?.keys) ? current.data.keys : []).some((k: any) => k.last4 === last4 && (!k.account_email || !vet.result.email || k.account_email === vet.result.email));
    if (same) return { ok: false, reason: "duplicate", messageAr: MSG.duplicate, status: 409 };
  }

  const id = randomUUID();
  const ciphertext = encryptPoolKey(enc, id, input.key);
  const res = await rpc(deps, "admin_add_treg_pool_key", { p_admin_id: input.adminId, p_id: id, p_label: input.label, p_ciphertext: ciphertext, p_last4: last4, p_email: vet.result.email, p_is_main: input.isMain });
  const outcome = fromFunction("add", res, input.isMain ? MSG.adopted : MSG.added, { keyId: id, number: Number(res.data?.number) || undefined, last4 });
  if (outcome.ok) { await recordAdminCheck(deps, id, vet.result); deps.pool.invalidate(); }
  return outcome;
}

export async function addPoolKey(deps: PoolAdminDeps, input: { adminId: string; label: unknown; key: unknown }): Promise<PoolActionOutcome> {
  const label = labelOf(input.label);
  if (!label) return { ok: false, reason: "invalid_label", messageAr: "اسم المفتاح يجب أن يكون بين ١ و٦٠ حرفًا.", status: 400 };
  const shape = validateKeyShape(input.key);
  if (shape) return { ok: false, reason: "invalid_key", messageAr: shape, status: 400 };
  if (tooMany(input.adminId, (deps.now ?? Date.now)())) return { ok: false, reason: "rate_limited", messageAr: MSG.tooMany, status: 429 };
  return saveNewKey(deps, { adminId: input.adminId, label, key: cleanKey(String(input.key)), isMain: false });
}

/** The first main key: the key the platform uses today (encrypted store, then environment) copied INSIDE the server into the pool. It is never sent to a browser. */
export async function adoptMainKey(deps: PoolAdminDeps, input: { adminId: string; label?: unknown; key?: unknown }): Promise<PoolActionOutcome> {
  if (tooMany(input.adminId, (deps.now ?? Date.now)())) return { ok: false, reason: "rate_limited", messageAr: MSG.tooMany, status: 429 };
  const label = labelOf(input.label) ?? "الرئيسي";
  const existing = await rpc(deps, "treg_pool_overview", {});
  if ((Array.isArray(existing.data?.keys) ? existing.data.keys : []).some((k: any) => k.is_main)) return { ok: false, reason: "main_exists", messageAr: "يوجد مفتاح رئيسي بالفعل؛ يمكن استبداله فقط.", status: 409 };
  let plain: string;
  if (input.key !== undefined && input.key !== null && input.key !== "") {
    const shape = validateKeyShape(input.key);
    if (shape) return { ok: false, reason: "invalid_key", messageAr: shape, status: 400 };
    plain = cleanKey(String(input.key));
  } else {
    const legacy = await resolveLegacyProviderKey("treg", { forceRefresh: true });
    if (!legacy.key) return { ok: false, reason: "no_current_key", messageAr: MSG.noMainAvailable, status: 409 };
    plain = legacy.key;
  }
  return saveNewKey(deps, { adminId: input.adminId, label, key: plain, isMain: true });
}

export async function replacePoolKey(deps: PoolAdminDeps, input: { adminId: string; keyId: unknown; key: unknown; label?: unknown }): Promise<PoolActionOutcome> {
  if (!validUuid(input.keyId)) return { ok: false, reason: "invalid_request", messageAr: MSG.invalidRequest, status: 400 };
  const shape = validateKeyShape(input.key);
  if (shape) return { ok: false, reason: "invalid_key", messageAr: shape, status: 400 };
  if (tooMany(input.adminId, (deps.now ?? Date.now)())) return { ok: false, reason: "rate_limited", messageAr: MSG.tooMany, status: 429 };
  const enc = await deps.pool.encryptionKey();
  if (!enc) return { ok: false, reason: "encryption_unavailable", messageAr: MSG.encryptionUnavailable, status: 503 };
  const key = cleanKey(String(input.key));
  const overview = await rpc(deps, "treg_pool_overview", {});
  const target = (Array.isArray(overview.data?.keys) ? overview.data.keys : []).find((k: any) => k.id === input.keyId);
  const settings = target?.is_main ? await readProviderKeySettings(deps.client).catch(() => null) : null;
  const vet = await vetKey(deps, key, settings?.tregOrgId);
  if (!vet.ok) return vet.outcome;
  const last4 = last4Of(key);
  const label = input.label === undefined ? null : labelOf(input.label);
  const ciphertext = encryptPoolKey(enc, input.keyId, key);
  const res = await rpc(deps, "admin_replace_treg_pool_key", { p_admin_id: input.adminId, p_key_id: input.keyId, p_ciphertext: ciphertext, p_last4: last4, p_email: vet.result.email, p_label: label });
  const outcome = fromFunction("replace", res, MSG.replaced, { keyId: input.keyId, last4 });
  if (outcome.ok) { await recordAdminCheck(deps, input.keyId, vet.result); deps.pool.invalidate(); }
  return outcome;
}

export async function removePoolKey(deps: PoolAdminDeps, input: { adminId: string; keyId: unknown }): Promise<PoolActionOutcome> {
  if (!validUuid(input.keyId)) return { ok: false, reason: "invalid_request", messageAr: MSG.invalidRequest, status: 400 };
  const outcome = fromFunction("remove", await rpc(deps, "admin_remove_treg_pool_key", { p_admin_id: input.adminId, p_key_id: input.keyId }), MSG.removed, { keyId: input.keyId });
  if (outcome.ok) deps.pool.invalidate();
  return outcome;
}

export async function setActivePoolKey(deps: PoolAdminDeps, input: { adminId: string; keyId: unknown; force?: unknown }): Promise<PoolActionOutcome> {
  if (!validUuid(input.keyId)) return { ok: false, reason: "invalid_request", messageAr: MSG.invalidRequest, status: 400 };
  const outcome = fromFunction("set_active", await rpc(deps, "admin_set_treg_active_key", { p_admin_id: input.adminId, p_key_id: input.keyId, p_force: input.force === true }), MSG.activated, { keyId: input.keyId });
  if (outcome.ok) deps.pool.invalidate();
  return outcome;
}

export async function setPoolChain(deps: PoolAdminDeps, input: { adminId: string; orderedIds: unknown }): Promise<PoolActionOutcome> {
  const ids = Array.isArray(input.orderedIds) ? input.orderedIds : null;
  if (!ids || ids.length > 500 || !ids.every(validUuid)) return { ok: false, reason: "invalid_request", messageAr: MSG.invalidRequest, status: 400 };
  const outcome = fromFunction("set_chain", await rpc(deps, "admin_set_treg_chain", { p_admin_id: input.adminId, p_ordered: ids }), MSG.chainSaved);
  if (outcome.ok) deps.pool.invalidate();
  return outcome;
}

export async function setPoolRollout(deps: PoolAdminDeps, input: { adminId: string; on: unknown }): Promise<PoolActionOutcome> {
  if (typeof input.on !== "boolean") return { ok: false, reason: "invalid_request", messageAr: MSG.invalidRequest, status: 400 };
  const outcome = fromFunction("set_rollout", await rpc(deps, "admin_set_treg_rollout", { p_admin_id: input.adminId, p_on: input.on }), input.on ? MSG.rolloutOn : MSG.rolloutOff);
  if (outcome.ok) deps.pool.invalidate();
  return outcome;
}

export async function setPoolSettings(deps: PoolAdminDeps, input: { adminId: string; minBalanceUsd: unknown }): Promise<PoolActionOutcome> {
  const usd = Number(String(input.minBalanceUsd ?? "").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))));
  if (!Number.isFinite(usd) || usd < 0 || usd > 10) return { ok: false, reason: "invalid_request", messageAr: "الحد الأدنى للرصيد يجب أن يكون بين ٠ و١٠ دولار.", status: 400 };
  const outcome = fromFunction("settings", await rpc(deps, "admin_set_treg_pool_settings", { p_admin_id: input.adminId, p_min_balance_micro: Math.round(usd * 1_000_000) }), MSG.settingsSaved);
  if (outcome.ok) deps.pool.invalidate();
  return outcome;
}

/** «فحص الآن» for one key (or all keys when keyId is omitted): the same read-only calls as the background check. */
export async function refreshPoolKeys(deps: PoolAdminDeps, input: { keyId?: unknown }): Promise<PoolActionOutcome & { health?: HealthRunResult }> {
  if (input.keyId !== undefined && !validUuid(input.keyId)) return { ok: false, reason: "invalid_request", messageAr: MSG.invalidRequest, status: 400 };
  const settings = await readProviderKeySettings(deps.client).catch(() => null);
  const health = await runPoolHealth({ client: deps.client, pool: deps.pool, fetchFn: deps.fetchFn, now: deps.now, only: input.keyId ? [input.keyId as string] : null, mainOrgId: settings?.tregOrgId ?? null, source: "admin", budgetMs: 40_000 });
  if (!health.ok) {
    const reason = health.problem ?? "read_failed";
    return { ok: false, reason, messageAr: reason === "sql_not_ready" ? "ملف التحديث ٠٦ (قراءة المفاتيح للفحص) لم يُطبَّق بعد." : reason === "encryption_unavailable" ? MSG.encryptionUnavailable : MSG.failed, status: reason === "sql_not_ready" ? 409 : 503, health };
  }
  return { ok: true, reason: "ok", messageAr: MSG.refreshed, status: 200, health };
}
