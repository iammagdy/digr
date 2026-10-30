import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { getTregKeyPool } from "@/lib/server/tregKeyPool";
import {
  adoptMainKey, addPoolKey, checkPastedKey, checkPoolKeyNow, loadPoolOverview, refreshPoolKeys, removePoolKey, replacePoolKey, setActivePoolKey, setPoolChain, setPoolRollout, setPoolSettings,
  type CheckOutcome, type PoolActionOutcome,
} from "@/lib/server/tregPoolAdmin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The TREG key pool, admin only (docs/proposals/treg-key-pool). The admin is verified here and again inside every SQL function. A key is accepted only in the body of
 * add / adopt_main / replace / check_key, is checked against the provider before it is saved (check_key never saves it), and is NEVER returned: every answer carries last 4 characters at
 * most, and the pasted-key checker's answer carries none. The body is never logged; a failure answers with a fixed Arabic sentence.
 */
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const pool = getTregKeyPool();
  if (!pool) return NextResponse.json({ error: "تعذّر تحميل مجمّع المفاتيح الآن." }, { status: 503, headers: NO_STORE });
  try {
    const overview = await loadPoolOverview({ client: createAdminClient(), pool }, { refresh: req.nextUrl.searchParams.get("refresh") === "1" });
    return NextResponse.json({ overview }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "تعذّر تحميل مجمّع المفاتيح الآن." }, { status: 500, headers: NO_STORE });
  }
}

const ACTION_LABEL: Record<string, string> = {
  add: "إضافة مفتاح TREG", adopt_main: "اعتماد المفتاح الرئيسي لـ TREG", replace: "استبدال مفتاح TREG", remove: "حذف مفتاح TREG", set_active: "تفعيل مفتاح TREG",
  set_chain: "ترتيب سلسلة مفاتيح TREG", set_rollout: "تشغيل/إيقاف مجمّع مفاتيح TREG", settings: "الحد الأدنى لرصيد مفاتيح TREG", refresh: "فحص مفاتيح TREG",
};
/** Actions that write their own audit row inside the limiter (so the route does not write a second one). */
const SELF_AUDITED = new Set(["refresh", "check_key", "check_pool_key"]);

export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const pool = getTregKeyPool();
  if (!pool) return NextResponse.json({ error: "تعذّر تنفيذ الطلب الآن." }, { status: 503, headers: NO_STORE });
  const body = await req.json().catch(() => ({}));
  const action = typeof body?.action === "string" ? body.action : "";
  const deps = { client: createAdminClient(), pool };
  const adminId = auth.ctx.adminId;

  let outcome: PoolActionOutcome | CheckOutcome;
  try {
    switch (action) {
      case "add": outcome = await addPoolKey(deps, { adminId, label: body?.label, key: body?.key }); break;
      case "adopt_main": outcome = await adoptMainKey(deps, { adminId, label: body?.label, key: body?.key }); break;
      case "replace": outcome = await replacePoolKey(deps, { adminId, keyId: body?.keyId, key: body?.key, label: body?.label }); break;
      case "remove": outcome = await removePoolKey(deps, { adminId, keyId: body?.keyId }); break;
      case "set_active": outcome = await setActivePoolKey(deps, { adminId, keyId: body?.keyId, force: body?.force }); break;
      case "set_chain": outcome = await setPoolChain(deps, { adminId, orderedIds: body?.orderedIds }); break;
      case "set_rollout": outcome = await setPoolRollout(deps, { adminId, on: body?.on }); break;
      case "settings": outcome = await setPoolSettings(deps, { adminId, minBalanceUsd: body?.minBalanceUsd }); break;
      case "refresh": outcome = await refreshPoolKeys(deps, { keyId: body?.keyId }); break;
      case "check_key": outcome = await checkPastedKey(deps, { adminId, key: body?.key }); break;
      case "check_pool_key": outcome = await checkPoolKeyNow(deps, { adminId, keyId: body?.keyId }); break;
      default: return NextResponse.json({ error: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
  } catch {
    return NextResponse.json({ error: "تعذّر تنفيذ الطلب الآن." }, { status: 500, headers: NO_STORE });
  }

  // the audit line names the action and the key's number or last 4: never a key
  if (outcome.ok && !SELF_AUDITED.has(action)) {
    const target = [outcome.number ? `رقم ${outcome.number}` : "", outcome.last4 ? `ينتهي بـ ${outcome.last4}` : "", action === "set_rollout" ? (body?.on ? "تشغيل" : "إيقاف") : ""].filter(Boolean).join(" · ") || action;
    await auth.ctx.audit("key", ACTION_LABEL[action] ?? "مجمّع مفاتيح TREG", target, { targetType: "treg_pool", targetId: outcome.keyId ?? action });
  }
  return NextResponse.json(
    { success: outcome.ok, reason: outcome.reason, message: outcome.messageAr, ...(outcome.ok ? {} : { error: outcome.messageAr }), ...(outcome.number ? { number: outcome.number } : {}), ...(outcome.last4 ? { last4: outcome.last4 } : {}), ...("report" in outcome && outcome.report ? { report: outcome.report } : {}) },
    { status: outcome.status, headers: NO_STORE },
  );
}
