import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NAME_FIELD, customerTextIssues, messageContentHash, withCustomerName } from "../src/lib/campaignText";
import { isMissingTable, parseDraft } from "../src/lib/server/campaignStore";

/**
 * DT-20261118-06 phase 2B (Tier A): the campaign drafts and the test send. Admin only; the test goes ONLY to the signed-in admin's own address; the customer-text guard refuses a
 * Latin word, a provider name or «صف» before anything is sent; a stale screen cannot overwrite a newer draft; before the migration is applied the routes say so (503).
 * There is no route in this PR that sends a campaign to customers.
 */
const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CID = "11111111-1111-4111-8111-111111111111";
const state = vi.hoisted(() => ({
  auth: "admin" as "admin" | "none",
  adminEmail: "owner@example.test",
  missing: false,
  rows: [] as Array<Record<string, unknown>>,
  sent: [] as Array<{ to: string; subject: string; idempotencyKey: string }>,
  audits: [] as unknown[][],
}));

vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => state.auth === "admin"
    ? { ok: true, ctx: { adminId: ADMIN_ID, adminEmail: state.adminEmail, audit: async (...a: unknown[]) => { state.audits.push(a); } } }
    : { ok: false, response: new Response(JSON.stringify({ error: "غير مصرح" }), { status: 401 }) }),
}));
vi.mock("../src/lib/server/customerMail", () => ({
  sendCustomerMail: vi.fn(async (input: { to: string; subject: string; idempotencyKey: string }) => { state.sent.push({ to: input.to, subject: input.subject, idempotencyKey: input.idempotencyKey }); return { ok: true, id: "m1" }; }),
  customerMailFailureAr: () => "تعذّر الإرسال.",
}));
/** A small stand-in for the service-role client on admin_campaigns: select/insert/update with eq filters, as the store uses them. */
vi.mock("../src/lib/supabase/server", () => {
  const missingError = { code: "42P01", message: 'relation "public.admin_campaigns" does not exist' };
  const query = () => {
    const filters: Array<[string, unknown]> = [];
    let patch: Record<string, unknown> | null = null;
    let insertRow: Record<string, unknown> | null = null;
    const run = () => {
      if (state.missing) return { data: null, error: missingError };
      if (insertRow) { const row = { id: CID, status: "draft", revision: 1, test_sent_at: null, test_content_hash: null, badge: "", cta_label: "", cta_path: "", created_at: "2026-11-19T00:00:00Z", updated_at: "2026-11-19T00:00:00Z", ...insertRow }; state.rows.push(row); return { data: row, error: null }; }
      const hit = state.rows.filter((r) => filters.every(([k, v]) => r[k] === v));
      if (patch) { for (const r of hit) Object.assign(r, patch); }
      return { data: hit, error: null };
    };
    const q: any = {
      select: () => q, order: () => q, limit: () => q,
      eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
      insert: (row: Record<string, unknown>) => { insertRow = row; return q; },
      update: (p: Record<string, unknown>) => { patch = p; return q; },
      single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
      maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, ko),
    };
    return q;
  };
  return { createAdminClient: () => ({ from: () => query() }), createServerSideClient: vi.fn() };
});

const req = (url: string, body?: unknown) => new NextRequest(`https://diger.test${url}`, body === undefined ? { method: "GET" } : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const GOOD = { name: "أخبار نوفمبر", subject: "جديد ديجر هذا الشهر", heading: `أهلًا ${NAME_FIELD}`, body: "أصبحت ملفات إكسل تصلك أسرع من قبل. جرّب طلبًا جديدًا اليوم." };

beforeEach(() => { state.auth = "admin"; state.adminEmail = "owner@example.test"; state.missing = false; state.rows = []; state.sent = []; state.audits = []; });

describe("campaign text rules (pure)", () => {
  it("the name field becomes the customer's greeting name, or «عزيزنا العميل»", () => {
    expect(withCustomerName({ subject: "س", heading: `مرحبًا ${NAME_FIELD}`, body: "ب" }, "منى").heading).toBe("مرحبًا منى");
    expect(withCustomerName({ subject: "س", heading: `مرحبًا ${NAME_FIELD}`, body: "ب" }, null).heading).toBe("مرحبًا عزيزنا العميل");
  });
  it("the guard names the fields with a Latin word, «صف» or a dollar amount; a clean Arabic text passes", () => {
    expect(customerTextIssues({ subject: "جديد ديجر", heading: "عنوان عربي", body: "نص عربي كامل للعميل." })).toEqual([]);
    expect(customerTextIssues({ subject: "جديد Excel", heading: "عنوان عربي", body: "ستصلك ١٠ صف جديدة." }).map((i) => i.field)).toEqual(["subject", "body"]);
  });
  it("the content hash changes with any edit and not otherwise", () => {
    const a = { subject: "س", heading: "ع", body: "ن" };
    expect(messageContentHash(a)).toBe(messageContentHash({ ...a }));
    expect(messageContentHash(a)).not.toBe(messageContentHash({ ...a, body: "ن." }));
  });
  it("a draft needs a name; every field is cut to its limit; a missing table is recognised", () => {
    expect(parseDraft({ subject: "س" }).ok).toBe(false);
    const p = parseDraft({ name: "x", body: "ب".repeat(6000) });
    expect(p.ok && p.draft.body.length).toBe(5000);
    expect(isMissingTable({ code: "42P01" })).toBe(true);
    expect(isMissingTable({ code: "PGRST205" })).toBe(true);
    expect(isMissingTable({ code: "23505" })).toBe(false);
  });
});

describe("the campaign routes", () => {
  const list = async () => (await import("../src/app/api/admin/campaigns/route")).GET(req("/api/admin/campaigns"));
  const save = async (body: unknown) => (await import("../src/app/api/admin/campaigns/route")).POST(req("/api/admin/campaigns", body));
  const test = async (id = CID) => (await import("../src/app/api/admin/campaigns/[id]/test/route")).POST(req(`/api/admin/campaigns/${id}/test`, {}), { params: Promise.resolve({ id }) });

  it("not an admin: 401 from every handler, nothing stored, nothing sent", async () => {
    state.auth = "none";
    expect((await list()).status).toBe(401);
    expect((await save(GOOD)).status).toBe(401);
    expect((await test()).status).toBe(401);
    expect(state.rows).toEqual([]);
    expect(state.sent).toEqual([]);
  });
  it("before the migration is applied every handler answers 503 with the Arabic sentence and notReady", async () => {
    state.missing = true;
    for (const res of [await list(), await save(GOOD), await test()]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "تخزين الحملات لم يُفعَّل بعد.", notReady: true });
    }
    expect(state.sent).toEqual([]);
  });
  it("create, then save with the revision seen; a stale revision is refused (409) and changes nothing", async () => {
    const made = await (await save(GOOD)).json();
    expect(made.campaign).toMatchObject({ id: CID, revision: 1, status: "draft", audience: "news_opt_in", created_by: ADMIN_ID });
    const saved = await save({ ...GOOD, id: CID, revision: 1, body: "نص أحدث للعميل عن ملفات إكسل." });
    expect(saved.status).toBe(200);
    expect((await saved.json()).campaign.revision).toBe(2);
    const stale = await save({ ...GOOD, id: CID, revision: 1, body: "نص قديم من شاشة أخرى." });
    expect(stale.status).toBe(409);
    expect(state.rows[0].body).toBe("نص أحدث للعميل عن ملفات إكسل.");
  });
  it("the test goes ONLY to the admin's own address, with the name field filled, and is recorded with the text's hash", async () => {
    await save(GOOD);
    const res = await test();
    expect(res.status).toBe(200);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].to).toBe("owner@example.test");
    expect(state.sent[0].subject).toBe("[نسخة تجريبية] جديد ديجر هذا الشهر");
    expect(state.rows[0].test_content_hash).toBe((await res.json()).hash);
    expect(state.audits.some((a) => a[1] === "نسخة تجريبية لحملة")).toBe(true);
  });
  it("a Latin word, a provider name or «صف» in the text: refused with the guard sentence before anything is sent", async () => {
    for (const body of ["أرسلنا لك ملف Excel جديدًا اليوم.", "وصلتك ٢٠ صف جديدة من البيانات."]) {
      state.rows = []; state.sent = [];
      await save({ ...GOOD, body });
      const res = await test();
      expect(res.status, body).toBe(422);
      expect((await res.json()).fields).toContain("body");
      expect(state.sent, body).toEqual([]);
    }
  });
  it("an admin without an e-mail of his own gets a clear refusal; nothing is sent", async () => {
    state.adminEmail = "";
    await save(GOOD);
    expect((await test()).status).toBe(400);
    expect(state.sent).toEqual([]);
  });
  it("PR 1 has no route that sends a campaign to customers: the campaign folder holds only the list/save route and the test route", () => {
    const dir = join(process.cwd(), "src/app/api/admin/campaigns");
    const routes: string[] = [];
    const walk = (d: string, rel = "") => { for (const f of readdirSync(d, { withFileTypes: true })) { if (f.isDirectory()) walk(join(d, f.name), `${rel}${f.name}/`); else routes.push(`${rel}${f.name}`); } };
    if (existsSync(dir)) walk(dir);
    expect(routes.sort()).toEqual(["[id]/test/route.ts", "route.ts"]);
  });
});
