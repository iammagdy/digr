import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { EXPORT_MAX_ROWS, EXPORT_TABLE_IDS, type ExportTableId } from "@/lib/adminExport";
import { readExportPage } from "./exportRead";

export const dynamic = "force-dynamic";

/**
 * Admin only, SELECT only: one page (at most 1000 rows) of one of the five exported tables, oldest first (created_at, then id), so rows
 * written while the export runs land at the end and never shift the pages already read. The page assembles the file in the browser;
 * this route keeps no state and writes nothing (no audit row either: the export must never write).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;

  const table = req.nextUrl.searchParams.get("table") || "";
  if (!EXPORT_TABLE_IDS.has(table)) return NextResponse.json({ error: "جدول غير معروف." }, { status: 400 });
  const offset = Math.max(0, Math.floor(Number(req.nextUrl.searchParams.get("offset") || 0)) || 0);
  if (offset >= EXPORT_MAX_ROWS) return NextResponse.json({ table, offset, rows: [], columns: [], omitted: [], done: true, capped: true });

  const page = await readExportPage(createAdminClient(), table as ExportTableId, offset);
  if (!page) return NextResponse.json({ error: "تعذّرت قراءة هذا الجدول الآن. أعد المحاولة بعد قليل." }, { status: 500 });

  return NextResponse.json({
    table,
    offset,
    rows: page.rows,
    columns: page.columns,
    omitted: page.omitted,
    count: page.count,
    done: page.done,
  });
}
