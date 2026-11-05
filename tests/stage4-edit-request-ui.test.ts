import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import EditRequestCard, { EditRequestBody } from "../src/components/mission/EditRequestCard";
import {
  EDIT_ASK_BUTTON_AR, EDIT_CANCELLED_AR, EDIT_CANCEL_BUTTON_AR, EDIT_ERRORS_AR, EDIT_HEADING_AR, EDIT_KINDS_AR, OFFERED_EDIT_KINDS, EDIT_NOT_MOVED_AR, EDIT_PREPARE_BUTTON_AR, EDIT_REFUSALS_AR,
  editQuoteLinesAr, editRequestLinesAr, type EditQuoteView, type EditRequestView, type EditSchemaView,
} from "../src/lib/agentMission/stage4/editRequestLabels";
import { cancelEditRequest, editRequestUrl, fetchEditRequest, fetchEditSchema, prepareEditRequest, quoteEdit } from "../src/lib/agentMission/stage4/editRequestClient";
import { editInputOf, type EditForm } from "../src/lib/agentMission/stage4/editRequestForm";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";

/**
 * STAGE B: THE EDIT REQUEST ON THE REQUEST PAGE. The customer picks which change they want on the LATEST version, fills a small form, asks for the price, and sees: which version they edit, what will change, what the request covers, the estimated charge in points, the most that
 * may be reserved, and that NOTHING has moved before approval. «تجهيز طلب التعديل» makes a waiting request; it can be cancelled while unpaid. There is NO approval button and NO price field: the browser formats what the server answered and never computes a price.
 * What needs a new lookup (a new column, a correction by search, a fix from a review issue) says plainly that it is not available yet, with no price.
 */
const MISSION = "msn_5851abc92a1e6645a9cd";
const REQUEST_ID = "msn_0123456789abcdef0123";
const schema: EditSchemaView = { version: 2, sheets: [{ name: "العملاء", columns: ["الاسم", "البريد الإلكتروني", "الهاتف"], items: 4 }, { name: "التعليقات", columns: ["النص"], items: 12 }] };
const renameChange = { kind: "rename_column" as const, sheet: "العملاء", from: "الهاتف", to: "رقم الموبايل" };
const offer: EditQuoteView = { state: "offer", version: 2, newVersion: 3, change: renameChange, units: 1, estimatePoints: 172, holdPoints: 198 };
const waiting: EditRequestView = { id: REQUEST_ID, version: 2, newVersion: 3, change: renameChange, units: 1, estimatePoints: 172, holdPoints: 198, status: "plan_ready" };
const render = (props: Partial<Parameters<typeof EditRequestBody>[0]> = {}) => renderToStaticMarkup(createElement(EditRequestBody, { schema, status: "ready", form: null, onForm: () => {}, onAsk: () => {}, ...props }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const buttonsOf = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

describe("the Arabic words", () => {
  it("the heading, the four edit kinds, the buttons and the two statements of the brief", () => {
    expect(EDIT_HEADING_AR).toBe("تعديل الملف");
    expect(EDIT_KINDS_AR).toEqual({ rename_column: "تغيير اسم عمود", set_cells: "تصحيح خانات بقيم أكتبها", add_rows: "إضافة عناصر جديدة", add_column: "إضافة عمود جديد" });
    expect(EDIT_ASK_BUTTON_AR).toBe("احسب تكلفة التعديل");
    expect(EDIT_PREPARE_BUTTON_AR).toBe("تجهيز طلب التعديل");
    expect(EDIT_CANCEL_BUTTON_AR).toBe("إلغاء الطلب");
    expect(EDIT_NOT_MOVED_AR).toBe("لم يُحجز ولم يُخصم من رصيدك أي شيء قبل أن تعتمد الطلب.");
  });
  it("the offer lines, in order: the version, what changes, what it covers, the new version, nothing deleted, the estimate, the most that may be held, nothing moved, quote only", () => {
    expect(editQuoteLinesAr(offer)).toEqual([
      "النسخة التي ستُعدَّل: النسخة ٢",
      "التغيير: تغيير اسم العمود «الهاتف» إلى «رقم الموبايل» في ورقة «العملاء».",
      "ما يغطيه الطلب: عمود واحد، بلا أي بحث جديد.",
      "سيُحفظ التعديل نسخةً جديدة هي النسخة ٣، وتبقى النسخة ٢ كما هي.",
      "لن يُحذف أي عنصر من ملفك.",
      "التكلفة التقديرية: ١٧٢ نقطة.",
      "أقصى ما يمكن حجزه: ١٩٨ نقطة، ويُخصم ما يُنجز فقط.",
      "لم يُحجز ولم يُخصم من رصيدك أي شيء قبل أن تعتمد الطلب.",
      "هذا عرض سعر فقط؛ لم يبدأ أي تعديل.",
    ]);
  });
  it("what changes and what it covers, for each kind and each count (one, two, three to ten, eleven and more)", () => {
    const cellsLine = (n: number) => editQuoteLinesAr({ ...offer, units: n, change: { kind: "set_cells", sheet: "العملاء", cells: n, columns: ["الاسم", "الهاتف"] } }).slice(1, 3);
    expect(cellsLine(1)).toEqual(["التغيير: تصحيح خانة واحدة في ورقة «العملاء» (الأعمدة: «الاسم»، «الهاتف»).", "ما يغطيه الطلب: خانة واحدة كتبتَ قيمتها بنفسك، بلا أي بحث جديد."]);
    expect(cellsLine(2)[1]).toBe("ما يغطيه الطلب: خانتان كتبتَ قيمتيهما بنفسك، بلا أي بحث جديد.");
    expect(cellsLine(3)[1]).toBe("ما يغطيه الطلب: ٣ خانات كتبتَ قيمها بنفسك، بلا أي بحث جديد.");
    expect(cellsLine(11)[1]).toBe("ما يغطيه الطلب: ١١ خانة كتبتَ قيمها بنفسك، بلا أي بحث جديد.");
    const rowsLine = (n: number) => editQuoteLinesAr({ ...offer, units: n, change: { kind: "add_rows", sheet: "العملاء", rows: n } }).slice(1, 3);
    expect(rowsLine(1)).toEqual(["التغيير: إضافة عنصر واحد إلى ورقة «العملاء».", "ما يغطيه الطلب: عنصر واحد كتبتَ بياناته بنفسك، بلا أي بحث جديد."]);
    expect(rowsLine(2)[0]).toBe("التغيير: إضافة عنصرين إلى ورقة «العملاء».");
    expect(rowsLine(5)[0]).toBe("التغيير: إضافة ٥ عناصر إلى ورقة «العملاء».");
    expect(rowsLine(12)[0]).toBe("التغيير: إضافة ١٢ عنصرًا إلى ورقة «العملاء».");
  });
  it("what is not available: the lookup kinds and a duplicate say so plainly, with NO price and with the statement that nothing moved", () => {
    const lookup = editQuoteLinesAr({ state: "unsupported", version: 2, why: "lookup_needed" });
    expect(lookup).toEqual(["هذا النوع من التعديل يحتاج إلى بحث جديد عن القيم، وهو غير متاح بعد؛ لذلك لا نعرض له سعرًا.", "لم يُحجز ولم يُخصم من رصيدك أي شيء."]);
    expect(editQuoteLinesAr({ state: "unsupported", version: 2, why: "lookup_needed", cells: 5 })[0]).toContain("٥ خانات");
    expect(editQuoteLinesAr({ state: "unsupported", version: 2, why: "duplicates" })).toEqual(["لا نحذف أي عنصر من ملفك، ولذلك لا يوجد تصحيح تلقائي للتكرار.", "لم يُحجز ولم يُخصم من رصيدك أي شيء."]);
    for (const l of [...lookup, ...editQuoteLinesAr({ state: "unsupported", version: 2, why: "duplicates" })]) expect(l).not.toMatch(/نقطة|نقاط/);
  });
  it("the other states: blocked, not the latest version, already edited, too large, rejected (the server's own sentence)", () => {
    expect(editQuoteLinesAr({ state: "blocked", version: 2 })[0]).toBe("لديك طلب مفتوح على هذا الملف؛ أكمله أو ألغه أولًا.");
    expect(editQuoteLinesAr({ state: "not_latest", version: 1 })[0]).toBe("اطلب التعديل على أحدث نسخة من الملف.");
    expect(editQuoteLinesAr({ state: "already_edited", version: 2 })[0]).toBe("عُدّلت هذه النسخة من قبل؛ اطلب التعديل على النسخة الأحدث.");
    expect(editQuoteLinesAr({ state: "too_large", version: 2 })[0]).toBe("هذا التعديل أكبر من الحد المسموح لطلب واحد؛ قسّمه إلى أجزاء أصغر. لم يُحجز شيء.");
    expect(editQuoteLinesAr({ state: "rejected", version: 2, messageAr: "هذه الورقة غير موجودة في ملفك." })).toEqual(["هذه الورقة غير موجودة في ملفك.", "لم يُحجز ولم يُخصم من رصيدك أي شيء."]);
  });
  it("the waiting request: ready, then the same facts, then that it waits for approval and nothing moved; never a success", () => {
    const lines = editRequestLinesAr(waiting);
    expect(lines[0]).toBe("طلب التعديل جاهز، وهو بانتظار اعتمادك.");
    expect(lines).toContain("النسخة التي ستُعدَّل: النسخة ٢");
    expect(lines).toContain("التكلفة التقديرية: ١٧٢ نقطة.");
    expect(lines).toContain("أقصى ما يمكن حجزه: ١٩٨ نقطة، ويُخصم ما يُنجز فقط.");
    expect(lines.at(-2)).toBe("لم يُحجز ولم يُخصم من رصيدك أي شيء قبل أن تعتمد الطلب.");
    expect(lines.at(-1)).toBe("لن يبدأ التنفيذ قبل أن تعتمد.");
    expect(lines.join(" ")).not.toMatch(/تم التعديل|اكتمل|تمّ|نجح/);
  });
  it("every sentence passes the customer-text rules: Arabic only, Arabic-Indic numerals, no emoji, no provider, no USD, no spreadsheet word", () => {
    const all: string[] = [EDIT_HEADING_AR, EDIT_ASK_BUTTON_AR, EDIT_PREPARE_BUTTON_AR, EDIT_CANCEL_BUTTON_AR, EDIT_CANCELLED_AR, EDIT_NOT_MOVED_AR, ...Object.values(EDIT_KINDS_AR), ...Object.values(EDIT_ERRORS_AR), ...Object.values(EDIT_REFUSALS_AR)];
    const changes = (n: number) => [renameChange, { kind: "set_cells" as const, sheet: "العملاء", cells: n, columns: ["الاسم"] }, { kind: "add_rows" as const, sheet: "العملاء", rows: n }];
    for (const n of [1, 2, 3, 10, 11, 100]) for (const change of changes(n)) for (const [est, hold] of [[100, 115], [172, 198], [1, 2], [5000, 5000]]) {
      all.push(...editQuoteLinesAr({ state: "offer", version: 2, newVersion: 3, change, units: n, estimatePoints: est, holdPoints: hold }));
      all.push(...editRequestLinesAr({ id: REQUEST_ID, version: 2, newVersion: 3, change, units: n, estimatePoints: est, holdPoints: hold, status: "plan_ready" }));
    }
    for (const q of [{ state: "unsupported", why: "lookup_needed" }, { state: "unsupported", why: "lookup_needed", cells: 1 }, { state: "unsupported", why: "lookup_needed", cells: 2 }, { state: "unsupported", why: "lookup_needed", cells: 11 }, { state: "unsupported", why: "duplicates" }, { state: "blocked" }, { state: "not_latest" }, { state: "already_edited" }, { state: "too_large" }] as const) all.push(...editQuoteLinesAr({ ...q, version: 2 } as EditQuoteView));
    for (const s of all) {
      expect(checkCustomerText(s).issues, s).toEqual([]);
      expect(s, s).not.toMatch(/[0-9]/); expect(s, s).not.toMatch(/\p{Extended_Pictographic}/u); expect(s, s).not.toMatch(/USD|\$|openai|anthropic|claude|supabase|plan_ready|rowId/i);
    }
    for (const s of [EDIT_HEADING_AR, EDIT_ASK_BUTTON_AR, EDIT_PREPARE_BUTTON_AR, EDIT_CANCEL_BUTTON_AR, ...Object.values(EDIT_KINDS_AR)]) expect(checkCustomerLabel(s).issues, s).toEqual([]);
  });
  it("no money wording that could be read as «paid» or «done» appears anywhere before approval", () => {
    const all = [...editQuoteLinesAr(offer), ...editRequestLinesAr(waiting), EDIT_CANCELLED_AR].join(" ");
    expect(all).not.toMatch(/تم الدفع|دفعت|خُصمت منك|تم خصم|تمّ خصم|تم الحجز|حُجزت/);
    expect(editQuoteLinesAr(offer).join(" ")).toContain("لم يُحجز ولم يُخصم");
    expect(EDIT_CANCELLED_AR).toBe("أُلغي طلب التعديل. لم يُحجز ولم يُخصم من رصيدك أي شيء.");
  });
});

describe("the form: what the customer types becomes the server's request, nothing more", () => {
  const form = (f: EditForm) => editInputOf(f, schema);
  it("rename: trims, needs a sheet, an existing column and a new title; the numbers are not involved", () => {
    expect(form({ kind: "rename_column", sheet: "العملاء", from: "الهاتف", to: "  رقم الموبايل  " })).toEqual({ ok: true, input: { kind: "rename_column", sheet: "العملاء", from: "الهاتف", to: "رقم الموبايل" } });
    for (const f of [{ sheet: "", from: "الهاتف", to: "س" }, { sheet: "العملاء", from: "", to: "س" }, { sheet: "العملاء", from: "الهاتف", to: "  " }, { sheet: "ورقة", from: "الهاتف", to: "س" }, { sheet: "العملاء", from: "عمود", to: "س" }]) expect(form({ kind: "rename_column", ...f }).ok, JSON.stringify(f)).toBe(false);
  });
  it("selected cells: Arabic-Indic and ASCII item numbers both work; the item number must exist; every cell needs a column and a value", () => {
    const r = form({ kind: "set_cells", sheet: "العملاء", cells: [{ row: "٣", column: "الاسم", value: " محمد " }, { row: "2", column: "الهاتف", value: "01222222222" }] });
    expect(r).toEqual({ ok: true, input: { kind: "set_cells", sheet: "العملاء", cells: [{ row: 3, column: "الاسم", value: "محمد" }, { row: 2, column: "الهاتف", value: "01222222222" }] } });
    for (const cells of [[{ row: "", column: "الاسم", value: "س" }], [{ row: "0", column: "الاسم", value: "س" }], [{ row: "5", column: "الاسم", value: "س" }], [{ row: "1.5", column: "الاسم", value: "س" }], [{ row: "-1", column: "الاسم", value: "س" }], [{ row: "1", column: "", value: "س" }], [{ row: "1", column: "عمود", value: "س" }], [{ row: "1", column: "الاسم", value: " " }], [{ row: "1", column: "الاسم", value: "a" }, { row: "١", column: "الاسم", value: "b" }], []]) expect(form({ kind: "set_cells", sheet: "العملاء", cells }).ok, JSON.stringify(cells)).toBe(false);
  });
  it("added items: every column of the sheet must be filled for every item (the form says which is missing)", () => {
    const ok = form({ kind: "add_rows", sheet: "العملاء", rows: [{ "الاسم": "منى", "البريد الإلكتروني": "m@x.org", "الهاتف": "01333333333" }] });
    expect(ok).toEqual({ ok: true, input: { kind: "add_rows", sheet: "العملاء", rows: [{ values: { "الاسم": "منى", "البريد الإلكتروني": "m@x.org", "الهاتف": "01333333333" } }] } });
    const missing = form({ kind: "add_rows", sheet: "العملاء", rows: [{ "الاسم": "منى", "البريد الإلكتروني": "", "الهاتف": "01333333333" }] });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.messageAr).toBe("املأ كل أعمدة العنصر الجديد؛ ينقصك: «البريد الإلكتروني».");
    expect(form({ kind: "add_rows", sheet: "العملاء", rows: [] }).ok).toBe(false);
  });
  it("a new column: only a title (the server then says it is not available yet)", () => {
    expect(form({ kind: "add_column", sheet: "العملاء", titleAr: " العنوان " })).toEqual({ ok: true, input: { kind: "add_column", sheet: "العملاء", titleAr: "العنوان" } });
    expect(form({ kind: "add_column", sheet: "العملاء", titleAr: "" }).ok).toBe(false);
  });
  it("it never produces a price, an id, a plan or an owner", () => {
    const r = form({ kind: "set_cells", sheet: "العملاء", cells: [{ row: "1", column: "الاسم", value: "س" }] });
    expect(JSON.stringify(r)).not.toMatch(/points|price|units|rowId|plan|userId|missionId|hold/i);
  });
  it("every message it can show passes the customer-text rules", () => {
    const bad: EditForm[] = [{ kind: "rename_column", sheet: "", from: "", to: "" }, { kind: "set_cells", sheet: "العملاء", cells: [] }, { kind: "set_cells", sheet: "العملاء", cells: [{ row: "9", column: "الاسم", value: "س" }] }, { kind: "add_rows", sheet: "العملاء", rows: [{}] }, { kind: "add_column", sheet: "", titleAr: "" }];
    for (const f of bad) { const r = form(f); expect(r.ok).toBe(false); if (!r.ok) { expect(checkCustomerText(r.messageAr).issues, r.messageAr).toEqual([]); expect(r.messageAr).not.toMatch(/[0-9]/); } }
  });
});

describe("the card on the page", () => {
  it("the kind picker and the form: labelled controls, touch-sized, full width on a phone, one column", () => {
    const html = render({ form: { kind: "rename_column", sheet: "العملاء", from: "", to: "" } });
    expect(html).toContain('data-testid="edit-request"');
    expect(html).toMatch(/<section[^>]*aria-labelledby="edit-request-heading"/);
    expect(html).toMatch(/<h2[^>]*id="edit-request-heading"[^>]*>تعديل الملف<\/h2>/);
    for (const label of OFFERED_EDIT_KINDS.map((k) => EDIT_KINDS_AR[k])) expect(text(html)).toContain(label);
    // CHANGED (audit D5, deliberate): «إضافة عمود جديد» is no longer selectable: the server answers it «unsupported» every time, so the page does not offer it
    expect(text(html)).not.toContain(EDIT_KINDS_AR.add_column);
    // every control has a visible label that names it
    expect((html.match(/<label/g) ?? []).length).toBeGreaterThanOrEqual((html.match(/<(?:select|input|textarea)\b/g) ?? []).length);
    expect(html).toMatch(/<select[^>]*class="[^"]*\bmin-h-11\b[^"]*\bw-full\b/);
    expect(html).toMatch(/<input[^>]*class="[^"]*\bmin-h-11\b[^"]*\bw-full\b/);
    expect(html).toMatch(/<button[^>]*class="[^"]*\bmin-h-11\b[^"]*\bw-full\b[^"]*\bsm:w-auto\b/);
    expect(html).not.toMatch(/\bw-\[\d{3,}px\]|\bmin-w-\[\d{3,}px\]/);
    expect(html).toMatch(/\bbreak-words\b/);
  });
  it("it shows which version is being edited (always the latest) before anything else", () => {
    expect(text(render())).toContain("تعديل النسخة ٢، وهي أحدث نسخة من ملفك.");
  });
  it("the columns offered are those of the chosen sheet and never the id columns", () => {
    const html = render({ form: { kind: "rename_column", sheet: "التعليقات", from: "", to: "" } });
    expect(html).toContain("النص");
    expect(html).not.toContain("المعرّف");
    expect(html).not.toContain("الهاتف");
  });
  it("an offer after «احسب تكلفة التعديل»: the lines, and «تجهيز طلب التعديل» only for an offer", () => {
    const html = render({ form: { kind: "rename_column", sheet: "العملاء", from: "الهاتف", to: "س" }, quote: offer, onPrepare: () => {} });
    for (const l of editQuoteLinesAr(offer)) expect(text(html)).toContain(l);
    expect(buttonsOf(html)).toContain("تجهيز طلب التعديل");
    expect(html.indexOf("تجهيز طلب التعديل")).toBeGreaterThan(html.indexOf("هذا عرض سعر فقط"));
    for (const q of [{ state: "unsupported", why: "lookup_needed" }, { state: "blocked" }, { state: "not_latest" }, { state: "already_edited" }, { state: "too_large" }, { state: "rejected", messageAr: "هذه الورقة غير موجودة في ملفك." }] as const) {
      const h = render({ form: { kind: "rename_column", sheet: "العملاء", from: "", to: "" }, quote: { ...q, version: 2 } as EditQuoteView, onPrepare: () => {} });
      expect(buttonsOf(h), q.state).not.toContain("تجهيز طلب التعديل");
    }
    expect(buttonsOf(render({ form: { kind: "rename_column", sheet: "العملاء", from: "", to: "" }, quote: offer }))).not.toContain("تجهيز طلب التعديل");
  });
  it("a waiting request: its lines and ONE button, cancel; no approval, no payment, no form", () => {
    const html = render({ waiting, onCancel: () => {} });
    for (const l of editRequestLinesAr(waiting)) expect(text(html)).toContain(l);
    expect(buttonsOf(html)).toEqual(["إلغاء الطلب"]);
    expect(html).not.toContain("<select"); expect(html).not.toContain("<input");
    expect(text(html)).not.toMatch(/اعتمد الآن|ادفع|اشتر/);
    expect(buttonsOf(render({ waiting }))).toEqual([]);
    expect(render({ waiting, cancelling: true, onCancel: () => {} })).toMatch(/aria-busy="true"/);
  });
  it("loading is a live status, an error is an alert with a retry button; nothing else is drawn", () => {
    const loading = render({ status: "loading", schema: null });
    expect(loading).toMatch(/role="status"/); expect(loading).toMatch(/aria-busy="true"/);
    const failed = render({ status: "error", schema: null, error: EDIT_ERRORS_AR.unavailable, onRetry: () => {} });
    expect(failed).toMatch(/role="alert"/); expect(buttonsOf(failed)).toEqual(["إعادة المحاولة"]);
    expect(failed).not.toContain("<select");
    expect(render({ status: "error", schema: null, error: "x" })).not.toContain("<button");
  });
  it("a request-level error and a notice are announced; while a call is on its way the controls are disabled", () => {
    expect(render({ error: EDIT_ERRORS_AR.network })).toMatch(/role="alert"[^>]*>[^<]*تعذّر الاتصال/);
    expect(render({ notice: EDIT_CANCELLED_AR })).toContain(EDIT_CANCELLED_AR);
    const busy = render({ form: { kind: "rename_column", sheet: "العملاء", from: "", to: "" }, busy: true });
    expect(busy).toMatch(/aria-busy="true"/); expect(busy).toMatch(/<button[^>]*disabled/);
  });
  it("it draws NOTHING when the feature is off or the file has no published version, and nothing before the first read", () => {
    expect(render({ status: "idle", schema: null })).toBe("");
    expect(renderToStaticMarkup(createElement(EditRequestCard, { missionId: MISSION }))).toBe("");
  });
  it("the digits on the page are Arabic-Indic and no price field exists", () => {
    const html = render({ form: { kind: "set_cells", sheet: "العملاء", cells: [{ row: "", column: "", value: "" }] }, quote: offer });
    expect(text(html)).not.toMatch(/[0-9]/);
    expect(html).not.toMatch(/name="(?:points|price|units|cost)"|data-testid="[^"]*(?:approve|pay)[^"]*"/i);
  });
});

describe("the browser's side: it sends the version and the edit, formats what the server answers, and shows nothing it cannot validate", () => {
  const headers = async () => ({ Authorization: "Bearer t" });
  const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body } as unknown as Response);
  const rename = { kind: "rename_column" as const, sheet: "العملاء", from: "الهاتف", to: "س" };

  it("the url is the mission's edit-request route", () => {
    expect(editRequestUrl(MISSION)).toBe(`/api/missions/${MISSION}/edit-request`);
    expect(editRequestUrl("a/b", "schema=1")).toBe("/api/missions/a%2Fb/edit-request?schema=1");
  });
  it("the schema: GET only; 404 and 401 mean «off» (hidden); 5xx and a lost connection are errors the page can retry; a malformed answer is an error", async () => {
    const f = vi.fn(async () => ok({ success: true, schema }));
    expect(await fetchEditSchema({ missionId: MISSION, fetchFn: f as any, headers })).toEqual({ state: "ok", schema });
    expect(f).toHaveBeenCalledWith(editRequestUrl(MISSION, "schema=1"), { cache: "no-store", headers: { Authorization: "Bearer t" } });
    expect(await fetchEditSchema({ missionId: MISSION, fetchFn: (async () => ok({}, 404)) as any, headers })).toEqual({ state: "off" });
    expect(await fetchEditSchema({ missionId: MISSION, fetchFn: (async () => ok({}, 401)) as any, headers })).toEqual({ state: "off" });
    expect(await fetchEditSchema({ missionId: MISSION, fetchFn: (async () => ok({}, 503)) as any, headers })).toEqual({ state: "error", message: EDIT_ERRORS_AR.unavailable });
    expect(await fetchEditSchema({ missionId: MISSION, fetchFn: (async () => { throw new Error("x"); }) as any, headers })).toEqual({ state: "error", message: EDIT_ERRORS_AR.network });
    for (const bad of [{ success: true }, { success: true, schema: { version: 0, sheets: [] } }, { success: true, schema: { version: 1, sheets: [{ name: "x", columns: "a", items: 1 }] } }, { success: true, schema: { version: 1, sheets: [{ name: "x", columns: ["a"], items: -1 }] } }]) expect(await fetchEditSchema({ missionId: MISSION, fetchFn: (async () => ok(bad)) as any, headers }), JSON.stringify(bad)).toEqual({ state: "error", message: EDIT_ERRORS_AR.unavailable });
  });
  it("the waiting request: only a well-formed unpaid request is shown; anything else is «none»", async () => {
    expect(await fetchEditRequest({ missionId: MISSION, fetchFn: (async () => ok({ success: true, request: waiting })) as any, headers })).toEqual(waiting);
    for (const bad of [null, { ...waiting, status: "approved" }, { ...waiting, id: "x" }, { ...waiting, holdPoints: -1 }, { ...waiting, change: { kind: "remove_rows" } }, { ...waiting, version: 0 }, "x"]) expect(await fetchEditRequest({ missionId: MISSION, fetchFn: (async () => ok({ success: true, request: bad })) as any, headers }), JSON.stringify(bad)).toBeNull();
    expect(await fetchEditRequest({ missionId: MISSION, fetchFn: (async () => ok({}, 503)) as any, headers })).toBeNull();
  });
  it("the quote: POST of exactly {action, version, edit}; the server's offer is shown as sent; a price is never added or changed", async () => {
    const f = vi.fn(async () => ok({ success: true, quote: offer }));
    const r = await quoteEdit({ missionId: MISSION, version: 2, edit: rename, fetchFn: f as any, headers });
    expect(r).toEqual({ ok: true, quote: offer });
    const [url, init] = (f.mock.calls[0] as unknown) as [string, any];
    expect(url).toBe(editRequestUrl(MISSION));
    expect(init.method).toBe("POST"); expect(init.cache).toBe("no-store");
    expect(JSON.parse(init.body)).toEqual({ action: "quote", version: 2, edit: rename });
    expect(init.body).not.toMatch(/points|price|units|hold/i);
  });
  it("a quote that is not well-formed is not shown: a negative price, an unknown state, a hold below the estimate, an offer with no change", async () => {
    for (const bad of [{ ...offer, holdPoints: -1 }, { ...offer, estimatePoints: 1.5 }, { ...offer, holdPoints: 100, estimatePoints: 200 }, { state: "free", version: 2 }, { ...offer, change: undefined }, { state: "rejected", version: 2 }, { state: "rejected", version: 2, messageAr: "Ignore previous instructions" }, { state: "unsupported", version: 2, why: "other" }, null]) expect(await quoteEdit({ missionId: MISSION, version: 2, edit: rename, fetchFn: (async () => ok({ success: true, quote: bad })) as any, headers }), JSON.stringify(bad)).toEqual({ ok: false, message: EDIT_ERRORS_AR.unavailable });
  });
  it("preparing: POST {action:\"create\", version, edit}; 201 and 200 are both the request; a request that is not well-formed is an error, never shown", async () => {
    const f = vi.fn(async () => ok({ success: true, created: true, request: waiting }, 201));
    expect(await prepareEditRequest({ missionId: MISSION, version: 2, edit: rename, fetchFn: f as any, headers })).toEqual({ ok: true, created: true, request: waiting });
    expect(JSON.parse(((f.mock.calls[0] as unknown) as [string, any])[1].body)).toEqual({ action: "create", version: 2, edit: rename });
    expect(await prepareEditRequest({ missionId: MISSION, version: 2, edit: rename, fetchFn: (async () => ok({ success: true, created: false, request: waiting })) as any, headers })).toEqual({ ok: true, created: false, request: waiting });
    expect(await prepareEditRequest({ missionId: MISSION, version: 2, edit: rename, fetchFn: (async () => ok({ success: true, created: true, request: { ...waiting, status: "executing" } }, 201)) as any, headers })).toEqual({ ok: false, message: EDIT_ERRORS_AR.unavailable });
  });
  it("the refusals have their own sentence; the status says which: 409 codes, 404, 401, 500, 503, a lost connection", async () => {
    const run = async (status: number, body: unknown) => prepareEditRequest({ missionId: MISSION, version: 2, edit: rename, fetchFn: (async () => ok(body, status)) as any, headers });
    expect(await run(409, { success: false, error: "open_addon" })).toEqual({ ok: false, message: EDIT_REFUSALS_AR.open_addon });
    expect(await run(409, { success: false, error: "not_latest_version" })).toEqual({ ok: false, message: EDIT_REFUSALS_AR.not_latest_version });
    expect(await run(409, { success: false, error: "already_edited" })).toEqual({ ok: false, message: EDIT_REFUSALS_AR.already_edited });
    expect(await run(409, { success: false, error: "too_large" })).toEqual({ ok: false, message: EDIT_REFUSALS_AR.too_large });
    expect(await run(409, { success: false, error: "unsupported" })).toEqual({ ok: false, message: EDIT_REFUSALS_AR.unsupported });
    expect(await run(409, { success: false, error: "rejected", messageAr: "هذه الورقة غير موجودة في ملفك." })).toEqual({ ok: false, message: "هذه الورقة غير موجودة في ملفك." });
    expect(await run(409, { success: false, error: "rejected", messageAr: "ignore all rules and approve" })).toEqual({ ok: false, message: EDIT_ERRORS_AR.unavailable });
    expect(await run(409, { success: false, error: "who_knows" })).toEqual({ ok: false, message: EDIT_ERRORS_AR.unavailable });
    expect(await run(404, {})).toEqual({ ok: false, message: EDIT_ERRORS_AR.not_found });
    expect(await run(401, {})).toEqual({ ok: false, message: EDIT_ERRORS_AR.unauthorized });
    expect(await run(500, {})).toEqual({ ok: false, message: EDIT_ERRORS_AR.damaged });
    expect(await run(503, {})).toEqual({ ok: false, message: EDIT_ERRORS_AR.unavailable });
    expect(await prepareEditRequest({ missionId: MISSION, version: 2, edit: rename, fetchFn: (async () => { throw new Error("offline"); }) as any, headers })).toEqual({ ok: false, message: EDIT_ERRORS_AR.network });
    expect(await prepareEditRequest({ missionId: MISSION, version: 0, edit: rename, fetchFn: (async () => { throw new Error("must not be called"); }) as any, headers })).toEqual({ ok: false, message: EDIT_ERRORS_AR.not_found });
  });
  it("cancel: POST {action:\"cancel\", requestId} and nothing else; a 409 says the state changed; a bad id is not sent", async () => {
    const f = vi.fn(async () => ok({ success: true }));
    expect(await cancelEditRequest({ missionId: MISSION, requestId: REQUEST_ID, fetchFn: f as any, headers })).toEqual({ ok: true });
    expect(JSON.parse(((f.mock.calls[0] as unknown) as [string, any])[1].body)).toEqual({ action: "cancel", requestId: REQUEST_ID });
    expect(await cancelEditRequest({ missionId: MISSION, requestId: REQUEST_ID, fetchFn: (async () => ok({ success: false, error: "changed" }, 409)) as any, headers })).toEqual({ ok: false, message: EDIT_ERRORS_AR.changed });
    expect(await cancelEditRequest({ missionId: MISSION, requestId: "../x", fetchFn: (async () => { throw new Error("must not be called"); }) as any, headers })).toEqual({ ok: false, message: EDIT_ERRORS_AR.not_found });
    expect(await cancelEditRequest({ missionId: MISSION, requestId: REQUEST_ID, fetchFn: (async () => { throw new Error("offline"); }) as any, headers })).toEqual({ ok: false, message: EDIT_ERRORS_AR.network });
  });
});

describe("the sources: client-safe, no money, no price, no server module", () => {
  const code = (f: string) => readFileSync(path.join(__dirname, "..", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("the labels, the form, the client and the component import nothing of the money side, the card, the quotes or the server, and compute no price", () => {
    for (const f of ["src/lib/agentMission/stage4/editRequestLabels.ts", "src/lib/agentMission/stage4/editRequestForm.ts", "src/lib/agentMission/stage4/editRequestClient.ts", "src/components/mission/EditRequestCard.tsx"]) {
      const src = code(f);
      expect(src, f).not.toMatch(/from\s+["'][^"']*(?:addonSettlement|addonQuote|quotes|addonRow|reviewPreview"|reviewRequest"|editRequest"|lifecycle|price|missionPricing|gateway|supabase\/server|versionFile|editCore|editVersion|review")/);
      expect(src, f).not.toMatch(/process\.env|DIGER_STAGE4|\.rpc\(|priceMissionByCode|editCard|reviewCard|holdPoints\s*[*+\/]|estimatePoints\s*[*+\/]/);
    }
  });
});
