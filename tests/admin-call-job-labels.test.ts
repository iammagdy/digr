import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PHASE 1: the admin call logs say what each job is. Old rows (no capability, status or duration) get a label derived in the READ layer only
 * (a join to the job, the plan card and the conversation); nothing is written; admin only; nothing of it reaches a customer route.
 */
interface Db { costs: any[]; tables: Record<string, any[]>; writes: string[] }
const state = vi.hoisted(() => ({ user: null as any, client: null as any }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.client),
}));

import { GET as callsLogGet } from "../src/app/api/admin/calls-log/route";
import { GET as providerCallsGet } from "../src/app/api/admin/provider-calls/route";
import { GET as providerKeysGet } from "../src/app/api/admin/provider-keys/route";
import { readCallsLog, parseCallsLogQuery, readActivityJobContext } from "../src/lib/server/adminCallsLog";
import { adminCapabilityLabelAr, adminJobHref, deriveJobLabelAr, deriveStatusFromRow, NOT_RECORDED_AR } from "../src/lib/server/adminJobLabels";
import { flushProviderLimitsCache } from "../src/lib/server/providerLimits";

const ADMIN = { id: "admin-1", email: "owner@example.test", app_metadata: { role: "admin" }, user_metadata: { name: "المدير" } };
const U_TEST = "aaaaaaaa-0000-4000-8000-000000000001";
const U_REAL = "bbbbbbbb-0000-4000-8000-000000000002";

function makeClient(db: Db) {
  return {
    from: (table: string) => {
      const filters: Array<(r: any) => boolean> = []; let order: { c: string; asc: boolean } | null = null; let lim: number | null = null; let cols = "";
      const run = async (single = false) => {
        if (table === "provider_costs" && /capability|status|duration_ms/.test(cols) && db.costs.length && !("capability" in db.costs[0])) return { data: null, error: { code: "42703", message: 'column "capability" does not exist' } };
        let rows = (table === "provider_costs" ? db.costs : db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (order) { const { c, asc } = order; rows = [...rows].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1)); }
        if (lim !== null) rows = rows.slice(0, lim);
        return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
      };
      const b: any = {
        select: (c: string) => { cols = c; return b; },
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return b; },
        gte: (c: string, v: any) => { filters.push((r) => r[c] >= v); return b; },
        lt: (c: string, v: any) => { filters.push((r) => r[c] < v); return b; },
        in: (c: string, vs: any[]) => { filters.push((r) => vs.includes(r[c])); return b; },
        order: (c: string, o?: { ascending?: boolean }) => { order = { c, asc: o?.ascending !== false }; return b; },
        limit: (n: number) => { lim = n; return b; },
        range: (a: number, z: number) => { lim = z + 1; return b; },
        maybeSingle: () => run(true),
        insert: async () => { db.writes.push(`insert:${table}`); return { data: null, error: null }; },
        update: () => { db.writes.push(`update:${table}`); return b; },
        upsert: () => { db.writes.push(`upsert:${table}`); return b; },
        delete: () => { db.writes.push(`delete:${table}`); return b; },
        then: (resolve: any, reject: any) => run().then(resolve, reject),
      };
      return b;
    },
    rpc: async (name: string) => { db.writes.push(`rpc:${name}`); return { data: null, error: null }; },
  };
}

function seed(): Db {
  const cost = (id: number, provider: string, job: string | null, extra: Record<string, any> = {}) => ({ id, provider, job_id: job, units: 10, cost_usd: 0.0123, created_at: `2026-10-22T0${id % 9}:15:00.000Z`, is_estimate: false, capability: null, status: null, duration_ms: null, ...extra });
  return {
    costs: [
      cost(1, "treg", "job_tiktok"),                                                    // old TREG row, job is a TikTok comments job
      cost(2, "treg", "job_company"),                                                   // old TREG row, a company directory job (plan card text only)
      cost(3, "treg", "job_gone"),                                                      // old TREG row, job unknown
      cost(4, "treg", null),                                                            // old TREG row, no job
      cost(5, "treg", "job_tiktok", { capability: "social-tiktok-comments", status: "success", duration_ms: 812 }), // NEW TREG row
      cost(6, "treg", "job_tiktok", { units: 0, cost_usd: 0.0001 }),                    // old row with no units: status cannot be settled
      cost(7, "firecrawl", "job_tiktok", { capability: "firecrawl.scrape", status: "success", duration_ms: 90, units: 1 }),
    ],
    tables: {
      jobs: [
        { id: "job_tiktok", user_id: U_TEST, template_slug: "social-tiktok-comments", params: JSON.stringify({ query: "كرة السلة", region: "EG" }) },
        { id: "job_company", user_id: U_REAL, template_slug: "icypeas-companies-search", params: "not json" },
      ],
      plans_quotes: [{ id: "q1", job_id: "job_company", conversation_id: "c1", summary_ar: "شركات الكهرباء في مصر", items: [] }],
      conversations: [{ id: "c1", title: "قائمة شركات" }],
      profiles: [{ id: U_TEST, email: "iam.magdy+1@outlook.com", name: "حساب اختبار" }, { id: U_REAL, email: "real.customer@example.com", name: "عميل" }],
      settings_private: [],
    },
    writes: [],
  };
}

let db: Db;
const req = (url: string) => new NextRequest(`http://localhost${url}`);
beforeEach(() => { db = seed(); state.client = makeClient(db); state.user = ADMIN; flushProviderLimitsCache(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("labels: a short Arabic job label from what the job itself says", () => {
  it("a TikTok comments job: «تعليقات تيك توك — كرة السلة»", () => {
    expect(deriveJobLabelAr({ job: { template_slug: "social-tiktok-comments", params: JSON.stringify({ query: "كرة السلة" }) } })).toBe("تعليقات تيك توك — كرة السلة");
  });
  it("other kinds and platforms", () => {
    expect(deriveJobLabelAr({ job: { template_slug: "social-x-posts", params: { query: "ترند كأس العالم" } } })).toBe("منشورات منصة إكس — ترند كأس العالم");
    expect(deriveJobLabelAr({ job: { template_slug: "social-facebook-posts", params: { channel: "https://www.facebook.com/youm7" } } })).toBe("منشورات فيسبوك"); // a link is never shown in a label
    expect(deriveJobLabelAr({ job: { template_slug: "icypeas-companies-search", params: { industry: "كهرباء", country: "مصر" } } })).toBe("دليل الشركات — كهرباء — مصر");
  });
  it("falls back to the plan card text, then the conversation title; markdown symbols never reach the label", () => {
    expect(deriveJobLabelAr({ job: { template_slug: "unknown-slug" }, quote: { summary_ar: "## شركات **الكهرباء**" } })).toBe("شركات الكهرباء");
    expect(deriveJobLabelAr({ job: {}, conversationTitle: "قائمة شركات" })).toBe("قائمة شركات");
  });
  it("returns null when nothing can be read (the screen then says «غير مسجّل (قبل التحديث)»)", () => {
    expect(deriveJobLabelAr({})).toBeNull();
    expect(deriveJobLabelAr({ job: { params: "{" } })).toBeNull();
  });
  it("capability ids: the data-provider catalog, the social slugs, TREG's own slugs; an unknown id is shown as it is", () => {
    expect(adminCapabilityLabelAr("firecrawl.scrape")).toBe("قراءة صفحة (Firecrawl)");
    expect(adminCapabilityLabelAr("social-tiktok-comments")).toBe("استخراج تعليقات فيديوهات تيك توك (TREG)");
    expect(adminCapabilityLabelAr("icypeas-companies-search")).toBe("دليل الشركات (TREG)");
    expect(adminCapabilityLabelAr("icypeas-people-search")).toBe("صناع القرار (TREG)");
    expect(adminCapabilityLabelAr("something-else")).toBe("something-else");
    expect(adminCapabilityLabelAr("")).toBeNull();
    expect(adminCapabilityLabelAr(null)).toBeNull();
  });
  it("an old row's status is settled only when the row itself says so", () => {
    expect(deriveStatusFromRow({ units: 3, isEstimate: false })).toBe("success");
    expect(deriveStatusFromRow({ units: 0, isEstimate: false })).toBeNull();
    expect(deriveStatusFromRow({ units: 3, isEstimate: true })).toBeNull();
    expect(NOT_RECORDED_AR).toBe("غير مسجّل (قبل التحديث)");
    expect(adminJobHref("job_a/b")).toBe("/admin/jobs?job=job_a%2Fb");
  });
});

describe("the calls log (all providers): old rows get a label, the user with the test badge, and the link", () => {
  it("an old TREG row: raw fields stay null (never invented), the derived ones come from the job", async () => {
    const log = await readCallsLog(makeClient(db), parseCallsLogQuery(new URLSearchParams("provider=treg")) .ok ? (parseCallsLogQuery(new URLSearchParams("provider=treg")) as any).value : null);
    const byId = new Map(log.rows.map((r) => [r.id, r]));
    const tiktok = byId.get(1)!;
    expect(tiktok).toMatchObject({ capabilityLabelAr: null, status: null, durationMs: null });
    expect(tiktok).toMatchObject({ jobLabelAr: "تعليقات تيك توك — كرة السلة", capabilityDerivedAr: "استخراج تعليقات فيديوهات تيك توك (TREG)", statusDerived: "success", userEmail: "iam.magdy+1@outlook.com", isTestAccount: true, jobHref: "/admin/jobs?job=job_tiktok" });
    const company = byId.get(2)!;
    expect(company).toMatchObject({ jobLabelAr: "شركات الكهرباء في مصر", userEmail: "real.customer@example.com", isTestAccount: false });
  });
  it("nothing derivable stays null, no row is invented: unknown job, no job, a committed row with no units", async () => {
    const log = await readCallsLog(makeClient(db), (parseCallsLogQuery(new URLSearchParams("provider=treg")) as any).value);
    const byId = new Map(log.rows.map((r) => [r.id, r]));
    // job unknown: no label, no capability, no owner; the row's own units still settle that a committed row with units was a success
    expect(byId.get(3)).toMatchObject({ jobLabelAr: null, capabilityDerivedAr: null, statusDerived: "success", userEmail: null, isTestAccount: false, jobHref: "/admin/jobs?job=job_gone" });
    expect(byId.get(4)).toMatchObject({ jobLabelAr: null, jobHref: null, capabilityDerivedAr: null });
    expect(byId.get(6)).toMatchObject({ statusDerived: null, capabilityDerivedAr: "استخراج تعليقات فيديوهات تيك توك (TREG)" });
  });
  it("a NEW TREG row carries its own capability (Arabic), status and duration; nothing is derived over it", async () => {
    const log = await readCallsLog(makeClient(db), (parseCallsLogQuery(new URLSearchParams("provider=treg")) as any).value);
    const fresh = log.rows.find((r) => r.id === 5)!;
    expect(fresh).toMatchObject({ capabilityLabelAr: "استخراج تعليقات فيديوهات تيك توك (TREG)", status: "success", durationMs: 812, capabilityDerivedAr: null, statusDerived: null });
  });
  it("is read only: no write and no database function", async () => {
    await readCallsLog(makeClient(db), (parseCallsLogQuery(new URLSearchParams("")) as any).value);
    expect(db.writes).toEqual([]);
  });
});

describe("the per-provider tab: the call log and the recent activity", () => {
  it("/api/admin/provider-calls: every row also carries job label, owner, test flag and link; the existing fields are as before", async () => {
    const res = await providerCallsGet(req("/api/admin/provider-calls?provider=treg"));
    expect(res.status).toBe(200);
    const { log } = await res.json();
    const first = log.rows.find((r: any) => r.id === 1);
    expect(first).toMatchObject({ capabilityLabelAr: null, status: null, durationMs: null, jobLabelAr: "تعليقات تيك توك — كرة السلة", userEmail: "iam.magdy+1@outlook.com", isTestAccount: true, jobHref: "/admin/jobs?job=job_tiktok", statusDerived: "success" });
    expect(db.writes).toEqual([]);
  });
  it("the Firecrawl rows get the same job context (the job's own label)", async () => {
    const res = await providerCallsGet(req("/api/admin/provider-calls?provider=firecrawl"));
    const { log } = await res.json();
    expect(log.rows[0]).toMatchObject({ capabilityLabelAr: "قراءة صفحة (Firecrawl)", jobLabelAr: "تعليقات تيك توك — كرة السلة", jobHref: "/admin/jobs?job=job_tiktok" });
  });
  it("«آخر النشاط»: the recent rows of a data provider, in order, each with label, email, badge and link (a separate list; the tab's own state is untouched)", async () => {
    const rows = await readActivityJobContext(makeClient(db), "treg");
    expect(rows.length).toBe(6);
    expect(rows[0]).toHaveProperty("at");
    const withJob = rows.find((r) => r.jobId === "job_company")!;
    expect(withJob).toMatchObject({ jobLabelAr: "شركات الكهرباء في مصر", userEmail: "real.customer@example.com", jobHref: "/admin/jobs?job=job_company" });
    expect(rows.find((r) => r.jobId === "job_tiktok")).toMatchObject({ isTestAccount: true });
  });
  it("the provider-keys route adds the list for data providers and nothing for the model", async () => {
    // No network of any kind: the provider status read gets an immediate refusal.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const res = await providerKeysGet(req("/api/admin/provider-keys?provider=treg"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.activityJobs.length).toBe(6);
    expect(json.state.provider).toBe("treg");
    expect(json.state.activity).toHaveLength(6);
    const llm = await providerKeysGet(req("/api/admin/provider-keys?provider=anthropic"));
    expect(llm.status).toBe(200);
    expect((await llm.json()).activityJobs).toEqual([]);
  });
});

describe("admin only", () => {
  it("401 signed out and 403 for a customer on the routes that carry job labels and emails; the refusal names nothing", async () => {
    for (const [handler, url] of [[callsLogGet, "/api/admin/calls-log"], [providerCallsGet, "/api/admin/provider-calls?provider=treg"], [providerKeysGet, "/api/admin/provider-keys?provider=treg"]] as const) {
      state.user = null;
      expect((await handler(req(url))).status).toBe(401);
      state.user = { id: U_REAL, email: "real.customer@example.com", app_metadata: {}, user_metadata: {} };
      const res = await handler(req(url));
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toMatch(/jobLabelAr|userEmail|iam\.magdy|treg|firecrawl|activityJobs/i);
    }
  });
});

describe("customer side: none of this is reachable or importable", () => {
  const ROOT = process.cwd();
  const walk = (dir: string, out: string[] = []): string[] => { for (const n of readdirSync(dir)) { const p = path.join(dir, n); if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n)) out.push(p); } return out; };
  const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
  const customer = [...walk(path.join(ROOT, "src/app")), ...walk(path.join(ROOT, "src/components"))].map(rel).filter((f) =>
    !f.startsWith("src/app/admin/") && !f.startsWith("src/app/api/admin/") && !f.startsWith("src/app/api/worker/") && !f.startsWith("src/app/api/cron/") && !f.startsWith("src/components/admin/"));
  const VOCAB = /adminJobLabels|JobCell|activityJobs|jobLabelAr|capabilityDerivedAr|statusDerived|readActivityJobContext|withJobContext|resolveJobContexts|مُستنتج|قبل التحديث/;

  it("no customer route, page or component names the admin job labels, the job cell, the derived fields or the new wording", () => {
    expect(customer.filter((f) => VOCAB.test(readFileSync(path.join(ROOT, f), "utf8")))).toEqual([]);
  });
  it("the admin label module is imported only by admin routes, admin components and server modules of the admin logs and the failures board", () => {
    const importers = walk(path.join(ROOT, "src")).map(rel).filter((f) => /adminJobLabels/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(importers.every((f) => /^src\/(app\/api\/admin\/|app\/admin\/|components\/admin\/|lib\/server\/(adminCallsLog|adminJobLabels|failureBoard|multiProvider\/callLog))/.test(f)), importers.join(", ")).toBe(true);
  });
  it("the customer metadata route answers none of the new fields", async () => {
    const { GET } = await import("../src/app/api/chat/metadata/route");
    const text = JSON.stringify(await (await GET(new NextRequest("http://localhost/api/chat/metadata"))).json());
    expect(text).not.toMatch(/jobLabelAr|capabilityDerivedAr|statusDerived|jobHref|activityJobs|userEmail/);
  });
});

describe("the screens", () => {
  it("the job cell: Arabic label as a link to the job, the email, the test badge; a job that cannot be read still shows its short id", async () => {
    const { JobCell } = await import("../src/components/admin/JobCell");
    const full = renderToStaticMarkup(createElement(JobCell, { info: { jobId: "job_tiktok_12345678", jobLabelAr: "تعليقات تيك توك — كرة السلة", userEmail: "iam.magdy+1@outlook.com", isTestAccount: true, jobHref: "/admin/jobs?job=job_tiktok_12345678" } }));
    expect(full).toContain('href="/admin/jobs?job=job_tiktok_12345678"');
    expect(full).toContain("تعليقات تيك توك — كرة السلة");
    expect(full).toContain("iam.magdy+1@outlook.com");
    expect(full).toContain("حساب تجريبي");
    const bare = renderToStaticMarkup(createElement(JobCell, { info: { jobId: "job_tiktok_12345678" } }));
    expect(bare).toContain("مهمة ١٢٣٤٥٦٧٨");
    expect(bare).not.toContain("حساب تجريبي");
    expect(renderToStaticMarkup(createElement(JobCell, { info: { jobId: null } }))).toContain("—");
  });
  it("the three screens use the cell and the honest wording for old rows", () => {
    for (const file of ["src/components/admin/ProviderCallLog.tsx", "src/components/admin/AllCallsLog.tsx"]) {
      const text = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(text, file).toContain("JobCell");
      expect(text, file).toContain("NOT_RECORDED");
    }
    expect(readFileSync(path.join(process.cwd(), "src/components/admin/ProviderTab.tsx"), "utf8")).toContain("JobCell");
    expect(readFileSync(path.join(process.cwd(), "src/components/admin/JobCell.tsx"), "utf8")).toContain("غير مسجّل (قبل التحديث)");
  });
  it("the jobs page opens one job from a call-log link", () => {
    const text = readFileSync(path.join(process.cwd(), "src/app/admin/jobs/page.tsx"), "utf8");
    expect(text).toContain('get("job")');
    expect(readFileSync(path.join(process.cwd(), "src/app/api/admin/jobs/route.ts"), "utf8")).toContain('get("job")');
  });
});
