"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import { columnsOf, EXPORT_MAX_ROWS, EXPORT_TABLES, exportFileName, rowsToCsv, type ExportTableId } from "@/lib/adminExport";

interface Page {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  omitted: string[];
  count?: number | null;
  done: boolean;
}

const STAMP_KEY = "diger-admin-export-stamps";

function readStamps(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(STAMP_KEY) || "{}") || {}; } catch { return {}; }
}
function saveStamp(table: string) {
  try { localStorage.setItem(STAMP_KEY, JSON.stringify({ ...readStamps(), [table]: new Date().toISOString() })); } catch { /* a convenience only */ }
}

function saveFile(name: string, text: string, type: string) {
  const blob = new Blob(["﻿" + text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 250);
}

/** The backup export: copies of the five tables that hold the money and the accounts. Read only (the route only SELECTs). */
export default function AdminExportPage() {
  const [stamps, setStamps] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>("");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { setStamps(readStamps()); }, []);

  const exportTable = useCallback(async (table: ExportTableId, format: "csv" | "json") => {
    const rows: Array<Record<string, unknown>> = [];
    let omitted: string[] = [];
    let total: number | null = null;
    for (let offset = 0; offset < EXPORT_MAX_ROWS; ) {
      const page = await adminFetch<Page>(`/api/admin/export?table=${table}&offset=${offset}`);
      rows.push(...page.rows);
      omitted = Array.from(new Set([...omitted, ...page.omitted]));
      if (offset === 0) total = page.count ?? null;
      offset += page.rows.length;
      setProgress(`${formatAr(rows.length)}${total !== null ? ` من ${formatAr(total)}` : ""} صفًا`);
      if (page.done || page.rows.length === 0) break;
    }
    const at = new Date();
    if (format === "json") {
      saveFile(exportFileName(table, at, "json"), JSON.stringify({ table, exportedAt: at.toISOString(), rowCount: rows.length, expectedCount: total, omittedColumns: omitted, rows }, null, 1), "application/json;charset=utf-8");
    } else {
      saveFile(exportFileName(table, at, "csv"), rowsToCsv(rows, columnsOf(rows)), "text/csv;charset=utf-8");
    }
    saveStamp(table);
    setStamps(readStamps());
    return { rows: rows.length, total };
  }, []);

  const run = useCallback(async (tables: ExportTableId[], format: "csv" | "json") => {
    setError("");
    setBusy(tables.length > 1 ? "all" : tables[0]);
    try {
      for (const table of tables) {
        setProgress("");
        await exportTable(table, format);
      }
      setProgress("اكتمل التنزيل.");
    } catch (e: any) {
      setError(e?.message || "تعذّر التنزيل. أعد المحاولة.");
    } finally {
      setBusy("");
    }
  }, [exportTable]);

  return (
    <div data-screen-label="Backup export" className="flex flex-col gap-3.5">
      <section className="rounded-[20px] border border-ln bg-sf p-[18px]" aria-labelledby="export-intro">
        <h2 id="export-intro" className="m-0 text-base font-semibold text-ink">نسخة احتياطية للقراءة فقط</h2>
        <p className="mb-0 mt-2.5 text-[13px] leading-[1.9] text-ink2">
          قاعدة البيانات الحالية لا تحتفظ بنسخ احتياطية تلقائية. هذه الصفحة تنزّل نسخة من الجداول الخمسة التي تحمل الأموال والحسابات إلى ملف على جهازك.
          القراءة فقط: لا شيء يُكتب أو يُعدَّل، والصفحة للمشرفين وحدهم، ولا تتضمن أي مفاتيح أو رموز سرية.
        </p>
        <p className="mb-0 mt-2.5 text-[13px] leading-[1.9] text-ink2">
          متى تنزّل: قبل المؤتمر، ثم كل بضع ساعات يوم المؤتمر (كل ثلاث ساعات تقريبًا)، ثم بعد انتهائه. احتفظ بالملفات خارج هذا الجهاز أيضًا.
        </p>
      </section>
      <section className="rounded-[20px] border border-ln bg-sf p-[18px]" aria-labelledby="export-tables">
        <h2 id="export-tables" className="m-0 text-base font-semibold text-ink">الجداول</h2>
        <ul className="m-0 mt-2.5 flex list-none flex-col gap-3 p-0 text-[13px] text-ink2" data-testid="export-tables">
          {EXPORT_TABLES.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-[10rem] font-semibold text-ink">{t.titleAr}</span>
              <span className="text-mut">{t.noteAr}</span>
              <span className="text-mut">{stamps[t.id] ? `آخر تنزيل: ${new Date(stamps[t.id]).toLocaleString("ar-EG")}` : "لم يُنزَّل بعد"}</span>
              <button type="button" disabled={Boolean(busy)} onClick={() => run([t.id], "csv")} className="rounded-xl border border-ln px-3 py-1.5 text-ink disabled:opacity-50">ملف CSV</button>
              <button type="button" disabled={Boolean(busy)} onClick={() => run([t.id], "json")} className="rounded-xl border border-ln px-3 py-1.5 text-ink disabled:opacity-50">ملف JSON</button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" disabled={Boolean(busy)} onClick={() => run(EXPORT_TABLES.map((t) => t.id), "csv")} className="rounded-xl bg-ink px-4 py-2 text-sf disabled:opacity-50" data-testid="export-all">
            {busy === "all" ? "جارٍ التنزيل…" : "تنزيل الجداول الخمسة (CSV)"}
          </button>
          {progress && <span className="text-[13px] text-mut" role="status">{progress}</span>}
        </div>
        {error && <p role="alert" className="mb-0 mt-2.5 text-[13px] text-bad">{error}</p>}
      </section>
    </div>
  );
}
