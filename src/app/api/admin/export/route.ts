import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { columnsOf, EXPORT_MAX_ROWS, EXPORT_PAGE_SIZE, EXPORT_TABLE_IDS, stripSecrets } from "@/lib/adminExport";

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

  const query = createAdminClient()
    .from(table)
    .select("*", offset === 0 ? { count: "exact" } : undefined)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + EXPORT_PAGE_SIZE - 1);
  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: "تعذّرت قراءة هذا الجدول الآن. أعد المحاولة بعد قليل." }, { status: 500 });

  const omitted = new Set<string>();
  const rows = (data || []).map((raw: Record<string, unknown>) => {
    const { row, omitted: left } = stripSecrets(raw);
    for (const name of left) omitted.add(name);
    return row;
  });
  return NextResponse.json({
    table,
    offset,
    rows,
    columns: columnsOf(rows),
    omitted: [...omitted],
    count: offset === 0 ? count ?? null : undefined,
    done: rows.length < EXPORT_PAGE_SIZE,
  });
}
