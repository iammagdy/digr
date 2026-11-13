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

Deno.test("buildResendPayload: the news footer link equals the List-Unsubscribe target even when the caller sent no UnsubscribeURL var", () => {
  const url = "https://diger.tech/api/email/unsubscribe?t=zz.yy";
  const vars = { ...SAMPLE_VARS["news"] } as Record<string, string>;
  delete vars.UnsubscribeURL;
  const payload = buildResendPayload({ template: "news", to: "a@example.test", vars, unsubscribeUrl: url });
  assert(payload.html.includes(`href="${url}"`), "footer href is not the unsubscribe URL");
  assert(!payload.html.includes('href=""'), "empty href");
});

Deno.test("isValidUnsubscribeUrl: https only, max 2048, no header-breaking characters", () => {
  assert(isValidUnsubscribeUrl("https://diger.tech/api/email/unsubscribe?t=a.b"));
  assert(!isValidUnsubscribeUrl("http://diger.tech/x"));
  assert(!isValidUnsubscribeUrl("https://diger.tech/x>\r\nBcc: a@b.c"));
  assert(!isValidUnsubscribeUrl("https://diger.tech/" + "a".repeat(2048)));
  assert(!isValidUnsubscribeUrl(42));
});

// ---- handle(): behaviour of the whole request path with a stubbed Resend (no network) ----
import { handle } from "./index.ts";

async function withStubbedResend(resendResponse: () => Response, run: (calls: { n: number }) => Promise<void>) {
  const realFetch = globalThis.fetch;
  const prevKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const prevResend = Deno.env.get("RESEND_API_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-test-key");
  Deno.env.set("RESEND_API_KEY", "re_test_key");
  const calls = { n: 0 };
  globalThis.fetch = (() => { calls.n++; return Promise.resolve(resendResponse()); }) as typeof fetch;
  try { await run(calls); } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY"); else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", prevKey);
    if (prevResend === undefined) Deno.env.delete("RESEND_API_KEY"); else Deno.env.set("RESEND_API_KEY", prevResend);
  }
}

const req = (auth: string | null, body: unknown) => new Request("https://x.test/send-email", {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
  body: JSON.stringify(body),
});
const NEWS_BODY = { template: "news", to: "a@example.test", vars: SAMPLE_VARS["news"], idempotencyKey: "launch:u1", unsubscribeUrl: "https://diger.tech/api/email/unsubscribe?t=a.b" };

Deno.test("handle: a delivered email (Resend 200) with an unreadable body is still reported ok, never a failure", async () => {
  await withStubbedResend(() => new Response("<<not json>>", { status: 200 }), async (calls) => {
    const res = await handle(req("Bearer service-test-key", NEWS_BODY));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true, id: null });
    assertEquals(calls.n, 1);
  });
});

Deno.test("handle: Resend rejection is a 502 with no provider body leaked", async () => {
  await withStubbedResend(() => new Response(JSON.stringify({ message: "re_secret_detail" }), { status: 422 }), async () => {
    const res = await handle(req("Bearer service-test-key", NEWS_BODY));
    assertEquals(res.status, 502);
    const text = await res.text();
    assert(!text.includes("re_secret_detail"));
  });
});

Deno.test("handle: no/wrong credentials never reach Resend", async () => {
  await withStubbedResend(() => new Response("{}", { status: 200 }), async (calls) => {
    assertEquals((await handle(req(null, NEWS_BODY))).status, 401);
    assertEquals(calls.n, 0);
  });
});

Deno.test("handle: a header-breaking unsubscribeUrl is refused before any send", async () => {
  await withStubbedResend(() => new Response("{}", { status: 200 }), async (calls) => {
    const res = await handle(req("Bearer service-test-key", { ...NEWS_BODY, unsubscribeUrl: "https://diger.tech/x>\r\nBcc: a@b.c" }));
    assertEquals(res.status, 400);
    assertEquals(calls.n, 0);
  });
});

Deno.test("handle: a news mail without unsubscribeUrl is refused before any send", async () => {
  await withStubbedResend(() => new Response("{}", { status: 200 }), async (calls) => {
    const { unsubscribeUrl: _omit, ...noUrl } = NEWS_BODY;
    const res = await handle(req("Bearer service-test-key", noUrl));
    assertEquals(res.status, 400);
    assertEquals(calls.n, 0);
  });
});
