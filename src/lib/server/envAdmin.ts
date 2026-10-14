/** Variables the admin panel may change. Anything else is rejected. */
export const ALLOWED_ENV_KEYS = [
  "LLM_ENABLED", "LLM_PROVIDER", "ANTHROPIC_MODEL", "OPENAI_MODEL", "LLM_MODEL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
  "TREG_LIVE", "TREG_TOKEN", "TREG_BASE_URL",
] as const;
export type EnvKey = (typeof ALLOWED_ENV_KEYS)[number];
export const SECRET_KEYS: ReadonlySet<string> = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TREG_TOKEN"]);

export function validateEnvUpdate(key: string, value: string): string | null {
  if (!(ALLOWED_ENV_KEYS as readonly string[]).includes(key)) return "متغير غير مسموح";
  const v = value.trim();
  if (key === "LLM_ENABLED" || key === "TREG_LIVE") return v === "true" || v === "false" ? null : "القيمة يجب أن تكون true أو false";
  if (key === "LLM_PROVIDER") return ["anthropic", "openai", "fake"].includes(v) ? null : "مزود غير مدعوم";
  if (key.endsWith("_MODEL")) return /^[A-Za-z0-9._:-]{1,80}$/.test(v) ? null : "اسم النموذج غير صالح";
  if (SECRET_KEYS.has(key)) return v.length >= 8 && v.length <= 400 && !/\s/.test(v) ? null : "المفتاح غير صالح (٨ خانات على الأقل بدون مسافات)";
  if (key === "TREG_BASE_URL") {
    try { const u = new URL(v); return u.protocol === "https:" ? null : "العنوان يجب أن يبدأ بـ https://"; } catch { return "عنوان غير صالح"; }
  }
  return null;
}

export interface EnvResult { target: string; ok: boolean; message: string }

export async function applyEnvUpdates(
  _client?: any,
  updates?: Array<{ key: EnvKey; value: string }>,
  tables?: any
): Promise<EnvResult[]> {
  const safeUpdates = Array.isArray(updates) ? updates : [];
  const results: EnvResult[] = [];

  // 1. Always apply in-memory to process.env immediately
  for (const u of safeUpdates) {
    if (u?.key && typeof u.value === "string") {
      process.env[u.key] = u.value.trim();
    }
  }

  // 2. Persist non-sensitive configuration to Supabase settings_private.
  // CRITICAL SECURITY GUARD: Secrets (API keys / tokens) must NEVER be persisted in DB tables.
  if (tables && typeof tables.from === "function") {
    try {
      const updatesMap: Record<string, string> = {};
      for (const u of safeUpdates) {
        if (u?.key && typeof u.value === "string" && !SECRET_KEYS.has(u.key)) {
          updatesMap[u.key] = u.value.trim();
        }
      }
      if (Object.keys(updatesMap).length > 0) {
        const { data: existing } = await tables
          .from("settings_private")
          .select("value")
          .eq("key", "providers")
          .maybeSingle();

        const existingVal = existing?.value && typeof existing.value === "object" ? existing.value : {};
        const cleanExisting: Record<string, any> = {};
        for (const [k, v] of Object.entries(existingVal)) {
          if (!SECRET_KEYS.has(k)) cleanExisting[k] = v;
        }
        const merged = { ...cleanExisting, ...updatesMap };

        await tables.from("settings_private").upsert({
          key: "providers",
          value: merged,
          updated_at: new Date().toISOString(),
        });
        results.push({ target: "supabase:settings_private", ok: true, message: "تم حفظ الإعدادات غير الحساسة في Supabase" });
      }
    } catch {
      results.push({ target: "supabase:settings_private", ok: false, message: "تعذر الحفظ في جدول الإعدادات" });
    }
  }

  if (results.length === 0) {
    results.push({ target: "runtime", ok: true, message: "تم تحديث بيئة التشغيل الحالية" });
  }

  return results;
}
