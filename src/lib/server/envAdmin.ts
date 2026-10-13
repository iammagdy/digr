import { Client, Functions, Sites } from "node-appwrite";

/** Variables the admin panel may change. Anything else is rejected. */
export const ALLOWED_ENV_KEYS = [
  "LLM_ENABLED", "LLM_PROVIDER", "ANTHROPIC_MODEL", "OPENAI_MODEL", "LLM_MODEL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
  "TREG_LIVE", "TREG_TOKEN", "TREG_BASE_URL",
] as const;
export type EnvKey = (typeof ALLOWED_ENV_KEYS)[number];
export const SECRET_KEYS: ReadonlySet<string> = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TREG_TOKEN"]);

/** Where each variable must live: the Next app (Appwrite Site) reads LLM_*; job functions read TREG_*. */
const FUNCTIONS_FOR: Record<string, string[]> = { llm: ["create-job", "job-worker"], treg: ["create-job", "job-worker"] };

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

async function upsertVariable(svc: Functions | Sites, kind: "function" | "site", id: string, key: string, value: string, secret: boolean) {
  const list: any = kind === "function" ? await (svc as Functions).listVariables({ functionId: id }) : await (svc as Sites).listVariables({ siteId: id });
  const existing = (list.variables as any[]).find((v) => v.key === key);
  if (kind === "function") {
    const f = svc as Functions;
    if (existing) await f.updateVariable({ functionId: id, variableId: existing.$id, key, value, secret });
    else await f.createVariable({ functionId: id, variableId: "unique()", key, value, secret });
  } else {
    const s = svc as Sites;
    if (existing) await s.updateVariable({ siteId: id, variableId: existing.$id, key, value, secret });
    else await s.createVariable({ siteId: id, variableId: "unique()", key, value, secret });
  }
}

async function redeploy(svc: Functions | Sites, kind: "function" | "site", id: string) {
  const res: any = kind === "function" ? await (svc as Functions).get({ functionId: id }) : await (svc as Sites).get({ siteId: id });
  const active = res.deploymentId || res.latestDeploymentId;
  if (!active) throw new Error("no active deployment");
  if (kind === "function") await (svc as Functions).createDuplicateDeployment({ functionId: id, deploymentId: active });
  else await (svc as Sites).createDuplicateDeployment({ siteId: id, deploymentId: active });
}

export async function applyEnvUpdates(
  client?: Client | null,
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

  // 2. Persist to Supabase settings_private if tables/DB client is present
  if (tables && typeof tables.from === "function") {
    try {
      const updatesMap: Record<string, string> = {};
      for (const u of safeUpdates) {
        if (u?.key && typeof u.value === "string") {
          updatesMap[u.key] = u.value.trim();
        }
      }
      const { data: existing } = await tables
        .from("settings_private")
        .select("value")
        .eq("key", "providers")
        .maybeSingle();

      const existingVal = existing?.value && typeof existing.value === "object" ? existing.value : {};
      const merged = { ...existingVal, ...updatesMap };

      await tables.from("settings_private").upsert({
        key: "providers",
        value: merged,
        updated_at: new Date().toISOString(),
      });
      results.push({ target: "supabase:settings_private", ok: true, message: "تم حفظ الإعدادات في Supabase" });
    } catch {
      results.push({ target: "supabase:settings_private", ok: false, message: "تعذر الحفظ في جدول الإعدادات" });
    }
  }

  // 3. Optional legacy Appwrite Sites / Functions sync if client and siteId are configured
  if (client && process.env.APPWRITE_SITE_ID && process.env.APPWRITE_API_KEY) {
    try {
      const functions = new Functions(client);
      const sites = new Sites(client);
      const siteId = process.env.APPWRITE_SITE_ID;

      const isLlm = (k: string) => k.startsWith("LLM_") || k.startsWith("ANTHROPIC_") || k.startsWith("OPENAI_");
      const targets: Array<{ kind: "site" | "function"; id: string }> = [];
      if (siteId) targets.push({ kind: "site", id: siteId });
      for (const f of new Set(safeUpdates.flatMap((u) => FUNCTIONS_FOR[isLlm(u.key) ? "llm" : "treg"]))) {
        targets.push({ kind: "function", id: f });
      }

      for (const t of targets) {
        try {
          const svc = t.kind === "site" ? sites : functions;
          for (const u of safeUpdates) {
            if (t.kind === "function" && isLlm(u.key) && !FUNCTIONS_FOR.llm.includes(t.id)) continue;
            await upsertVariable(svc, t.kind, t.id, u.key, u.value.trim(), SECRET_KEYS.has(u.key));
          }
          try {
            await redeploy(svc, t.kind, t.id);
            results.push({ target: `${t.kind}:${t.id}`, ok: true, message: "تم الحفظ وإعادة النشر" });
          } catch {
            results.push({ target: `${t.kind}:${t.id}`, ok: true, message: "تم الحفظ — أعد نشر الدالة يدويًا ليسري التغيير" });
          }
        } catch (e: any) {
          results.push({
            target: `${t.kind}:${t.id}`,
            ok: false,
            message: e?.type === "general_unauthorized_scope" ? "المفتاح يفتقد صلاحية functions.write / sites.write" : "تعذّر تحديث المتغيرات",
          });
        }
      }
    } catch {
      // Non-fatal if Appwrite is unavailable
    }
  }

  if (results.length === 0) {
    results.push({ target: "runtime", ok: true, message: "تم حفظ الإعدادات في بيئة التشغيل" });
  }

  return results;
}
