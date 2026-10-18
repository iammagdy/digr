import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { savePromoCodeAsAdmin } from "@/lib/server/adminCredit";
import { normalizePromoCode, isWellFormedPromoCode } from "@/lib/server/promoCodes";
import { summarizePromoCodes } from "@/lib/server/promoStats";
import { getAuthAccount } from "@/lib/server/authAccount";

export const dynamic = "force-dynamic";

function missingTable(error: any): boolean {
  return /42P01|PGRST205|does not exist|schema cache|could not find/i.test(`${error?.code || ""} ${error?.message || ""}`);
}

export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const client = createAdminClient();

  const codes = await client.from("promo_codes").select("*").order("created_at", { ascending: false }).limit(500);
  if (codes.error) {
    if (missingTable(codes.error)) {
      console.warn("[money:promo_codes_unavailable] migration not applied");
      return NextResponse.json({ codes: [], migrationPending: true });
    }
    return NextResponse.json({ error: "تعذّر تحميل الأكواد." }, { status: 500 });
  }
  const redemptions = await client.from("promo_redemptions").select("code,user_id,redeemed_at").order("redeemed_at", { ascending: false }).limit(5000);
  if (redemptions.error) return NextResponse.json({ error: "تعذّر تحميل الاستخدامات." }, { status: 500 });

  const ids = [...new Set((redemptions.data || []).map((r: any) => String(r.user_id)))];
  const accounts = new Map<string, { name: string; email: string; createdAt: string | null }>();
  for (let i = 0; i < ids.length; i += 20) {
    await Promise.all(ids.slice(i, i + 20).map(async (id) => {
      const account = await getAuthAccount(client, id);
      accounts.set(id, { name: account.name, email: account.email, createdAt: account.createdAt });
    }));
  }
  return NextResponse.json({ codes: summarizePromoCodes(codes.data || [], redemptions.data || [], accounts), migrationPending: false });
}

function parseDate(value: unknown): string | null | "invalid" {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "invalid" : date.toISOString();
}

/** Create or edit a code. The database function re-checks the admin role and the limits. */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => ({}));
  const code = normalizePromoCode(body?.code);
  const points = Number(body?.points);
  const max = Number(body?.maxRedemptions);
  const startsAt = parseDate(body?.startsAt);
  const expiresAt = parseDate(body?.expiresAt);
  if (!isWellFormedPromoCode(code)) return NextResponse.json({ error: "الكود يتكوّن من ٣ إلى ٣٢ حرفًا لاتينيًا كبيرًا أو أرقامًا أو - أو _." }, { status: 400 });
  if (!Number.isInteger(points) || points < 1 || points > 100000) return NextResponse.json({ error: "قيمة الكود يجب أن تكون بين ١ و١٠٠٠٠٠ نقطة." }, { status: 400 });
  if (!Number.isInteger(max) || max < 1) return NextResponse.json({ error: "الحد الأقصى للاستخدام يجب أن يكون ١ أو أكثر." }, { status: 400 });
  if (startsAt === "invalid" || expiresAt === "invalid") return NextResponse.json({ error: "التاريخ غير صالح." }, { status: 400 });

  const outcome = await savePromoCodeAsAdmin(createAdminClient(), auth.ctx.adminId, {
    code, points, maxRedemptions: max, startsAt, expiresAt,
    active: body?.active !== false,
    note: String(body?.note ?? "").trim().slice(0, 200),
  });
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.messageAr, reason: outcome.reason }, { status: outcome.reason === "not_admin" ? 403 : outcome.reason === "unavailable" ? 503 : 400 });
  }
  await auth.ctx.audit("setting", "حفظ كود ترويجي", code, { targetType: "promo_code", targetId: code });
  return NextResponse.json({ success: true, messageAr: outcome.messageAr });
}

/** Enable or disable a code without touching its other fields. */
export async function PATCH(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await req.json().catch(() => ({}));
  const code = normalizePromoCode(body?.code);
  if (!isWellFormedPromoCode(code) || typeof body?.active !== "boolean") return NextResponse.json({ error: "طلب غير صالح." }, { status: 400 });
  const client = createAdminClient();
  const { data: row, error } = await client.from("promo_codes").select("*").eq("code", code).maybeSingle();
  if (error || !row) return NextResponse.json({ error: "الكود غير موجود." }, { status: 404 });
  const outcome = await savePromoCodeAsAdmin(client, auth.ctx.adminId, {
    code, points: row.points, maxRedemptions: row.max_redemptions, startsAt: row.starts_at, expiresAt: row.expires_at,
    active: body.active, note: row.note || "",
  });
  if (!outcome.ok) return NextResponse.json({ error: outcome.messageAr, reason: outcome.reason }, { status: outcome.reason === "not_admin" ? 403 : 400 });
  await auth.ctx.audit("toggle", body.active ? "تفعيل كود ترويجي" : "تعطيل كود ترويجي", code, { targetType: "promo_code", targetId: code });
  return NextResponse.json({ success: true });
}
