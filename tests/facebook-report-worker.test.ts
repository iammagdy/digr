/**
 * The Facebook topic REPORT through the REAL worker route: spec resolution, the chunked collector (browse, comments, classify), the llm_usage rows of the one batched model call,
 * the assembly of the Excel and the methodology PDF from the saved record, the shortfall sentence, and the settlement arithmetic (the mocked settlement applies the money rule:
 * charge = ceil(delivered x unit price), never above the hold). The sources are the FAKE world of helpers/fakeFacebookReport.ts; the model is a fake. No provider, no model, no SQL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  jobs: [] as any[],
  quotes: [] as any[],
  partials: new Map<string, Buffer>(),
  results: new Map<string, Buffer>(),
  rpcCalls: [] as Array<{ name: string; args: any }>,
  events: [] as any[],
  step: 0,
  cursor: null as string | null,
  deliveredUnits: 0,
  targetVolumeMax: 20,
  unitPrice: 9,
  reserved: 207,
  slug: "social-youtube-comments",
  /** What `llm_usage` answers to the daily review guard: costs of today's review rows (null = the table is not stubbed), a failing read, and how many reads were made. */
  usage: { rows: null as number[] | null, fail: false, reads: 0 },
}));

function builder(rows: () => any[]) {
  const filters: Array<[string, unknown]> = [];
  const apply = () => rows().filter((row) => filters.every(([col, val]) => row[col] === val));
  const api: any = {
    select: () => api,
    eq: (col: string, val: unknown) => { filters.push([col, val]); return api; },
    in: () => api, or: () => api, not: () => api, order: () => api, limit: () => api,
    maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
    then: (resolve: any, reject: any) => Promise.resolve({ data: apply(), error: null }).then(resolve, reject),
  };
  return api;
}

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async (name: string, args: any) => {
      db.rpcCalls.push({ name, args });
      if (name === "claim_job_chunk") {
        return { data: { claimed: true, job_id: args.p_job_id, user_id: "user_1", step: db.step, current_cursor: db.cursor, delivered_units: db.deliveredUnits, target_volume_max: db.targetVolumeMax, target_volume_min: 1, endpoint_id: db.slug, unit_price: db.unitPrice }, error: null };
      }
      if (name === "reserve_provider_spend_atomic") return { data: { allowed: true, cost_id: 11 }, error: null };
      if (name === "commit_provider_spend") return { data: { success: true }, error: null };
      if (name === "complete_chunk") {
        db.step += 1;
        db.deliveredUnits = args.p_new_delivered_units;
        db.cursor = args.p_new_cursor;
        const job = db.jobs.find((row) => row.id === args.p_job_id);
        if (job) Object.assign(job, { current_cursor: db.cursor, delivered_units: db.deliveredUnits, status: "running" });
        return { data: { success: true, delivered_units: db.deliveredUnits }, error: null };
      }
      if (name === "settle_job_atomic") {
        const charged = Math.min(Math.ceil(db.deliveredUnits * db.unitPrice), db.reserved);
        return { data: { success: true, charged_credits: charged, refunded_credits: db.reserved - charged }, error: null };
      }
      if (name === "release_job_atomic") return { data: { success: true, released_credits: db.reserved }, error: null };
      return { data: { success: true }, error: null };
    }),
    storage: {
      from: (bucket: string) => {
        const store = bucket === "partials" ? db.partials : db.results;
        return {
          upload: async (path: string, body: any) => { store.set(path, Buffer.isBuffer(body) ? body : Buffer.from(String(body))); return { data: { path }, error: null }; },
          download: async (path: string) => {
            const buf = store.get(path);
            return buf ? { data: new Blob([new Uint8Array(buf)]), error: null } : { data: null, error: { message: "not_found" } };
          },
          remove: async (paths: string[]) => { for (const p of paths) store.delete(p); return { data: paths, error: null }; },
        };
      },
    },
    from: (table: string) => {
      if (table === "jobs") return builder(() => db.jobs);
      if (table === "plans_quotes") return builder(() => db.quotes);
      if (table === "llm_usage" && db.usage.rows !== null) {
        const chain: any = {
          select: () => chain, like: () => chain, gte: () => chain, order: () => chain,
          range: async () => { db.usage.reads += 1; return db.usage.fail ? { data: null, error: { message: "read failed" } } : { data: (db.usage.rows ?? []).map((cost_usd) => ({ cost_usd })), error: null }; },
          insert: async (row: any) => ({ data: row, error: null }),
        };
        return chain;
      }
      if (table === "job_events" || table === "notifications" || table === "artifact_versions") {
        const base = builder(() => (table === "job_events" ? db.events : []));
        return { ...base, insert: async (row: any) => { if (table === "job_events") db.events.push(row); return { data: row, error: null }; }, upsert: async (row: any) => ({ data: row, error: null }) };
      }
      return builder(() => []);
    },
  })),
}));

// The capability is gated on the owner's review of at least one Page (see FACEBOOK_REPORT_ENABLED). These tests exercise the report itself, so they switch the gate on; tests/facebook-report-gate.test.ts proves what happens with it off.
vi.mock("../src/lib/facebookReport/registry", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/facebookReport/registry")>()), FACEBOOK_REPORT_ENABLED: true }));

vi.mock("../src/lib/server/sendPlatformEmail", () => ({
  sendPlatformEmail: vi.fn(async () => undefined),
  getRecipient: vi.fn(async () => null),
}));

vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

import { jobIdForQuote } from "../src/lib/server/retryReuse";
import { setProviderAdapterForTesting } from "../src/lib/server/tregAdapter";
import { setRelativeDateClockForTesting } from "../src/lib/server/relativeDate";
import { setAxisModelForTesting } from "../src/lib/server/facebookReportAxisModel";
import { chargeForUnits, reserveForUnits, recordUnitPricePoints } from "../src/lib/recordPricing";
import { FACEBOOK_PAGE_REGISTRY } from "../src/lib/facebookReport/registry";
import { facebookReportWorld, postUrl, DAY_MS, type WorldPage, type WorldPost } from "./helpers/fakeFacebookReport";
import { runFacebookReportChunk } from "../src/lib/server/facebookReportAdapter";
import { createFakeProviderAdapter } from "../src/lib/server/fakeSocialSource";
import ExcelJS from "exceljs";

const SLUG = "facebook-topic-report";
const UNIT = recordUnitPricePoints(SLUG)!;
const JOB = jobIdForQuote("quote_fb_report");
const END = Date.parse("2026-10-23T12:00:00Z");
const PARAMS = { query: "الترندات الصحية", region: "EG", dateFrom: "2026-07-24", dateTo: "2026-10-24", videoCount: 20, perVideo: 5 };
const urls = Object.fromEntries(FACEBOOK_PAGE_REGISTRY.map((entry) => [entry.id, entry.url]));
const usableIds = ["eg_health_el_consolto", "eg_health_drug_authority", "eg_health_medical_syndicate", "eg_health_cairo24", "eg_health_masrawy"];
const TEXTS = ["أعراض الجلطة القلبية وأمراض القلب: متى تذهب للطوارئ", "حقن التخسيس واوزمبيك: ماذا يقول الأطباء", "نواقص الأدوية وأسعار الأدوية وبدائل الدواء", "لقاح الانفلونزا ومصل الانفلونزا للكبار", "ارتجاع المريء وحرقان المعدة والقولون"];

const posts = (count: number, from = 0): WorldPost[] => Array.from({ length: count }, (_, i) => ({ n: from + i, dateMs: END - i * DAY_MS, reactions: 20 + i, comments: 8, shares: 2, text: TEXTS[(from + i) % TEXTS.length] }));
const page = (id: string, list: WorldPost[], mode: WorldPage["mode"] = "ok"): WorldPage => ({ url: urls[id], posts: list, mode, perCall: 3 });

function resetDb(params: Record<string, unknown>, target: number) {
  db.slug = SLUG;
  db.jobs = [{ id: JOB, status: "running", current_cursor: null, delivered_units: 0, target_volume_max: target, created_at: new Date().toISOString() }];
  db.quotes = [{ id: "quote_fb_report", user_id: "user_1", items: [{ capabilitySlug: SLUG, endpointId: SLUG, params, targetVolumeMax: target, paginationStrategy: "cursor", unitCostUsd: 0.00055, pricingUnit: "item" }], output_formats: ["xlsx", "pdf"] }];
  db.partials.clear();
  db.results.clear();
  db.rpcCalls = [];
  db.events = [];
  db.usage = { rows: null, fail: false, reads: 0 };
  db.step = 0;
  db.cursor = null;
  db.deliveredUnits = 0;
  db.targetVolumeMax = target;
  db.unitPrice = UNIT;
  db.reserved = reserveForUnits(target, UNIT);
}

describe("worker: the Facebook topic report", () => {
  let originalEnv: Record<string, string | undefined>;
  beforeEach(() => {
    originalEnv = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "social-test-secret";
    process.env.ENABLE_MOCK_PROVIDER = "true";
    (process.env as any).NODE_ENV = "test";
    process.env.VERCEL_ENV = "development";
    setRelativeDateClockForTesting(() => END);
  });
  afterEach(() => {
    setProviderAdapterForTesting(null);
    setAxisModelForTesting(null);
    setRelativeDateClockForTesting(null);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete (process.env as any)[key];
      else (process.env as any)[key] = value;
    }
  });

  const useWorld = (world: ReturnType<typeof facebookReportWorld>) =>
    setProviderAdapterForTesting(async (input: any) => runFacebookReportChunk(input, { call: world.call, store: input.reportStore, axisModel: input.axisModel, now: () => 0 }));

  const callWorker = async () => {
    const route = await import("../src/app/api/worker/chunk/route");
    const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
      method: "POST",
      headers: { authorization: "Bearer social-test-secret" },
      body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
    }));
    return { status: res.status, json: await res.json() };
  };
  const runAllChunks = async (maxChunks = 200) => {
    let last: { status: number; json: any } = { status: 0, json: {} };
    let chunks = 0;
    for (; chunks < maxChunks; chunks++) {
      last = await callWorker();
      if (last.json.done || last.json.released || last.status >= 400) { chunks += 1; break; }
    }
    return { ...last, chunks };
  };
  const lines = () => db.events.map((event) => String(event.message));

  it("a 100-comment report (20 posts x 5): done, ONE item, files built from the saved record, the charge is ceil(100 x 3.025) = 303, below the hold, comments never judged", async () => {
    resetDb(PARAMS, 100);
    const world = facebookReportWorld({ pages: usableIds.map((id) => page(id, posts(60))) });
    useWorld(world);
    // a model that is never needed: every post's own words place it (and if it were asked, it would be shown posts, never a comment)
    const asked: string[][] = [];
    setAxisModelForTesting(async ({ posts: batch }) => { asked.push(batch.map((p) => p.text)); return { ok: true, axes: {} }; });

    const { status, json, chunks } = await runAllChunks();

    expect(status).toBe(200);
    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(100);
    expect(db.rpcCalls.some((c) => c.name === "release_job_atomic")).toBe(false);
    // the money rule, exact
    expect(UNIT).toBe(3.025);
    expect(json.settle.charged_credits).toBe(chargeForUnits(100, UNIT));
    expect(json.settle.charged_credits).toBe(303);
    expect(json.settle.charged_credits).toBeLessThanOrEqual(db.reserved);
    expect(json.settle.refunded_credits).toBe(db.reserved - 303);
    // the collector asked for comments of the kept posts only, never searched (no supplement was needed)
    expect(world.count("justoneapi.x.facebook-search-post-v1")).toBe(0);
    expect(world.count("scrapecreators.x.v1-facebook-post-comments")).toBeGreaterThanOrEqual(20);
    // no comment went to any model
    expect(asked.flat().every((text) => !/تعليق رقم/.test(text))).toBe(true);
    // the files: the workbook and the methodology PDF, both from the saved record
    const workbookBytes = db.results.get(`user_1/${JOB}/result.xlsx`);
    const pdfBytes = db.results.get(`user_1/${JOB}/report.pdf`) ?? [...db.results.entries()].find(([key]) => key.endsWith(".pdf"))?.[1];
    expect(workbookBytes).toBeDefined();
    expect(pdfBytes).toBeDefined();
    expect(pdfBytes!.subarray(0, 5).toString()).toBe("%PDF-");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(workbookBytes as any);
    expect(workbook.getWorksheet("التعليقات")!.rowCount).toBe(101);
    expect(workbook.getWorksheet("المنشورات")!.rowCount).toBe(21);
    // the posts are balanced: no Page holds more than 20% of the delivered posts
    const publishers = new Map<string, number>();
    workbook.getWorksheet("المنشورات")!.eachRow((row, n) => { if (n > 1) publishers.set(String(row.getCell(4).value), (publishers.get(String(row.getCell(4).value)) ?? 0) + 1); });
    expect(Math.max(...publishers.values())).toBeLessThanOrEqual(4);
    expect(publishers.size).toBe(5);
    // the progress chunks (browse and classify, which deliver no row) never stopped the job as «empty pages»: it ran to its target
    expect(chunks).toBeGreaterThanOrEqual(2);
    // no stored record is left behind once the job is settled
    expect([...db.partials.keys()].filter((key) => key.includes("fbreport_state_"))).toEqual([]);
    // nothing a customer reads names a provider, an endpoint or an amount
    for (const line of lines()) expect(line).not.toMatch(/anyapi|scrapecreators|justoneapi|treg|usd|\$/i);
  });

  it("a Page that is not found and a Page with no posts are skipped and counted; the job still delivers, and says in ONE Arabic sentence what fell short, charging only what was delivered", async () => {
    resetDb({ ...PARAMS, videoCount: 20, perVideo: 5 }, 100);
    const world = facebookReportWorld({ pages: [
      page("eg_health_el_consolto", posts(6)),
      page("eg_health_drug_authority", [], "not_found"),
      page("eg_health_medical_syndicate", [], "empty"),
      page("eg_health_cairo24", posts(6)),
      page("eg_health_masrawy", posts(6)),
    ] });
    useWorld(world);
    setAxisModelForTesting(async () => ({ ok: true, axes: {} }));

    const { json } = await runAllChunks();

    expect(json.done).toBe(true);
    // 18 posts at most exist in the window, five comments each at most: fewer than the 100 asked for
    expect(json.deliveredUnits).toBeLessThan(100);
    expect(json.deliveredUnits).toBeGreaterThan(0);
    expect(json.settle.charged_credits).toBe(chargeForUnits(json.deliveredUnits, UNIT));
    expect(json.settle.charged_credits).toBeLessThanOrEqual(db.reserved);
    const shortfall = lines().find((line) => line.startsWith(`المسلَّم ${String(json.deliveredUnits).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)])} من ١٠٠ مطلوب`));
    expect(shortfall).toBeDefined();
    expect(shortfall).toContain("تصفّحنا");
    expect(shortfall).toContain("لا يُحتسب عليك إلا ما سُلّم فعلًا");
    expect(shortfall).not.toMatch(/[A-Za-z]/);
  });

  it("nothing found at all: the whole hold is released, nothing is charged", async () => {
    resetDb(PARAMS, 100);
    const world = facebookReportWorld({ pages: usableIds.map((id) => page(id, [], "empty")) });
    useWorld(world);
    setAxisModelForTesting(async () => ({ ok: true, axes: {} }));

    const { json } = await runAllChunks();

    expect(json.released).toBe(true);
    expect(json.chargedCredits).toBe(0);
    expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
    expect(String(json.error)).not.toMatch(/[A-Za-z]/);
  });

  it("the PREVIEW fake provider serves the report too: the real collector on a fake Page source, the whole job through the real worker, 100 comments, the same money rule", async () => {
    resetDb(PARAMS, 100);
    setProviderAdapterForTesting(createFakeProviderAdapter({ commentsPerVideo: 1, videos: 1, pageSize: 20, latencyMs: 0 }, () => END));
    setAxisModelForTesting(async () => ({ ok: true, axes: {} }));

    const { json } = await runAllChunks();

    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(100);
    expect(json.settle.charged_credits).toBe(303);
    expect(db.results.get(`user_1/${JOB}/result.xlsx`)).toBeDefined();
  });
});
