import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as any,
  storageFiles: new Map<string, Buffer>(),
  topupsTable: [] as any[],
  settingsPricing: null as any,
  sent: [] as Array<{ template: string; to: string; vars: Record<string, string>; key?: string }>,
  failEmail: false as false | "throw" | "not_ok",
  // approve / reject
  topup: null as any,
  notifications: [] as any[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async (name: string) =>
      name === "approve_topup_atomic" ? { data: { success: true, credits: 2500, effective_amount_egp: 250, balance: 3000 }, error: null } : { data: { success: true }, error: null }),
    from: vi.fn((table: string) => {
      if (table === "settings_public") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.settingsPricing, error: null }) }) }) };
      if (table === "notifications") return { insert: async (row: any) => { state.notifications.push(row); return { error: null }; } };
      if (table === "admin_audit_log") return { insert: async () => ({ error: null }) };
      if (table === "topups") {
        return {
          select: (_c: string, opts?: { head?: boolean }) => opts?.head
            ? { eq: () => ({ eq: async () => ({ count: 0, error: null }) }) }
            : { eq: (col: string, val: string) => ({
                maybeSingle: async () => ({ data: state.topupsTable.find((t) => t.reference === val) || null, error: null }),
                single: async () => ({ data: col === "id" ? state.topup : null, error: null }),
              }) },
          insert: (row: any) => ({ select: () => ({ single: async () => { state.topupsTable.push(row); return { data: row, error: null }; } }) }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      return {};
    }),
    storage: { from: () => ({ download: async (path: string) => { const buf = state.storageFiles.get(path); return buf ? { data: new Blob([new Uint8Array(buf)]), error: null } : { data: null, error: new Error("nf") }; } }) },
  })),
}));

vi.mock("@/lib/server/sendPlatformEmail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/server/sendPlatformEmail")>()),
  sendPlatformEmail: vi.fn(async (template: string, to: string, vars: Record<string, string>, key?: string) => {
    state.sent.push({ template, to, vars, key });
    if (state.failEmail === "throw") throw new Error("function unavailable");
    if (state.failEmail === "not_ok") return { ok: false, reason: "function_unavailable" };
    return { ok: true };
  }),
  getRecipient: vi.fn(async () => ({ email: "customer@example.test", name: "منى السيد" })),
}));
vi.mock("@/lib/supabase/ledger", () => ({ applyTopup: vi.fn(), getBalance: vi.fn(async () => 3000) }));

import { PLATFORM_EMAIL_SUBJECTS, renderEmailTemplate, type PlatformEmailTemplateId } from "../supabase/functions/send-email/templates";
import { notifyOwnerOfTopup, buildTopupAlertTemplateVars, buildTopupAlertVars } from "../src/lib/server/topupOwnerAlert";
import { isEmailPreferenceEnabled, TEMPLATE_CATEGORY_MAP } from "../src/lib/server/sendPlatformEmail";
import { TOPUP_REVIEW_DEFAULT_AR, topupReviewSentenceAr } from "../src/lib/topupConfig";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
/** What a person reads: no tags, no style block, no comments. */
const visibleText = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/&[#\w]+;/g, " ").replace(/\s+/g, " ").trim();
const LATIN_DIGIT = /[0-9]/;
const INTERNAL_ID = /rcpt_|[0-9a-f]{24,}/i;

const userId = "usr_000000000001";
beforeEach(() => {
  vi.clearAllMocks();
  state.user = { id: userId, email: "customer@example.test", email_confirmed_at: "2026-10-14T00:00:00Z", user_metadata: { full_name: "منى السيد", email_verified: true } };
  state.storageFiles.clear(); state.topupsTable = []; state.sent = []; state.failEmail = false; state.notifications = [];
  state.settingsPricing = { key: "pricing", value: { ipa: "iammagdy", maxPendingTopups: 3, creditValueEgp: 0.1 } };
  state.topup = { id: "tp_1", user_id: "u1", amount_egp: 100, reference: "rcpt_9f2c4e7a1b3d5f60718293a4b5c6d7e8", status: "pending" };
  vi.stubEnv("ADMIN_ALERT_EMAIL", "");
});

async function submitTopup(amountEgp: number) {
  const { POST } = await import("@/app/api/topup/submit/route");
  const receiptFileId = `${userId}/${Math.random().toString(36).slice(2)}.png`;
  state.storageFiles.set(receiptFileId, Buffer.from(`receipt-${receiptFileId}`));
  const res = await POST(new NextRequest("http://localhost:3000/api/topup/submit", { method: "POST", body: JSON.stringify({ amountEgp, receiptFileId }) }));
  return { status: res.status, body: await res.json() };
}
async function review(action: "approve" | "reject") {
  const { POST } = await import("@/app/api/admin/topups/approve/route");
  state.user = { id: "admin-1", email: "admin@example.test", app_metadata: { role: "admin" } };
  const body = action === "approve" ? { topupId: "tp_1", action } : { topupId: "tp_1", action, rejectReason: "الإيصال غير واضح" };
  const res = await POST(new NextRequest("http://localhost:3000/api/admin/topups/approve", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
const sentTo = (template: string) => state.sent.filter((mail) => mail.template === template);

describe("A. the customer's «استلمنا طلب الشحن» e-mail", () => {
  it("(a) subject and body use Arabic-Indic digits only", async () => {
    expect((await submitTopup(100)).status).toBe(200);
    const [mail] = sentTo("topup-received");
    expect(mail.vars).toMatchObject({ AmountEgp: "١٠٠", Credits: "١٠٠٠" });
    expect(mail.vars.CreatedAt).toMatch(/^[٠-٩]{1,2} \S+ [٠-٩]{4}$/);
    const { subject, html } = renderEmailTemplate("topup-received", mail.vars);
    expect(subject).toBe("استلمنا طلب شحن ١٠٠ ج.م");
    expect(subject).not.toMatch(LATIN_DIGIT);
    expect(visibleText(html)).not.toMatch(LATIN_DIGIT);
    expect(visibleText(html)).toContain("١٠٠ ج.م");
    expect(visibleText(html)).toContain("١٠٠٠ نقطة");
  });

  it("(a) a fractional amount keeps the Arabic decimal mark and the points are the exact whole number (123.5 EGP is 1235 points)", async () => {
    expect((await submitTopup(123.5)).status).toBe(200);
    const [mail] = sentTo("topup-received");
    expect(mail.vars.AmountEgp).toBe("١٢٣٫٥");
    expect(mail.vars.Credits).toBe("١٢٣٥");
    expect(renderEmailTemplate("topup-received", mail.vars).subject).toBe("استلمنا طلب شحن ١٢٣٫٥ ج.م");
  });

  it("(b) no receipt id: it is not sent, and the template has no reference row", async () => {
    await submitTopup(100);
    const [mail] = sentTo("topup-received");
    expect(Object.keys(mail.vars)).not.toContain("Reference");
    expect(JSON.stringify(mail)).not.toMatch(INTERNAL_ID);
    const { subject, html } = renderEmailTemplate("topup-received", mail.vars);
    expect(subject + html).not.toMatch(INTERNAL_ID);
    expect(visibleText(html)).not.toContain("الرقم المرجعي");
    expect(visibleText(html)).not.toContain("المرجع");
  });

  it("(c) the body carries the very sentence of the top-up page, and not «عادةً خلال ساعات العمل»", async () => {
    await submitTopup(100);
    const [mail] = sentTo("topup-received");
    expect(mail.vars.ReviewNote).toBe(TOPUP_REVIEW_DEFAULT_AR);
    expect(mail.vars.ReviewNote).toBe("غالبًا يتم الاعتماد خلال ١٥ دقيقة، وبحد أقصى ٢٤ ساعة، وتصلك رسالة عند إضافة النقاط.");
    const text = visibleText(renderEmailTemplate("topup-received", mail.vars).html);
    expect(text).toContain(TOPUP_REVIEW_DEFAULT_AR);
    expect(text).not.toContain("عادةً خلال ساعات العمل");
    expect(text).not.toContain("ساعات العمل");
  });

  it("(c) when the owner configured a review time, the e-mail follows the page (one source: topupReviewSentenceAr)", async () => {
    state.settingsPricing = { key: "pricing", value: { ipa: "iammagdy", creditValueEgp: 0.1, reviewTimeAr: " خلال ٣٠ دقيقة " } };
    await submitTopup(100);
    expect(sentTo("topup-received")[0].vars.ReviewNote).toBe(topupReviewSentenceAr("خلال ٣٠ دقيقة"));
  });

  it("an e-mail that throws, or answers not ok, never blocks or fails the top-up request", async () => {
    for (const mode of ["throw", "not_ok"] as const) {
      state.failEmail = mode;
      const { status, body } = await submitTopup(100);
      expect(status, mode).toBe(200);
      expect(body.success).toBe(true);
    }
    expect(state.topupsTable).toHaveLength(2);
  });
});

describe("the approved and rejected e-mails", () => {
  it("approved: Arabic-Indic digits, no receipt id, and the in-app text is untouched", async () => {
    expect((await review("approve")).status).toBe(200);
    const [mail] = sentTo("topup-approved");
    expect(mail.vars).toEqual({ Name: "منى السيد", Credits: "٢٥٠٠", ConfirmedAmountEgp: "٢٥٠", Balance: "٣٠٠٠" });
    expect(mail.key).toBe("topup-approved:tp_1");
    const { subject, html } = renderEmailTemplate("topup-approved", mail.vars);
    expect(subject).toBe("أُضيف ٢٥٠٠ نقطة إلى رصيدك");
    expect(subject + visibleText(html)).not.toMatch(LATIN_DIGIT);
    expect(subject + html + JSON.stringify(mail)).not.toMatch(INTERNAL_ID);
    expect(visibleText(html)).not.toContain("المرجع");
  });

  it("rejected: Arabic-Indic digits, no receipt id in the e-mail, and none in the notification the customer sees", async () => {
    expect((await review("reject")).status).toBe(200);
    const [mail] = sentTo("topup-rejected");
    expect(mail.vars).toEqual({ Name: "منى السيد", AmountEgp: "١٠٠", RejectReason: "الإيصال غير واضح" });
    const { subject, html } = renderEmailTemplate("topup-rejected", mail.vars);
    expect(subject + visibleText(html)).not.toMatch(LATIN_DIGIT);
    expect(subject + html + JSON.stringify(mail)).not.toMatch(INTERNAL_ID);
    expect(visibleText(html)).toContain("الإيصال غير واضح");
    expect(visibleText(html)).not.toContain("المرجع");
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0].body).toBe("تم رفض طلب الشحن. السبب: الإيصال غير واضح");
    expect(JSON.stringify(state.notifications[0])).not.toMatch(INTERNAL_ID);
  });

  it("a failing e-mail never blocks an approval or a rejection", async () => {
    for (const action of ["approve", "reject"] as const) {
      state.failEmail = "throw";
      const { status, body } = await review(action);
      expect(status, action).toBe(200);
      expect(body.success).toBe(true);
    }
    expect(state.notifications.length).toBe(2);
  });
});

describe("the refund e-mails use Arabic-Indic digits too", () => {
  it("the stalled-job and failed-job refund e-mails send their points and balance through toArabicDigits", () => {
    for (const file of ["src/app/api/cron/watchdog/route.ts", "src/app/api/worker/chunk/route.ts"]) {
      const code = src(file);
      const block = code.slice(code.indexOf('sendPlatformEmail("refund"'), code.indexOf('sendPlatformEmail("refund"') + 700);
      expect(block, file).toContain("Points: toArabicDigits(Math.round(releasedCredits))");
      expect(block, file).toContain("Balance: toArabicDigits(balance)");
      expect(block, file).not.toMatch(/String\(/);
    }
    const { subject, html } = renderEmailTemplate("refund", { Name: "سلمى", Points: "٢٠٧", JobTitle: "طلبك", Reason: "سبب", Balance: "٥١٢٣" });
    expect(subject).toBe("حجز مؤقت مُحرَّر بقيمة ٢٠٧ نقطة");
    expect(visibleText(html)).not.toMatch(LATIN_DIGIT);
  });
});

describe("B. the admin alert e-mail", () => {
  const input = { topupId: "topup_abc", customerName: "منى السيد", customerEmail: "customer@example.test", points: 2500, amountEgp: 250, createdAt: "2026-10-25T10:00:00Z" };

  it("is right-to-left and right-aligned on the card, with a label/value table and the approval button", () => {
    const { subject, html } = renderEmailTemplate("admin-topup-alert", buildTopupAlertTemplateVars(input));
    expect(subject).toBe("طلب شحن جديد: ٢٥٠٠ نقطة");
    const body = html.slice(html.indexOf("<body"));
    expect(body).toContain('<body dir="rtl"');
    expect(body).toMatch(/<td class="card" dir="rtl" align="right"[^>]*text-align:right/);
    expect(body).toContain('<table role="presentation" dir="rtl" width="100%"');
    // every row: label then value, in the order the owner asked for
    const rows = [...body.matchAll(/<tr><td style="[^"]*" width="38%">([^<]+)<\/td><td dir="(rtl|ltr)" style="[^"]*text-align:(right|left)">([^<]*)<\/td><\/tr>/g)].map((m) => [m[1], m[4], m[2]]);
    expect(rows).toEqual([
      ["اسم العميل", "منى السيد", "rtl"],
      ["بريد العميل", "customer@example.test", "ltr"],
      ["النقاط", "٢٥٠٠ نقطة", "rtl"],
      ["المبلغ المتوقع", "٢٥٠ ج.م", "rtl"],
      ["وقت الطلب", "٢٥ أكتوبر ٢٠٢٦ في ١:٠٠ م", "rtl"],
    ]);
    expect(body).toContain('href="https://diger.tech/admin/topups"');
    expect(visibleText(html)).toContain("افتح صفحة الاعتماد");
    expect(visibleText(html)).toContain("طلب شحن جديد بانتظار الاعتماد");
  });

  it("Arabic-Indic digits in subject and body; no receipt, no token, no secret; values are escaped", () => {
    const { subject, html } = renderEmailTemplate("admin-topup-alert", { ...buildTopupAlertTemplateVars(input), CustomerName: "<b>منى</b>" });
    expect(subject).not.toMatch(LATIN_DIGIT);
    expect(visibleText(html)).not.toMatch(LATIN_DIGIT);
    expect(html).toContain("&lt;b&gt;منى&lt;/b&gt;");
    expect(html).not.toContain("<b>منى</b>");
    expect(html).not.toMatch(/token|secret|receipt|rcpt_|[?&]id=|Bearer|service_role/i);
    expect(html).not.toContain("{{");
  });

  it("its footer says what the e-mail is, not the customer's «you enabled e-mail notifications»", () => {
    const { html } = renderEmailTemplate("admin-topup-alert", buildTopupAlertTemplateVars(input));
    const text = visibleText(html);
    expect(text).toContain("تنبيه داخلي للإدارة: يصل هذا البريد عند وصول كل طلب شحن جديد.");
    expect(text).not.toContain("فعّلت إشعارات البريد");
    expect(text).not.toContain("غيّر تفضيلاتك");
  });

  it("the app can send it, the function accepts it, and no customer preference can switch it off", () => {
    expect(src("supabase/functions/send-email/index.ts")).toContain('"admin-topup-alert",');
    expect(TEMPLATE_CATEGORY_MAP["admin-topup-alert"]).toBeNull();
    expect(isEmailPreferenceEnabled("admin-topup-alert", { prefs: { notif: { topup: false, done: false } } })).toBe(true);
  });

  it("while the live function does not know the template, the previous layout goes out instead: still ONE e-mail, same key", async () => {
    const env = { ADMIN_ALERT_EMAIL: "o@x.test" };
    const send = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "invalid_request" })
      .mockResolvedValueOnce({ ok: true });
    expect(await notifyOwnerOfTopup(input, { send: send as never, env })).toEqual({ sent: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, "admin-topup-alert", "o@x.test", buildTopupAlertTemplateVars(input), "topup-alert:topup_abc");
    expect(send).toHaveBeenNthCalledWith(2, "job-update", "o@x.test", buildTopupAlertVars(input), "topup-alert:topup_abc");
  });

  it("any other failure is not retried with another layout (no duplicate), and a failure of both is only «failed»", async () => {
    const env = { ADMIN_ALERT_EMAIL: "o@x.test" };
    for (const reason of ["timeout", "resend_rejected", "function_unavailable", "network_error"]) {
      const send = vi.fn().mockResolvedValue({ ok: false, reason });
      expect(await notifyOwnerOfTopup(input, { send: send as never, env }), reason).toEqual({ sent: false, reason: "failed" });
      expect(send, reason).toHaveBeenCalledTimes(1);
    }
    const both = vi.fn().mockResolvedValue({ ok: false, reason: "invalid_request" });
    expect(await notifyOwnerOfTopup(input, { send: both as never, env })).toEqual({ sent: false, reason: "failed" });
    expect(both).toHaveBeenCalledTimes(2);
    const boom = vi.fn().mockRejectedValue(new Error("x"));
    expect(await notifyOwnerOfTopup(input, { send: boom as never, env })).toEqual({ sent: false, reason: "failed" });
  });

  it("through the route: the alert is sent once with the new template and never blocks the request", async () => {
    vi.stubEnv("ADMIN_ALERT_EMAIL", "owner@example.test");
    const { status, body } = await submitTopup(250);
    expect(status).toBe(200);
    const alerts = sentTo("admin-topup-alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].to).toBe("owner@example.test");
    expect(alerts[0].key).toBe(`topup-alert:${body.topupId}`);
    expect(alerts[0].vars).toMatchObject({ Points: "٢٥٠٠", AmountEgp: "٢٥٠", CustomerName: "منى السيد", CustomerEmail: "customer@example.test", AdminURL: "https://diger.tech/admin/topups" });
    state.failEmail = "throw";
    expect((await submitTopup(250)).status).toBe(200);
  });
});

describe("C. every template of the Edge Function", () => {
  const ids = Object.keys(PLATFORM_EMAIL_SUBJECTS) as PlatformEmailTemplateId[];
  const sample: Record<string, string> = {
    Name: "منى", AmountEgp: "١٠٠", Credits: "١٠٠٠", ReviewNote: TOPUP_REVIEW_DEFAULT_AR, CreatedAt: "١٣ أكتوبر ٢٠٢٦", ConfirmedAmountEgp: "٢٥٠", Balance: "٣٠٠٠",
    RejectReason: "الإيصال غير واضح", JobTitle: "طلبك", JobURL: "https://diger.tech/dashboard/requests", Delivered: "١٠", Requested: "١٠٠", Charged: "٨٠", Refunded: "٢٠",
    Points: "٢٠", Reason: "سبب", Subject: "تحديث", Heading: "عنوان", Lead: "نص", DetailOne: "تفصيل", DetailTwo: "تفصيل", ButtonLabel: "زر",
    CustomerName: "منى", CustomerEmail: "m@x.test", RequestTime: "١٣ أكتوبر ٢٠٢٦", AdminURL: "https://diger.tech/admin/topups",
  };

  it("each one is right-to-left on an element inside the body (clients drop the attributes of <html>) and right-aligned", () => {
    for (const id of ids) {
      const { html } = renderEmailTemplate(id, sample);
      const body = html.slice(html.indexOf("<body"));
      expect(body, `${id} dir`).toContain('dir="rtl"');
      expect(body, `${id} align`).toMatch(/text-align:right/);
      expect(html, `${id} tokens`).not.toContain("{{");
    }
  });

  it("no template shows a reference or receipt id any more, and none renders a Latin digit when it is given Arabic-Indic ones", () => {
    expect(src("supabase/functions/send-email/templates.ts")).not.toContain(".Reference");
    for (const id of ids) {
      const { subject, html } = renderEmailTemplate(id, sample);
      expect(subject + html, id).not.toMatch(INTERNAL_ID);
      expect(visibleText(html) + subject, id).not.toMatch(LATIN_DIGIT);
    }
  });
});
