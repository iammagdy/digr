import { NextRequest, NextResponse } from "next/server";
import { Query } from "node-appwrite";
import { authenticateAdmin, creditValueEgp, listAllUsers } from "@/lib/server/adminAuth";
import { normalizeDigits } from "@/lib/arabicDigits";

export const dynamic = "force-dynamic";

async function readPublic(tables: any) {
  try { return (await tables.getRow({ databaseId: "digr", tableId: "settings_public", rowId: "pricing" })) as any; } catch { return null; }
}

export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { tables, users } = auth.ctx;
  const row = await readPublic(tables);

  let admins: any[] = [];
  try {
    admins = (await users.list({ queries: [Query.equal("labels", ["admin"]), Query.limit(50)] })).users;
  } catch {
    admins = (await listAllUsers(users, [], 2000)).filter((u) => Array.isArray(u.labels) && u.labels.includes("admin"));
  }

  return NextResponse.json({
    creditValueEgp: row?.creditValueEgp ?? 0.1,
    maxPendingTopups: Number.isInteger(row?.maxPendingTopups) ? row.maxPendingTopups : 3,
    ipa: row?.ipa ?? process.env.NEXT_PUBLIC_INSTAPAY_HANDLE ?? "",
    admins: admins.map((u) => ({ id: u.$id, name: u.name || "", email: u.email || "", lastLogin: u.accessedAt || null })),
  });
}

/** Saves pricing/top-up settings to settings_public/pricing and records each changed field in the audit log. */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { tables } = auth.ctx;
  const body = await req.json().catch(() => ({}));

  const credit = Number(normalizeDigits(String(body.creditValueEgp ?? "")).replace(",", "."));
  const maxPending = Number(normalizeDigits(String(body.maxPendingTopups ?? "")));
  const ipa = String(body.ipa ?? "").trim();
  if (!(credit > 0 && credit <= 100)) return NextResponse.json({ error: "قيمة النقطة غير صالحة" }, { status: 400 });
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 20) return NextResponse.json({ error: "الحد الأقصى للطلبات المعلقة يجب أن يكون بين ١ و٢٠" }, { status: 400 });
  if (ipa.length < 3 || ipa.length > 128 || /\s/.test(ipa)) return NextResponse.json({ error: "عنوان الدفع اللحظي غير صالح" }, { status: 400 });

  const before = await readPublic(tables);
  const data = { creditValueEgp: credit, maxPendingTopups: maxPending, ipa, updatedAt: new Date().toISOString() };
  try {
    if (before) await tables.updateRow({ databaseId: "digr", tableId: "settings_public", rowId: "pricing", data });
    else await tables.createRow({ databaseId: "digr", tableId: "settings_public", rowId: "pricing", data: { key: "pricing", ...data } });
  } catch {
    return NextResponse.json({ error: "تعذّر الحفظ — تأكد من تشغيل سكربت ترحيل قاعدة البيانات (setup-redesign-db)" }, { status: 500 });
  }

  const prevCredit = before?.creditValueEgp ?? (await creditValueEgp(tables));
  const changes: string[] = [];
  if (prevCredit !== credit) changes.push(`creditValueEgp: ${prevCredit} → ${credit}`);
  if ((before?.maxPendingTopups ?? 3) !== maxPending) changes.push(`maxPendingTopups: ${before?.maxPendingTopups ?? 3} → ${maxPending}`);
  if ((before?.ipa ?? "") !== ipa) changes.push(`ipa: ${before?.ipa || "—"} → ${ipa}`);
  for (const c of changes) await auth.ctx.audit("setting", "تغيير إعداد", c, { targetType: "settings_public", targetId: "pricing" });

  return NextResponse.json({ success: true, changed: changes.length });
}
