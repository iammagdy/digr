import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/hooks/useUser", () => ({ useUser: () => ({ user: null, loading: false }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => "/" }));

import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import ResultsCanvas from "../src/app/dashboard/chat/components/ResultsCanvas";
import TopupForm from "../src/app/dashboard/topup/TopupForm";
import { generateExcelReport } from "../src/functions/shared/fileGenerators";
import { contactCellUnavailable } from "../src/lib/contactVerification";
import { NOTIFICATION_LIST_LIMIT, bellBadgeText, mergeNewerNotifications } from "../src/lib/notificationBadge";
import { PHONE_MAY_BE_INCOMPLETE_AR, phoneMayBeIncomplete } from "../src/lib/phoneDisplay";
import { pluralizeStoredCountsAr } from "../src/lib/planCounts";
import { toArabicDigits } from "../src/lib/arabicDigits";
import { TOPUP_REVIEW_DEFAULT_AR, topupReviewSentenceAr } from "../src/lib/topupConfig";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The company rows as the results panel receives them: the delivered row with the status the source reported for each contact field. */
const withContacts = { company_name: "شركة النيل", city: "القاهرة", phone: "+20 100 123 4567", work_email: "a@nile.test", contact_name: "منى سالم", job_title: "مديرة المبيعات", phone_verification_status: "متحقق", work_email_verification_status: "valid", id: "r1" };
const withoutContacts = { company_name: "شركة الدلتا", city: "طنطا", phone: "", work_email: "", contact_name: "", job_title: "", phone_verification_status: "غير متاح", work_email_verification_status: "غير متاح", id: "r2" };
const invalidContacts = { company_name: "شركة الهرم", city: "الجيزة", phone: "+20 100 765 4321", work_email: "bad@pyramid.test", contact_name: "علي حسن", job_title: "مدير", phone_verification_status: "غير صالح", work_email_verification_status: "غير صالح", id: "r3" };

/** The text of every cell of a table row, by column title. */
function tableRows(html: string): Array<Record<string, string>> {
  const titles = Array.from(html.matchAll(/<th\b[^>]*>([^<]+)<\/th>/g)).map((match) => match[1]);
  const body = html.slice(html.indexOf("<tbody"));
  return Array.from(body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)).map((row) => {
    const cells = Array.from(row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)).map((cell) => cell[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
    return Object.fromEntries(titles.map((title, index) => [title, cells[index] ?? ""]));
  });
}

describe("1. the results table writes «غير متاح» for a missing or invalid contact value", () => {
  const html = renderToStaticMarkup(createElement(ResultsCanvas, { records: [withContacts, withoutContacts, invalidContacts] as any, jobStatus: "done" } as any));
  const [filled, missing, invalid] = tableRows(html);

  it("a missing phone, e-mail, contact name and job title read «غير متاح», never «—»", () => {
    for (const title of ["الهاتف التجاري", "البريد المهني", "اسم المسؤول / جهة الاتصال", "المسمى الوظيفي"]) {
      expect(missing[title], title).toBe("غير متاح");
    }
  });

  it("a value the source marked invalid reads «غير متاح» (the same rule as the Excel); a valid one is shown", () => {
    expect(invalid["الهاتف التجاري"]).toBe("غير متاح");
    expect(invalid["البريد المهني"]).toBe("غير متاح");
    expect(filled["الهاتف التجاري"]).toContain("+201001234567");
    expect(filled["البريد المهني"]).toBe("a@nile.test");
    expect(filled["اسم المسؤول / جهة الاتصال"]).toBe("منى سالم");
    expect(filled["المسمى الوظيفي"]).toBe("مديرة المبيعات");
  });

  it("the availability columns keep their own wording", () => {
    expect(Object.keys(filled).some((title) => /توفر|التحقق|حالة/.test(title))).toBe(true);
    expect(filled["حالة تحقق الهاتف"]).toBe("متحقق");
    expect(invalid["حالة تحقق الهاتف"]).toBe("غير صالح");
    expect(missing["حالة تحقق الهاتف"]).toBe("غير متاح");
  });

  it("contactCellUnavailable only judges the five contact columns", () => {
    expect(contactCellUnavailable("phone", { phone: "—" })).toBe(true);
    expect(contactCellUnavailable("phone", { phone: "+20 100 123 4567" })).toBe(false);
    expect(contactCellUnavailable("work_email", { work_email: "a@b.test", email_verification_status: "invalid" })).toBe(true);
    expect(contactCellUnavailable("work_email", { work_email: "a@b.test", work_email_verification_status: "accept_all" })).toBe(false);
    expect(contactCellUnavailable("website", { website: "" })).toBe(false);
    expect(contactCellUnavailable("phone_verification_status", { phone_verification_status: "" })).toBe(false);
  });
});

describe("2. stored titles and the duplicate note use the plural after a number", () => {
  it("a title stored before the plural rule is read again at display time; eleven or more keeps the bare singular", () => {
    expect(pluralizeStoredCountsAr("استخراج بيانات ٥ سجل من شركات مقاولات في مصر")).toBe("استخراج بيانات ٥ سجلات من شركات مقاولات في مصر");
    expect(pluralizeStoredCountsAr("استخراج بيانات ٥٠ سجل من شركات")).toBe("استخراج بيانات ٥٠ سجل من شركات");
    expect(pluralizeStoredCountsAr("استخراج ١١ سجل")).toBe("استخراج ١١ سجل");
    expect(pluralizeStoredCountsAr("استخراج بيانات ١ سجل")).toBe("استخراج بيانات سجل واحد");
    expect(pluralizeStoredCountsAr("استخراج بيانات ٢ سجل")).toBe("استخراج بيانات سجلين");
    expect(pluralizeStoredCountsAr("وصلتك نتيجته (٤سجل)")).toBe("وصلتك نتيجته (٤ سجلات)");
    expect(pluralizeStoredCountsAr("5 سجل")).toBe("٥ سجلات");
    expect(pluralizeStoredCountsAr("٥ شركة")).toBe("٥ شركات");
  });

  it("a text that is already right, or has no number, is not touched", () => {
    for (const text of ["٣ سجلات", "سجل واحد", "٤٠ تعليقًا", "٥ سجلًا", "جارٍ الجمع", "٠ سجل", "", "سجلات مكررة"]) expect(pluralizeStoredCountsAr(text), text).toBe(text);
  });

  it("the requests page reads titles and notes through it; the stored rows are not rewritten", () => {
    const page = src("src/app/dashboard/requests/page.tsx");
    expect(page).toContain("pluralizeStoredCountsAr(");
    expect(page).toContain("{pluralizeStoredCountsAr(note)}");
    expect(page).not.toMatch(/\.(?:update|insert|upsert)\(/);
  });

  it("the duplicate-request note on the plan card: the number, a space and the right plural", () => {
    const quote = { quoteId: "q1", planHash: "h", status: "quoted", summaryAr: "خطة", targetVolumeMax: 10, requestedVolumeMax: 10, expectedPoints: 30, quotedPoints: 35, unitPricePoints: 3, items: [{ capabilitySlug: "maps-business-search", targetVolumeMax: 10, params: { query: "مصانع", location: "Egypt" } }], outputFormats: ["xlsx"], expiresAt: new Date(Date.now() + 3_600_000).toISOString(), balance: 5000, currentBalance: 5000, duplicateOf: { jobId: "job_1", conversationId: "c1", deliveredUnits: 4 } } as unknown as PlanQuoteData;
    const html = renderToStaticMarkup(createElement(PlanQuoteCard, { quote, onOpenPrevious: () => {}, onSaveEdit: async () => {}, onApprove: () => {}, onRefresh: async () => {} } as never));
    const note = html.slice(html.indexOf('data-testid="plan-duplicate-warning"')).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    expect(note).toContain("(٤ سجلات)");
    expect(note).not.toContain("٤سجل");
    expect(note).not.toContain("٤ سجل)");
  });
});

describe("3. the requests-page tab for a released hold", () => {
  it("reads «حجز مؤقت مُحرَّر», the only customer form", () => {
    const page = src("src/app/dashboard/requests/page.tsx");
    expect(page).toContain('["refunded", "حجز مؤقت مُحرَّر"]');
    expect(page).not.toMatch(/\["refunded", "حجز مُحرَّر"\]/);
  });
});

describe("4. the review sheet of the company Excel has no record id", () => {
  it("the headers start with the company name, and nothing in the workbook points at a review row", async () => {
    const buffer = await generateExcelReport({
      title: "شركات", country: "مصر", entityType: "companies",
      rows: [{ id: "m1", company_name: "Accepted Co", industry: "Construction" }],
      uncertainRows: [{ id: "uncertain-1", company_name: "Maybe Co", industry: "Energy", location: "Cairo, Egypt", _relevance_reason: "النشاط غير واضح" }],
    } as any);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const review = workbook.getWorksheet("نتائج تحتاج مراجعة")!;
    expect((review.getRow(2).values as unknown[]).slice(1).map(String)).toEqual(["اسم الشركة", "مجال النشاط كما ورد", "العنوان كما ورد", "سبب المراجعة"]);
    expect(review.getRow(3).getCell(1).value).toBe("Maybe Co");
    let text = "";
    review.eachRow((row) => row.eachCell((cell) => { text += `${cell.value} `; }));
    expect(text).not.toContain("uncertain-1");
    expect(text).not.toContain("معرّف السجل");
    // the main sheet and the branch sheet carry no record id either, so the review sheet links to nothing
    const main = workbook.getWorksheet("بيانات الشركات")!;
    expect((main.getRow(1).values as unknown[]).map(String)).not.toContain("معرّف السجل");
  });
});

describe("5. a phone outside the normal digit count of its country code is marked, never completed", () => {
  it("the number of the live check (7 digits after the Cairo area code) is marked", () => {
    for (const raw of ["+2025087419", "+20 2 5087419", "+20 25087419", "'+2025087419"]) expect(phoneMayBeIncomplete(raw), raw).toBe(true);
  });

  it("normal numbers of their country are not marked", () => {
    for (const raw of ["+20 100 123 4567", "+201001234567", "+20 2 2345 6789", "+20 (0)2 2345 6789", "+20 3 4567 890", "+966 5 1234 5678", "+966 11 234 5678", "+971 4 123 4567", "+971 50 123 4567", "+1 415 555 2671", "+44 20 7946 0958", "+965 2222 3333"]) {
      expect(phoneMayBeIncomplete(raw), raw).toBe(false);
    }
  });

  it("too short or too long for the code is marked", () => {
    for (const raw of ["+201001234", "+2010012345678", "+96651234", "+97141234", "+1415555267", "+9665123456789"]) expect(phoneMayBeIncomplete(raw), raw).toBe(true);
  });

  it("a number without «+», a country not in the table, text and a trunk zero are never judged", () => {
    for (const raw of ["0225087419", "25087419", "+49 30 123456", "+86 10 1234", "", null, undefined, "+20 100 123 4567 ext 5", "+20 02 25087419"]) {
      expect(phoneMayBeIncomplete(raw), String(raw)).toBe(false);
    }
  });

  it("the screen shows the neutral mark under a marked number only, and the digits stay as they are", () => {
    const html = renderToStaticMarkup(createElement(ResultsCanvas, { records: [{ ...withContacts, phone: "+2025087419" }, { ...withContacts, id: "r9", company_name: "شركة ثانية" }] as any, jobStatus: "done" } as any));
    expect(html.match(/data-testid="phone-maybe-incomplete"/g)).toHaveLength(1);
    expect(html).toContain(PHONE_MAY_BE_INCOMPLETE_AR);
    expect(PHONE_MAY_BE_INCOMPLETE_AR).toBe("رقم قد يكون ناقصًا");
    expect(html).toContain("+2025087419");
  });

  it("the workbook keeps the phone cell a plain number and puts the remark in a cell note", async () => {
    const buffer = await generateExcelReport({
      title: "شركات", country: "مصر", entityType: "companies",
      rows: [{ id: "a", company_name: "قصير", phone: "+2025087419" }, { id: "b", company_name: "كامل", phone: "+20 100 123 4567" }],
    } as any);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet("بيانات الشركات")!;
    const column = (sheet.getRow(1).values as unknown[]).slice(1).map(String).indexOf("الهاتف التجاري") + 1;
    expect(column).toBeGreaterThan(0);
    expect(String(sheet.getRow(2).getCell(column).value)).toBe("+2025087419");
    expect(String(sheet.getRow(3).getCell(column).value)).toBe("+201001234567");
    const noteOf = (cell: ExcelJS.Cell) => { const note = cell.note as any; return typeof note === "string" ? note : note?.texts?.map((part: any) => part.text).join("") ?? ""; };
    expect(noteOf(sheet.getRow(2).getCell(column))).toBe(PHONE_MAY_BE_INCOMPLETE_AR);
    expect(noteOf(sheet.getRow(3).getCell(column))).toBe("");
  });
});

describe("6. the top-up review sentence", () => {
  it("is the owner-approved sentence, in Arabic-Indic digits, while nothing is configured", () => {
    expect(TOPUP_REVIEW_DEFAULT_AR).toBe("غالبًا يتم الاعتماد خلال ١٥ دقيقة، وبحد أقصى ٢٤ ساعة، وتصلك رسالة عند إضافة النقاط.");
    expect(topupReviewSentenceAr(null)).toBe(TOPUP_REVIEW_DEFAULT_AR);
    expect(topupReviewSentenceAr("   ")).toBe(TOPUP_REVIEW_DEFAULT_AR);
    expect(TOPUP_REVIEW_DEFAULT_AR).not.toMatch(/\d/);
  });

  it("stays configurable: a configured time replaces the default, and its digits are Arabic-Indic", () => {
    expect(topupReviewSentenceAr("خلال 2 ساعة في أيام العمل")).toBe("يراجع فريق الإدارة صورة الإيصال يدويًا، ومدة المراجعة المتوقعة خلال ٢ ساعة في أيام العمل، وتُضاف النقاط إلى محفظتك فور الاعتماد.");
    const config = src("src/lib/topupConfig.ts");
    expect(config).toContain("export const TOPUP_REVIEW_TIME_AR: string | null = null;");
    expect(src("src/app/dashboard/topup/page.tsx")).toContain("reviewTimeAr");
  });

  it("the form shows the sentence (default and configured) and leaves the payment address and label as they were", () => {
    const render = (reviewTimeAr?: string | null) => renderToStaticMarkup(createElement(TopupForm, { amount: 100, onAmount: () => {}, creditValue: 1, ipa: "digr@instapay", onSubmitted: () => {}, pendingCount: 0, maxPending: 3, reviewTimeAr } as never));
    const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    expect(text(render(null))).toContain(TOPUP_REVIEW_DEFAULT_AR);
    expect(text(render("خلال ساعة"))).toContain("ومدة المراجعة المتوقعة خلال ساعة");
    expect(text(render(null))).toContain("digr@instapay");
    expect(text(render(null))).toContain("عنوان الدفع اللحظي · منصة ديجر");
  });
});

describe("7. the bell: the number counts what is loaded, and a new notice always joins the list", () => {
  // The rows as useNotifications maps them: the job notice is written by the server, the released-hold notice a moment later.
  const row = (id: string, kind: string, createdAt: string, read = false) => ({ id, $id: id, kind, title: id, body: "", read, created_at: createdAt, createdAt });

  it("ROOT CAUSE of «٣٠»: the list is read with limit 30, so thirty unread results read as a plain «٣٠»; at the limit it reads «٣٠+»", () => {
    expect(NOTIFICATION_LIST_LIMIT).toBe(30);
    expect(src("src/hooks/useNotifications.ts")).toContain(".limit(NOTIFICATION_LIST_LIMIT)");
    expect(bellBadgeText(30, 30, toArabicDigits)).toBe("٣٠+");
    expect(bellBadgeText(29, 30, toArabicDigits)).toBe("٢٩");
    expect(bellBadgeText(30, 31, toArabicDigits)).toBe("٣٠+");
    expect(bellBadgeText(3, 3, toArabicDigits)).toBe("٣");
    const shell = src("src/components/app/AppShell.tsx");
    expect(shell).toContain("bellBadgeText(notifs.actionableUnread, notifs.items.length, toArabicDigits)");
  });

  it("ROOT CAUSE of «not first»: a notice written a moment before the newest one held (same job, clock skew) was skipped by «newer than the newest»; it now joins", () => {
    // the poll saw the released-hold notice (10:00:05) first; the result notice of the same job carries 10:00:04
    const held = [row("notif_refund_job1", "refund", "2026-10-25T10:00:05.000Z"), row("old_a", "job_done", "2026-10-25T09:00:00.000Z", true)];
    const fetched = [row("notif_refund_job1", "refund", "2026-10-25T10:00:05.000Z"), row("notif_job_done_job1", "job_done", "2026-10-25T10:00:04.000Z")];
    const strictlyNewer = fetched.filter((item) => Date.parse(item.created_at) > Date.parse(held[0].created_at));
    expect(strictlyNewer).toHaveLength(0); // the old check found nothing and the result notice stayed missing until a reload
    const merged = mergeNewerNotifications(held, fetched);
    expect(merged.foundNew).toBe(true);
    expect(merged.items.map((item) => item.id)).toEqual(["notif_refund_job1", "notif_job_done_job1", "old_a"]);
    expect(src("src/hooks/useNotifications.ts")).toContain("NOTIFICATION_NEWER_WINDOW_MS");
    expect(src("src/hooks/useNotifications.ts")).not.toMatch(/\.gt\("created_at", newestRef\.current\)/);
  });

  it("the list is always newest first, a row already held is not duplicated, and a quiet check reports nothing new", () => {
    const held = [row("c", "job_done", "2026-10-25T10:00:03.000Z"), row("a", "job_done", "2026-10-25T10:00:01.000Z")];
    const same = mergeNewerNotifications(held, [row("c", "job_done", "2026-10-25T10:00:03.000Z", true)]);
    expect(same.foundNew).toBe(false);
    expect(same.items).toEqual(held);
    const joined = mergeNewerNotifications(held, [row("d", "job_done", "2026-10-25T10:00:09.000Z"), row("b", "job_done", "2026-10-25T10:00:02.000Z")]);
    expect(joined.items.map((item) => item.id)).toEqual(["d", "c", "b", "a"]);
  });

  it("the list keeps the newest thirty and never hides a real notice below them", () => {
    const held = Array.from({ length: 30 }, (_, i) => row(`n${i}`, "job_done", new Date(Date.UTC(2026, 9, 25, 9, 0, 30 - i)).toISOString()));
    const merged = mergeNewerNotifications(held, [row("fresh", "job_done", "2026-10-25T10:00:00.000Z")]);
    expect(merged.items).toHaveLength(30);
    expect(merged.items[0].id).toBe("fresh");
  });
});
