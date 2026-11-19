import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SegmentChips } from "../src/components/admin/ui";
import { GrantConfirmDialog, SuspendDialog, UserActionsRow, UserTabPanel, type UserDetail } from "../src/components/admin/UserSheet";
import { USER_TABS, createGrantFlow, createSuspendFlow, runningMissionsCount, runningNoteAr, suspendControlOf, userBadges, type UserMissionItem } from "../src/components/admin/userSheetLogic";

/**
 * DT-20261118-06 phase 1B: the rebuilt profile. The environment is node (no DOM library is installed and none may be added), so the behaviour lives in small pure flows
 * (grant and suspend) that the sheet calls, and each piece of markup is checked as rendered HTML.
 */
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const noop = () => {};
const buttonOf = (h: string, label: string) => h.split("<button").find((b) => b.includes(`>${label}</button>`)) ?? "";

const user: UserDetail = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "مها أحمد", email: "maha@example.com", registration: "2026-11-03T08:42:00Z", lastLogin: "2026-11-19T11:00:00Z",
  balance: 340, totalTopupsEgp: 1200, lastTopupAt: "2026-11-10T10:00:00Z", jobs: 12, lastJobAt: "2026-11-18T10:00:00Z", promo: { used: false, codes: [] },
  topups: [{ id: "t1", amountEgp: 1200, status: "approved", createdAt: "2026-11-10T10:00:00Z" }],
  history: [{ id: "h1", at: "2026-11-10T10:00:00Z", kind: "topup_instapay", kindAr: "شحن عبر انستاباي", amount: 340, runningBalance: 340, note: "", grantedBy: null, jobId: null }],
};
const missions: UserMissionItem[] = [
  { id: "msn_a", created_at: "2026-11-18T10:00:00Z", status: "completed", request: "تغريدات عن الغسل الأخضر", delivered: 80, asked: 100, charged_points: 400 },
  { id: "msn_b", created_at: "2026-11-19T09:00:00Z", status: "executing", request: "تعليقات فيسبوك", delivered: null, asked: 200, charged_points: null },
  { id: "msn_c", created_at: "2026-11-19T10:00:00Z", status: "planning", request: "بحث عن مطاعم", delivered: null, asked: 0, charged_points: null },
];
const panel = (tab: (typeof USER_TABS)[number][0]) => html(createElement(UserTabPanel, {
  tab, u: user, missions: { rows: missions, error: "" }, onRetryMissions: noop, ledgerShown: 30, onMoreLedger: noop,
  grantForm: createElement("p", null, "GRANT-SLOT"), messages: createElement("p", null, "MESSAGES-SLOT"), actions: createElement("p", null, "ACTIONS-SLOT"),
}));

describe("the profile's tabs", () => {
  it("are ملخص · الرصيد · المهام · الشحن · الرسائل · إجراءات, and each shows only its own content", () => {
    expect(USER_TABS.map(([, label]) => label)).toEqual(["ملخص", "الرصيد", "المهام", "الشحن", "الرسائل", "إجراءات"]);
    const own: Record<string, string> = { summary: "تاريخ التسجيل", balance: "سجل الرصيد الكامل", missions: "تغريدات عن الغسل الأخضر", topups: "١٬٢٠٠ ج.م", messages: "MESSAGES-SLOT", actions: "ACTIONS-SLOT" };
    for (const [tab] of USER_TABS) {
      const h = text(panel(tab));
      for (const [other, marker] of Object.entries(own)) expect(h.includes(marker), `${tab} shows ${other}`).toBe(other === tab);
    }
    expect(text(panel("balance"))).toContain("GRANT-SLOT");
  });

  it("the missions tab shows delivered of asked and the points charged, with Arabic-Indic digits", () => {
    const h = text(panel("missions"));
    expect(h).toContain("سُلِّم ٨٠ من ١٠٠");
    expect(h).toContain("٤٠٠ نقطة");
    expect(h).not.toMatch(/[0-9]{2,}/);
  });

  it("the header badges: نشط الآن / خامل / موقوف / حساب أعمال موثّق", () => {
    const now = Date.parse("2026-11-19T11:30:00Z");
    expect(userBadges({ lastLogin: "2026-11-19T11:00:00Z", suspended: false, verified: true, now }).map((b) => b.label)).toEqual(["نشط الآن", "حساب أعمال موثّق"]);
    expect(userBadges({ lastLogin: "2026-09-01T00:00:00Z", suspended: true, verified: false, now }).map((b) => b.label)).toEqual(["موقوف", "خامل"]);
    expect(userBadges({ lastLogin: null, suspended: false, verified: false, now }).map((b) => b.label)).toEqual(["خامل"]);
    expect(userBadges({ lastLogin: "2026-11-10T00:00:00Z", suspended: false, verified: false, now })).toEqual([]);
  });
});

describe("«أضف رصيدًا»: never one tap", () => {
  const ids = () => { let n = 0; return () => `req-${++n}`; };

  it("needs a reason of 3 characters and a whole number of points; reviewing posts nothing; cancel changes nothing", () => {
    const post = vi.fn(async () => ({ messageAr: "ok" }));
    const flow = createGrantFlow({ post, newId: ids() });
    expect(flow.review("100", "ab")).toMatchObject({ ok: false });
    expect(flow.review("", "تعويض عن مشكلة")).toMatchObject({ ok: false });
    expect(flow.review("١٫٥", "تعويض عن مشكلة")).toMatchObject({ ok: false });
    expect(flow.review("١٥٠", "تعويض عن مشكلة")).toEqual({ ok: true, body: { points: "150", note: "تعويض عن مشكلة", requestId: "req-1" } });
    flow.cancel();
    expect(flow.pending).toBeNull();
    expect(flow.confirm()).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("a double tap on confirm grants once with one requestId; the next review gets a new id; a failed try keeps its id for the retry", async () => {
    let release!: (v: { messageAr: string }) => void;
    const post = vi.fn(() => new Promise<{ messageAr: string }>((r) => { release = r; }));
    const flow = createGrantFlow({ post, newId: ids() });
    flow.review("150", "تعويض عن مشكلة");
    const first = flow.confirm();
    const second = flow.confirm();
    expect(second).toBe(first);
    release({ messageAr: "أُضيفت ١٥٠ نقطة." });
    expect(await first).toEqual({ ok: true, messageAr: "أُضيفت ١٥٠ نقطة." });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ points: "150", note: "تعويض عن مشكلة", requestId: "req-1" });
    expect(flow.pending).toBeNull();

    const failing = vi.fn(async () => { throw new Error("انقطع الاتصال"); });
    const again = createGrantFlow({ post: failing, newId: ids() });
    again.review("20", "هدية ترحيب");
    expect(await again.confirm()).toEqual({ ok: false, errorAr: "انقطع الاتصال" });
    expect(again.review("20", "هدية ترحيب")).toMatchObject({ ok: true, body: { requestId: "req-1" } });
    expect(flow.review("10", "هدية أخرى")).toMatchObject({ ok: true, body: { requestId: "req-2" } });
  });

  it("the confirm dialog says the number, the name and the current balance (spec §5.4), and the button is busy while it runs", () => {
    const h = html(createElement(GrantConfirmDialog, { open: true, points: "150", name: "مها أحمد", balance: 340, working: false, error: null, onConfirm: noop, onCancel: noop }));
    expect(h).toContain("تأكيد إضافة الرصيد");
    expect(text(h)).toContain("ستُضاف ١٥٠ نقطة إلى رصيد مها أحمد. رصيده الحالي ٣٤٠ نقطة.");
    expect(h).toContain("تُسجَّل الحركة باسمك في سجل الرصيد وفي سجل العمليات، ولا تُحذف. الخطأ لا يُصحَّح إلا بحركة جديدة.");
    expect(buttonOf(h, "أؤكد الإضافة")).not.toContain('disabled=""');
    const busy = html(createElement(GrantConfirmDialog, { open: true, points: "150", name: "مها أحمد", balance: 340, working: true, error: null, onConfirm: noop, onCancel: noop }));
    expect(buttonOf(busy, "جارٍ الإضافة…")).toContain('disabled=""');
  });
});

describe("«أوقف الحساب» / «أعد تفعيل الحساب»", () => {
  it("the dialog asks for a duration and a reason and says honestly how many missions are running (from the missions tab rows)", () => {
    const running = runningMissionsCount(missions);
    expect(running).toBe(2);
    expect(runningNoteAr(running)).toBe("لدى العميل ٢ مهام قيد التنفيذ؛ الإيقاف لا يلغيها ولا يلمس أي حجز.");
    const h = html(createElement(SuspendDialog, { open: true, mode: "suspend", reason: "", onReason: noop, duration: "7d", onDuration: noop, running, working: false, error: null, onConfirm: noop, onCancel: noop }));
    const t = text(h);
    for (const s of ["أوقف الحساب", "مدة الإيقاف", "٧ أيام", "٣٠ يومًا", "حتى أعيد التفعيل", "سبب الإيقاف", "لدى العميل ٢ مهام قيد التنفيذ؛ الإيقاف لا يلغيها ولا يلمس أي حجز."]) expect(t).toContain(s);
    const back = text(html(createElement(SuspendDialog, { open: true, mode: "reactivate", reason: "تمت المراجعة", onReason: noop, duration: "7d", onDuration: noop, running, working: false, error: null, onConfirm: noop, onCancel: noop })));
    expect(back).toContain("أعد تفعيل الحساب");
    expect(back).not.toContain("مدة الإيقاف");
  });

  it("a reason under 3 characters posts nothing; a good one posts the route's exact body, once even on a double tap", async () => {
    const post = vi.fn(async () => ({ suspended: true, bannedUntil: "2026-12-19T00:00:00Z" }));
    const flow = createSuspendFlow(post);
    expect(await flow.submit({ action: "suspend", duration: "30d", reason: "ab" })).toEqual({ ok: false, errorAr: "اكتب سبب الإجراء (٣ أحرف على الأقل)." });
    expect(post).not.toHaveBeenCalled();
    const a = flow.submit({ action: "suspend", duration: "30d", reason: " إساءة استخدام " });
    const b = flow.submit({ action: "suspend", duration: "30d", reason: " إساءة استخدام " });
    expect(b).toBe(a);
    expect(await a).toEqual({ ok: true, suspended: true, bannedUntil: "2026-12-19T00:00:00Z" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ action: "suspend", duration: "30d", reason: "إساءة استخدام" });
  });

  it("reactivate posts {action: reactivate, reason}", async () => {
    const post = vi.fn(async () => ({ suspended: false, bannedUntil: null }));
    expect(await createSuspendFlow(post).submit({ action: "reactivate", reason: "تمت المراجعة" })).toEqual({ ok: true, suspended: false, bannedUntil: null });
    expect(post).toHaveBeenCalledWith({ action: "reactivate", reason: "تمت المراجعة" });
  });

  it("the actions row: راسل, أضف رصيدًا and the account action; none on the admin's own profile; behind «⋯» on a phone", () => {
    const row = (suspend: ReturnType<typeof suspendControlOf>, phone = false, moreOpen = false) => text(html(createElement(UserActionsRow, { phone, suspend, moreOpen, onToggleMore: noop, onMessage: noop, onGrant: noop, onSuspend: noop, onReactivate: noop })));
    expect(suspendControlOf({ suspended: false, self: true })).toBeNull();
    expect(suspendControlOf(null)).toBeNull();
    const own = row(suspendControlOf({ suspended: false, self: true }));
    expect(own).toContain("راسل");
    expect(own).toContain("أضف رصيدًا");
    expect(own).not.toContain("أوقف الحساب");
    expect(own).not.toContain("أعد تفعيل الحساب");
    expect(own).not.toContain("⋯");
    expect(row(suspendControlOf({ suspended: false, self: false }))).toContain("أوقف الحساب");
    expect(row(suspendControlOf({ suspended: true, self: false }))).toContain("أعد تفعيل الحساب");
    const phoneClosed = row(suspendControlOf({ suspended: false, self: false }), true, false);
    expect(phoneClosed).toContain("⋯");
    expect(phoneClosed).not.toContain("أوقف الحساب");
    expect(row(suspendControlOf({ suspended: false, self: false }), true, true)).toContain("أوقف الحساب");
  });
});

describe("the users page", () => {
  it("SegmentChips: a scrolling tab list with Arabic-Indic counts and the selected chip marked", () => {
    const h = html(createElement(SegmentChips, { label: "شرائح المستخدمين", items: [["all", "الكل"], ["low", "رصيد منخفض"]], value: "low", counts: { all: 810, low: 23 }, onChange: noop }));
    expect(h).toMatch(/role="tablist"/);
    expect(h).toContain("overflow-x-auto");
    expect(text(h)).toContain("الكل ٨١٠");
    expect(text(h)).toContain("رصيد منخفض ٢٣");
    expect(h).toMatch(/aria-selected="true"[^>]*>رصيد منخفض/);
    expect(h).toMatch(/aria-selected="false"[^>]*>الكل/);
    expect(h).toContain("min-h-11");
  });

  it("uses the chips, the sort, the «موقوف» badge and the scan note; closing a profile only closes it (search and chip stay)", () => {
    const page = readFileSync("src/app/admin/users/page.tsx", "utf8");
    for (const s of ["<SegmentChips", "USER_SEGMENTS", "USER_SORTS", "ترتيب حسب", "موقوف", "USERS_SCAN_LIMITED_AR", "pageSize=", "&sort="]) expect(page).toContain(s);
    expect(page).toContain("onClose={() => setOpen(null)}");
  });

  it("no emoji and logical edges only in the new and rebuilt files; e-mails in <bdi dir=\"ltr\">", () => {
    for (const f of ["src/components/admin/UserSheet.tsx", "src/components/admin/userSheetLogic.ts", "src/app/admin/users/page.tsx", "src/components/admin/ui.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(src, f).not.toMatch(/\b(ml|mr|pl|pr|left|right)-[\w[]|text-(left|right)\b|\b(marginLeft|marginRight|paddingLeft|paddingRight)\b|[{,]\s*(left|right):/);
    }
    expect(readFileSync("src/components/admin/UserSheet.tsx", "utf8")).toMatch(/<bdi dir="ltr"[^>]*>\{u\?\.email\}/);
    expect(readFileSync("src/app/admin/users/page.tsx", "utf8")).toMatch(/<bdi dir="ltr"[^>]*>\{u\.email\}/);
  });
});
