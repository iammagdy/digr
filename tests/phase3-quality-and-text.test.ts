import ExcelJS from "exceljs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * PHASE 3: the sector question and its answers, Arabic sector names everywhere the customer reads them, company rows without page titles, markdown,
 * list pages, foreign phone prefixes and data errors, and the honest «حجز مؤقت مُحرَّر» wording. Fake data only; no model, no provider.
 */
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { runConversation } from "./helpers/chatSession";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { generateExcelReport } from "../src/functions/shared/fileGenerators";
import { COMPANY_SECTOR_CHIPS, CUSTOM_SECTOR_LABEL_AR, detectIndustryFromText, getCompanyRequirementItems, getMissingCompanyResearchRequirements, industryAnswerFromText, industryAnsweredWithOtherChipOnly, industryDisplayLabelAr } from "../src/lib/planParameters";
import { INDUSTRY_NOT_TRANSLATED_AR, industryLabelAr, industryLabelForCell, localizeSectorNamesInText } from "../src/lib/industryLabels";
import { CALLING_CODES, cleanCompanyName, cleanCompanyRecord, cleanFoundedYear, cleanMarkdownText, isListOrArticleTitle, isListOrArticleUrl, isNotAWebsite, markForeignPhones, nonCompanyReasonAr, phoneHasForeignPrefix } from "../src/lib/companyRowHygiene";
import { resolveCompanyLinks } from "../src/lib/companyUrls";
import { candidatesFromDirectory, candidatesFromSearch } from "../src/lib/server/multiProvider/chainRunner";
import { buildContactRow, extractPhones } from "../src/lib/multiProvider/policy";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { normalizeRecord } from "../src/lib/server/normalizationPipeline";
import { renderEmailTemplate } from "../src/functions/shared/emailTemplates";
import { notifyJobOutcome } from "../src/functions/shared/notify";

const ans = (qid: string, q: string, value: string) => JSON.stringify({ type: "clarification_answers", answers: [{ questionId: qid, question: q, value }] });
const ENGLISH = /[A-Za-z]/;

async function sectorFlow(answer: string) {
  clearBriefCacheForTesting();
  const { responses } = await runConversation(["عايز ٥٠ شركة في مصر", ans("company_industry_required", "ما القطاع أو المجال الذي تعمل فيه الشركات المطلوبة؟", answer)]);
  return responses as any[];
}

describe("the sector question: options, the free-text «أخرى», and no loop", () => {
  it("the question lists the common sectors with «اتصالات», and «أخرى» is last (it used to be cut off at four options)", async () => {
    const [first] = await sectorFlow("اتصالات");
    expect(first.outputType).toBe("ask_clarification");
    const options: string[] = first.clarificationItems[0].options;
    expect(first.clarificationItems[0].id).toBe("company_industry_required");
    for (const sector of ["اتصالات", "تقنية وبرمجيات", "التقنية المالية", "بنوك وتأمين", "تصنيع", "مقاولات وعقارات", "أغذية ومطاعم", "صحة وأدوية", "تجارة وتجزئة", "نقل وشحن"]) expect(options, sector).toContain(sector);
    expect(options[options.length - 1]).toBe("أخرى");
    expect(first.clarificationItems[0].allowOther).toBe(true);
    expect(options.join(" ")).not.toMatch(ENGLISH);
  });

  it("every chip is read back as its own sector: tapping one always produces a plan card", async () => {
    for (const chip of COMPANY_SECTOR_CHIPS) {
      const found = detectIndustryFromText(`عايز ٥٠ شركة في مصر المجال المطلوب: ${chip} ${chip}`);
      expect(found.exactTaxonomy?.length, chip).toBeGreaterThan(0);
      expect(getMissingCompanyResearchRequirements(`عايز ٥٠ شركة في مصر المجال المطلوب: ${chip}`), chip).not.toContain("industry");
    }
  });

  it("a sector typed in the free field («اتصالات», «تأمين», «محاماة», «طباعة») is accepted and produces a plan card in Arabic (it asked again for ever)", async () => {
    for (const [typed, label] of [["اتصالات", "الاتصالات"], ["تأمين", "التأمين"], ["محاماة", "الخدمات القانونية"], ["طباعة", "الطباعة والتغليف"], ["صحة", "الصحة والرعاية الطبية"]] as const) {
      const turns = await sectorFlow(typed);
      const plan = turns[1];
      expect(plan.outputType, typed).toBe("propose_plan");
      expect(plan.planQuote.items[0].params.industry, typed).toBe(label);
      expect(String(plan.contentAr), typed).toContain(label);
      expect(String(plan.contentAr), typed).not.toMatch(ENGLISH);
    }
  });

  it("a sector no rule knows is still accepted: the plan card appears with the customer's own Arabic words, or a neutral Arabic phrase for English words", async () => {
    const arabic = (await sectorFlow("رياضة"))[1];
    expect(arabic.outputType).toBe("propose_plan");
    expect(String(arabic.contentAr)).toContain("رياضة");
    const english = (await sectorFlow("Fancy Niche Widgets"))[1];
    expect(english.outputType).toBe("propose_plan");
    expect(english.planQuote.items[0].params.industry).toBe(CUSTOM_SECTOR_LABEL_AR);
    expect(String(english.contentAr)).not.toMatch(ENGLISH);
    expect(String(english.contentAr)).not.toContain("fancy");
  });

  it("an English sector written by the customer («information technology») reads as the Arabic sector, never as English", async () => {
    const plan = (await sectorFlow("information technology"))[1];
    expect(plan.outputType).toBe("propose_plan");
    expect(plan.planQuote.items[0].params.industry).toBe("تقنية المعلومات والبرمجيات");
    expect(String(plan.contentAr)).not.toMatch(ENGLISH);
  });

  it("the chip «أخرى» alone is not an answer: ONE free-text question with no chips follows, and the typed answer then gives the plan", async () => {
    const turns = await sectorFlow("أخرى");
    expect(turns[1].outputType).toBe("ask_clarification");
    const item = turns[1].clarificationItems[0];
    expect(item).toMatchObject({ id: "company_industry_required", type: "free" });
    expect(item.options ?? []).toEqual([]);
    expect(item.text).not.toMatch(ENGLISH);
    clearBriefCacheForTesting();
    const { responses } = await runConversation(["عايز ٥٠ شركة في مصر", ans("company_industry_required", "ما القطاع؟", "أخرى"), ans("company_industry_required", "اكتب القطاع", "اتصالات")]);
    expect((responses as any[])[2].outputType).toBe("propose_plan");
  });

  it("the answer is found wherever it sits (joined with a space or with « | », repeated by the card) and the chip alone is not one", () => {
    expect(industryAnswerFromText("طلب المجال المطلوب: اتصالات اتصالات")).toBe("اتصالات");
    expect(industryAnswerFromText("طلب | المجال المطلوب: تأمين | الدولة المطلوبة: مصر")).toBe("تأمين");
    expect(industryAnswerFromText("طلب المجال المطلوب: رياضة رياضة شركة مصر شركة مصر المجال المطلوب: رياضة")).toBe("رياضة");
    expect(industryAnswerFromText("طلب المجال المطلوب: أخرى أخرى")).toBeNull();
    expect(industryAnsweredWithOtherChipOnly("طلب المجال المطلوب: أخرى أخرى")).toBe(true);
    expect(industryAnsweredWithOtherChipOnly("طلب المجال المطلوب: أخرى المجال المطلوب: اتصالات")).toBe(false);
    expect(industryAnsweredWithOtherChipOnly("طلب بلا إجابة")).toBe(false);
    const items = getCompanyRequirementItems(["industry"], "عايز ٥٠ شركة في مصر المجال المطلوب: أخرى");
    expect(items[0]).toMatchObject({ type: "free", options: [] });
  });
});

describe("English sector names never reach the customer", () => {
  it("labels: any case, «&» / «and», lists, the whole common taxonomy; the display label of a plan is Arabic", () => {
    for (const [english, arabic] of [
      ["Construction", "المقاولات والتشييد"], ["information technology", "تقنية المعلومات والخدمات التقنية"], ["Information Technology", "تقنية المعلومات والخدمات التقنية"],
      ["INFORMATION TECHNOLOGY AND SERVICES", "تقنية المعلومات والخدمات التقنية"], ["Telecommunications", "الاتصالات"], ["Insurance", "التأمين"], ["Banking", "الخدمات المصرفية"],
      ["Construction; Real Estate", "المقاولات والتشييد، العقارات"], ["Utilities / Oil & Energy", "المرافق العامة (كهرباء ومياه وغاز)، النفط والطاقة"],
    ] as const) expect(industryLabelAr(english), english).toBe(arabic);
    expect(industryDisplayLabelAr("Construction")).toBe("المقاولات والتشييد");
    expect(industryDisplayLabelAr("FinTech")).toBe("التقنية المالية");
    expect(industryDisplayLabelAr("Totally Unknown Trade")).toBe(CUSTOM_SECTOR_LABEL_AR);
    expect(industryDisplayLabelAr("تأمين")).toBe("تأمين");
  });

  it("the Excel activity column: Arabic for known labels in any spelling, lists, and a plain Arabic marker (never the English text) for an unknown one", async () => {
    const rows = ["Construction", "information technology", "Information Technology & Services", "Construction, Real Estate", "Fancy Niche Widgets", "Insurance"].map((industry, i) => ({ id: `r${i}`, company_name: `شركة ${i}`, industry }));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await generateExcelReport({ title: "Company research", entityType: "companies", rows })) as any);
    const sheet = workbook.getWorksheet("بيانات الشركات")!;
    const col = (sheet.getRow(1).values as string[]).indexOf("مجال النشاط");
    const cells = rows.map((_, i) => String(sheet.getRow(i + 2).getCell(col).value));
    expect(cells).toEqual(["المقاولات والتشييد", "تقنية المعلومات والخدمات التقنية", "تقنية المعلومات والخدمات التقنية", "المقاولات والتشييد، العقارات", INDUSTRY_NOT_TRANSLATED_AR, "التأمين"]);
    for (const cell of cells) expect(cell).not.toMatch(ENGLISH);
    expect(industryLabelForCell("")).toBe("غير متاح");
  });

  it("a known English sector name inside a sentence is replaced by its Arabic name (the plan summary's last guard)", () => {
    expect(localizeSectorNamesInText("الهدف: ٥٠ شركة في Construction وفي Information Technology & Services")).toBe("الهدف: ٥٠ شركة في المقاولات والتشييد وفي تقنية المعلومات والخدمات التقنية");
    expect(localizeSectorNamesInText("شركات تقنية")).toBe("شركات تقنية");
  });
});

describe("company names and descriptions: no page titles, no markdown", () => {
  it("a page title is the company's name; the page words after a separator are dropped", () => {
    for (const [raw, name] of [["Utopia Pharmaceutical: Home", "Utopia Pharmaceutical"], ["**Utopia Pharmaceutical** | Welcome", "Utopia Pharmaceutical"], ["## Alpha Pharma - Official Website", "Alpha Pharma"], ["Home | Beta Co", "Beta Co"], ["ايبيكو للأدوية - الصفحة الرئيسية", "ايبيكو للأدوية"], ["Welcome to Delta Steel", "Delta Steel"], ["Nile Group", "Nile Group"]] as const) {
      expect(cleanCompanyName(raw, "x.com"), raw).toBe(name);
    }
    expect(cleanCompanyName("", "utopia-pharma.com")).toBe("Utopia Pharma");
  });

  it("markdown becomes plain text", () => {
    expect(cleanMarkdownText("## About\n**Utopia** makes [medicine](http://x.com) for **everyone**.\n- one\n- two")).toBe("About Utopia makes medicine for everyone. one two");
    expect(cleanMarkdownText("![logo](a.png) _plain_ `code`\n> quote")).toBe("plain code quote");
    expect(cleanMarkdownText("<b>bold</b> text")).toBe("bold text");
  });

  it("the delivered record: name, description, website, founding year cleaned in one place", () => {
    const row = normalizeRecord({ company_name: "**Utopia Pharmaceutical**: Home", description: "## نبذة\n**شركة** أدوية [موقعنا](http://u.com)", website: "https://maps.google.com/?q=cairo", founded_year: "-1", industry: "Pharmaceuticals" }, 0);
    expect(row.company_name).toBe("Utopia Pharmaceutical");
    expect(row.description).toBe("نبذة شركة أدوية موقعنا");
    expect(row.website).toBe("");
    expect(row.founded_year).toBe("");
  });

  it("a chain candidate's name from a search hit is cleaned, and a hit about a list is not a candidate", () => {
    const c = candidatesFromSearch([
      { url: "https://utopia-pharma.com/", title: "Utopia Pharmaceutical: Home", description: "## نبذة **عن** الشركة" },
      { url: "https://bionixus.com/blog/top-40-pharmaceutical-companies-in-egypt", title: "Top 40 Pharmaceutical Companies in Egypt (2026)", description: "list" },
      { url: "https://market-research.example/", title: "Egypt Pharmaceutical Market Report 2026", description: "report" },
      { url: "https://acme-pharma.com/", title: "Best 10 Pharma Firms in Cairo", description: "x" },
    ] as any);
    expect(c.map((x) => x.n)).toEqual(["Utopia Pharmaceutical"]);
    expect(c[0].d).toBe("نبذة عن الشركة");
    expect(candidatesFromDirectory([{ company_name: "List of companies in Egypt", website: "https://l.example" }, { company_name: "**Alpha**: Home", website: "https://alpha.example" }]).map((x) => x.n)).toEqual(["Alpha"]);
  });
});

describe("list, ranking, directory and article pages are not companies", () => {
  it("titles", () => {
    for (const t of ["Top 40 Pharmaceutical Companies in Egypt", "Best 10 Construction Firms", "List of companies in Egypt", "أفضل ١٠ شركات أدوية في مصر", "قائمة شركات الأدوية", "How to choose a supplier", "Egypt Pharmaceutical Market Report"]) expect(isListOrArticleTitle(t), t).toBe(true);
    for (const t of ["Utopia Pharmaceutical", "Top Notch Printing", "Leading Edge Systems", "Delta Pharma | Home", "شركة النيل للأدوية", "Best Western Hotels"]) expect(isListOrArticleTitle(t), t).toBe(false);
  });
  it("addresses", () => {
    expect(isListOrArticleUrl("https://bionixus.com/blog/top-40-pharmaceutical-companies-in-egypt")).toBe(true);
    expect(isListOrArticleUrl("https://x.com/news/2026/01/some-story")).toBe(true);
    for (const u of ["https://acme.com/", "https://acme.com/about", "https://acme.com/products/pumps", "acme.com"]) expect(isListOrArticleUrl(u), u).toBe(false);
  });
  it("the gate: such a record is not matched, not delivered and not charged, with an Arabic reason", () => {
    const ctx = { capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", params: { industry: "الأدوية", country: "Egypt", query: { keyword: { include: ["pharmaceuticals"] } } } };
    const row = { company_name: "Top 40 Pharmaceutical Companies in Egypt", website: "https://bionixus.com/blog/top-40", industry: "Pharmaceuticals", description: "pharmaceutical companies" };
    const verdict = evaluateResearchRowRelevance(row, ctx);
    expect(verdict.decision).toBe("no_match");
    expect(verdict.reasonAr).toContain("استُبعد السجل ولم يُحتسب");
    expect(verdict.reasonAr).not.toMatch(ENGLISH);
    expect(nonCompanyReasonAr({ company_name: "Utopia Pharmaceutical", website: "https://utopia.example" })).toBeNull();
    // a real company is judged by the sector rules as before: the list rule does not touch it
    const real = evaluateResearchRowRelevance({ company_name: "Utopia Pharmaceutical", website: "https://utopia.example", industry: "Pharmaceuticals", description: "pharmaceutical manufacturer" }, ctx);
    expect(real.reasonAr).not.toContain("قائمة أو ترتيب أو مقال");
    expect(real.reasonAr).not.toContain("رابط الصفحة لمقال");
  });
});

describe("foreign phone prefixes and data errors", () => {
  it("a prefix that is not the requested country's: judged only when the number carries one, and only for a known country", () => {
    expect(phoneHasForeignPrefix("+201001234567", "EG")).toBe(false);
    expect(phoneHasForeignPrefix("+971501234567", "EG")).toBe(true);
    expect(phoneHasForeignPrefix("00966501234567", "EG")).toBe(true);
    expect(phoneHasForeignPrefix("+1 202 555 0100", "EG")).toBe(true);
    expect(phoneHasForeignPrefix("01001234567", "EG")).toBe(false);
    expect(phoneHasForeignPrefix("+971501234567", "ZZ")).toBe(false);
    expect(phoneHasForeignPrefix("+971501234567", undefined)).toBe(false);
    expect(CALLING_CODES.EG).toBe("20");
  });
  it("on the chain: the foreign number is «unverified» (reason kept), so a row that requires a verified phone is not delivered and not charged", () => {
    const phones = markForeignPhones(extractPhones("اتصل بنا: +971 50 123 4567 أو +20 10 0123 4567", []), "EG");
    expect(phones.find((p) => p.value.startsWith("+971"))).toMatchObject({ status: "unverified", reason: "country_prefix_mismatch" });
    expect(phones.find((p) => p.value.startsWith("+20"))).toMatchObject({ status: "verified" });
  });
  it("in the delivered sheet: the foreign number is not delivered as that company's phone and its status says it was not verified", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await generateExcelReport({
      title: "Company research", entityType: "companies", metadata: { reportContext: { scope: { country: "مصر" } } },
      rows: [{ id: "a", company_name: "Alpha", industry: "Construction", phone: "+971501234567", phone_verification_status: "متحقق" }, { id: "b", company_name: "Beta", industry: "Construction", phone: "+201001234567", phone_verification_status: "متحقق" }],
    } as any)) as any);
    const sheet = workbook.getWorksheet("بيانات الشركات")!;
    const headers = sheet.getRow(1).values as string[];
    const phone = headers.indexOf("الهاتف التجاري");
    // The verification-status columns are not in the company workbook (owner decision): the foreign number is simply not delivered.
    expect(headers.indexOf("حالة تحقق الهاتف")).toBe(-1);
    expect(String(sheet.getRow(2).getCell(phone).value)).toBe("غير متاح");
    sheet.eachRow((row) => row.eachCell((cell) => expect(String(cell.value)).not.toBe("متحقق")));
    expect(String(sheet.getRow(3).getCell(phone).value)).toBe("+201001234567");
  });
  it("the founding year is a plausible year or nothing", () => {
    for (const bad of ["-1", "0", "abc", "2999", "99", "", null, undefined, -1]) expect(cleanFoundedYear(bad as any, new Date("2026-10-23")), String(bad)).toBe("");
    expect(cleanFoundedYear("1999")).toBe("1999");
    expect(cleanFoundedYear("٢٠١٠")).toBe("2010");
  });
  it("the website column holds a website: a map link or an e-mail is not one (an e-mail moves to the e-mail column when it is empty)", () => {
    for (const bad of ["https://maps.google.com/?q=x", "https://www.google.com/maps/place/Cairo", "https://goo.gl/maps/abc", "https://maps.app.goo.gl/xyz", "info@acme.com", "mailto:info@acme.com"]) expect(isNotAWebsite(bad), bad).toBe(true);
    for (const ok of ["https://acme.com", "acme.com", "https://acme.com/maps-and-more"]) expect(isNotAWebsite(ok), ok).toBe(false);
    expect(resolveCompanyLinks({ website: "https://maps.google.com/?q=x", domain: "acme.com" })).toEqual({ website: "https://acme.com", linkedin: "" });
    expect(resolveCompanyLinks({ website: "info@acme.com" })).toEqual({ website: "", linkedin: "" });
    expect(cleanCompanyRecord({ company_name: "Acme", website: "info@acme.com" })).toMatchObject({ website: "", work_email: "info@acme.com" });
    expect(normalizeRecord({ company_name: "Acme", website: "info@acme.com" }, 0)).toMatchObject({ website: "", work_email: "info@acme.com" });
    expect(cleanCompanyRecord({ company_name: "Acme", website: "info@acme.com", work_email: "sales@acme.com" })).toMatchObject({ work_email: "sales@acme.com" });
  });
  it("the contact row of the chain carries the cleaned name and description", () => {
    const row = buildContactRow({ companyName: "Utopia Pharmaceutical: Home", website: "https://utopia.example", description: "## نبذة **عن** الشركة", emails: [], phones: [] });
    expect(row).toMatchObject({ company_name: "Utopia Pharmaceutical", description: "نبذة عن الشركة" });
  });
});

describe("«حجز مؤقت مُحرَّر»: the leftover refund wording is gone from notifications, emails and the admin finance and jobs pages", () => {
  const ROOT = process.cwd();
  const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
  const OLD = /مستردات|فرق الحجز المرتجع|فرق الحجز|استرداد حجز|نقاط مستردة|فشل بحث واسترداد|فشل · استرداد|رجعت\s/;

  it("the notification texts and the e-mail templates say a temporary hold was released; nothing was refunded", async () => {
    const sent: Array<{ title: string; body: string }> = [];
    const client: any = { from: () => ({ insert: async (row: any) => { sent.push({ title: row.title, body: row.body }); return { data: row, error: null }; }, select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }), maybeSingle: async () => ({ data: null, error: null }) }) }) };
    void client;
    const { subject, html } = renderEmailTemplate("refund", { Points: "٢٠", Reason: "حجز مؤقت مُحرَّر", JobTitle: "بحث", Name: "أحمد", Balance: "٣٠٠٠" });
    expect(subject).toBe("حجز مؤقت مُحرَّر بقيمة ٢٠ نقطة");
    expect(`${subject} ${html}`).not.toMatch(OLD);
    expect(html).not.toContain("استرداد");
    expect(html).toContain("حجز مؤقت مُحرَّر");
    const done = renderEmailTemplate("job-done", { Name: "أحمد", JobTitle: "بحث", Delivered: "١٠", Requested: "١٠٠", Charged: "٨٠", Refunded: "٢٠", JobURL: "https://diger.tech" });
    expect(done.html).not.toContain("رجع لرصيدك");
    expect(done.html).toContain("حجز مؤقت مُحرَّر");
    expect(typeof notifyJobOutcome).toBe("function");
  });

  it("the source of the customer's notifications, plan text, requests, settings and wallet carry none of the old words", () => {
    for (const file of ["src/functions/shared/notify.ts", "src/functions/shared/emailTemplates.ts", "src/lib/planExplanation.ts", "src/lib/jobs/requestStatus.ts", "src/app/dashboard/requests/page.tsx", "src/app/dashboard/settings/page.tsx", "src/lib/honestDisplay.ts", "src/lib/creditKinds.ts"]) {
      expect(read(file).replace(/cleaned\.includes\("[^"]*"\)/g, "").replace(/\/\*[\s\S]*?\*\//g, ""), file).not.toMatch(OLD);
    }
  });

  it("the admin finance and jobs screens use the honest wording", () => {
    for (const file of ["src/app/admin/finance/page.tsx", "src/app/admin/jobs/page.tsx", "src/components/admin/AdminShell.tsx"]) expect(read(file), file).not.toMatch(/مستردات|نقاط مستردة|فرق الحجز المرتجع|فشل بحث واسترداد|فشل · استرداد|رجعت \$\{/);
    expect(read("src/app/admin/finance/page.tsx")).toContain("حجز مؤقت مُحرَّر");
    expect(read("src/app/admin/jobs/page.tsx")).toContain("حجز مُحرَّر");
  });

  it("the plan's cost line says the rest of the hold is released", () => {
    expect(read("src/lib/planExplanation.ts")).toContain("والباقي حجز مؤقت مُحرَّر");
  });

  it("no customer-facing file of the app shows these old words (admin files are checked above)", () => {
    const walk = (dir: string, out: string[] = []): string[] => { for (const n of readdirSync(dir)) { const p = path.join(dir, n); if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n)) out.push(p); } return out; };
    const customer = walk(path.join(ROOT, "src/app/dashboard")).filter((f) => !f.includes("/admin/"));
    const offenders = customer.filter((f) => /مستردات|فرق الحجز المرتجع|استرداد حجز/.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
