/**
 * Tests for send-email (run: deno test --allow-env).
 * Covers: every template renders with no leftover {{ }} tokens, values are
 * HTML-escaped, and the Resend payload shape is correct. No network calls.
 */

import { assertEquals, assert } from "jsr:@std/assert";
import { buildResendPayload, isValidUnsubscribeUrl } from "./index.ts";
import { buildResendHeaders } from "./resendHeaders.ts";
import { renderEmailTemplate } from "./templates.ts";

const TEMPLATES = [
  "welcome",
  "topup-received",
  "topup-approved",
  "topup-rejected",
  "job-done",
  "refund",
  "job-update",
  "admin-topup-alert",
  "news",
] as const;

const SAMPLE_VARS: Record<(typeof TEMPLATES)[number], Record<string, string>> = {
  "welcome": { Name: "Magdy" },
  "topup-received": { Name: "Magdy", AmountEgp: "٥٠٠", Credits: "٥٠٠٠", ReviewNote: "غالبًا يتم الاعتماد خلال ١٥ دقيقة.", CreatedAt: "١٣ أكتوبر ٢٠٢٦" },
  "topup-approved": { Name: "Magdy", Credits: "٥٠٠٠", ConfirmedAmountEgp: "٥٠٠", Balance: "٥٢٠٠" },
  "topup-rejected": { Name: "Magdy", AmountEgp: "٥٠٠", RejectReason: "الإيصال غير واضح" },
  "job-done": { Name: "Magdy", JobTitle: "بحث تجريبي" },
  "refund": { Name: "Magdy", Points: "200", JobTitle: "بحث تجريبي", Reason: "تغطية ناقصة", Balance: "5400" },
  "job-update": { Name: "Magdy", Subject: "اكتمل طلبك جزئيًا", Heading: "اكتمل طلبك جزئيًا", Lead: "وصلك ٤٠ من ١٠٠.", DetailOne: "خُصم ٣٦٠ نقطة.", DetailTwo: "", ButtonLabel: "افتح طلباتي", JobURL: "https://diger.tech/dashboard/requests" },
  "admin-topup-alert": { CustomerName: "Magdy", CustomerEmail: "magdy@example.com", Points: "٢٥٠٠", AmountEgp: "٢٥٠", RequestTime: "٢٥ أكتوبر ٢٠٢٦ في ١:٠٠ م", AdminURL: "https://diger.tech/admin/topups" },
  "news": { Name: "Magdy", Subject: "جديد في ديجر", Heading: "جديد في ديجر", Lead: "أضفنا ما يخلّي رحلة طلبك أوضح:", Item1: "• جدول حيّ لنتائجك.", Item2: "", ButtonLabel: "افتح لوحتك", UnsubscribeURL: "https://diger.tech/api/email/unsubscribe?t=a.b" },
};

for (const id of TEMPLATES) {
  Deno.test(`render ${id}: no leftover tokens, logo URL present`, () => {
    const { subject, html } = renderEmailTemplate(id, SAMPLE_VARS[id]);
    assert(!subject.includes("{{"), `${id} subject has leftover token`);
    assert(!html.includes("{{"), `${id} html has leftover token`);
    assert(html.includes("https://diger.tech/email/digr-wordmark.png"), `${id} missing logo URL`);
  });
}

Deno.test("render escapes HTML in values", () => {
  const { html } = renderEmailTemplate("welcome", { Name: "<script>alert(1)</script>" });
  assert(!html.includes("<script>alert(1)</script>"), "raw HTML leaked");
  assert(html.includes("&lt;script&gt;"), "escaped value missing");
});

Deno.test("buildResendPayload: shape + fixed sender", () => {
  const payload = buildResendPayload({
    template: "welcome",
    to: "magdy.saber@outlook.com",
    vars: { Name: "Magdy" },
  });
  assertEquals(payload.from, "Diger <noreply@diger.tech>");
  assertEquals(payload.to, ["magdy.saber@outlook.com"]);
  assert(payload.subject.includes("Magdy"), "subject not substituted");
  assert(payload.html.includes("Magdy"), "html not substituted");
});

Deno.test("buildResendHeaders carries deterministic idempotency keys for transactional sends", () => {
  assertEquals(buildResendHeaders("test-key", "job-done:job_123")["Idempotency-Key"], "job-done:job_123");
  assertEquals(buildResendHeaders("test-key", "topup-approved:top_123")["Idempotency-Key"], "topup-approved:top_123");
  assertEquals(buildResendHeaders("test-key")["Idempotency-Key"], undefined);
});

Deno.test("news: the footer carries the visible one-click unsubscribe link; empty items are dropped", () => {
  const { html } = renderEmailTemplate("news", SAMPLE_VARS["news"]);
  assert(html.includes('href="https://diger.tech/api/email/unsubscribe?t=a.b"'), "unsubscribe link missing");
  assert(html.includes("إلغاء الاشتراك من الأخبار"), "unsubscribe label missing");
  assert(!/<p\b[^>]*>\s*<\/p>/.test(html), "empty paragraph left");
});

Deno.test("buildResendPayload: List-Unsubscribe headers only when unsubscribeUrl is given", () => {
  const withUrl = buildResendPayload({ template: "news", to: "a@example.test", vars: SAMPLE_VARS["news"], unsubscribeUrl: "https://diger.tech/api/email/unsubscribe?t=a.b" }) as Record<string, unknown>;
  assertEquals(withUrl.headers, { "List-Unsubscribe": "<https://diger.tech/api/email/unsubscribe?t=a.b>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  const without = buildResendPayload({ template: "welcome", to: "a@example.test", vars: { Name: "Magdy" } });
  assertEquals(Object.keys(without), ["from", "to", "subject", "html"]);
});

Deno.test("isValidUnsubscribeUrl: https only, max 2048, no header-breaking characters", () => {
  assert(isValidUnsubscribeUrl("https://diger.tech/api/email/unsubscribe?t=a.b"));
  assert(!isValidUnsubscribeUrl("http://diger.tech/x"));
  assert(!isValidUnsubscribeUrl("https://diger.tech/x>\r\nBcc: a@b.c"));
  assert(!isValidUnsubscribeUrl("https://diger.tech/" + "a".repeat(2048)));
  assert(!isValidUnsubscribeUrl(42));
});
