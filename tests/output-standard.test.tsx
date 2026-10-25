import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  OUTPUT_STANDARDS,
  SAMPLE_FILES,
  SAMPLE_LABEL_AR,
  SAMPLE_PREVIEW_ROWS,
  SAMPLE_ROWS,
  samplePayload,
  samplePreview,
  standardFileName,
  type OutputKind,
} from "../src/lib/outputStandard";
import { buildSampleWorkbook } from "../src/lib/server/sampleFiles";
import { SampleFile } from "../src/components/landing/Sections";
import { generateExcelReport } from "../src/functions/shared/fileGenerators";

const KINDS = Object.keys(OUTPUT_STANDARDS) as OutputKind[];

async function load(buffer: Buffer | Uint8Array) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  return wb;
}
const cellText = (value: unknown) => (value && typeof value === "object" && "text" in (value as any) ? String((value as any).text) : String(value ?? ""));

/** The header row and data rows of a workbook's one data sheet, whatever banner rows precede the table. */
function table(wb: ExcelJS.Workbook, headerFirstCell: string) {
  const ws = wb.worksheets[0];
  const rows: string[][] = [];
  ws.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map(cellText)));
  const headerIndex = rows.findIndex((r) => r[0] === headerFirstCell);
  return { headers: rows[headerIndex], data: rows.slice(headerIndex + 1) };
}
const HEADER_FIRST: Record<OutputKind, string> = { comments: "معرف السجل", companies: "اسم الشركة", people: "م" };

describe("one standard workbook per kind of data", () => {
  it("each has ONE data sheet and no summary sheet by default", async () => {
    for (const kind of KINDS) {
      const standard = OUTPUT_STANDARDS[kind];
      expect(standard.dataSheets).toBe(1);
      expect(standard.summarySheet).toBe(false);
      const wb = await load(await generateExcelReport(samplePayload(kind)));
      expect(wb.worksheets, kind).toHaveLength(1);
      expect(wb.worksheets[0].name, kind).toBe(standard.sheetNameAr);
      expect(wb.worksheets[0].views?.[0]?.rightToLeft, kind).toBe(true);
    }
  });

  it("file names are built from the task, never from an id, and are safe", () => {
    expect(standardFileName({ kind: "comments", subject: "منتخب مصر في كأس العالم", count: 500, date: "2026-10-20", ext: "xlsx" })).toBe("منتخب مصر في كأس العالم - 500 تعليق - 2026-10-20.xlsx");
    expect(standardFileName({ kind: "companies", subject: "مقاولات في مصر", count: 50, date: "2026-10-20", ext: "xlsx" })).toBe("مقاولات في مصر - 50 شركة - 2026-10-20.xlsx");
    const unsafe = standardFileName({ kind: "people", subject: 'a/b\\c?d%e*f:g|h"i<j>k', count: 3, date: "2026-10-20", ext: "csv" });
    expect(unsafe).not.toMatch(/[/\\?%*:|"<>](?!.*\.)/);
    expect(unsafe.endsWith("- 3 سجل - 2026-10-20.csv")).toBe(true);
    expect(standardFileName({ kind: "comments", subject: "", count: 0, date: "2026-10-20", ext: "xlsx" })).toBe("تعليقات - 1 تعليق - 2026-10-20.xlsx");
    expect(standardFileName({ kind: "comments", subject: "x".repeat(300), count: 1, date: "d", ext: "pdf" }).length).toBeLessThan(100);
  });
});

describe("the sample files are built from fake data with the real generator", () => {
  it("every committed sample is in sync with a fresh build (same sheet, headers, rows) and labelled as a sample", async () => {
    for (const kind of KINDS) {
      const path = `public/samples/${SAMPLE_FILES[kind].fileName}`;
      expect(existsSync(path), path).toBe(true);
      const committed = await load(readFileSync(path));
      const fresh = await load(await buildSampleWorkbook(kind));
      expect(committed.worksheets).toHaveLength(1);
      expect(committed.worksheets[0].name).toBe(OUTPUT_STANDARDS[kind].sheetNameAr);
      expect(table(committed, HEADER_FIRST[kind])).toEqual(table(fresh, HEADER_FIRST[kind]));
      expect(committed.title).toBe(SAMPLE_LABEL_AR);
      expect(committed.description).toContain("وهمي");
    }
  });

  it("holds no real person, company, link, e-mail or phone: only invented names, no link or address at all, zero-numbered phones", () => {
    for (const kind of KINDS) {
      for (const row of SAMPLE_ROWS[kind]) {
        for (const [key, raw] of Object.entries(row)) {
          const value = String(raw);
          // audit phase 3: a sample carries NO link, e-mail address or domain at all (not even a reserved example one)
          expect(key, `${kind}.${key}`).not.toMatch(/url|website|email|link/i);
          expect(value, `${kind}.${key}`).not.toMatch(/example|:\/\/|@|www\./i);
          if (/phone/i.test(key)) expect(value, `${kind}.${key}`).toMatch(/^\+20 100 000 000\d$/);
        }
      }
    }
    const names = SAMPLE_ROWS.people.map((r) => String(r.full_name)).concat(SAMPLE_ROWS.comments.map((r) => String(r.author_name)), SAMPLE_ROWS.companies.map((r) => String(r.company_name)));
    for (const name of names) expect(name).toMatch(/تجريبي|النموذج/);
  });

  it("the landing preview is a subset of the workbook: same header text, same cells", async () => {
    for (const kind of KINDS) {
      const preview = samplePreview(kind);
      expect(preview.rows).toHaveLength(SAMPLE_PREVIEW_ROWS);
      const { headers, data } = table(await load(await buildSampleWorkbook(kind)), HEADER_FIRST[kind]);
      for (let c = 0; c < preview.headers.length; c++) {
        const column = headers.indexOf(preview.headers[c]);
        expect(column, `${kind}: «${preview.headers[c]}» is a column of the workbook`).toBeGreaterThanOrEqual(0);
        preview.rows.forEach((row, r) => expect(cellText(data[r][column]), `${kind} r${r} c${c}`).toBe(row[c]));
      }
    }
  });
});

describe("the landing page shows the sample, clearly labelled", () => {
  const html = renderToStaticMarkup(createElement(SampleFile));
  it("states in the card and in the text that the data is fake", () => {
    expect(html).toContain('data-testid="sample-label"');
    expect(html).toContain(SAMPLE_LABEL_AR);
    expect(html).toContain("وهمية، ولا تخص أي شخص أو جهة حقيقية");
  });
  it("offers the file for download and one tab per kind of file", () => {
    expect(html).toContain(`href="/samples/${SAMPLE_FILES.comments.fileName}"`);
    for (const kind of KINDS) expect(html).toContain(SAMPLE_FILES[kind].labelAr);
  });
  it("shows Arabic digits and Arabic copy only (the fake data's own links and e-mails excepted)", () => {
    // links and e-mail addresses are shown as they are; every other number is Arabic-Indic
    const text = html.replace(/<[^>]+>/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/\S+@\S+/g, " ");
    expect(text).not.toMatch(/[0-9]/);
    expect(text).not.toMatch(/undefined|null|NaN/);
  });
  it("is part of the landing page", () => {
    expect(readFileSync("src/app/page.tsx", "utf8")).toContain("<SampleFile />");
  });
});
