import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { buildRequestContract } from "../src/lib/agentMission/requestContract";
import { fieldNotesAr, recoverFields } from "../src/lib/agentMission/foundation/discovery/fieldRecovery";
import { discoverCards } from "../src/lib/agentMission/foundation/discovery/deriveCards";
import { NO_SENSITIVE_ACCESS } from "../src/lib/treg/dataPolicy";
import { csvExportFromWorkbook } from "../src/lib/server/csvFromExcel";
import { catalog, catalogPage, deliver, discoveryWorld } from "./helpers/discoveryWorld";

/**
 * ROUND 36: THE FIELDS THE CUSTOMER NAMED. Live (msn_30093b19…, a reels search, 5 rows, 200 points): the request named «النصوص والروابط والتواريخ وعدد المشاهدات»; the plan carried text, link, views and the topic mark; no date and no account. The file and the CSV matched cell by cell (no shifted column).
 * The selected tool's catalog entry lists only the first fields of its item («… 10 more field(s) truncated»), so the card derived from it never mapped a date or an account. EVIDENCE LABELS: the endpoint's field list is the REAL catalog snapshot; the raw pages of that mission are in private storage and
 * were NOT readable here, so the PAGES below are SIMULATED in two shapes (a provider that carries date and account under its own keys; one that carries neither) and prove the mechanism, not what that provider returned.
 */
const REELS = "scrapecreators.x.v2-instagram-reels-search";
const REQUEST = "اجمع ٥ ريلز عامة من إنستجرام عن الذكاء الاصطناعي، مع النصوص والروابط والتواريخ وعدد المشاهدات إن كانت متاحة.";
const base = (i: number) => ({ id: `39400000000000${String(i).padStart(5, "0")}`, __typename: "XDTGraphVideo", shortcode: `Rl${i}`, url: `https://www.instagram.com/reel/Rl${i}/`, caption: `ريل عن الذكاء الاصطناعي رقم ${i}`, product_type: "clips", video_view_count: 10 * i, video_play_count: 100 * i });
const withMeta = (i: number) => ({ ...base(i), taken_at_timestamp: 1_788_000_000 + i * 3600, owner: { username: `creator_${i}`, id: `${i}` } });

describe("the request's words", () => {
  it("the real request names text, link, dates and views; «من تاريخ ١ يناير» is a period, not a date column", () => {
    expect(buildRequestContract(REQUEST).wants).toEqual(["posted_at", "views"]);
    expect(buildAsk(REQUEST, null, Date.UTC(2026, 10, 4)).wants).toEqual(["posted_at", "views"]);
    expect(buildRequestContract("٥ ريلز من إنستجرام عن القهوة مع اسم الحساب والإعجابات").wants).toEqual(["author", "likes"]);
    for (const t of ["٥ ريلز من إنستجرام عن القهوة", "٥ منشورات من إنستجرام من تاريخ ١ يناير حتى ١٠ يناير", "منشورات من حساب @natgeo"]) expect(buildRequestContract(t).wants, t).toBeUndefined();
  });
});

describe("recovery on a real page (pure)", () => {
  const card = discoverCards(catalog, "instagram", NO_SENSITIVE_ACCESS).cards.find((c) => c.endpointId === REELS)!;
  it("the real catalog entry of the selected tool maps NO date and NO account (its field list is truncated): this is the live defect", () => {
    expect(Object.keys((card.mapping as { fields: object }).fields)).toEqual(["id", "text", "link", "views"]);
  });
  it("a page whose items carry the date and the account under the provider's own keys: both are recovered with their paths, the values are the page's own", () => {
    const page = catalogPage(REELS, Array.from({ length: 10 }, (_, i) => withMeta(i + 1)), null);
    const r = recoverFields(card, page, ["posted_at", "views"], Date.parse("2026-11-04T18:00:00Z"));
    expect(r.report).toEqual([{ key: "posted_at", status: "recovered", path: "taken_at_timestamp" }, { key: "views", status: "card", path: "video_view_count" }].map((x) => expect.objectContaining(x)));
    const withAuthor = recoverFields(card, page, ["author"]);
    expect(withAuthor.report[0]).toEqual({ key: "author", status: "recovered", path: "owner.username" });
  });
  it("a page with neither: unavailable, nothing invented, the card is unchanged; a key present on too few items is not recovered", () => {
    const none = catalogPage(REELS, Array.from({ length: 10 }, (_, i) => base(i + 1)), null);
    const r = recoverFields(card, none, ["posted_at", "author"]);
    expect(r.report.map((x) => x.status)).toEqual(["unavailable", "unavailable"]);
    expect(r.card).toBe(card);
    const few = catalogPage(REELS, Array.from({ length: 10 }, (_, i) => (i < 3 ? withMeta(i + 1) : base(i + 1))), null);
    expect(recoverFields(card, few, ["posted_at"]).report[0].status).toBe("unavailable");
    // a number that is no date (a counter under a date-like key) is refused
    const bad = catalogPage(REELS, Array.from({ length: 10 }, (_, i) => ({ ...base(i + 1), timestamp: i })), null);
    expect(recoverFields(card, bad, ["posted_at"]).report[0].status).toBe("unavailable");
  });
  it("the sentences: nothing is said when all is delivered; a missing field is said before approval with no provider and no path", () => {
    expect(fieldNotesAr([{ key: "views", status: "card" }])).toEqual([]);
    const text = fieldNotesAr([{ key: "posted_at", status: "unavailable" }, { key: "author", status: "recovered", path: "owner.username" }]).join(" ");
    expect(text).toContain("التواريخ");
    expect(text).not.toMatch(/owner|username|anyapi|scrapecreators|endpoint/i);
  });
});

/** The production choice among the validated candidates is the MODEL's (it chose the reels search in the live mission): the test stands in for it with the same answer; the ranking without a model is tested separately. */
const pickReelsSearch = async () => ({ endpointId: REELS, reason: "reels-only tool", costUsd: 0 });
async function planAndDeliver(pages: (i: number) => Record<string, unknown>) {
  const w = discoveryWorld(REQUEST, { [REELS]: () => catalogPage(REELS, Array.from({ length: 10 }, (_, i) => pages(i + 1)), "2") }, { discovery: true, platform: "instagram" });
  const r = await w.plan({ selectCapability: pickReelsSearch });
  expect(r.kind === "plan" ? "plan" : `${r.kind}:${(r as { reason?: string }).reason}`).toBe("plan");
  if (r.kind !== "plan") throw new Error("no plan");
  const out = await deliver(w, r.plan, REQUEST, "instagram");
  return { w, r, out };
}
const sheetOf = async (xlsx: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as never); return wb; };

describe("the plan and the file, end to end (SIMULATED pages)", () => {
  it("DATE AND ACCOUNT PRESENT ON THE PAGE: the plan has the date column filled, the file carries the page's own values, the stage and the methodology say REELS, Excel and CSV agree", async () => {
    const { r, out } = await planAndDeliver((i) => withMeta(i));
    const mark = r.kind === "plan" ? r.plan.compiled! : null;
    expect(mark!.media).toMatchObject({ asked: "reels", basis: "native" });
    expect(mark!.fields).toEqual(expect.arrayContaining([expect.objectContaining({ key: "posted_at", status: "recovered", path: "taken_at_timestamp" })]));
    const stage = out.plan.stages[0];
    expect(stage.title_ar).toBe("الريلز");
    expect(stage.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["text", "link", "views", "posted_at"]));
    const wb = await sheetOf(out.built.xlsx);
    const sheet = wb.worksheets[1];
    expect(sheet.name).toBe("الريلز");
    const headers = Array.from({ length: sheet.columnCount }, (_, c) => String(sheet.getCell(1, c + 1).value));
    expect(headers).toContain("تاريخ ووقت النشر");
    expect(sheet.rowCount - 1).toBe(5);
    const dateCol = headers.indexOf("تاريخ ووقت النشر") + 1;
    for (let rr = 2; rr <= 6; rr += 1) expect(sheet.getCell(rr, dateCol).value).toBeInstanceOf(Date);
    // the delivered rows are the page's own (the stage's rows by id), the CSV carries the same ids
    // the 19-digit ids are TEXT cells in the Excel (a number would lose digits); only a spreadsheet's CSV import turns them into 3.94E+18
    const idCol = headers.indexOf("المعرّف") + 1;
    for (let rr = 2; rr <= 6; rr += 1) expect(typeof sheet.getCell(rr, idCol).value).toBe("string");
    const rows = out.rowsByStage[stage.key];
    expect(rows).toHaveLength(5);
    const exp = await csvExportFromWorkbook(out.built.xlsx);
    for (const row of rows) expect(exp.stages[0].csv).toContain(String(row.id));
    const summary = wb.worksheets[0];
    const all: string[] = [];
    summary.eachRow((row) => row.eachCell((cell) => all.push(String(cell.text))));
    const text = all.join("\n");
    expect(text).toContain("ريلز");
    expect(text).toContain("نوع المحتوى: طُلبت ريلز");
    expect(text).not.toMatch(/٥ منشورات/);
  });
  it("NEITHER ON THE PAGE: the limitation is in the plan BEFORE approval, the date column says «غير متاح» in every row, the summary and the methodology name the gap, nothing is invented", async () => {
    const { r, out } = await planAndDeliver((i) => base(i));
    if (r.kind !== "plan") return;
    expect((r.plan.notes_ar ?? []).join("\n")).toContain("طلبت التواريخ");
    expect(r.plan.compiled!.fields).toEqual(expect.arrayContaining([expect.objectContaining({ key: "posted_at", status: "unavailable" })]));
    const wb = await sheetOf(out.built.xlsx);
    const sheet = wb.worksheets[1];
    const headers = Array.from({ length: sheet.columnCount }, (_, c) => String(sheet.getCell(1, c + 1).value));
    const dateCol = headers.indexOf("تاريخ ووقت النشر") + 1;
    expect(dateCol).toBeGreaterThan(0);
    for (let rr = 2; rr <= 6; rr += 1) expect(sheet.getCell(rr, dateCol).text).toBe("غير متاح");
    const all: string[] = [];
    wb.worksheets[0].eachRow((row) => row.eachCell((cell) => all.push(String(cell.text))));
    const text = all.join("\n");
    expect(text).toContain("تاريخ ووقت النشر");
    expect(text).toMatch(/لم يوفّره المصدر|التواريخ: طلبتها/);
  });
});

describe("SOURCE ELIGIBILITY: the fields the customer named take part in the choice (no model)", () => {
  // NOV 6 2026: the synthetic captions name the topic (an Instagram keyword search now never chooses a reel whose text does not name it)
  it("ranked by the catalog, the Reels-capable tool that LISTS the date and the account (the hashtag search with its documented reel filter) comes before the reels search whose field list is truncated; both prove reels; no non-Reels tool is a candidate", async () => {
    const ANY = "anyapi.instagram.hashtag.posts";
    const w = discoveryWorld("اجمع ٥ ريلز من إنستجرام عن الذكاء الاصطناعي مع التواريخ وأسماء أصحاب الحسابات", { [ANY]: () => catalogPage(ANY, Array.from({ length: 10 }, (_, i) => ({ id: `3940000000000${i}`, shortcode: `A${i}`, url: `https://www.instagram.com/reel/A${i}/`, caption: `ريل عن الذكاء الاصطناعي ${i}`, username: `u${i}`, createdUtc: 1_788_000_000 + i, likes: i, comments: i, type: "XDTGraphVideo" })), "c2") }, { discovery: true, platform: "instagram" });
    const r = await w.plan();
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const mark = r.plan.compiled!.discovery!;
    expect(mark.endpoint_id).toBe(ANY);
    expect(mark.media).toMatchObject({ basis: "filter", filter: { field: "mediaType", value: "reel" } });
    expect(w.calls[0].params).toMatchObject({ mediaType: "reel" });
    // NOV 6 2026: the Instagram parent sheet's standard fields (the account, the date, the likes) are checked with the ones named: the likes are given by this card
    expect(r.plan.compiled!.fields!.map((f) => [f.key, f.status])).toEqual([["posted_at", "card"], ["author", "card"], ["likes", "card"]]);
    for (const e of mark.evaluation!.eligible) expect(["anyapi.instagram.hashtag.posts", "scrapecreators.x.v1-instagram-search-hashtag", "scrapecreators.x.v2-instagram-reels-search"]).toContain(e.endpoint_id);
    expect(r.plan.summary_ar).toBe("٥ ريلز من إنستجرام عن «الذكاء الاصطناعي».");
  });
});
