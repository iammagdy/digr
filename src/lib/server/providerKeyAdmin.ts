import { isMissingAtomicRpc } from "../../functions/shared/atomicRpc";
import { resolveProviderLimits } from "./providerLimits";
import {
  ENCRYPTION_KEY_ENV, PROVIDER_IDS, ProviderKeyCryptoError, cleanKey, decryptProviderKey, encryptProviderKey,
  isEncryptionConfigured, last4Of, maskedKey, validateKeyShape, type ProviderId,
} from "./providerKeyCrypto";
import { envKeyConfigured, getLastAuthRejection, invalidateProviderKeyCache, resolveLegacyProviderKey, type AuthRejection, type KeySource, type StoreState } from "./providerKeys";
import { selectAllRows } from "./selectAll";
import { resolveProviderDailyCapUsd } from "./multiProvider/providerCaps";
import {
  DEFAULT_LOW_BALANCE_THRESHOLD_USD, checkProviderKey, getProviderAccountEmail, getProviderStatus, invalidateProviderStatusCache, isLowBalance,
  type FetchLike, type ProviderStatusSnapshot,
} from "./providerStatus";

export const PROVIDER_LABEL_AR: Record<ProviderId, string> = { treg: "مزود البيانات", anthropic: "مزود النموذج الذكي", firecrawl: "مزود قراءة المواقع (Firecrawl)", contextdev: "مزود البحث والقراءة (Context.dev)" };
export const isProviderId = (v: unknown): v is ProviderId => typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);

export const MSG = {
  encryptionMissing: `لا يمكن حفظ المفتاح لأن المتغير ${ENCRYPTION_KEY_ENV} غير مضبوط في Vercel. اضبطه (٣٢ بايت عشوائية بصيغة base64) ثم اضغط Redeploy وجرّب مرة أخرى. لم يُحفظ شيء.`,
  encryptionInvalid: `المتغير ${ENCRYPTION_KEY_ENV} موجود لكن قيمته غير صالحة (يجب أن تكون ٣٢ بايت عشوائية بصيغة base64). صحّحه في Vercel ثم اضغط Redeploy. لم يُحفظ شيء.`,
  storeNotReady: "مخزن المفاتيح غير جاهز بعد لأن تحديث قاعدة البيانات لم يُطبَّق. المفتاح المضبوط في متغيرات البيئة ما زال مستخدمًا ولم يتغير شيء.",
  rejected: "رفض المزود هذا المفتاح، لذلك لم يُحفظ وما زال المفتاح القديم يعمل.",
  unreachable: "تعذر الاتصال بالمزود للتحقق من المفتاح، لذلك لم يُحفظ وما زال المفتاح القديم يعمل. حاول بعد قليل.",
  unexpected: "ردّ المزود بشكل غير متوقع أثناء التحقق، لذلك لم يُحفظ المفتاح وما زال المفتاح القديم يعمل.",
  sameAsStored: "هذا هو المفتاح المحفوظ والمستخدم حاليًا بالفعل.",
  failed: "تعذر حفظ المفتاح الآن. لم يتغير شيء وما زال المفتاح القديم يعمل.",
  tooMany: "محاولات كثيرة لتغيير المفاتيح. انتظر بضع دقائق ثم حاول مرة أخرى.",
  saved: "تم التحقق من المفتاح وحفظه مشفّرًا، وهو مستخدم الآن في كل الطلبات (قد يستغرق حتى ٣٠ ثانية على الخوادم الأخرى).",
  rolledBack: "تم الرجوع إلى المفتاح السابق وهو مستخدم الآن في كل الطلبات (قد يستغرق حتى ٣٠ ثانية على الخوادم الأخرى).",
  noPrevious: "لا يوجد مفتاح سابق للرجوع إليه.",
  previousUnusable: "تعذر قراءة المفتاح السابق المخزّن، لذلك لم يحدث رجوع.",
  notAdmin: "هذا الإجراء مخصص للمسؤولين فقط.",
} as const;

export interface KeyActionOutcome { ok: boolean; reason: string; messageAr: string; status: number; last4?: string | null }

// ---- Attempt limiter (in memory per server instance: slows mistakes and abuse, not a hard limit) ------------------
const attempts = new Map<string, number[]>();
export const KEY_CHANGE_LIMIT = { max: 8, windowMs: 10 * 60_000 };
export function __resetKeyChangeLimiter(): void { attempts.clear(); }
function tooMany(adminId: string, now = Date.now()): boolean {
  const recent = (attempts.get(adminId) || []).filter((t) => now - t < KEY_CHANGE_LIMIT.windowMs);
  if (recent.length >= KEY_CHANGE_LIMIT.max) { attempts.set(adminId, recent); return true; }
  attempts.set(adminId, [...recent, now]);
  return false;
}

// ---- Store reads (never selects ciphertext except where a rollback needs it) -------------------------------------
interface StoreInfo {
  ready: boolean;
  activeLast4: string | null;
  activeSetAt: string | null;
  previousLast4: string | null;
  previousSetAt: string | null;
  version: number;
}

const isMissingTable = (e: any) => {
  const code = String(e?.code || ""); const msg = String(e?.message || "");
  return code === "42P01" || code === "PGRST205" || /does not exist|schema cache/i.test(msg);
};

export async function readStoreInfo(client: any, provider: ProviderId): Promise<StoreInfo> {
  const empty: StoreInfo = { ready: true, activeLast4: null, activeSetAt: null, previousLast4: null, previousSetAt: null, version: 0 };
  try {
    const { data, error } = await client
      .from("provider_api_keys")
      .select("active_last4, active_set_at, previous_last4, previous_set_at, version")
      .eq("provider", provider)
      .maybeSingle();
    if (error) return isMissingTable(error) ? { ...empty, ready: false } : empty;
    if (!data) return empty;
    return {
      ready: true,
      activeLast4: data.active_last4 ?? null,
      activeSetAt: data.active_set_at ?? null,
      previousLast4: data.previous_last4 ?? null,
      previousSetAt: data.previous_set_at ?? null,
      version: Number(data.version) || 0,
    };
  } catch {
    return { ...empty, ready: false };
  }
}

// ---- Non-secret settings -----------------------------------------------------------------------------------------
export interface ProviderKeySettings { lowBalanceThresholdUsd: number; tregOrgId: string | null }
const SETTINGS_KEY = "provider_keys";

export async function readProviderKeySettings(client: any): Promise<ProviderKeySettings> {
  const base: ProviderKeySettings = { lowBalanceThresholdUsd: DEFAULT_LOW_BALANCE_THRESHOLD_USD, tregOrgId: null };
  try {
    const { data } = await client.from("settings_private").select("value").eq("key", SETTINGS_KEY).maybeSingle();
    const v = data?.value;
    const t = Number(v?.lowBalanceThresholdUsd);
    if (Number.isFinite(t) && t >= 0 && t <= 100000) base.lowBalanceThresholdUsd = t;
    if (typeof v?.tregOrgId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v.tregOrgId)) base.tregOrgId = v.tregOrgId;
  } catch { /* defaults */ }
  return base;
}

export function validateSettingsInput(input: { lowBalanceThresholdUsd?: unknown; tregOrgId?: unknown }): { ok: true; value: Partial<ProviderKeySettings> } | { ok: false; messageAr: string } {
  const out: Partial<ProviderKeySettings> = {};
  if (input.lowBalanceThresholdUsd !== undefined) {
    const t = Number(String(input.lowBalanceThresholdUsd).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))));
    if (!Number.isFinite(t) || t < 0 || t > 100000) return { ok: false, messageAr: "حد التنبيه يجب أن يكون رقمًا بين ٠ و١٠٠٠٠٠ دولار." };
    out.lowBalanceThresholdUsd = Math.round(t * 100) / 100;
  }
  if (input.tregOrgId !== undefined) {
    const raw = String(input.tregOrgId ?? "").trim();
    if (raw && !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return { ok: false, messageAr: "معرّف الفريق غير صالح (أحرف وأرقام و - و _ فقط)." };
    out.tregOrgId = raw || null;
  }
  return { ok: true, value: out };
}

export async function saveProviderKeySettings(client: any, patch: Partial<ProviderKeySettings>): Promise<boolean> {
  try {
    const current = await readProviderKeySettings(client);
    const merged = { ...current, ...patch };
    const { error } = await client.from("settings_private").upsert({ key: SETTINGS_KEY, value: merged, updated_at: new Date().toISOString() });
    if (error) return false;
    invalidateProviderStatusCache("treg");
    return true;
  } catch { return false; }
}

// ---- Replace and rollback ----------------------------------------------------------------------------------------
export interface KeyActionDeps { client: any; fetchFn?: FetchLike; now?: () => number }

function validationFailure(reason: string): KeyActionOutcome {
  if (reason === "auth_rejected") return { ok: false, reason: "validation_rejected", messageAr: MSG.rejected, status: 422 };
  if (reason === "unexpected") return { ok: false, reason: "validation_unexpected", messageAr: MSG.unexpected, status: 422 };
  return { ok: false, reason: "validation_unreachable", messageAr: MSG.unreachable, status: 502 };
}

function encryptionRefusal(): KeyActionOutcome | null {
  try {
    if (isEncryptionConfigured()) return null;
    const raw = (process.env[ENCRYPTION_KEY_ENV] || "").trim();
    return raw
      ? { ok: false, reason: "encryption_key_invalid", messageAr: MSG.encryptionInvalid, status: 503 }
      : { ok: false, reason: "encryption_key_missing", messageAr: MSG.encryptionMissing, status: 503 };
  } catch {
    return { ok: false, reason: "encryption_key_missing", messageAr: MSG.encryptionMissing, status: 503 };
  }
}

function finishCaches(provider: ProviderId): void {
  invalidateProviderKeyCache(provider);
  invalidateProviderStatusCache(provider);
}

/**
 * Replace a provider key. Order matters: nothing is sent to the provider and nothing is stored unless the
 * encryption key and the store are ready; the new key is validated against the provider BEFORE it is saved, and a
 * failed validation leaves the old key untouched.
 */
export async function replaceProviderKey(
  deps: KeyActionDeps,
  input: { adminId: string; provider: ProviderId; newKey: unknown },
): Promise<KeyActionOutcome> {
  if (tooMany(input.adminId, deps.now?.())) return { ok: false, reason: "rate_limited", messageAr: MSG.tooMany, status: 429 };
  const shapeError = validateKeyShape(input.newKey);
  if (shapeError) return { ok: false, reason: "invalid_key", messageAr: shapeError, status: 400 };
  const refusal = encryptionRefusal();
  if (refusal) return refusal;

  const store = await readStoreInfo(deps.client, input.provider);
  if (!store.ready) return { ok: false, reason: "store_not_ready", messageAr: MSG.storeNotReady, status: 409 };

  const key = cleanKey(String(input.newKey));
  const current = await resolveLegacyProviderKey(input.provider);
  if (current.source === "store" && current.key === key) return { ok: false, reason: "same_key", messageAr: MSG.sameAsStored, status: 409 };

  const { health } = await checkProviderKey(input.provider, key, deps.fetchFn);
  if (!health.ok) return validationFailure(health.reason);

  let ciphertext: string;
  try {
    ciphertext = encryptProviderKey(input.provider, key);
  } catch (e) {
    const code = e instanceof ProviderKeyCryptoError ? e.code : "encrypt_failed";
    return { ok: false, reason: code, messageAr: MSG.encryptionMissing, status: 503 };
  }

  const { data, error } = await deps.client.rpc("admin_set_provider_key_atomic", {
    p_admin_id: input.adminId, p_provider: input.provider, p_ciphertext: ciphertext, p_last4: last4Of(key),
  });
  if (error) {
    if (isMissingAtomicRpc(error, "admin_set_provider_key_atomic")) {
      console.warn("[provider_key:set_function_unavailable] migration not applied; key store is off");
      return { ok: false, reason: "store_not_ready", messageAr: MSG.storeNotReady, status: 409 };
    }
    console.error("[provider_key:set_failed] code=" + String((error as any)?.code || "unknown"));
    return { ok: false, reason: "failed", messageAr: MSG.failed, status: 500 };
  }
  if (data?.success !== true) {
    const reason = String(data?.error || "failed");
    return { ok: false, reason, messageAr: reason === "not_admin" ? MSG.notAdmin : (typeof data?.error_ar === "string" && data.error_ar) || MSG.failed, status: reason === "not_admin" ? 403 : 400 };
  }
  finishCaches(input.provider);
  return { ok: true, reason: "saved", messageAr: MSG.saved, status: 200, last4: last4Of(key) };
}

export async function rollbackProviderKey(
  deps: KeyActionDeps,
  input: { adminId: string; provider: ProviderId },
): Promise<KeyActionOutcome> {
  if (tooMany(input.adminId, deps.now?.())) return { ok: false, reason: "rate_limited", messageAr: MSG.tooMany, status: 429 };
  const refusal = encryptionRefusal();
  if (refusal) return refusal;

  let previousCiphertext: string | null = null;
  try {
    const { data, error } = await deps.client.from("provider_api_keys").select("previous_ciphertext").eq("provider", input.provider).maybeSingle();
    if (error) return isMissingTable(error) ? { ok: false, reason: "store_not_ready", messageAr: MSG.storeNotReady, status: 409 } : { ok: false, reason: "failed", messageAr: MSG.failed, status: 500 };
    previousCiphertext = data?.previous_ciphertext ?? null;
  } catch {
    return { ok: false, reason: "failed", messageAr: MSG.failed, status: 500 };
  }
  if (!previousCiphertext) return { ok: false, reason: "no_previous_key", messageAr: MSG.noPrevious, status: 404 };

  let previousKey: string;
  try { previousKey = decryptProviderKey(input.provider, previousCiphertext); } catch { return { ok: false, reason: "previous_unusable", messageAr: MSG.previousUnusable, status: 500 }; }
  const { health } = await checkProviderKey(input.provider, previousKey, deps.fetchFn);
  if (!health.ok) return validationFailure(health.reason);

  const { data, error } = await deps.client.rpc("admin_rollback_provider_key_atomic", { p_admin_id: input.adminId, p_provider: input.provider });
  if (error) {
    if (isMissingAtomicRpc(error, "admin_rollback_provider_key_atomic")) return { ok: false, reason: "store_not_ready", messageAr: MSG.storeNotReady, status: 409 };
    console.error("[provider_key:rollback_failed] code=" + String((error as any)?.code || "unknown"));
    return { ok: false, reason: "failed", messageAr: MSG.failed, status: 500 };
  }
  if (data?.success !== true) {
    const reason = String(data?.error || "failed");
    return { ok: false, reason, messageAr: reason === "not_admin" ? MSG.notAdmin : (typeof data?.error_ar === "string" && data.error_ar) || MSG.failed, status: reason === "not_admin" ? 403 : 400 };
  }
  finishCaches(input.provider);
  return { ok: true, reason: "rolled_back", messageAr: MSG.rolledBack, status: 200, last4: last4Of(previousKey) };
}

// ---- Tab state (everything the admin screen needs; no secret) ----------------------------------------------------
export interface ActivityRow { at: string; label: string; detail: string; amount: string }

export interface ProviderTabState {
  provider: ProviderId;
  keySource: KeySource;
  maskedKey: string;
  last4: string | null;
  storeState: StoreState;
  store: { ready: boolean; version: number; activeSetAt: string | null; previousLast4: string | null; previousSetAt: string | null };
  encryptionConfigured: boolean;
  envKeyConfigured: boolean;
  status: ProviderStatusSnapshot;
  /** The e-mail of the connected provider account as the provider's own answer gave it (admin only), or null when it had none. Never the team id. */
  accountEmail: string | null;
  authRejection: AuthRejection | null;
  settings: ProviderKeySettings;
  lowBalance: boolean;
  spend: { todayUsd: number; capUsd: number | null; capKind: "provider_daily" | "llm_daily" };
  activity: ActivityRow[];
  noticesAr: string[];
}

function utcStartOfDay(): string {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())).toISOString();
}

async function readCap(client: any, provider: ProviderId): Promise<number> {
  // Firecrawl and Context.dev each have their own daily limit (0 until the owner sets one); TREG and the model are exactly as before.
  if (provider === "firecrawl" || provider === "contextdev") return resolveProviderDailyCapUsd(client, provider);
  const { limits } = await resolveProviderLimits(client);
  return provider === "treg" ? limits.dailyUsd : limits.llmDailyUsd;
}

async function readSpendAndActivity(client: any, provider: ProviderId): Promise<{ todayUsd: number; activity: ActivityRow[] }> {
  const since = utcStartOfDay();
  let todayUsd = 0;
  const activity: ActivityRow[] = [];
  try {
    if (provider === "treg" || provider === "firecrawl" || provider === "contextdev") {
      // The same two reads for every data provider, each filtered by its OWN provider identifier (for TREG the calls are exactly the ones before).
      const { data: today } = await selectAllRows(() => client.from("provider_costs").select("cost_usd").eq("provider", provider).gte("created_at", since), { orderBy: "id" });
      for (const r of today || []) { const c = Number(r.cost_usd); if (Number.isFinite(c) && c > 0) todayUsd += c; }
      const { data } = await client.from("provider_costs").select("job_id, units, cost_usd, created_at, is_estimate").eq("provider", provider).order("created_at", { ascending: false }).limit(20);
      for (const r of data || []) activity.push({ at: r.created_at, label: r.job_id ? `مهمة ${String(r.job_id).slice(-8)}` : "—", detail: `${Number(r.units) || 1} وحدة${r.is_estimate ? " · تقدير" : ""}`, amount: String(Number(r.cost_usd) || 0) });
    } else {
      const { data: today } = await selectAllRows(() => client.from("llm_usage").select("cost_usd").gte("created_at", since), { orderBy: "id" });
      for (const r of today || []) { const c = Number(r.cost_usd); if (Number.isFinite(c) && c > 0) todayUsd += c; }
      const { data } = await client.from("llm_usage").select("reason, tokens_in, tokens_out, cost_usd, created_at").order("created_at", { ascending: false }).limit(20);
      for (const r of data || []) activity.push({ at: r.created_at, label: String(r.reason || "—"), detail: `${Number(r.tokens_in) || 0} / ${Number(r.tokens_out) || 0}`, amount: String(Number(r.cost_usd) || 0) });
    }
  } catch { /* tables unavailable: empty */ }
  return { todayUsd, activity };
}

export async function loadProviderTabState(
  deps: { client: any; fetchFn?: FetchLike; now?: () => number },
  provider: ProviderId,
  options?: { forceRefresh?: boolean },
): Promise<ProviderTabState> {
  const [settings, store] = await Promise.all([readProviderKeySettings(deps.client), readStoreInfo(deps.client, provider)]);
  // the tab's own key section is the LEGACY key (encrypted store, then environment) even while the key pool is ON: the pool has its own section
  const resolved = await resolveLegacyProviderKey(provider, { forceRefresh: options?.forceRefresh });
  const status = await getProviderStatus(provider, resolved.key, { forceRefresh: options?.forceRefresh, orgIdOverride: provider === "treg" ? settings.tregOrgId : null, fetchFn: deps.fetchFn, now: deps.now });
  const [{ todayUsd, activity }, capUsd] = await Promise.all([readSpendAndActivity(deps.client, provider), readCap(deps.client, provider)]);
  const authRejection = getLastAuthRejection(provider);
  const encryptionConfigured = isEncryptionConfigured();

  const noticesAr: string[] = [];
  if (!store.ready) noticesAr.push(`مخزن المفاتيح غير جاهز بعد لأن تحديث قاعدة البيانات لم يُطبَّق. يُستخدم الآن المفتاح المضبوط في متغيرات البيئة${resolved.source === "env" ? "" : " (لا يوجد)"}.`);
  else if (!encryptionConfigured) noticesAr.push(`المتغير ${ENCRYPTION_KEY_ENV} غير مضبوط أو غير صالح في Vercel، لذلك لا يمكن حفظ مفتاح جديد. اضبطه ثم اضغط Redeploy.`);
  if (resolved.storeState === "encryption_missing") noticesAr.push(`يوجد مفتاح محفوظ لكن الخادم لا يستطيع فك تشفيره لأن ${ENCRYPTION_KEY_ENV} غير مضبوط، فيُستخدم مفتاح متغيرات البيئة.`);
  if (resolved.storeState === "decrypt_failed") noticesAr.push(`المفتاح المحفوظ فشل فحص سلامته (قد يكون ${ENCRYPTION_KEY_ENV} تغيّر)، فيُستخدم مفتاح متغيرات البيئة. الصق المفتاح من جديد لحفظه.`);
  if (resolved.source === "none") noticesAr.push("لا يوجد أي مفتاح مضبوط لهذا المزود.");
  if (authRejection) noticesAr.push(`رفض المزود المفتاح المستخدم (HTTP ${authRejection.httpStatus}) ${authRejection.count > 1 ? `${authRejection.count} مرات` : "مرة"} على هذا الخادم، آخرها ${authRejection.at}. لم يجرِ أي تبديل تلقائي للمفتاح.`);
  if (provider === "anthropic") noticesAr.push("مزود النموذج الذكي لا يوفّر واجهة لقراءة الرصيد بمفتاح عادي، لذلك لا يظهر رصيد هنا. راجع لوحة المزود مباشرة.");
  if (provider === "firecrawl" || provider === "contextdev") {
    noticesAr.push("الرصيد المعروض هو عدد الرصيد (كريدت) كما يرده المزود نفسه بطلب مجاني، وليس رقمًا تقديريًا.");
    if (provider === "contextdev") noticesAr.push("قراءة الرصيد تحتاج مفتاحًا بصلاحية قراءة السجلات (logs:read). مفتاح بدونها يظل مقبولًا ويعمل في البحث والقراءة، لكن لا يُعرض رصيده هنا.");
    if (!capUsd) noticesAr.push("لم يُضبط حد يومي لهذا المزود بعد، لذلك لا يُسمح بأي إنفاق عليه حتى تحدده من قسم الحدود.");
  }

  return {
    provider,
    keySource: resolved.source,
    maskedKey: maskedKey(resolved.last4),
    last4: resolved.last4,
    storeState: resolved.storeState,
    store: { ready: store.ready, version: store.version, activeSetAt: store.activeSetAt, previousLast4: store.previousLast4, previousSetAt: store.previousSetAt },
    encryptionConfigured,
    envKeyConfigured: envKeyConfigured(provider),
    status,
    accountEmail: provider === "treg" ? getProviderAccountEmail("treg") : null,
    authRejection,
    settings,
    lowBalance: provider === "treg" && isLowBalance(status.balance, settings.lowBalanceThresholdUsd),
    spend: { todayUsd, capUsd, capKind: provider === "anthropic" ? "llm_daily" : "provider_daily" },
    activity,
    noticesAr,
  };
}
