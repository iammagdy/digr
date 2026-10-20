/**
 * Tests for send-email (run: deno test --allow-env).
 * Covers: every template renders with no leftover {{ }} tokens, values are
 * HTML-escaped, and the Resend payload shape is correct. No network calls.
 */

import { assertEquals, assert } from "jsr:@std/assert";
import { buildResendPayload } from "./index.ts";
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
] as const;

const SAMPLE_VARS: Record<(typeof TEMPLATES)[number], Record<string, string>> = {
  "welcome": { Name: "Magdy" },
  "topup-received": { Name: "Magdy", AmountEgp: "500", Credits: "5000", Reference: "REF-1", CreatedAt: "13 أكتوبر 2026" },
  "topup-approved": { Name: "Magdy", Credits: "5000", ConfirmedAmountEgp: "500", Reference: "REF-1", Balance: "5200" },
  "topup-rejected": { Name: "Magdy", AmountEgp: "500", Reference: "REF-1", RejectReason: "الإيصال غير واضح" },
  "job-done": { Name: "Magdy", JobTitle: "بحث تجريبي" },
  "refund": { Name: "Magdy", Points: "200", JobTitle: "بحث تجريبي", Reason: "تغطية ناقصة", Balance: "5400" },
  "job-update": { Name: "Magdy", Subject: "اكتمل طلبك جزئيًا", Heading: "اكتمل طلبك جزئيًا", Lead: "وصلك ٤٠ من ١٠٠.", DetailOne: "خُصم ٣٦٠ نقطة.", DetailTwo: "", ButtonLabel: "افتح طلباتي", JobURL: "https://diger.tech/dashboard/requests" },
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
