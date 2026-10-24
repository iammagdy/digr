import { generateFacebookReportExcel } from "./facebookReportExcel";
import { generateFacebookReportPdf } from "./facebookReportPdf";
import type { ReportPayload } from "../../lib/facebookReport/aggregate";

/**
 * The saved data of a finished Facebook topic report job carries the report in `metadata.facebookReport` (posts with their axes, the collection counts) and its comments in
 * `rows`. Every place that turns saved data into a file (the worker at completion, the download route, the methodology add-on, the artifact versions) asks here whether the data is a
 * report and, if so, builds the report's own workbook and methodology file instead of the generic ones.
 */
export const facebookReportOf = (payload: any): ReportPayload | null => {
  const report = payload?.metadata?.facebookReport;
  return report && report.v === 1 && Array.isArray(report.posts) ? (report as ReportPayload) : null;
};

export const buildFacebookReportExcelFrom = (payload: any): Promise<Buffer> => generateFacebookReportExcel(facebookReportOf(payload)!, Array.isArray(payload?.rows) ? payload.rows : []);
export const buildFacebookReportPdfFrom = (payload: any): Promise<Buffer> => generateFacebookReportPdf(facebookReportOf(payload)!);
