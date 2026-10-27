import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin, Query } from "@/lib/server/adminAuth";
import { getLlmStatusSnapshot } from "@/functions/shared/llmClient";
import { LLM_KEY_ENV, LLM_MODEL_ENV, last4 } from "@/lib/server/providerEnv";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveProviderKey } from "@/lib/server/providerKeys";
import { getProviderStatus, isLowBalance } from "@/lib/server/providerStatus";
import { readProviderKeySettings } from "@/lib/server/providerKeyAdmin";
import { getLiveProviderGateStatusFromSettings } from "@/lib/server/providerGate";
import { loadProviderLimitsState } from "@/lib/server/providerLimitsAdmin";
import { SECRET_KEYS, applyEnvUpdates, validateEnvUpdate, type EnvKey } from "@/lib/server/envAdmin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { tables } = auth.ctx;
  const tregGate = await getLiveProviderGateStatusFromSettings(tables);

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const since = startOfDay.toISOString();

  let lastLlmUsage: string | null = null;
  let lastTregCall: string | null = null;
  let tregCallsToday = 0;
  let llmCallsToday = 0;
  let llmCostToday = 0;
  try {
    const u = await tables.listRows({ databaseId: "digr", tableId: "llm_usage", queries: [Query.orderDesc("createdAt"), Query.limit(1)] });
    lastLlmUsage = (u.rows[0] as any)?.createdAt ?? null;
  } catch { /* table not provisioned */ }
  try {
    const c = await tables.listRows({ databaseId: "digr", tableId: "job_calls", queries: [Query.orderDesc("createdAt"), Query.limit(1)] });
    lastTregCall = (c.rows[0] as any)?.createdAt ?? null;
    const today = await tables.listRows({ databaseId: "digr", tableId: "job_calls", queries: [Query.greaterThanEqual("createdAt", since), Query.limit(1)] });
    tregCallsToday = today.total;
  } catch { /* none */ }
  try {
    const today = await tables.listRows({ databaseId: "digr", tableId: "provider_costs", queries: [Query.equal("provider", "llm"), Query.greaterThanEqual("at", since), Query.limit(100)] });
    llmCallsToday = today.total;
    llmCostToday = today.rows.reduce((a: number, r: any) => a + (r.costEgp || 0), 0);
  } catch { /* none */ }

  // Real checks (an authenticated provider call, cached 60 s per server instance), never a flag.
  const settings = await readProviderKeySettings(createAdminClient());
  const [tregKey, anthropicKey] = await Promise.all([resolveProviderKey("treg"), resolveProviderKey("anthropic")]);
  // the sidebar reads the SAME live check the TREG tab runs (`?refresh=true` skips the 60 s cache, as the tab's refresh does)
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "true";
  const [tregStatus, anthropicStatus] = await Promise.all([
    getProviderStatus("treg", tregKey.key, { orgIdOverride: settings.tregOrgId, forceRefresh }),
    getProviderStatus("anthropic", anthropicKey.key, { forceRefresh }),
  ]);

  const limitsState = await loadProviderLimitsState(createAdminClient(), { forceRefresh: false }).catch(() => null);
  const snap = getLlmStatusSnapshot(lastLlmUsage);
  const keyEnv = LLM_KEY_ENV[snap.provider] ?? "";

  return NextResponse.json({
    llm: {
      enabled: snap.llm_enabled,
      provider: snap.provider,
      model: snap.model,
      keyEnv,
      modelEnv: LLM_MODEL_ENV[snap.provider],
      keyConfigured: snap.provider === "fake" ? false : snap.key_present,
      keyLast4: snap.provider === "anthropic" ? anthropicKey.last4 : keyEnv ? last4(process.env[keyEnv]) : null,
      keySource: anthropicKey.source,
      health: anthropicStatus.health,
      lastUsage: snap.last_llm_usage_timestamp,
      fallbackReason: snap.last_fallback_reason,
      callsToday: llmCallsToday,
      costTodayEgp: llmCostToday,
    },
    treg: {
      live: tregGate.isReady,
      tokenConfigured: Boolean(tregKey.key),
      tokenLast4: tregKey.last4,
      keySource: tregKey.source,
      health: tregStatus.health,
      balance: tregStatus.balance,
      thresholdUsd: settings.lowBalanceThresholdUsd,
      lowBalance: isLowBalance(tregStatus.balance, settings.lowBalanceThresholdUsd),
      baseUrl: (process.env.TREG_BASE_URL || "https://treg.to").replace(/\/$/, ""),
      lastCall: lastTregCall,
      callsToday: tregCallsToday,
    },
    limits: limitsState ? { level: limitsState.spend.level, percent: limitsState.spend.percent, llmLevel: limitsState.spend.llmLevel, llmPercent: limitsState.spend.llmPercent } : undefined,
  });
}

const FIELD_LABEL_KIND: Record<string, "key" | "toggle" | "setting"> = {
  ANTHROPIC_API_KEY: "key", OPENAI_API_KEY: "key", TREG_TOKEN: "key", LLM_ENABLED: "toggle", TREG_LIVE: "toggle",
};

/**
 * Updates provider variables (LLM_ENABLED / LLM_PROVIDER / model / API key / TREG_LIVE / TREG_TOKEN / TREG_BASE_URL).
 * Secrets are accepted here but only ever echoed back as the last 4 characters.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => ({}));
  const updates: Array<{ key: EnvKey; value: string }> = Array.isArray(body?.updates) ? body.updates : [];
  if (!updates.length || updates.length > 4) return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 });

  // Keys are never accepted here: they change only through the validated, encrypted key store (provider-keys route).
  if (updates.some((u) => typeof u?.key === "string" && SECRET_KEYS.has(u.key))) {
    return NextResponse.json({ error: "لا يمكن تغيير المفاتيح من هنا. استخدم زر «استبدال المفتاح» في تبويب المزود: يتحقق من المفتاح ويحفظه مشفّرًا ويُفعّله فورًا." }, { status: 400 });
  }

  for (const u of updates) {
    const err = typeof u?.key === "string" && typeof u?.value === "string" ? validateEnvUpdate(u.key, u.value) : "طلب غير صالح";
    if (err) return NextResponse.json({ error: err, key: u?.key }, { status: 400 });
  }

  const results = await applyEnvUpdates(null, updates, auth.ctx.tables);

  for (const u of updates) {
    const kind = FIELD_LABEL_KIND[u.key] ?? "setting";
    const label = kind === "key" ? "تغيير مفتاح" : kind === "toggle" ? "تشغيل/إيقاف" : "تغيير إعداد";
    const before = !SECRET_KEYS.has(u.key) ? (process.env[u.key] ?? "—") : null;
    const target = SECRET_KEYS.has(u.key)
      ? `${u.key} · ينتهي بـ ${u.value.trim().slice(-4)}`
      : `${u.key}: ${before} → ${u.value.trim()}`;
    await auth.ctx.audit(kind, label, target, { targetType: "env", targetId: u.key });
  }

  return NextResponse.json({ success: results.every((r) => r.ok), results, needsRestart: false });
}
