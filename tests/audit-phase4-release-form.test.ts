import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { generateExcelReport } from "../src/functions/shared/fileGenerators";
import { formatPhoneDisplay } from "../src/lib/phoneDisplay";
import { normalizeReleaseWording, settlementEventAr } from "../src/lib/releaseWording";
import { samplePayload } from "../src/lib/outputStandard";
import { BANNED_RELEASE_FORMS_AR, walletDisplayText } from "../src/lib/walletText";
import { renderEmailTemplate } from "../supabase/functions/send-email/templates";
import { renderEmailTemplate as renderSharedTemplate } from "../src/functions/shared/emailTemplates";

const RELEASED = "حجز مؤقت مُحرَّر";
const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe("audit phase 4: «حجز مؤقت مُحرَّر» is the ONLY customer-facing form", () => {
  const VERB_FORMS = /حُرّر\s+(?:ال)?حجز|حُرِّر\s+(?:ال)?حجز|تحرير\s+(?:ال)?حجز|يُحرَّر\s+الباقي|تعذر\s+تحرير\s+الرصيد/;
  it("no customer-facing source in src or the e-mail function uses the verb form or «تحرير الحجز»", () => {
    // allowed: the legal text, the admin pages, and the two files that DEFINE the banned list and read old stored text through it
    const allowed = [/lib\/legalText\.ts$/, /admin\//, /app\/admin\//, /lib\/walletText\.ts$/, /lib\/releaseWording\.ts$/];
    const hits: string[] = [];
    for (const file of [...walk("src"), "supabase/functions/send-email/templates.ts"]) {
      if (allowed.some((pattern) => pattern.test(file))) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        if (VERB_FORMS.test(line)) hits.push(`${file}:${index + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("the wallet's banned list names every old form, and shown text never contains one", () => {
    expect(BANNED_RELEASE_FORMS_AR).toEqual(["تحرير حجز", "تحرير الحجز المؤقت", "حُرّر الحجز المؤقت", "حُرّر حجز مؤقت", "حُرّر حجزك المؤقت", "يُحرَّر الباقي", "استرداد", "إرجاع"]);
    for (const stored of ["حُرّر الحجز المؤقت كاملًا ولم يُخصم أي رصيد", "حُرّر حجز مؤقت بقيمة ٢٠ نقطة", "تحرير الحجز المؤقت كاملًا لفشل الاستخراج", "ولا يُحتسب عليك إلا ما سُلّم، ويُحرَّر الباقي من الحجز المؤقت"]) {
      const shown = walletDisplayText(stored);
      expect(shown).toContain(RELEASED);
      for (const banned of BANNED_RELEASE_FORMS_AR.slice(0, 6)) expect(shown).not.toContain(banned);
    }
  });

  it("old stored text (bell, request cards, activity) is read as the noun form", () => {
    expect(normalizeReleaseWording("حُرّر حجز مؤقت بقيمة ٢٠ نقطة")).toBe("حجز مؤقت مُحرَّر بقيمة ٢٠ نقطة");
    expect(normalizeReleaseWording("تعذّر الإكمال · حُرّر الحجز المؤقت")).toBe("تعذّر الإكمال · حجز مؤقت مُحرَّر");
    expect(normalizeReleaseWording("حُرّر حجزك المؤقت")).toBe(RELEASED);
    expect(normalizeReleaseWording("ويُحرَّر الباقي من الحجز المؤقت")).toBe("والباقي حجز مؤقت مُحرَّر");
    expect(normalizeReleaseWording("تعذر تحرير الرصيد المحجوز للمهمة.")).toBe("تعذر تأكيد الحجز المؤقت المُحرَّر للمهمة.");
  });

  it("the settlement line and the e-mails say the noun form", () => {
    expect(settlementEventAr({ reservedPoints: 135, chargedPoints: 4 }, (value) => String(value))).toContain(RELEASED);
    const vars = { Name: "أحمد", Points: "٢٠", JobTitle: "بحث", Reason: "سبب", Balance: "٣٠٠" };
    for (const render of [renderEmailTemplate, renderSharedTemplate]) {
      const refund = render("refund", vars);
      expect(refund.subject).toBe("حجز مؤقت مُحرَّر بقيمة ٢٠ نقطة");
      expect(refund.html).not.toMatch(VERB_FORMS);
    }
  });

  it("the notification-preference label in settings is the noun form", () => {
    const settings = src("src/app/dashboard/settings/page.tsx");
    expect(settings).toContain('["refund", "حجز مؤقت مُحرَّر", "عند أي حجز مؤقت مُحرَّر من رصيدك"]');
    expect(settings).toContain("غير قابل للاسترداد بعد الحذف"); // the account-deletion line is the owner's exception
  });

  it("untouched by this change: the legal text, the admin alert and the admin recover route", () => {
    expect(src("src/lib/legalText.ts")).toContain("لا يُعاد الرصيد عن سجل تم تسليمه");
    expect(src("src/components/admin/AdminShell.tsx")).toContain("فشل بحث وتحرير حجز");
    expect(src("src/app/api/admin/jobs/recover/route.ts")).toContain("تحرير الحجز المؤقت");
  });
});

describe("audit phase 4: the decision-makers workbook writes the phone like the companies sheet", () => {
  async function phoneCells(kind: "people" | "companies") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await generateExcelReport(samplePayload(kind))) as never);
    const ws = wb.worksheets[0];
    const rows: string[][] = [];
    ws.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((value) => String(value && typeof value === "object" && "text" in (value as object) ? (value as { text: string }).text : value ?? ""))));
    const headerIndex = rows.findIndex((row) => row.some((cell) => cell === "رقم الهاتف" || cell === "الهاتف التجاري"));
    const column = rows[headerIndex].findIndex((cell) => cell === "رقم الهاتف" || cell === "الهاتف التجاري");
    return rows.slice(headerIndex + 1).map((row) => row[column]);
  }
  it("people and companies both show +201000000000 style numbers, from formatPhoneDisplay", async () => {
    const people = await phoneCells("people");
    const companies = await phoneCells("companies");
    expect(people.length).toBeGreaterThan(0);
    for (const cell of [...people, ...companies]) expect(cell).toMatch(/^\+\d{12}$/);
    expect(people[0]).toBe(formatPhoneDisplay("+20 100 000 0000"));
    expect(people[0]).toBe(companies[0]);
  });
  it("a record with no phone still says «غير متاح»", async () => {
    const wb = new ExcelJS.Workbook();
    const payload = samplePayload("people");
    payload.rows = [{ ...payload.rows[0], phone: "" }];
    await wb.xlsx.load((await generateExcelReport(payload)) as never);
    const texts: string[] = [];
    wb.worksheets[0].eachRow((row) => (row.values as unknown[]).slice(1).forEach((value) => texts.push(String(value && typeof value === "object" && "text" in (value as object) ? (value as { text: string }).text : value ?? ""))));
    expect(texts).toContain("غير متاح");
  });
});
