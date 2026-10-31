import { Zip, ZipDeflate } from "fflate";
import {
  columnsOf, EXPORT_MAX_ROWS, EXPORT_PAGE_SIZE, EXPORT_TABLES, EXPORT_ZIP_MAX_ROWS_PER_TABLE, EXPORT_ZIP_TIME_BUDGET_MS, exportFileName, rowsToCsv,
  type ExportTable, type ExportTableId,
} from "@/lib/adminExport";
import { readExportPage, type ExportPageRead } from "../exportRead";

export const ZIP_ERRORS_AR = {
  unreadable: "تعذّرت قراءة الجداول الآن. أعد المحاولة بعد قليل.",
  tooLarge: "حجم الجداول أكبر من حد التنزيل الواحد. نزّل كل جدول على حدة بدل الملف الواحد.",
  incomplete: "انقطع تجهيز الملف قبل اكتماله، ولم يُحفظ أي ملف. أعد المحاولة، أو نزّل الجداول واحدًا واحدًا.",
} as const;

export type BackupPrepared =
  | { ok: false; status: 413 | 500; error: string }
  | { ok: true; stream: ReadableStream<Uint8Array>; expectedRows: number };

/** The CSV exactly as the page-by-page download writes it: a byte-order mark, then rowsToCsv over the union of the columns. */
export function csvBytes(rows: Array<Record<string, unknown>>): Uint8Array {
  return new TextEncoder().encode("\uFEFF" + rowsToCsv(rows, columnsOf(rows)));
}

/**
 * Reads the first page of all five tables (SELECT only, the same reader as the page-by-page route), refuses a table that is too large BEFORE anything
 * is sent, then returns a stream of one ZIP: the five CSV files, then manifest.json LAST with the real row counts. A read that fails or runs past the time
 * budget ERRORS the stream, so the download fails as a whole: a short or half-written file is never delivered as if it were complete (and a ZIP cut short
 * has no manifest and no central directory, so it also does not open).
 */
export async function prepareBackupZip(
  db: { from: (table: string) => any },
  options: { now?: Date; clock?: () => number; budgetMs?: number; maxRowsPerTable?: number; tables?: ExportTable[] } = {},
): Promise<BackupPrepared> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const budget = options.budgetMs ?? EXPORT_ZIP_TIME_BUDGET_MS;
  const cap = Math.min(options.maxRowsPerTable ?? EXPORT_ZIP_MAX_ROWS_PER_TABLE, EXPORT_MAX_ROWS);
  const at = options.now ?? new Date();
  const tableList = options.tables ?? EXPORT_TABLES;

  const firstPages = new Map<ExportTableId, ExportPageRead>();
  for (const table of tableList) {
    const page = await readExportPage(db, table.id, 0);
    if (!page) return { ok: false, status: 500, error: ZIP_ERRORS_AR.unreadable };
    if ((page.count ?? page.rows.length) > cap) return { ok: false, status: 413, error: ZIP_ERRORS_AR.tooLarge };
    firstPages.set(table.id, page);
  }
  const expectedRows = [...firstPages.values()].reduce((sum, page) => sum + (page.count ?? page.rows.length), 0);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const zip = new Zip((error, chunk, final) => {
          if (error) { controller.error(error); return; }
          controller.enqueue(chunk);
          if (final) controller.close();
        });
        const add = (name: string, bytes: Uint8Array) => {
          const file = new ZipDeflate(name, { level: 6 });
          zip.add(file);
          file.push(bytes, true);
        };

        const files: Array<Record<string, unknown>> = [];
        let totalRows = 0;
        for (const table of tableList) {
          const first = firstPages.get(table.id)!;
          const rows: Array<Record<string, unknown>> = [...first.rows];
          let omitted = new Set(first.omitted);
          let done = first.done;
          for (let offset = rows.length; !done && offset < cap + EXPORT_PAGE_SIZE; ) {
            if (clock() - started > budget) throw new Error("time budget");
            const page = await readExportPage(db, table.id, offset);
            if (!page) throw new Error("read failed");
            rows.push(...page.rows);
            for (const name of page.omitted) omitted.add(name);
            offset += page.rows.length;
            done = page.done || page.rows.length === 0;
          }
          // the table grew past the ceiling while it was being read: a file that stopped short is never delivered
          if (!done || rows.length > cap) throw new Error("table too large");
          const bytes = csvBytes(rows);
          const name = exportFileName(table.id, at, "csv");
          add(name, bytes);
          totalRows += rows.length;
          files.push({ file: name, table: table.id, rows: rows.length, rowsAtStart: first.count ?? null, bytes: bytes.length, omittedColumns: [...omitted] });
        }

        const manifest = {
          note: "نسخة احتياطية للقراءة فقط. هذا الملف يُكتب أخيرًا: إن لم تجده في الأرشيف فالتنزيل لم يكتمل.",
          complete: true,
          exportedAt: at.toISOString(),
          totalRows,
          files,
        };
        add("manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 1)));
        zip.end();
      } catch {
        // a fixed reason only: no row, no table content and no database message is ever logged or sent
        console.error("[admin-export-zip] aborted");
        controller.error(new Error(ZIP_ERRORS_AR.incomplete));
      }
    },
  });
  return { ok: true, stream, expectedRows };
}
