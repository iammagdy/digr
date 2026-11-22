import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import { describedCompanyOf, identityConflictOf, qualityResultLineAr, isUnusableAddress, linkedinCompanyOf, nameIsDomain, VERIFICATION_NOTE_HEADER_AR, withCompanyQuality } from "../src/lib/agentMission/companyQuality";
import { exactPlaceLabelAr, withoutRepeatedWords } from "../src/lib/agentMission/places";
import { csvExportFromWorkbook } from "../src/lib/server/csvFromExcel";

/**
 * ROUND 59: the company rows of the authenticated production mission msn_088c (13 Nov 2026), exactly as they were delivered (description cut to the sentence the check reads), and its plan's
 * two stages. Nothing paid is called: the rows are the file's own cells.
 */
const stage = (over: Record<string, unknown>) => ({ endpoint_id: "e", expected_rows: 9, planned_rows: 9, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001, ...over });
const COMPANIES = stage({
  key: "companies", title_ar: "شركات مستحضرات التجميل في مصر", endpoint_id: "tomba.companies.search.reveal",
  columns: [{ key: "name", title_ar: "الاسم" }, { key: "description", title_ar: "الوصف" }, { key: "website", title_ar: "الموقع الإلكتروني" }, { key: "city", title_ar: "المدينة" }, { key: "street_address", title_ar: "العنوان" }, { key: "linkedin_url", title_ar: "صفحة الشركة على لينكدإن" }],
});
const CONTACTS = stage({
  key: "contacts", title_ar: "الإيميل والتليفون المنشورين على موقع كل شركة", parent_key: "companies", endpoint_id: "contextdev.parse.emails",
  columns: [{ key: "email", kind: "work_email", title_ar: "الإيميل" }, { key: "phone", kind: "phone", title_ar: "رقم التليفون" }, { key: "link", title_ar: "الرابط" }],
});
const plan = (): PricedPlan => ({ summary_ar: "تجمع لك ٩ شركات مستحضرات تجميل في مصر، ومعها الإيميل والتليفون المنشورين.", stages: [COMPANIES, CONTACTS] as any, price: { totalCostUsd: 0.0229, deliveredRows: 18, costPerFinalRowUsd: 0.0027, unitPricePoints: 14.970984, reservePoints: 310, maxChargePoints: 270, overCap: false } });

const companies = [
  { id: "c0-bobana-eg.com", name: "BOBANA", description: "vision cosmetics is one of egypt's leading manufacturers and marketers of cosmetics", website: "https://bobana-eg.com", city: "غير مذكورة في المصدر", street_address: "", linkedin_url: "https://linkedin.com/company/vision-cosmetics" },
  { id: "c2-nanostetic.com", name: "Nanostetic", description: "the element for skincare experts. pharmaceutical laboratory specialized in cosmeceuticals", website: "https://nanostetic.com", city: "مدينة نصر", street_address: "", linkedin_url: "https://linkedin.com/company/nanostetic" },
  { id: "c3-yolo-cosmetics.com", name: "yolo-cosmetics.com", description: "cosmotrade is one of the leading companies in the field of cosmetics, skin care and hair care", website: "https://yolo-cosmetics.com", city: "القاهرة", street_address: "new nozha", linkedin_url: "https://linkedin.com/company/yolo-cosmetics-eg" },
  { id: "c4-go-natural.shop", name: "go natural pure cosmetics", description: "“feel natural, be natural” go natural pure cosmetics is a cosmetics manufacturer", website: "https://go-natural.shop", city: "Giza Giza", street_address: "giza", linkedin_url: "https://linkedin.com/company/go-natural-egypt" },
  { id: "c8-avenscosmetics.com", name: "Avens cosmetics", description: "avens cosmetics Pharmaceutical Agent for natural products", website: "https://avenscosmetics.com", city: "الإسكندرية", street_address: "", linkedin_url: "https://linkedin.com/company/avens-cosmetics" },
  { id: "c10-kaline.com", name: "KALINE COSMETICS", description: "kaline cosmetics is a manufacturing company located in cairo - egypt", website: "https://kaline.com", city: "القاهرة", street_address: "", linkedin_url: "https://linkedin.com/company/kaline-cosmetics" },
  { id: "c15-deoc.store", name: "DEOC cosmetics", description: "deoc cosmetics is a natural skincare brand. our brand was founded by doctors", website: "https://deoc.store", city: "القاهرة", street_address: "cairo", linkedin_url: "https://linkedin.com/company/deoc-cosmetics" },
  { id: "c17-donnanatural.com", name: "Donna Natural", description: "donna natural beauty products egypt", website: "https://donnanatural.com", city: "مدينة ٦ أكتوبر", street_address: "", linkedin_url: "https://linkedin.com/company/donna-natural" },
  { id: "c16-hktrade-eg.com", name: "hk trade", description: "hk trade is a cosmetics and cosmeceuticals products family-owned business", website: "https://hktrade-eg.com", city: "القاهرة", street_address: "31.25", linkedin_url: "https://linkedin.com/company/hk-trade" },
];
const contacts = [
  { id: "ct-c2-nanostetic.com", parent_id: "c2-nanostetic.com", email: "info@nanostetic.com", phone: "+20222620242", link: "https://nanostetic.com/contact-us/" },
  { id: "ct-c0-bobana-eg.com", parent_id: "c0-bobana-eg.com", email: "info@bobana-eg.com", phone: "", link: "https://bobana-eg.com/pages/contact" },
  { id: "ct-c3-yolo-cosmetics.com", parent_id: "c3-yolo-cosmetics.com", email: "", phone: "+201003308322", link: "https://yolo-cosmetics.com/language/en/contact-us/" },
  { id: "ct-c17-donnanatural.com", parent_id: "c17-donnanatural.com", email: "hello@donnanatural.com", phone: "+201130755305", link: "https://donnanatural.com/contact" },
];
const byId = (id: string) => companies.find((c) => c.id === id)!;

async function load(xlsx: Buffer) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as unknown as ArrayBuffer); return wb; }
const header = (sheet: ExcelJS.Worksheet) => (sheet.getRow(1).values as unknown[]).slice(1).map(String);

describe("round 59: a company's identity is checked against its own description and LinkedIn page", () => {
  it("the two live mismatches are found, and only them", () => {
    const conflicts = companies.map((c) => [c.name, identityConflictOf({ name: c.name, website: c.website, description: c.description, linkedin: c.linkedin_url })] as const).filter(([, x]) => x !== null);
    expect(conflicts.map(([n]) => n)).toEqual(["BOBANA", "yolo-cosmetics.com"]);
    expect(conflicts[0][1]).toEqual({ where: ["description", "linkedin"], otherName: "vision cosmetics" });
    expect(conflicts[1][1]).toEqual({ where: ["description"], otherName: "cosmotrade" });
  });
  it("reads the company a description opens with and the one a LinkedIn address names; a description that does not open with «X is» names none", () => {
    expect(describedCompanyOf(byId("c0-bobana-eg.com").description)).toBe("vision cosmetics");
    expect(describedCompanyOf(byId("c2-nanostetic.com").description)).toBeNull();
    expect(describedCompanyOf(byId("c4-go-natural.shop").description)).toBeNull();
    expect(linkedinCompanyOf("https://linkedin.com/company/vision-cosmetics")).toBe("vision cosmetics");
    expect(linkedinCompanyOf("https://example.com/company/x")).toBeNull();
  });
  it("a side with no distinctive word proves nothing («hk trade», a generic LinkedIn slug): no conflict is claimed", () => {
    expect(identityConflictOf({ name: "hk trade", website: "https://hktrade-eg.com", description: "hk trade is a cosmetics business", linkedin: "https://linkedin.com/company/hk-trade" })).toBeNull();
    expect(identityConflictOf({ name: "", website: "", description: "acme is a company", linkedin: "" })).toBeNull();
    // a name that differs only by a suffix is the same company
    expect(identityConflictOf({ name: "Nanostetic", website: "https://nanostetic.com", description: "nanostetics is a lab", linkedin: "" })).toBeNull();
  });
  it("a name that is only the site's address is said", () => {
    expect(nameIsDomain("yolo-cosmetics.com")).toBe(true);
    expect(nameIsDomain("https://www.yolo-cosmetics.com/")).toBe(true);
    expect(nameIsDomain("YOLO Cosmetics")).toBe(false);
  });
});

describe("round 59: unusable addresses and places written twice", () => {
  it("«31.25» is not an address; «new nozha», «giza» and «cairo» are kept", () => {
    expect(isUnusableAddress("31.25")).toBe(true);
    expect(isUnusableAddress("-")).toBe(true);
    for (const v of ["new nozha", "giza", "cairo", "12 Abbas El Akkad St"]) expect(isUnusableAddress(v)).toBe(false);
    expect(isUnusableAddress("")).toBe(false);
  });
  it("«Giza Giza» is the city of Giza; a real two-word place is untouched", () => {
    expect(withoutRepeatedWords("giza giza")).toBe("giza");
    expect(exactPlaceLabelAr("Giza Giza", "city")).toBe("الجيزة");
    expect(exactPlaceLabelAr("giza, giza", "city")).toBe("الجيزة");
    expect(exactPlaceLabelAr("Port Said", "city")).toBe("بورسعيد");
    expect(exactPlaceLabelAr("Nasr City", "city")).toBe("مدينة نصر");
  });
});

describe("round 59: the delivered file of msn_088c, rebuilt from its own rows", () => {
  it("the companies sheet gets «ملاحظات التحقق»: identity, domain-only name, unusable address, companies with no contact row; nothing removed or invented", async () => {
    const built = await buildMissionFiles(plan(), { companies, contacts }, undefined, undefined, { completeContract: false, now: Date.UTC(2026, 10, 13, 16, 6) });
    const wb = await load(built.xlsx);
    const sheet = wb.worksheets[1];
    const h = header(sheet);
    expect(h).toEqual(["الاسم", "الوصف", "الموقع الإلكتروني", "المدينة", "العنوان", "صفحة الشركة على لينكدإن", VERIFICATION_NOTE_HEADER_AR, "المعرّف"]);
    expect(sheet.rowCount).toBe(10);
    const note = (row: number) => String(sheet.getRow(row).getCell(7).value ?? "");
    const cell = (row: number, col: number) => sheet.getRow(row).getCell(col).value;
    // BOBANA: the description and the LinkedIn page name another company
    expect(note(2)).toContain("الهوية غير مؤكدة: الوصف وصفحة لينكدإن يذكران «vision cosmetics» لا «BOBANA»");
    expect(note(2)).not.toContain("لا توجد لها بيانات");
    // Nanostetic: nothing to say
    expect(note(3)).toBe("");
    // yolo: the description names Cosmotrade, and the name is only the domain
    expect(note(4)).toContain("الوصف يذكر «cosmotrade» لا «yolo-cosmetics.com»");
    expect(note(4)).toContain("الاسم في المصدر هو عنوان الموقع فقط");
    // go natural: «Giza Giza» is said once, in Arabic; no contact row
    expect(cell(5, 4)).toBe("الجيزة");
    expect(note(5)).toBe("لا توجد لها بيانات في «الإيميل والتليفون المنشورين على موقع كل شركة»");
    // hk trade: the address «31.25» is left out and said
    expect(cell(10, 1)).toBe("hk trade");
    expect(cell(10, 5)).toBeNull();
    expect(note(10)).toContain("العنوان في المصدر («31.25») ليس عنوانًا فتُرك فارغًا");
    // every company is still there, with the values the source gave
    expect([2, 3, 4, 5, 6, 7, 8, 9, 10].map((r) => cell(r, 1))).toEqual(companies.map((c) => c.name));
    // five companies have no contact row: said on each of them
    expect([2, 3, 4, 5, 6, 7, 8, 9, 10].filter((r) => note(r).includes("لا توجد لها بيانات"))).toHaveLength(5);
  });

  it("the summary's «حدود هذا التسليم» states the uncertain identities, the address, the missing source links, and that no site was visited", async () => {
    const built = await buildMissionFiles(plan(), { companies, contacts }, undefined, undefined, { completeContract: false });
    const wb = await load(built.xlsx);
    const summary: string[] = [];
    wb.worksheets[0].eachRow((row) => row.eachCell((c) => summary.push(String(c.value ?? ""))));
    const all = summary.join("\n");
    expect(all).toContain("هوية شركتين من ٩ غير مؤكدة");
    expect(all).toContain("«BOBANA»، «yolo-cosmetics.com». لم نحذفها ولم نستبدلها بغيرها");
    expect(all).toContain("تركنا العنوان فارغًا في شركة واحدة لأن قيمته في المصدر ليست عنوانًا («31.25»)");
    expect(all).toContain("ليس في ورقة «شركات مستحضرات التجميل في مصر» رابط مصدر لكل سجل");
    expect(all).toContain("ولم نزر مواقع الشركات للتحقق من هويتها؛ لم نجد تعارضًا في الباقي (٧ شركات)");
    // the count sentence is unchanged: 13 delivered of 18, 9 companies
    expect(all).toContain("تم تسليم ١٣ من ١٨ عنصرًا. منها ٩ شركات");
  });

  it("the CSV package carries the same column and the same notes, UTF-8 with BOM-free cells and Arabic intact", async () => {
    const built = await buildMissionFiles(plan(), { companies, contacts }, undefined, undefined, { completeContract: false });
    const exp = await csvExportFromWorkbook(built.xlsx);
    const companiesCsv = exp.stages[0].csv;
    expect(companiesCsv.split(/\r?\n/)[0]).toContain(VERIFICATION_NOTE_HEADER_AR);
    expect(companiesCsv).toContain("الهوية غير مؤكدة");
    expect(companiesCsv).toContain("الجيزة");
    expect(companiesCsv).not.toContain("Giza Giza");
    expect(companiesCsv).not.toContain("31.25\"");
    expect(exp.methodologyCsv).toContain("هوية شركتين من ٩ غير مؤكدة");
  });

  it("the rows the settlement counts are never touched (the check works on a copy)", () => {
    const rows = { companies: companies.map((c) => ({ ...c })), contacts: contacts.map((c) => ({ ...c })) };
    const before = JSON.stringify(rows);
    const out = withCompanyQuality(plan() as any, rows);
    expect(JSON.stringify(rows)).toBe(before);
    expect(out.rowsByStage.companies).toHaveLength(9);
    expect(out.rowsByStage.contacts).toBe(rows.contacts);
    expect(out.reports[0]).toMatchObject({ total: 9, uncertain: ["c0-bobana-eg.com", "c3-yolo-cosmetics.com"], nameIsDomain: ["c3-yolo-cosmetics.com"], unusableAddress: ["c16-hktrade-eg.com"], possibleDuplicates: [], hasSourceColumn: false });
    expect(out.reports[0].withoutDetails).toHaveLength(5);
  });
});

describe("round 59: duplicates and branches are flagged, never removed", () => {
  it("the same site twice, or the same distinctive name twice, is said on the later row", () => {
    const rows = [
      { id: "a", name: "Kaline Cosmetics", website: "https://kaline.com", description: "", linkedin_url: "" },
      { id: "b", name: "Kaline Cosmetics - Alexandria branch", website: "https://www.kaline.com/alex", description: "", linkedin_url: "" },
      { id: "c", name: "KALINE", website: "https://kaline-eg.com", description: "", linkedin_url: "" },
      { id: "d", name: "Deoc", website: "https://deoc.store", description: "", linkedin_url: "" },
    ];
    const out = withCompanyQuality(plan() as any, { companies: rows });
    expect(out.reports[0].possibleDuplicates).toEqual(["b", "c"]);
    expect(String(out.rowsByStage.companies[1].verification_note)).toContain("قد تكون فرعًا أو تكرارًا لـ «Kaline Cosmetics» (نفس الموقع الإلكتروني)");
    expect(String(out.rowsByStage.companies[2].verification_note)).toContain("(نفس الاسم)");
    expect(out.rowsByStage.companies).toHaveLength(4);
    expect(out.limitLines.join("\n")).toContain("قد تكون فرعًا أو تكرارًا لشركة أخرى في الملف");
  });
  it("a plan with no company stage is returned as it is", () => {
    const posts = { ...stage({ key: "posts", title_ar: "منشورات الصفحة", columns: [{ key: "text", title_ar: "النص" }] }) };
    const p = { stages: [posts] } as any;
    const rows = { posts: [{ id: "p1", text: "x" }] };
    const out = withCompanyQuality(p, rows);
    expect(out.layoutPlan).toBe(p);
    expect(out.limitLines).toEqual([]);
    expect(out.rowsByStage.posts).toBe(rows.posts);
  });
});

describe("round 59: the line the customer reads with the delivery", () => {
  it("msn_088c: two uncertain identities are said with the delivery; nothing removed", async () => {
    const built = await buildMissionFiles(plan(), { companies, contacts }, undefined, undefined, { completeContract: false });
    expect(qualityResultLineAr(built.companyQuality)).toBe("تنبيه عن جودة البيانات: هوية شركتين من ٩ غير مؤكدة (اسمها أو موقعها لا يطابق وصفها أو صفحة لينكدإن). لم نحذف شيئًا ولم نستبدله، والتفاصيل في عمود «ملاحظات التحقق» في ملف Excel.");
  });
  it("a delivery with nothing of the kind gets no line (an unusable address alone is said in the file only)", () => {
    const clean = companies.filter((c) => !["c0-bobana-eg.com", "c3-yolo-cosmetics.com"].includes(c.id));
    const out = withCompanyQuality(plan() as any, { companies: clean, contacts });
    expect(out.reports[0].unusableAddress).toHaveLength(1);
    expect(qualityResultLineAr(out.reports)).toBeNull();
    expect(qualityResultLineAr([])).toBeNull();
  });
});
