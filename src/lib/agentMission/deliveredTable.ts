import ExcelJS from "exceljs";
import { cellText } from "../server/csvFromExcel";
import { csvCell } from "./csvText";
import { withoutProviderHosts } from "./providerLabels";
import { escapeFormula } from "../server/normalizationPipeline";
import { FileShapeError } from "../../functions/shared/fileGenerators";
import {
  FILE_SPEC_LIMITS,
  specColumns,
  applySpecToRows,
  groupRows,
  sheetNames,
  type DatasetColumn,
  type FileSpec,
} from "../fileSpec";
import { toArabicDigits } from "../arabicDigits";

export const DELIVERED_SHAPE_MAX_ROWS = 20_000;

export interface DeliveredTable {
  sheetName: string;
  sheetCount: number;
  columns: DatasetColumn[];
  rows: Array<Record<string, any>>;
}

export type ReadDeliveredTableResult =
  | DeliveredTable
  | {
      error: "invalid" | "no_data_sheet" | "too_many_rows";
      rowCount?: number;
    };

const COLOR_NAVY_HEADER = "FF1F4E79";
const COLOR_WHITE = "FFFFFFFF";
const COLOR_ZEBRA_FILL = "FFF2F2F2";
const BORDER_THIN: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFE0E0E0" } },
  left: { style: "thin", color: { argb: "FFE0E0E0" } },
  bottom: { style: "thin", color: { argb: "FFE0E0E0" } },
  right: { style: "thin", color: { argb: "FFE0E0E0" } },
};

export async function readDeliveredTable(
  bytes: Buffer | Uint8Array | ArrayBuffer,
  options?: { maxRows?: number; headerOnly?: boolean }
): Promise<ReadDeliveredTableResult> {
  const wb = new ExcelJS.Workbook();
  try {
    const buf = bytes instanceof ArrayBuffer ? bytes : Buffer.from(bytes as Uint8Array);
    await (wb.xlsx as any)["load"](buf as unknown as ArrayBuffer);
  } catch {
    return { error: "invalid" };
  }

  const [summary, ...dataSheets] = wb.worksheets;
  if (!summary || dataSheets.length === 0) {
    return { error: "no_data_sheet" };
  }

  const firstDataSheet = dataSheets[0];
  const sheetName = firstDataSheet.name;
  const sheetCount = dataSheets.length;
  const totalRows = firstDataSheet.rowCount;
  const dataRowsCount = Math.max(0, totalRows - 1);
  const maxRows = options?.maxRows ?? DELIVERED_SHAPE_MAX_ROWS;

  if (!options?.headerOnly && dataRowsCount > maxRows) {
    return { error: "too_many_rows", rowCount: dataRowsCount };
  }

  const width = Math.max(1, firstDataSheet.columnCount);
  const row1 = firstDataSheet.getRow(1);
  const columns: DatasetColumn[] = [];
  const colIndices: number[] = [];

  for (let c = 1; c <= width; c++) {
    const rawCell = row1.getCell(c);
    const headerText = cellText(rawCell).trim();
    if (!headerText) continue; // skip empty header columns
    const key = `col_${columns.length + 1}`;
    columns.push({ key, titleAr: headerText });
    colIndices.push(c);
  }

  if (columns.length === 0) {
    return { error: "invalid" };
  }

  if (options?.headerOnly) {
    return { sheetName, sheetCount, columns, rows: [] };
  }

  const rows: Array<Record<string, any>> = [];
  for (let r = 2; r <= totalRows; r++) {
    const rowObj: Record<string, any> = {};
    const excelRow = firstDataSheet.getRow(r);
    for (let i = 0; i < columns.length; i++) {
      const key = columns[i].key;
      const c = colIndices[i];
      const cell = excelRow.getCell(c);
      const val = cell.value;
      if (val === null || val === undefined) {
        rowObj[key] = "";
      } else if (typeof val === "number" && Number.isFinite(val)) {
        rowObj[key] = val;
      } else {
        rowObj[key] = withoutProviderHosts(cellText(cell));
      }
    }
    rows.push(rowObj);
  }

  return { sheetName, sheetCount, columns, rows };
}

export async function deliveredColumnsOf(bytes: Buffer | Uint8Array | ArrayBuffer): Promise<DatasetColumn[]> {
  const result = await readDeliveredTable(bytes, { headerOnly: true });
  if ("error" in result) return [];
  return result.columns.slice(0, 60);
}

export async function deliveredShapedXlsx(table: DeliveredTable, spec: FileSpec): Promise<Buffer> {
  const allColKeys = table.columns.map((c) => c.key);
  const columns = specColumns(allColKeys, spec);
  if (columns.length === 0) throw new FileShapeError("لا توجد أعمدة مطابقة لما طلبته.");
  const labels = new Map(table.columns.map((c) => [c.key, c.titleAr]));

  const rows = applySpecToRows(table.rows, spec);
  if (rows.length === 0) throw new FileShapeError("لا توجد سجلات تطابق شروط التصفية التي طلبتها.");

  let groups: Array<{ value: string; rows: Array<Record<string, any>> }>;
  if (spec.groupBy) {
    groups = groupRows(rows, spec.groupBy.column);
    if (groups.length > FILE_SPEC_LIMITS.maxSheets) {
      throw new FileShapeError(
        `التقسيم المطلوب ينتج ${toArabicDigits(groups.length)} شيتًا، والحد الأقصى ${toArabicDigits(
          FILE_SPEC_LIMITS.maxSheets
        )} شيتًا. اختر عمودًا قيمه أقل.`
      );
    }
  } else {
    groups = [{ value: table.sheetName, rows }];
  }

  const names = spec.groupBy ? sheetNames(groups.map((g) => g.value)) : sheetNames([table.sheetName]);

  const wb = new ExcelJS.Workbook();
  wb.creator = "Diger";
  wb.title = table.sheetName;

  groups.forEach((group, groupIndex) => {
    const sheet = wb.addWorksheet(names[groupIndex], {
      views: [{ state: "frozen", ySplit: 1, rightToLeft: true }],
    });

    const header = sheet.addRow(columns.map((key) => withoutProviderHosts(labels.get(key) || key)));
    header.eachCell((cell) => {
      cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: COLOR_WHITE } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLOR_NAVY_HEADER } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    });
    header.height = 30;

    group.rows.forEach((record, index) => {
      const rowValues = columns.map((key) => {
        const val = record[key];
        if (val === null || val === undefined) return "";
        if (typeof val === "number" && Number.isFinite(val)) return val;
        if (typeof val === "boolean") return val ? "نعم" : "لا";
        const s = withoutProviderHosts(String(val));
        if (/^https?:\/\//i.test(s.trim())) {
          const url = s.trim();
          return { text: url, hyperlink: url, tooltip: url };
        }
        return escapeFormula(s);
      });

      const row = sheet.addRow(rowValues);
      row.height = 22;
      row.alignment = { vertical: "middle", wrapText: true };
      row.eachCell((cell) => {
        cell.border = BORDER_THIN;
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: index % 2 ? COLOR_ZEBRA_FILL : COLOR_WHITE },
        };
        if (cell.hyperlink) {
          cell.font = { name: "Calibri", size: 10, color: { argb: "FF0563C1" }, underline: true };
        }
      });
    });

    sheet.columns = columns.map((key) => ({
      width: /text|caption|title|description/.test(key) ? 48 : /url|link/.test(key) ? 32 : 18,
    }));
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, group.rows.length + 1), column: columns.length },
    };
    sheet.pageSetup = {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9,
    };
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function deliveredShapedCsv(table: DeliveredTable, spec: FileSpec): Promise<Buffer> {
  const allColKeys = table.columns.map((c) => c.key);
  const columns = specColumns(allColKeys, spec);
  if (columns.length === 0) throw new FileShapeError("لا توجد أعمدة مطابقة لما طلبته.");
  const labels = new Map(table.columns.map((c) => [c.key, c.titleAr]));

  const rows = applySpecToRows(table.rows, spec);
  if (rows.length === 0) throw new FileShapeError("لا توجد سجلات تطابق شروط التصفية التي طلبتها.");

  const BOM = "\uFEFF";
  const headerLine = columns
    .map((k) => csvCell(withoutProviderHosts(labels.get(k) || k)))
    .join(",");

  const dataLines = rows.map((r) =>
    columns
      .map((k) => {
        const val = r[k];
        if (val === null || val === undefined) return csvCell("");
        return csvCell(withoutProviderHosts(String(val)));
      })
      .join(",")
  );

  const csv = `${BOM}${[headerLine, ...dataLines].join("\r\n")}`;
  return Buffer.from(csv, "utf8");
}
