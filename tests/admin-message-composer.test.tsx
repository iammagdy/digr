import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/adminApi", () => ({ adminFetch: vi.fn(async () => ({})) }));

import {
  COMPOSER_AR, ComposerView, composerReducer, createComposerController, initialComposerState, type ComposerAction, type ComposerApi, type ComposerMode, type ComposerState,
} from "../src/components/admin/MessageComposer";
import { CAMPAIGNS_EMPTY_AR, CAMPAIGNS_NOT_READY_AR, CampaignList, type CampaignLite } from "../src/components/admin/CampaignList";
import { CustomerEmailPanel } from "../src/components/admin/CustomerEmailPanel";
import AdminMessagesPage from "../src/app/admin/messages/page";
import { listCampaigns } from "../src/lib/server/campaignStore";

/**
 * DT-20261118-06 phase 2A: the one composer, two modes. The test environment has no DOM, so the composer's behaviour lives in a reducer and a controller
 * (tested here directly) and the screen is checked as rendered markup of the state they produce.
 */
const GOOD = { subject: "ملفاتك تصلك أسرع الآن", badge: "جديد في ديجر", heading: "تسليم أسرع لملفات إكسل", body: "{الاسم}، تحية طيبة،\n\nأصبحت ملفات إكسل تصلك أسرع من قبل.", ctaLabel: "اطلب الآن" };
const RECIPIENT = { email: "mona@example.test", adminEmail: "owner@example.test", greetingName: "منى" };
const EMOJI = /\p{Extended_Pictographic}/u;
const NOW = new Date("2026-11-19T10:00:00Z");

function harness(mode: ComposerMode, api: ComposerApi, start?: ComposerState) {
  let s = start ?? initialComposerState(mode);
  const dispatch = (a: ComposerAction) => { s = composerReducer(s, a); };
  const ctl = createComposerController(mode, api, () => s, dispatch, () => NOW);
  const html = () => renderToStaticMarkup(createElement(ComposerView, { mode, state: s, dispatch, ctl, recipient: mode === "single" ? RECIPIENT : undefined }));
  return { get: () => s, dispatch, ctl, html };
}
const filled = (mode: ComposerMode) => composerReducer(initialComposerState(mode), { type: "draftDone", draft: GOOD, refused: null, fields: [], remaining: null });
const buttonOf = (h: string, label: string) => h.split("<button").find((b) => b.includes(`>${label}</button>`)) ?? "";

describe("«اكتب بالذكاء الاصطناعي»", () => {
  it("the sheet asks for the note (2000 max) with the privacy line and the tone; the draft fills the fields and pins the AI note; only note, tone and audience are posted", async () => {
    const draft = vi.fn(async () => ({ draft: GOOD, refused: false, remaining: 19 }));
    const h = harness("campaign", { draft });
    h.dispatch({ type: "sheet", open: true });
    let page = h.html();
    expect(page).toContain("ماذا تريد أن تقول؟");
    expect(page).toContain("لا تكتب بيانات عميل هنا (اسم أو بريد أو رقم).");
    expect(page).toMatch(/<textarea[^>]*maxLength="2000"/);
    for (const tone of ["رسمية", "ودّية", "مختصرة"]) expect(page).toContain(tone);
    expect(buttonOf(page, "اكتب المسودة")).toContain("min-h-11");
    expect(page).not.toContain(COMPOSER_AR.aiNote);

    h.dispatch({ type: "note", value: "أخبرهم أن ملفات إكسل أصبحت أسرع" });
    h.dispatch({ type: "tone", value: "مختصرة" });
    await h.ctl.writeDraft();
    expect(draft).toHaveBeenCalledTimes(1);
    expect(draft.mock.calls[0]).toEqual([{ note: "أخبرهم أن ملفات إكسل أصبحت أسرع", tone: "مختصرة", audience: "news_opt_in" }]);
    expect(h.get().fields).toMatchObject({ subject: GOOD.subject, badge: GOOD.badge, heading: GOOD.heading, body: GOOD.body, ctaLabel: GOOD.ctaLabel, withButton: true });
    page = h.html();
    expect(page).toContain("هذه مسودة من الذكاء الاصطناعي. اقرأها وعدّلها قبل الإرسال؛ لن تُرسَل من نفسها.");
    expect(page).toContain(`value="${GOOD.subject}"`);
    expect(page).toContain("المتبقي لك هذه الساعة: ١٩ مسودة.");
  });

  it("a refused draft still fills the fields, marks them, and says the guard sentence", async () => {
    const sentence = "المسودة تحتوي على ما لا يصلح للعميل (أحرف لاتينية أو أسماء مزودين أو أرقام داخلية). عدّلها أو أعد الكتابة.";
    const h = harness("single", { draft: async () => ({ draft: { ...GOOD, subject: "Diger" }, refused: true, fields: ["subject"], error: sentence, remaining: 3 }) });
    h.dispatch({ type: "note", value: "اكتب خبرًا" });
    await h.ctl.writeDraft();
    expect(h.get().fields.subject).toBe("Diger");
    const page = h.html();
    expect(page).toContain(sentence);
    expect(page).toMatch(/<input[^>]*aria-invalid="true"[^>]*value="Diger"/);
  });
});

describe("the test lock: a test counts only for the exact text it was sent with", () => {
  it.each([["subject"], ["badge"], ["heading"], ["body"], ["ctaLabel"]] as const)("after a test the line says it arrived; editing %s clears it", async (key) => {
    const singleTest = vi.fn(async () => ({ messageAr: "أُرسلت نسخة تجريبية إلى بريدك." }));
    const h = harness("single", { draft: vi.fn(), singleTest }, filled("single"));
    expect(h.html()).toContain("لم تُرسَل نسخة تجريبية بهذا النص بعد.");
    await h.ctl.test();
    expect(singleTest).toHaveBeenCalledTimes(1);
    expect(h.html()).toContain("وصلتك نسخة تجريبية في");
    expect(h.html()).toMatch(/role="status"[^>]*>[^<]*وصلتك نسخة تجريبية في/);
    h.dispatch({ type: "field", key, value: `${h.get().fields[key]} أيضًا` });
    expect(h.get().tested).toBeNull();
    expect(h.html()).toContain("لم تُرسَل نسخة تجريبية بهذا النص بعد.");
  });

  it("the name chip inserts {الاسم}, and in single mode the test carries the customer's name in its place", async () => {
    const singleTest = vi.fn(async (_m: unknown) => ({ messageAr: "تم" }));
    const h = harness("single", { draft: vi.fn(), singleTest }, filled("single"));
    h.dispatch({ type: "field", key: "body", value: "مرحبًا" });
    h.dispatch({ type: "insertName", key: "body", at: 0 });
    expect(h.get().fields.body).toBe("{الاسم}مرحبًا");
    expect(h.html()).toContain(">إدراج الاسم</button>");
    await h.ctl.test("منى");
    expect(JSON.stringify(singleTest.mock.calls[0][0])).toContain("منىمرحبًا");
    expect(JSON.stringify(singleTest.mock.calls[0][0])).not.toContain("{الاسم}");
  });
});

describe("«عميل واحد»: the real send is a manual click through the confirm dialog", () => {
  it("the send opens the dialog and sends nothing; cancel sends nothing; confirm sends once", async () => {
    const singleSend = vi.fn(async () => ({ messageAr: "أُرسلت الرسالة." }));
    const h = harness("single", { draft: vi.fn(), singleSend }, filled("single"));
    expect(h.html()).not.toContain('role="dialog"');
    h.ctl.requestSend();
    expect(singleSend).not.toHaveBeenCalled();
    let page = h.html();
    expect(page).toContain('role="dialog"');
    expect(page).toContain("تأكيد إرسال الرسالة");
    expect(page).toContain(RECIPIENT.email);
    h.ctl.cancelSend();
    expect(h.get().confirmOpen).toBe(false);
    await h.ctl.confirmSend();
    expect(singleSend).not.toHaveBeenCalled();
    h.ctl.requestSend();
    await h.ctl.confirmSend();
    expect(singleSend).toHaveBeenCalledTimes(1);
    page = h.html();
    expect(page).not.toContain('role="dialog"');
    expect(page).toContain("أُرسلت الرسالة.");
    for (const f of ["src/components/admin/MessageComposer.tsx", "src/components/admin/CustomerEmailPanel.tsx"]) expect(readFileSync(f, "utf8"), f).not.toMatch(/window\.confirm|confirm\(`/);
  });
});

describe("«حملة»", () => {
  it("the final «راجع ثم أرسل» is disabled with the sentence, even after a test", async () => {
    const h = harness("campaign", {
      draft: vi.fn(),
      saveCampaign: async () => ({ campaign: { id: "11111111-1111-4111-8111-111111111111", revision: 2 } }),
      campaignTest: async () => ({ messageAr: "أُرسلت نسخة تجريبية إلى بريدك." }),
    }, filled("campaign"));
    h.dispatch({ type: "name", value: "تسليم أسرع" });
    await h.ctl.test();
    expect(h.get().campaign).toMatchObject({ id: "11111111-1111-4111-8111-111111111111", revision: 2 });
    const page = h.html();
    expect(page).toContain("وصلتك نسخة تجريبية في");
    const final = buttonOf(page, "راجع ثم أرسل");
    expect(final).toContain('disabled=""');
    const describedBy = final.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(page).toMatch(new RegExp(`id="${describedBy}"[^>]*>إرسال الحملات للعملاء يأتي في التحديث القادم.<`));
  });

  it("storage not ready: the composer and the list say «تخزين الحملات لم يُفعَّل بعد.» and no test is attempted", async () => {
    expect(CAMPAIGNS_NOT_READY_AR).toBe("تخزين الحملات لم يُفعَّل بعد.");
    // the screen recognises the store's own sentence (the 503 body's notReady flag does not survive adminFetch, its message does)
    const q: any = { select: () => q, order: () => q, limit: async () => ({ data: null, error: { code: "42P01" } }) };
    expect(await listCampaigns({ from: () => q })).toMatchObject({ ok: false, code: "not_ready", messageAr: CAMPAIGNS_NOT_READY_AR });
    const campaignTest = vi.fn();
    const h = harness("campaign", { draft: vi.fn(), saveCampaign: async () => { throw Object.assign(new Error("تخزين الحملات لم يُفعَّل بعد."), { status: 503 }); }, campaignTest }, filled("campaign"));
    h.dispatch({ type: "name", value: "تسليم أسرع" });
    await h.ctl.test();
    expect(campaignTest).not.toHaveBeenCalled();
    expect(h.get().notReady).toBe(true);
    expect(h.html()).toContain("تخزين الحملات لم يُفعَّل بعد.");
    expect(renderToStaticMarkup(createElement(CampaignList, { state: { kind: "notReady" }, onOpen: () => {} }))).toContain("تخزين الحملات لم يُفعَّل بعد.");
    expect(renderToStaticMarkup(createElement(CampaignList, { state: { kind: "ready", rows: [] }, onOpen: () => {} }))).toContain(CAMPAIGNS_EMPTY_AR);
    expect(CAMPAIGNS_EMPTY_AR).toBe("لم تُرسل أي رسالة بعد.");
  });
});

describe("the screens carry no emoji and use logical properties", () => {
  const ROW: CampaignLite = { id: "c1", name: "تسليم أسرع", subject: GOOD.subject, badge: "", heading: GOOD.heading, body: GOOD.body, cta_label: "", cta_path: "", status: "draft", revision: 3, test_sent_at: "2026-11-19T09:00:00Z", test_content_hash: "abcd1234", updated_at: "2026-11-19T09:30:00Z" };
  it("no emoji in any rendered state; the list shows the status words and Arabic-Indic dates", () => {
    const states: Array<[ComposerMode, ComposerState]> = [];
    for (const mode of ["single", "campaign"] as const) {
      const base = filled(mode);
      states.push([mode, initialComposerState(mode)], [mode, base], [mode, composerReducer(base, { type: "sheet", open: true })], [mode, composerReducer(base, { type: "confirm", open: true })], [mode, composerReducer(base, { type: "width", value: "phone" })]);
    }
    const pages = states.map(([mode, s]) => renderToStaticMarkup(createElement(ComposerView, { mode, state: s, dispatch: () => {}, ctl: createComposerController(mode, { draft: vi.fn() }, () => s, () => {}), recipient: mode === "single" ? RECIPIENT : undefined })));
    const list = renderToStaticMarkup(createElement(CampaignList, { state: { kind: "ready", rows: [ROW, { ...ROW, id: "c2", status: "ready" }, { ...ROW, id: "c3", status: "sent", test_sent_at: null }] }, onOpen: () => {} }));
    pages.push(list, renderToStaticMarkup(createElement(CustomerEmailPanel, { userId: "u1" })), renderToStaticMarkup(createElement(AdminMessagesPage)));
    for (const p of pages) expect(p).not.toMatch(EMOJI);
    for (const w of ["مسودة", "جاهزة للإرسال", "أُرسلت", "١٩"]) expect(list).toContain(w);
    expect(list).not.toMatch(/>[^<]*[0-9][^<]*</);
    const wide = pages[4];
    expect(wide).toMatch(/<iframe[^>]*sandbox=""[^>]*/);
    expect(wide).toMatch(/<iframe[^>]*title="معاينة الرسالة"/);
    for (const label of ["عرض الجوال", "عرض الحاسوب", "أرسل نسخة تجريبية لي", "إدراج الاسم", "اكتب بالذكاء الاصطناعي"]) expect(wide).toContain(label);
    expect(renderToStaticMarkup(createElement(AdminMessagesPage))).toMatch(/role="tab"[^>]*>رسالة جديدة<[\s\S]*role="tab"[^>]*>الحملات</);
  });

  it("the new and changed files have no emoji, no window.confirm and no physical left/right", () => {
    for (const f of ["src/components/admin/MessageComposer.tsx", "src/components/admin/CustomerEmailPanel.tsx", "src/components/admin/CampaignList.tsx", "src/app/admin/messages/page.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(EMOJI);
      expect(src, f).not.toMatch(/\b(ml|mr|pl|pr|left|right)-[\w[]|text-(left|right)\b|\b(marginLeft|marginRight|paddingLeft|paddingRight)\b|[{,]\s*(left|right):/);
    }
  });
});
