import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  user: null as any,
  storageFiles: new Map<string, Buffer>(),
  topupsTable: [] as any[],
  settingsPricing: null as any,
  sent: [] as Array<{ template: string; to: string; vars: Record<string, string>; key?: string }>,
  failAlert: false as false | "throw" | "not_ok",
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: mockState.user }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "settings_public") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mockState.settingsPricing, error: null }) }) }) };
      if (table === "topups") {
        return {
          select: (_c: string, opts?: { head?: boolean }) => opts?.head
            ? { eq: () => ({ eq: async () => ({ count: 0, error: null }) }) }
            : { eq: (_col: string, val: string) => ({ maybeSingle: async () => ({ data: mockState.topupsTable.find((t) => t.reference === val) || null, error: null }) }) },
          insert: (row: any) => ({ select: () => ({ single: async () => { mockState.topupsTable.push(row); return { data: row, error: null }; } }) }),
        };
      }
      return {};
    }),
    storage: { from: () => ({ download: async (path: string) => { const buf = mockState.storageFiles.get(path); return buf ? { data: new Blob([new Uint8Array(buf)]), error: null } : { data: null, error: new Error("nf") }; } }) },
  })),
}));

vi.mock("@/lib/server/sendPlatformEmail", () => ({
  sendPlatformEmail: vi.fn(async (template: string, to: string, vars: Record<string, string>, key?: string) => {
    mockState.sent.push({ template, to, vars, key });
    if (template === "job-update" && mockState.failAlert === "throw") throw new Error("function unavailable");
    if (template === "job-update" && mockState.failAlert === "not_ok") return { ok: false, reason: "function_unavailable" };
    return { ok: true };
  }),
  resolveDisplayName: vi.fn((u: any) => u?.user_metadata?.full_name || u?.email?.split("@")[0] || "عميل"),
  formatArabicDate: vi.fn(() => "١٤ أكتوبر ٢٠٢٦"),
  isEmailPreferenceEnabled: vi.fn(() => true),
}));
vi.mock("../src/hooks/useUser", () => ({ useUser: () => ({ user: { id: "u1", email: "a@b.test", user_metadata: {} }, loading: false }) }));
vi.mock("../src/lib/supabase/client", () => ({ createClient: () => ({}) }));

import TopupForm from "../src/app/dashboard/topup/TopupForm";
import { buildTopupAlertVars, notifyOwnerOfTopup, ownerAlertRecipient, OWNER_ALERT_ENV } from "../src/lib/server/topupOwnerAlert";
import { TOPUP_DEFAULT_POINTS, TOPUP_MAX_POINTS, TOPUP_MIN_POINTS, TOPUP_PRESET_POINTS } from "../src/lib/topupConfig";
import { egpClipboardText, egpDueAr, egpToPoints, parseTopupPointsInput, pointsToEgp, topupAmountMessageAr, validateSubmittedEgp, validateTopupPoints } from "../src/lib/topupAmount";
import { TOPUP_ERROR_MESSAGES } from "../src/lib/topupErrors";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const form = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(TopupForm, { creditValue: 0.1, ipa: "iammagdy", onSubmitted: () => {}, pendingCount: 0, maxPending: 3, ...props } as never));

describe("A. the amounts: presets, default, the free amount", () => {
  it("the presets are 1000, 2500, 5000 and 10000 points, the default is 2500, the 500 preset is gone", () => {
    expect([...TOPUP_PRESET_POINTS]).toEqual([1000, 2500, 5000, 10000]);
    expect(TOPUP_DEFAULT_POINTS).toBe(2500);
    const html = form();
    const presets = html.slice(html.indexOf('data-testid="topup-presets"'), html.indexOf('data-testid="topup-custom"'));
    for (const text of ["١٬٠٠٠", "٢٬٥٠٠", "٥٬٠٠٠", "١٠٬٠٠٠"]) expect(presets, text).toContain(text);
    expect(presets.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(/aria-pressed="true"[^>]*>(?:(?!<button)[\s\S])*٢٬٥٠٠/.test(presets)).toBe(true); // the pressed one is 2,500
    expect(presets).not.toMatch(/>٥٠٠</); // no 500-point preset
    expect(html).toContain('data-testid="topup-custom"');
    expect(html).toContain("أخرى");
  });

  it("the free amount takes Arabic or Latin digits, integers only, and shows Arabic-Indic digits", () => {
    expect(parseTopupPointsInput("٢٥٠٠")).toBe(2500);
    expect(parseTopupPointsInput("2500")).toBe(2500);
    expect(parseTopupPointsInput("٢٬٥٠٠")).toBe(2500);
    expect(parseTopupPointsInput("2,500")).toBe(2500);
    expect(parseTopupPointsInput(" 1 2 3 ")).toBe(123);
    expect(parseTopupPointsInput("12abc")).toBe(12);
    expect(parseTopupPointsInput("١٫٥")).toBe(1); // a decimal mark ends the number: integers only
    expect(parseTopupPointsInput("1.5")).toBe(1);
    expect(parseTopupPointsInput("-5")).toBe(5);
    for (const empty of ["", "abc", "   ", "٫"]) expect(parseTopupPointsInput(empty)).toBeNull();
    expect(parseTopupPointsInput("99999999999")).toBe(9999999); // seven digits at most
  });
});

describe("B. minimum and maximum, on the screen and on the server", () => {
  it("the limits are constants of the top-up config: 1000 points (100 EGP) to 100000 points", () => {
    expect(TOPUP_MIN_POINTS).toBe(1000);
    expect(TOPUP_MAX_POINTS).toBe(100000);
    expect(validateTopupPoints(999)).toBe("below_min");
    expect(validateTopupPoints(1000)).toBeNull();
    expect(validateTopupPoints(100000)).toBeNull();
    expect(validateTopupPoints(100001)).toBe("above_max");
    for (const bad of [1500.5, NaN, Infinity, -5, 0, "2500", null, undefined]) expect(validateTopupPoints(bad), String(bad)).toBe("invalid");
  });

  it("the message under the minimum is the owner's wording, with the limits written from the config", () => {
    expect(topupAmountMessageAr("below_min", 0.1)).toBe("أقل مبلغ للشحن ١٠٠٠ نقطة (١٠٠ جنيه)");
    expect(topupAmountMessageAr("above_max", 0.1)).toBe("أقصى مبلغ للشحن ١٠٠٠٠٠ نقطة (١٠٠٠٠ جنيه)");
    expect(TOPUP_ERROR_MESSAGES.amount_below_min).toBe("أقل مبلغ للشحن ١٠٠٠ نقطة (١٠٠ جنيه)");
    expect(src("src/app/dashboard/topup/TopupForm.tsx")).toContain("disabled={sending || problem !== null}"); // submit is off while the amount is invalid
  });

  it("the server's own check of an EGP amount: whole points at the credit value, inside the limits", () => {
    expect(validateSubmittedEgp(100, 0.1)).toEqual({ ok: true, points: 1000 });
    expect(validateSubmittedEgp(250, 0.1)).toEqual({ ok: true, points: 2500 });
    expect(validateSubmittedEgp(123.5, 0.1)).toEqual({ ok: true, points: 1235 });
    expect(validateSubmittedEgp(10000, 0.1)).toEqual({ ok: true, points: 100000 });
    expect(validateSubmittedEgp(99.9, 0.1)).toEqual({ ok: false, problem: "below_min" });
    expect(validateSubmittedEgp(50, 0.1)).toEqual({ ok: false, problem: "below_min" });
    expect(validateSubmittedEgp(10000.1, 0.1)).toEqual({ ok: false, problem: "above_max" });
    expect(validateSubmittedEgp(100.05, 0.1)).toEqual({ ok: false, problem: "invalid" }); // not a whole number of points
    for (const bad of [0, -100, NaN, "abc", null, undefined]) expect(validateSubmittedEgp(bad, 0.1), String(bad)).toEqual({ ok: false, problem: "invalid" });
    expect(validateSubmittedEgp(100, 0)).toEqual({ ok: false, problem: "invalid" });
  });
});

describe("C. the exact EGP to pay", () => {
  it("EGP is points x the credit value, rounded to piastres, for several values", () => {
    const table: Array<[number, number]> = [[1000, 100], [2500, 250], [5000, 500], [10000, 1000], [1235, 123.5], [1001, 100.1], [1007, 100.7], [100000, 10000], [33333, 3333.3]];
    for (const [points, egp] of table) {
      expect(pointsToEgp(points, 0.1), String(points)).toBe(egp);
      expect(egpToPoints(egp, 0.1), String(egp)).toBe(points);
    }
    expect(pointsToEgp(2500, 0.15)).toBe(375); // the credit value comes from the settings, never a constant of the screen
  });

  it("the default screen says «ستحوّل» over «٢٥٠ جنيه» and offers «نسخ المبلغ»; the copied text is the number only", () => {
    const html = form();
    expect(html).toContain('data-testid="topup-egp-due-text"');
    expect(html).toContain(">ستحوّل<");
    expect(/data-testid="topup-egp-due-text"[^>]*>٢٥٠ جنيه</.test(html)).toBe(true);
    expect(html).toContain("نسخ المبلغ");
    expect(egpDueAr(250)).toBe("ستحوّل ٢٥٠ جنيهًا");
    expect(egpDueAr(123.5)).toBe("ستحوّل ١٢٣٫٥ جنيهًا");
    expect(egpClipboardText(250)).toBe("250");
    expect(egpClipboardText(123.5)).toBe("123.5");
    expect(egpClipboardText(pointsToEgp(1235, 0.1))).toBe("123.5");
    const code = src("src/app/dashboard/topup/TopupForm.tsx");
    expect(code).toContain("navigator.clipboard?.writeText(egpClipboardText(amountEgp))");
    // no 0.1 in a component: the credit value is a prop
    expect(code).not.toMatch(/0\.1\b|\* ?0\.10?\b|\/ ?0\.1\b/);
  });

  it("the page never claims the InstaPay link carries the amount", () => {
    const html = form();
    expect(html).toContain("الرابط لا يحمل المبلغ — اكتب المبلغ المنسوخ بنفسك في إنستاباي قبل التأكيد.");
    expect(html).not.toMatch(/المبلغ (?:مُدخل|مدرج|يُملأ) تلقائيًا|يحمل المبلغ تلقائيًا/);
    expect(src("src/app/dashboard/topup/InstapayShortcuts.tsx")).not.toMatch(/amount|\?a=/i);
  });
});

describe("D. the request as the screen sends it", () => {
  const userId = "usr_000000000001";
  const submit = async (body: Record<string, unknown>, withFile = true) => {
    const { POST } = await import("@/app/api/topup/submit/route");
    const receiptFileId = `${userId}/${Math.random().toString(36).slice(2)}.png`;
    if (withFile) mockState.storageFiles.set(receiptFileId, Buffer.from(`receipt-${receiptFileId}`));
    const res = await POST(new NextRequest("http://localhost:3000/api/topup/submit", { method: "POST", body: JSON.stringify({ receiptFileId, ...body }) }));
    return { status: res.status, body: await res.json() };
  };
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.user = { id: userId, email: "customer@example.test", email_confirmed_at: "2026-10-14T00:00:00Z", user_metadata: { full_name: "منى السيد", email_verified: true } };
    mockState.storageFiles.clear(); mockState.topupsTable = []; mockState.sent = []; mockState.failAlert = false;
    mockState.settingsPricing = { key: "pricing", value: { ipa: "iammagdy", maxPendingTopups: 3, creditValueEgp: 0.1 } };
    vi.stubEnv("ADMIN_ALERT_EMAIL", "owner@example.test");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("the server stores the EGP as sent and accepts every preset and a free amount; points x 0.10 = EGP", async () => {
    for (const points of [1000, 2500, 5000, 10000, 1235, 100000]) {
      const egp = pointsToEgp(points, 0.1);
      const { status, body } = await submit({ amountEgp: egp });
      expect(status, String(points)).toBe(200);
      expect(body.success).toBe(true);
      expect(mockState.topupsTable[mockState.topupsTable.length - 1].amount_egp).toBe(egp);
    }
  });

  it("an amount outside the limits, or not a whole number of points, is refused before anything is stored", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ amountEgp: 99.9 }, "amount_below_min"], [{ amountEgp: 50 }, "amount_below_min"], [{ amountEgp: 10000.1 }, "amount_above_max"],
      [{ amountEgp: 1e9 }, "amount_above_max"], [{ amountEgp: 100.05 }, "amount_invalid"],
    ];
    for (const [payload, reason] of cases) {
      const { status, body } = await submit(payload);
      expect(status, JSON.stringify(payload)).toBe(400);
      expect(body).toMatchObject({ success: false, reason });
      expect(body.error).toMatch(/[؀-ۿ]/);
    }
    expect((await submit({ amountEgp: 99.9 })).body.error).toBe("أقل مبلغ للشحن ١٠٠٠ نقطة (١٠٠ جنيه)");
    expect(mockState.topupsTable).toHaveLength(0);
    expect(mockState.sent).toHaveLength(0); // a refused amount sends no e-mail at all
  });

  it("the limits follow the credit value of the settings, on the server", async () => {
    mockState.settingsPricing = { key: "pricing", value: { ipa: "iammagdy", creditValueEgp: 0.2 } };
    expect((await submit({ amountEgp: 100 })).body.reason).toBe("amount_below_min"); // 500 points at 0.20
    expect((await submit({ amountEgp: 200 })).status).toBe(200); // 1000 points
  });

  it("E. ONE alert e-mail goes to the configured address with the request's facts and a link without a token", async () => {
    const { status, body } = await submit({ amountEgp: 250 });
    expect(status).toBe(200);
    const alerts = mockState.sent.filter((mail) => mail.to === "owner@example.test");
    expect(alerts).toHaveLength(1);
    const [alert] = alerts;
    expect(alert.template).toBe("job-update");
    expect(alert.key).toBe(`topup-alert:${body.topupId}`);
    expect(alert.vars.Subject).toBe("طلب شحن جديد: ٢٥٠٠ نقطة");
    expect(alert.vars.Lead).toContain("منى السيد");
    expect(alert.vars.Lead).toContain("customer@example.test");
    expect(alert.vars.DetailOne).toBe("النقاط: ٢٥٠٠. المبلغ المتوقع: ٢٥٠ جنيهًا.");
    expect(alert.vars.DetailTwo).toMatch(/^وقت الطلب: .+\.$/);
    expect(alert.vars.JobURL).toBe("https://diger.tech/admin/topups");
    const everything = JSON.stringify(alert);
    expect(everything).not.toMatch(/token|secret|receipt|rcpt_|[?&=]|Bearer|service_role|\.png/i);
    // the customer's own e-mail is still sent, once
    expect(mockState.sent.filter((mail) => mail.to === "customer@example.test")).toHaveLength(1);
  });

  it("E. an alert that throws, or answers not ok, never fails or delays the request", async () => {
    for (const mode of ["throw", "not_ok"] as const) {
      mockState.failAlert = mode;
      const { status, body } = await submit({ amountEgp: 250 });
      expect(status, mode).toBe(200);
      expect(body.success).toBe(true);
    }
    expect(mockState.topupsTable).toHaveLength(2);
  });

  it("E. with no ADMIN_ALERT_EMAIL nothing is sent to the owner and the request still succeeds", async () => {
    vi.stubEnv("ADMIN_ALERT_EMAIL", "");
    const { status } = await submit({ amountEgp: 250 });
    expect(status).toBe(200);
    expect(mockState.sent.map((mail) => mail.template)).toEqual(["topup-received"]);
  });
});

describe("E. the owner alert module", () => {
  it("the recipient is the configured address only, never hard-coded, and a malformed value is ignored", () => {
    expect(OWNER_ALERT_ENV).toBe("ADMIN_ALERT_EMAIL");
    expect(ownerAlertRecipient({ ADMIN_ALERT_EMAIL: " owner@example.test " })).toBe("owner@example.test");
    for (const bad of ["", "   ", "not an address", "a@b", undefined]) expect(ownerAlertRecipient({ ADMIN_ALERT_EMAIL: bad as never }), String(bad)).toBeNull();
    expect(src("src/lib/server/topupOwnerAlert.ts")).not.toMatch(/@(?:outlook|gmail|diger)\./i);
  });
  it("a missing recipient sends nothing; a failure is reported as «failed» without throwing; the idempotency key is the request id", async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const input = { topupId: "topup_abc", customerName: "منى", customerEmail: "m@x.test", points: 2500, amountEgp: 250, createdAt: "2026-10-25T10:00:00Z" };
    expect(await notifyOwnerOfTopup(input, { send: send as never, env: {} })).toEqual({ sent: false, reason: "no_recipient" });
    expect(send).not.toHaveBeenCalled();
    expect(await notifyOwnerOfTopup(input, { send: send as never, env: { ADMIN_ALERT_EMAIL: "o@x.test" } })).toEqual({ sent: true });
    expect(send).toHaveBeenCalledWith("job-update", "o@x.test", buildTopupAlertVars(input), "topup-alert:topup_abc");
    const boom = vi.fn(async () => { throw new Error("x"); });
    expect(await notifyOwnerOfTopup(input, { send: boom as never, env: { ADMIN_ALERT_EMAIL: "o@x.test" } })).toEqual({ sent: false, reason: "failed" });
    // the time reads in Cairo (10:00 UTC is 1:00 pm there) with Arabic-Indic digits
    expect(buildTopupAlertVars(input).DetailTwo).toBe("وقت الطلب: ٢٥ أكتوبر ٢٠٢٦ في ١:٠٠ م.");
  });
  it("it uses the existing generic layout: no new template key, so the e-mail function needs no redeploy", () => {
    expect(src("src/lib/server/topupOwnerAlert.ts")).toContain('"job-update"');
    expect(src("supabase/functions/send-email/templates.ts")).toContain('"job-update"');
  });
});
