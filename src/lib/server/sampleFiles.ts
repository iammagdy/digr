import ExcelJS from "exceljs";
import { generateExcelReport } from "../../functions/shared/fileGenerators";
import { SAMPLE_LABEL_AR, samplePayload, type OutputKind } from "../outputStandard";

/**
 * The sample workbook of a kind: the REAL generator on FAKE rows, so it is what a customer would receive, then labelled as a
 * sample (workbook title and description). The sheet itself stays a data sheet; no summary sheet is added.
 */
export async function buildSampleWorkbook(kind: OutputKind): Promise<Buffer> {
  const generated = await generateExcelReport(samplePayload(kind));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(generated as any);
  wb.title = SAMPLE_LABEL_AR;
  wb.subject = SAMPLE_LABEL_AR;
  wb.description = "هذا الملف نموذج توضيحي: كل ما فيه من أسماء وروابط وأرقام وهمي ولا يخص أي شخص أو جهة حقيقية.";
  wb.creator = "Diger";
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
