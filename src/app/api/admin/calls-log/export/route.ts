import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { EXPORT_MAX_ROWS, parseCallsLogQuery, readCallsForExport } from "@/lib/server/adminCallsLog";
import { CSV_CONTENT_TYPE, XLSX_CONTENT_TYPE, toCsv, toXlsx } from "@/lib/server/callsLogExport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The CURRENT FILTERED result of the calls log as a file: ?format=csv (UTF-8 with a byte-order mark) or ?format=xlsx. Admin only, read only,
 * at most EXPORT_MAX_ROWS rows (newest first). The headers say whether the result was cut.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const format = req.nextUrl.searchParams.get("format") || "csv";
  if (format !== "csv" && format !== "xlsx") return NextResponse.json({ error: "صيغة الملف غير معروفة." }, { status: 400 });
  const parsed = parseCallsLogQuery(req.nextUrl.searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.messageAr }, { status: 400 });
  try {
    const { rows, total, capped } = await readCallsForExport(createAdminClient(), parsed.value);
    try { await auth.ctx.audit("setting", "تصدير سجل الاستدعاءات", format); } catch { /* the audit line is best effort */ }
    const day = new Date().toISOString().slice(0, 10);
    const headers: Record<string, string> = {
      "Content-Disposition": `attachment; filename="calls-log-${day}.${format}"`,
      "Cache-Control": "no-store",
      "X-Export-Rows": String(rows.length),
      "X-Export-Total": String(total),
      "X-Export-Cap": String(EXPORT_MAX_ROWS),
      "X-Export-Capped": capped ? "true" : "false",
    };
    if (format === "csv") return new NextResponse(toCsv(rows), { status: 200, headers: { ...headers, "Content-Type": CSV_CONTENT_TYPE } });
    const file = await toXlsx(rows);
    return new NextResponse(new Uint8Array(file), { status: 200, headers: { ...headers, "Content-Type": XLSX_CONTENT_TYPE } });
  } catch {
    return NextResponse.json({ error: "تعذر تجهيز ملف التصدير الآن." }, { status: 500 });
  }
}
