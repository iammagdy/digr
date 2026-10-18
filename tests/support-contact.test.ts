import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as any,
  db: { inserts: [] as any[], updates: [] as any[], job: null as any, existingReport: false, insertError: null as any, settings: null as any },
}));

function table(name: string) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    limit: () => Promise.resolve({ data: state.db.existingReport ? [{ id: "old" }] : [], error: null }),
    maybeSingle: async () => {
      if (name === "jobs") return { data: state.db.job, error: null };
      if (name === "settings_public") return { data: state.db.settings, error: null };
      return { data: null, error: null };
    },
    insert: async (row: any) => { state.db.inserts.push({ name, row }); return { error: state.db.insertError }; },
    update: (row: any) => { state.db.updates.push({ name, row }); return { eq: async () => ({ error: null }) }; },
  };
  return chain;
}

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    from: (name: string) => table(name),
    auth: { admin: { getUserById: async () => ({ data: { user: { email: "c@x.test", user_metadata: { name: "سلمى" }, created_at: "2026-10-01T00:00:00Z" } }, error: null }) } },
  })),
}));

import { POST } from "../src/app/api/support/messages/route";
import {
  jobReportMessageAr,
  normalizeSupportSettings,
  normalizeWhatsapp,
  SUPPORT_PLACEHOLDER_AR,
  validateSupportMessage,
  whatsappHref,
} from "../src/lib/supportContact";

const post = (body: unknown, ip = "1.1.1.1") =>
  new NextRequest("http://localhost/api/support/messages", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });

beforeEach(() => {
  state.user = null;
  state.db = { inserts: [], updates: [], job: null, existingReport: false, insertError: null, settings: null };
  delete process.env.RESEND_API_KEY;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("11. support: the contact form rules", () => {
  it("validates in Arabic and trims", () => {
    expect(validateSupportMessage({ name: "س", email: "a@b.co", message: "مرحبا بكم" })).toMatchObject({ ok: false });
    expect(validateSupportMessage({ name: "سلمى", email: "bad", message: "مرحبا بكم" })).toMatchObject({ ok: false, errorAr: expect.stringMatching(/بريد/) });
    expect(validateSupportMessage({ name: "سلمى", email: "a@b.co", message: "ببب" })).toMatchObject({ ok: false });
    expect(validateSupportMessage({ name: " سلمى  علي ", email: "a@b.co", message: " مرحبا بكم " })).toEqual({ ok: true, value: { name: "سلمى علي", email: "a@b.co", message: "مرحبا بكم" } });
  });

  it("support settings: placeholders until set, WhatsApp digits only and a wa.me link", () => {
    expect(normalizeSupportSettings(null)).toEqual({ supportEmail: "", whatsappNumber: "" });
    expect(normalizeSupportSettings({ supportEmail: "help@diger.tech", whatsappNumber: "+٢٠ 100 000 0000" })).toEqual({ supportEmail: "help@diger.tech", whatsappNumber: "201000000000" });
    expect(normalizeWhatsapp("123")).toBe("");
    expect(whatsappHref("201000000000")).toBe("https://wa.me/201000000000");
    expect(whatsappHref("")).toBeNull();
    expect(SUPPORT_PLACEHOLDER_AR).toBe("سيُضاف قريبًا");
    const page = readFileSync("src/app/contact/ContactForm.tsx", "utf8");
    expect(page).toContain("SUPPORT_PLACEHOLDER_AR");
    expect(page).toContain("/api/support/settings");
    expect(page).not.toMatch(/alert\(/);
  });

  it("the job report text is written by code and names the job", () => {
    expect(jobReportMessageAr({ id: "job_x", status: "failed" })).toContain("job_x");
    expect(jobReportMessageAr({ id: "job_x", status: "completed", delivered: 2, requested: 5 })).toContain("اكتمل جزئيًا");
  });
});

describe("11. support: the message route", () => {
  it("stores a valid contact message; with no Resend key it still succeeds (stored) and says so in Arabic", async () => {
    const res = await POST(post({ name: "سلمى", email: "c@x.test", message: "عندي سؤال عن الأسعار" }, "2.2.2.1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.messageAr).toMatch(/وصلتنا/);
    expect(state.db.inserts).toHaveLength(1);
    expect(state.db.inserts[0].name).toBe("support_messages");
    expect(state.db.inserts[0].row).toMatchObject({ name: "سلمى", email: "c@x.test", source: "contact", job_id: null });
  });

  it("sends through Resend when the key and the support email both exist, with the verified sender and an idempotency key", async () => {
    process.env.RESEND_API_KEY = "re_test_key_not_real";
    state.db.settings = { value: { supportEmail: "help@diger.tech", whatsappNumber: "" } };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "m1" }), { status: 200 }));
    const res = await POST(post({ name: "سلمى", email: "c@x.test", message: "عندي سؤال عن الأسعار" }, "2.2.2.2"));
    expect(res.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0] as [string, any];
    expect(url).toBe("https://api.resend.com/emails");
    const payload = JSON.parse(init.body);
    expect(payload.from).toBe("Diger <noreply@diger.tech>");
    expect(payload.to).toEqual(["help@diger.tech"]);
    expect(payload.reply_to).toBe("c@x.test");
    expect(init.headers["Idempotency-Key"]).toMatch(/^support:/);
    expect(state.db.updates.some((u) => u.row.emailed === true)).toBe(true);
  });

  it("when the table is missing but the email goes out, the customer is still told it arrived; when neither works, an honest failure", async () => {
    state.db.insertError = { code: "42P01", message: 'relation "public.support_messages" does not exist' };
    process.env.RESEND_API_KEY = "re_test_key_not_real";
    state.db.settings = { value: { supportEmail: "help@diger.tech" } };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect((await POST(post({ name: "سلمى", email: "c@x.test", message: "عندي سؤال عن الأسعار" }, "2.2.2.3"))).status).toBe(200);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 500 }));
    const failed = await POST(post({ name: "سلمى", email: "c@x.test", message: "عندي سؤال عن الأسعار" }, "2.2.2.4"));
    expect(failed.status).toBe(503);
    expect((await failed.json()).messageAr).toMatch(/واتساب/);
    expect(JSON.stringify((console.error as any).mock.calls)).not.toContain("re_test_key_not_real");
  });

  it("a bot that fills the hidden field is told it worked and nothing is stored", async () => {
    const res = await POST(post({ name: "x y", email: "c@x.test", message: "spam spam spam", website: "http://spam" }, "2.2.2.5"));
    expect((await res.json()).success).toBe(true);
    expect(state.db.inserts).toHaveLength(0);
  });

  it("too many messages from one address are refused", async () => {
    let last = 200;
    for (let i = 0; i < 7; i++) last = (await POST(post({ name: "سلمى", email: "c@x.test", message: "عندي سؤال عن الأسعار" }, "9.9.9.9"))).status;
    expect(last).toBe(429);
  });

  it("a job report needs a signed-in owner of that job; the job id goes through automatically and the server writes the text", async () => {
    expect((await POST(post({ jobId: "job_quote_abc" }, "3.3.3.1"))).status).toBe(401);

    state.user = { id: "owner-1", email: "c@x.test" };
    state.db.job = { id: "job_quote_abc", user_id: "someone-else", status: "failed", delivered_units: 0, target_volume_max: 5 };
    expect((await POST(post({ jobId: "job_quote_abc" }, "3.3.3.2"))).status).toBe(404);

    state.db.job = { id: "job_quote_abc", user_id: "owner-1", status: "failed", delivered_units: 0, target_volume_max: 5 };
    const ok = await POST(post({ jobId: "job_quote_abc", message: "ignored free text" }, "3.3.3.3"));
    expect(ok.status).toBe(200);
    expect(state.db.inserts[0].row).toMatchObject({ job_id: "job_quote_abc", source: "job_report", user_id: "owner-1", email: "c@x.test" });
    expect(state.db.inserts[0].row.message).toContain("job_quote_abc");
    expect(state.db.inserts[0].row.message).not.toContain("ignored free text");
  });

  it("reporting the same job twice does not create a second message", async () => {
    state.user = { id: "owner-1", email: "c@x.test" };
    state.db.job = { id: "job_quote_abc", user_id: "owner-1", status: "completed", delivered_units: 2, target_volume_max: 5 };
    state.db.existingReport = true;
    const res = await POST(post({ jobId: "job_quote_abc" }, "3.3.3.4"));
    expect((await res.json()).duplicate).toBe(true);
    expect(state.db.inserts).toHaveLength(0);
  });
});

describe("11. «بلّغ عن مشكلة» appears only on failed or partial jobs", () => {
  it("requests list: refunded (failed) and partial cards only", () => {
    const page = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    expect(page).toContain('(k === "refunded" || k === "partial") && <ReportProblemButton jobId={j.$id}');
  });

  it("chat: only when the job ended failed or delivered less than requested", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain('activeJob.status === "failed" || (activeJob.requestedRows && activeJob.rowsCollected < activeJob.requestedRows)');
    expect(page).toContain("<ReportProblemButton jobId={activeJob.jobId}");
  });

  it("the contact page is public and linked from the landing footer and the sitemap", () => {
    expect(readFileSync("src/components/landing/Sections.tsx", "utf8")).toContain('href="/contact"');
    expect(readFileSync("src/app/sitemap.ts", "utf8")).toContain("/contact");
    expect(readFileSync("src/middleware.ts", "utf8")).not.toContain('"/contact"');
  });
});
