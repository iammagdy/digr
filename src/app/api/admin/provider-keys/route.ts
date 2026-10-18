import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import {
  MSG, PROVIDER_LABEL_AR, isProviderId, loadProviderTabState, replaceProviderKey, rollbackProviderKey,
  saveProviderKeySettings, validateSettingsInput,
} from "@/lib/server/providerKeyAdmin";

export const dynamic = "force-dynamic";

/** Everything the provider tab shows: masked key (last 4 only), store state, real health and balance, activity. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const provider = req.nextUrl.searchParams.get("provider");
  if (!isProviderId(provider)) return NextResponse.json({ error: "مزود غير معروف." }, { status: 400 });
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";
  try {
    const state = await loadProviderTabState({ client: createAdminClient() }, provider, { forceRefresh: refresh });
    return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "تعذر تحميل بيانات المزود الآن." }, { status: 500 });
  }
}

/**
 * action = "replace" (validate the new key with the provider, then save it encrypted), "rollback" (one step back)
 * or "settings" (low-balance threshold, provider team id). Admin is verified here and again inside the SQL function.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => ({}));
  const provider = body?.provider;
  if (!isProviderId(provider)) return NextResponse.json({ error: "مزود غير معروف." }, { status: 400 });
  const client = createAdminClient();
  const adminId = auth.ctx.adminId;

  if (body?.action === "replace") {
    const outcome = await replaceProviderKey({ client }, { adminId, provider, newKey: body?.key });
    if (outcome.ok) await auth.ctx.audit("key", `تغيير مفتاح ${PROVIDER_LABEL_AR[provider]}`, `${provider} · ينتهي بـ ${outcome.last4 ?? "—"}`, { targetType: "provider_key", targetId: provider });
    return NextResponse.json({ success: outcome.ok, reason: outcome.reason, message: outcome.messageAr }, { status: outcome.status });
  }

  if (body?.action === "rollback") {
    const outcome = await rollbackProviderKey({ client }, { adminId, provider });
    if (outcome.ok) await auth.ctx.audit("key", `رجوع إلى المفتاح السابق لـ ${PROVIDER_LABEL_AR[provider]}`, `${provider} · ينتهي بـ ${outcome.last4 ?? "—"}`, { targetType: "provider_key", targetId: provider });
    return NextResponse.json({ success: outcome.ok, reason: outcome.reason, message: outcome.messageAr }, { status: outcome.status });
  }

  if (body?.action === "settings") {
    if (provider !== "treg") return NextResponse.json({ error: "هذه الإعدادات لمزود البيانات فقط." }, { status: 400 });
    const parsed = validateSettingsInput({ lowBalanceThresholdUsd: body?.lowBalanceThresholdUsd, tregOrgId: body?.tregOrgId });
    if (!parsed.ok) return NextResponse.json({ success: false, message: parsed.messageAr }, { status: 400 });
    const saved = await saveProviderKeySettings(client, parsed.value);
    if (!saved) return NextResponse.json({ success: false, message: MSG.failed }, { status: 500 });
    await auth.ctx.audit("setting", "تعديل إعدادات مزود البيانات", `${Object.keys(parsed.value).join("، ")}`, { targetType: "provider_settings", targetId: provider });
    return NextResponse.json({ success: true, message: "تم حفظ الإعدادات." });
  }

  return NextResponse.json({ error: "طلب غير صالح." }, { status: 400 });
}
