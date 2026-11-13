import { afterEach, describe, expect, it, vi } from "vitest";
import { renderEmailTemplate as renderEdge, templateVariables } from "../supabase/functions/send-email/templates";
import { renderEmailTemplate as renderApp, PLATFORM_EMAIL_SUBJECTS as appSubjects } from "../src/functions/shared/emailTemplates";
import { assembleResendPayload, isValidUnsubscribeUrl } from "../supabase/functions/send-email/payload";
import { isEmailPreferenceEnabled, sendPlatformEmail, TEMPLATE_CATEGORY_MAP } from "../src/lib/server/sendPlatformEmail";

const visible = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/&[#\w]+;/g, " ").replace(/\s+/g, " ").trim();
const VARS = {
  Name: "منى", Subject: "جديد في ديجر", Heading: "جديد في ديجر", Lead: "أضفنا ما يخلّي رحلة طلبك أوضح:",
  Item1: "• جدول حيّ لنتائجك.", Item2: "• بطاقة «فهمنا طلبك».", Item3: "", Item4: "", Item5: "", Item6: "",
  ButtonLabel: "افتح لوحتك", UnsubscribeURL: "https://diger.tech/api/email/unsubscribe?t=abc.def",
};

describe("news template: render", () => {
  it("renders subject, heading, greeting, lead, the given bullets, ONE button to /dashboard and both footer links", () => {
    const { subject, html } = renderEdge("news", VARS);
    expect(subject).toBe("جديد في ديجر");
    expect(html).toContain(">جديد في ديجر</h1>");
    expect(html).toContain("أهلًا منى،");
    expect(html).toContain("أضفنا ما يخلّي رحلة طلبك أوضح:");
    expect(html).toContain("• جدول حيّ لنتائجك.");
    expect(html).toContain('href="https://diger.tech/dashboard" target="_blank"');
    expect(html.match(/target="_blank"/g)).toHaveLength(1);
    expect(html).toContain('href="https://diger.tech/dashboard/settings"');
    expect(html).toContain('href="https://diger.tech/api/email/unsubscribe?t=abc.def"');
    expect(visible(html)).toContain("إلغاء الاشتراك من الأخبار");
  });

  it("drops the empty item paragraphs and leaves no raw {{ }} token (even with no variable at all)", () => {
    const { html } = renderEdge("news", VARS);
    expect(html).not.toContain("{{");
    expect(html).not.toMatch(/<p\b[^>]*>\s*<\/p>/);
    // greeting + lead + 2 bullets = 4 paragraphs in the card (the footer is not a <p>)
    expect(html.match(/<p dir="rtl"/g)).toHaveLength(4);
    const empty = renderEdge("news", {});
    expect(empty.html + empty.subject).not.toContain("{{");
  });

  it("HTML-escapes every value (a hostile name or bullet cannot inject markup), the subject stays plain text", () => {
    const { subject, html } = renderEdge("news", { ...VARS, Name: "<script>alert(1)</script>", Item1: '"><img src=x onerror=1>', Subject: "a & b" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(subject).toBe("a & b");
  });

  it("reads exactly the pinned variables", () => {
    expect(templateVariables("news")).toEqual(["ButtonLabel", "Heading", "Item1", "Item2", "Item3", "Item4", "Item5", "Item6", "Lead", "Name", "SiteURL", "Subject", "UnsubscribeURL"]);
  });

  it("the app's copy and the Edge Function's copy produce identical output for the same variables", () => {
    for (const vars of [VARS, {}, { ...VARS, Name: "<b>x</b> & y", Item6: "• آخر" }]) {
      expect(renderApp("news", vars)).toEqual(renderEdge("news", vars));
    }
    expect(appSubjects.news).toBe("{{ .Subject }}");
  });

  it("an unsubscribe link exists ONLY in the news template: another template renders byte-identically to before (no flag leaks)", () => {
    for (const id of ["welcome", "topup-approved", "job-done", "refund", "admin-topup-alert"] as const) {
      expect(renderEdge(id, { Name: "منى" }).html, id).not.toMatch(/unsubscribe|إلغاء الاشتراك/i);
    }
  });
});

describe("news template: consent category", () => {
  it("news maps to the news category, which defaults to OFF", () => {
    expect(TEMPLATE_CATEGORY_MAP.news).toBe("news");
    expect(isEmailPreferenceEnabled("news", null)).toBe(false);
    expect(isEmailPreferenceEnabled("news", {})).toBe(false);
    expect(isEmailPreferenceEnabled("news", { prefs: { notif: { topup: true } } })).toBe(false);
    expect(isEmailPreferenceEnabled("news", { prefs: { notif: { news: "true" } } })).toBe(false);
    expect(isEmailPreferenceEnabled("news", { prefs: { notif: { news: false } } })).toBe(false);
    expect(isEmailPreferenceEnabled("news", { prefs: { notif: { news: true } } })).toBe(true);
  });
});

describe("List-Unsubscribe headers on the Resend payload (Edge Function)", () => {
  const base = { template: "welcome" as const, to: "customer@example.test", vars: { Name: "منى" } };
  // index.ts's buildResendPayload = renderEmailTemplate + assembleResendPayload (pinned by the Deno test of the function)
  const buildResendPayload = (r: { template: any; to: string; vars: any; unsubscribeUrl?: string }) => assembleResendPayload("Diger <noreply@diger.tech>", renderEdge(r.template, r.vars), r.to, r.unsubscribeUrl);

  it("adds List-Unsubscribe and List-Unsubscribe-Post (RFC 8058) only when an unsubscribeUrl is given, for ANY template", () => {
    for (const template of ["news", "welcome", "job-done"] as const) {
      const p = buildResendPayload({ ...base, template, unsubscribeUrl: "https://diger.tech/api/email/unsubscribe?t=a.b" }) as any;
      expect(p.headers).toEqual({ "List-Unsubscribe": "<https://diger.tech/api/email/unsubscribe?t=a.b>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    }
  });

  it("the payload of every other caller is byte-identical to before: exactly from, to, subject, html", () => {
    for (const template of ["welcome", "topup-approved", "job-done", "refund", "job-update", "admin-topup-alert"] as const) {
      const without = buildResendPayload({ ...base, template });
      const undef = buildResendPayload({ ...base, template, unsubscribeUrl: undefined });
      const { subject, html } = renderEdge(template, base.vars);
      expect(JSON.stringify(without)).toBe(JSON.stringify({ from: "Diger <noreply@diger.tech>", to: [base.to], subject, html }));
      expect(JSON.stringify(undef)).toBe(JSON.stringify(without));
      expect(Object.keys(without)).toEqual(["from", "to", "subject", "html"]);
    }
  });

  it("validates the URL: https only, a string, at most 2048 characters, no header-breaking characters", () => {
    expect(isValidUnsubscribeUrl("https://diger.tech/api/email/unsubscribe?t=a.b")).toBe(true);
    expect(isValidUnsubscribeUrl("http://diger.tech/x")).toBe(false);
    expect(isValidUnsubscribeUrl("javascript:alert(1)")).toBe(false);
    expect(isValidUnsubscribeUrl("mailto:a@b.c")).toBe(false);
    expect(isValidUnsubscribeUrl("https://diger.tech/x>\r\nBcc: a@b.c")).toBe(false);
    expect(isValidUnsubscribeUrl("https://diger.tech/ x")).toBe(false);
    expect(isValidUnsubscribeUrl("https://diger.tech/" + "a".repeat(2048))).toBe(false);
    expect(isValidUnsubscribeUrl("https://diger.tech/" + "a".repeat(2000))).toBe(true);
    expect(isValidUnsubscribeUrl("")).toBe(false);
    expect(isValidUnsubscribeUrl(42)).toBe(false);
    expect(isValidUnsubscribeUrl(undefined)).toBe(false);
  });
});

describe("sendPlatformEmail forwards the unsubscribe URL (fake fetch; no network)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  const setup = () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-only-key");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("sends unsubscribeUrl in the body only when given", async () => {
    const fetchMock = setup();
    await sendPlatformEmail("news", "customer@example.test", { Name: "منى" }, "launch-2026-11:u1", { unsubscribeUrl: "https://diger.tech/api/email/unsubscribe?t=a.b" });
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      template: "news", to: "customer@example.test", vars: { Name: "منى" }, idempotencyKey: "launch-2026-11:u1", unsubscribeUrl: "https://diger.tech/api/email/unsubscribe?t=a.b",
    });
  });

  it("an ordinary caller's request body is byte-identical to before", async () => {
    const fetchMock = setup();
    await sendPlatformEmail("job-done", "customer@example.test", { JobTitle: "بحث" }, "job-done:j1");
    await sendPlatformEmail("welcome", "customer@example.test", { Name: "منى" });
    await sendPlatformEmail("welcome", "customer@example.test", { Name: "منى" }, undefined, {});
    const bodies = fetchMock.mock.calls.map((c) => String((c[1] as RequestInit).body));
    expect(bodies[0]).toBe(JSON.stringify({ template: "job-done", to: "customer@example.test", vars: { JobTitle: "بحث" }, idempotencyKey: "job-done:j1" }));
    expect(bodies[1]).toBe(JSON.stringify({ template: "welcome", to: "customer@example.test", vars: { Name: "منى" } }));
    expect(bodies[2]).toBe(bodies[1]);
  });

  it("an invalid_unsubscribe_url answer of the function is a fixed reason code", async () => {
    setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ ok: false, error: "invalid_unsubscribe_url" }) }));
    expect(await sendPlatformEmail("news", "customer@example.test", {}, "k", { unsubscribeUrl: "http://x" })).toEqual({ ok: false, reason: "invalid_request" });
  });
});
