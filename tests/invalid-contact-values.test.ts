import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { generateExcelReport } from "../src/functions/shared/fileGenerators";
import { arabicVerificationStatus, markedInvalid } from "../src/lib/contactVerification";

/** The rows are built as the delivered company rows are: the email and the phone with the status the SOURCE reported for each. */
async function companySheet(rows: Array<Record<string, unknown>>) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await generateExcelReport({ title: "شركات", country: "السعودية", entityType: "companies", rows } as any)) as any);
  const sheet = workbook.getWorksheet("بيانات الشركات")!;
  const headers = (sheet.getRow(1).values as unknown[]).slice(1).map((value) => String(value));
  const cell = (rowNumber: number, header: string) => String(sheet.getRow(rowNumber).getCell(headers.indexOf(header) + 1).value);
  const allText = () => { const out: string[] = []; sheet.eachRow((row) => row.eachCell((c) => out.push(String(c.value && typeof c.value === "object" && "text" in (c.value as object) ? (c.value as { text: string }).text : c.value)))); return out; };
  return { sheet, headers, cell, allText };
}

describe("a value the source marked invalid is not delivered in the company Excel", () => {
  it("markedInvalid: only a PRESENT value the source called invalid; no report, to review, not verified and a missing value are not invalid", () => {
    for (const status of ["invalid", "INVALID", "undeliverable", "disposable", "fail", "غير صالح"]) expect(markedInvalid(status, true), status).toBe(true);
    for (const status of ["valid", "verified", "متحقق", "accept_all", "catch-all", "يحتاج مراجعة", "لم يتم التحقق", "لم يتوفر تأكيد", "", undefined, null, false, true]) expect(markedInvalid(status, true), String(status)).toBe(false);
    expect(markedInvalid("invalid", false)).toBe(false); // nothing to withhold when there is no value
    expect(arabicVerificationStatus("invalid", true)).toBe("غير صالح");
  });

  it("an invalid e-mail and an invalid phone are written «غير متاح»; every other value is delivered as before", async () => {
    const { cell, allText } = await companySheet([
      { company_name: "صالحة", work_email: "ok@valid.sa", work_email_verification_status: "valid", phone: "+966 50 123 4567", phone_verification_status: "متحقق" },
      { company_name: "بريد مرفوض", work_email: "x@bad.sa", work_email_verification_status: "invalid", phone: "+966 50 765 4321", phone_verification_status: "متحقق" },
      { company_name: "هاتف مرفوض", work_email: "y@fine.sa", work_email_verification_status: "valid", phone: "+966 50 000 1111", phone_verification_status: "غير صالح" },
      { company_name: "الاثنان مرفوضان", work_email: "z@dead.sa", work_email_verification_status: "undeliverable", phone: "+966 50 222 3333", phone_verification_status: "invalid" },
      { company_name: "بلا تقرير", work_email: "n@none.sa", phone: "+966 50 444 5555" },
      { company_name: "مراجعة", work_email: "r@review.sa", work_email_verification_status: "accept_all", phone: "+966 50 666 7777", phone_verification_status: "لم يتم التحقق" },
      { company_name: "بلا قيم", work_email: "", phone: "" },
    ]);
    expect(cell(2, "البريد المهني")).toBe("ok@valid.sa");
    expect(cell(2, "الهاتف التجاري")).toBe("+966501234567");
    expect(cell(3, "البريد المهني")).toBe("غير متاح");
    expect(cell(3, "الهاتف التجاري")).toBe("+966507654321");
    expect(cell(4, "البريد المهني")).toBe("y@fine.sa");
    expect(cell(4, "الهاتف التجاري")).toBe("غير متاح");
    expect(cell(5, "البريد المهني")).toBe("غير متاح");
    expect(cell(5, "الهاتف التجاري")).toBe("غير متاح");
    expect(cell(6, "البريد المهني")).toBe("n@none.sa");
    expect(cell(6, "الهاتف التجاري")).toBe("+966504445555");
    expect(cell(7, "البريد المهني")).toBe("r@review.sa");
    expect(cell(7, "الهاتف التجاري")).toBe("+966506667777");
    expect(cell(8, "البريد المهني")).toBe("غير متاح");
    // the withheld values appear nowhere in the sheet
    const text = allText().join(" | ");
    for (const withheld of ["x@bad.sa", "z@dead.sa", "+966500001111", "+966502223333"]) expect(text).not.toContain(withheld);
  });

  it("an e-mail the source called invalid is withheld whatever key it came under (email, workEmail) and whatever status key (email_verification_status)", async () => {
    const { cell } = await companySheet([
      { company_name: "أ", email: "a@bad.sa", email_verification_status: "invalid" },
      { company_name: "ب", workEmail: "b@bad.sa", work_email_verification_status: "disposable" },
      { company_name: "ج", email: "c@ok.sa", email_verification_status: "deliverable" },
    ]);
    expect(cell(2, "البريد المهني")).toBe("غير متاح");
    expect(cell(3, "البريد المهني")).toBe("غير متاح");
    expect(cell(4, "البريد المهني")).toBe("c@ok.sa");
  });

  it("the company workbook still has no status column, so a withheld value cannot be told apart from a missing one by a status (it says «غير متاح»)", async () => {
    const { headers } = await companySheet([{ company_name: "أ", work_email: "a@bad.sa", work_email_verification_status: "invalid" }]);
    expect(headers.some((header) => /^حالة تحقق/.test(header))).toBe(false);
  });
});
