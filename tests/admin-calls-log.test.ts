import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ExcelJS from "exceljs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The admin CALLS LOG: every provider call with the user behind it. Admin only, read only. The database here is an in-memory fake that
 * records every write it is asked to perform, so «read only» is checked, not assumed.
 */
interface CostRow { id: number; provider: string; job_id: string | null; units: number; cost_usd: number; created_at: string; is_estimate: boolean; capability?: string | null; status?: string | null; duration_ms?: number | null }
interface Db { costs: CostRow[]; jobs: Array<{ id: string; user_id: string }>; profiles: Array<Record<string, any>>; settings: Array<{ key: string; value: any }>; metadata: boolean; writes: string[] }

const state = vi.hoisted(() => ({ user: null as any, client: null as any }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.client),
}));

import { GET as listGet } from "../src/app/api/admin/calls-log/route";
import { GET as exportGet } from "../src/app/api/admin/calls-log/export/route";
import { CALLS_LOG_PAGE_SIZE, EXPORT_MAX_ROWS, parseCallsLogQuery, readCallsLog, readFilteredCalls, summarizeCalls, type CallsLogResult, type CallsLogRow } from "../src/lib/server/adminCallsLog";
import { EXPORT_COLUMNS, neutralizeCell, toCsv, toXlsx } from "../src/lib/server/callsLogExport";
import { TEST_ACCOUNT_EMAILS, TEST_ACCOUNT_IDS, isTestAccount } from "../src/lib/server/testAccounts";
import { flushProviderLimitsCache } from "../src/lib/server/providerLimits";

const ADMIN = { id: "admin-1", email: "owner@example.test", app_metadata: { role: "admin" }, user_metadata: { name: "المدير" } };
const U_TEST = "aaaaaaaa-0000-4000-8000-000000000001";
const U_REAL = "bbbbbbbb-0000-4000-8000-000000000002";
const U_EVIL = "cccccccc-0000-4000-8000-000000000003";
const EVIL_NAME = '=HYPERLINK("http://evil.example","click")';

function makeClient(db: Db) {
  const client: any = {
    from: (table: string) => {
      const filters: Array<(r: any) => boolean> = [];
      let order: { c: string; asc: boolean } | null = null; let lim: number | null = null; let off = 0; let cols = "";
      const source = () => (table === "provider_costs" ? db.costs : table === "jobs" ? db.jobs : table === "profiles" ? db.profiles : table === "settings_private" ? db.settings : []);
      const run = async (single = false) => {
        if (table === "provider_costs" && !db.metadata && /capability|status|duration_ms/.test(cols)) return { data: null, error: { code: "42703", message: 'column "capability" does not exist' } };
        let rows = (source() as any[]).filter((r) => filters.every((f) => f(r)));
        if (order) { const { c, asc } = order; rows = [...rows].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1)); }
        if (lim !== null) rows = rows.slice(off, off + lim);
        if (table === "provider_costs" && !db.metadata) rows = rows.map(({ capability, status, duration_ms, ...rest }) => rest);
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
        range: (a: number, z: number) => { off = a; lim = z - a + 1; return b; },
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
  return client;
}

const todayAt = (h: number) => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), h)).toISOString(); };

function seed(opts: { metadata?: boolean; extra?: number } = {}): Db {
  const costs: CostRow[] = [];
  let id = 1;
  const add = (provider: string, job: string | null, cost: number, at: string, status: string | null, cap: string | null, units = 1) =>
    costs.push({ id: id++, provider, job_id: job, units, cost_usd: cost, created_at: at, is_estimate: false, capability: cap, status, duration_ms: status ? 100 + id : null });
  // test user: firecrawl + contextdev, three days
  for (let i = 0; i < 12; i += 1) add("firecrawl", "job_t1", 0.005, `2026-10-2${i % 3}T${String(8 + (i % 10)).padStart(2, "0")}:00:00.000Z`, i % 4 === 0 ? "failed" : "success", "firecrawl.scrape");
  for (let i = 0; i < 8; i += 1) add("contextdev", "job_t1", 0.00254, `2026-10-21T${String(9 + i).padStart(2, "0")}:30:00.000Z`, i % 5 === 0 ? "empty" : "success", i === 0 ? "contextdev.search" : "contextdev.scrape");
  // real customer: treg (old rows without metadata) + firecrawl
  for (let i = 0; i < 6; i += 1) add("treg", "job_r1", 0.0123, `2026-10-22T0${i}:15:00.000Z`, null, null, 10);
  for (let i = 0; i < 4; i += 1) add("firecrawl", "job_r1", 0.01, `2026-10-22T1${i}:45:00.000Z`, "success", "firecrawl.search");
  // the evil name's job, and calls with no job
  add("firecrawl", "job_e1", 0.005, "2026-10-22T20:00:00.000Z", "success", "firecrawl.scrape");
  add("treg", null, 0.001, "2026-10-22T21:00:00.000Z", null, null);
  // today's rows (for spend vs limit)
  add("firecrawl", "job_r1", 0.01, todayAt(1), "success", "firecrawl.search");
  add("contextdev", "job_t1", 0.00254, todayAt(2), "success", "contextdev.scrape");
  // a provider the log must never list
  add("anthropic", "job_r1", 0.5, "2026-10-22T05:00:00.000Z", "success", null);
  for (let i = 0; i < (opts.extra ?? 0); i += 1) add("firecrawl", "job_t1", 0.001, `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00.000Z`, "success", "firecrawl.scrape");
  return {
    costs,
    jobs: [{ id: "job_t1", user_id: U_TEST }, { id: "job_r1", user_id: U_REAL }, { id: "job_e1", user_id: U_EVIL }],
    profiles: [
      { id: U_TEST, email: "iam.magdy+1@outlook.com", name: "حساب اختبار" },
      { id: U_REAL, email: "real.customer@example.com", name: "عميل حقيقي" },
      { id: U_EVIL, email: "evil@example.com", name: EVIL_NAME },
    ],
    settings: [{ key: "provider_limits", value: { dailyUsd: 0.8, firecrawlDailyUsd: 2, contextdevDailyUsd: 0 } }],
    metadata: opts.metadata !== false,
    writes: [],
  };
}

const req = (url: string) => new NextRequest(`http://localhost${url}`);
const listJson = async (qs = ""): Promise<CallsLogResult> => { const res = await listGet(req(`/api/admin/calls-log${qs ? `?${qs}` : ""}`)); expect(res.status).toBe(200); return (await res.json()).log; };
async function allPages(qs: string): Promise<CallsLogRow[]> {
  const first = await listJson(qs);
  const rows = [...first.rows];
  for (let p = 2; p <= Math.ceil(first.total / first.pageSize); p += 1) rows.push(...(await listJson(`${qs}${qs ? "&" : ""}page=${p}`)).rows);
  return rows;
}

let db: Db;
beforeEach(() => { db = seed(); state.client = makeClient(db); state.user = ADMIN; flushProviderLimitsCache(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("access: admin only, nothing for anyone else", () => {
  it("401 signed out, 403 for a customer, on the list and on both exports; no row, provider name or email in the refusal", async () => {
    for (const url of ["/api/admin/calls-log", "/api/admin/calls-log/export?format=csv", "/api/admin/calls-log/export?format=xlsx"]) {
      const handler = url.includes("export") ? exportGet : listGet;
      state.user = null;
      expect((await handler(req(url))).status).toBe(401);
      state.user = { id: "u1", email: "customer@example.com", app_metadata: {}, user_metadata: {} };
      const denied = await handler(req(url));
      expect(denied.status).toBe(403);
      expect(JSON.stringify(await denied.json())).not.toMatch(/firecrawl|contextdev|treg|usd|cost|iam\.magdy|real\.customer|job_/i);
    }
    // nothing was read for them
    expect(db.writes).toEqual([]);
  });

  it("400 for a bad provider, date, status, test value, job id or format", async () => {
    for (const qs of ["provider=nope", "from=2026-13-40", "to=yesterday", "from=2026-10-22&to=2026-10-01", "status=maybe", "test=both", "jobId=%3Cscript%3E"]) {
      expect((await listGet(req(`/api/admin/calls-log?${qs}`))).status, qs).toBe(400);
    }
    expect((await exportGet(req("/api/admin/calls-log/export?format=pdf"))).status).toBe(400);
    expect(parseCallsLogQuery(new URLSearchParams("")).ok).toBe(true);
  });
});

describe("rows: every provider, the user behind each call, test accounts marked", () => {
  it("lists only TREG, Firecrawl and Context.dev, newest first, each row with its owner and the test flag", async () => {
    const log = await listJson();
    const rows = await allPages("");
    expect(log.total).toBe(db.costs.filter((c) => c.provider !== "anthropic").length);
    expect(rows.every((r) => ["treg", "firecrawl", "contextdev"].includes(r.provider))).toBe(true);
    const times = rows.map((r) => r.at);
    expect([...times].sort().reverse()).toEqual(times);
    const t1 = rows.find((r) => r.jobId === "job_t1")!;
    expect(t1).toMatchObject({ userId: U_TEST, userEmail: "iam.magdy+1@outlook.com", userName: "حساب اختبار", isTestAccount: true });
    const r1 = rows.find((r) => r.jobId === "job_r1" && r.provider === "treg")!;
    expect(r1).toMatchObject({ userId: U_REAL, userEmail: "real.customer@example.com", isTestAccount: false, status: null, capabilityLabelAr: null, durationMs: null });
    const noJob = rows.find((r) => r.jobId === null)!;
    expect(noJob).toMatchObject({ userId: null, userEmail: null, isTestAccount: false });
    expect(rows.find((r) => r.capabilityLabelAr)?.capabilityLabelAr).toMatch(/[؀-ۿ]/);
  });

  it("test-account rules: the named accounts, plus-aliases of the doc'd test mailbox, the fixture users; never the owner's account", () => {
    expect(TEST_ACCOUNT_EMAILS).toContain("iam.magdy+1@outlook.com");
    expect(isTestAccount({ email: "iam.magdy+1@outlook.com" })).toBe(true);
    expect(isTestAccount({ email: "IAM.Magdy+1@Outlook.com" })).toBe(true);
    expect(isTestAccount({ email: "iam.magdy@outlook.com" })).toBe(true);
    expect(isTestAccount({ email: "iam.magdy+7@outlook.com" })).toBe(true);
    for (const id of TEST_ACCOUNT_IDS) expect(isTestAccount({ id })).toBe(true);
    expect(isTestAccount({ email: "magdy.saber@outlook.com" })).toBe(false);
    expect(isTestAccount({ email: "iam.magdy+1@evil.com" })).toBe(false);
    expect(isTestAccount({ email: "xiam.magdy+1@outlook.com" })).toBe(false);
    expect(isTestAccount({})).toBe(false);
  });
});

describe("filters", () => {
  const expectSubset = async (qs: string, predicate: (c: CostRow) => boolean) => {
    const rows = await allPages(qs);
    const expected = db.costs.filter((c) => c.provider !== "anthropic" && predicate(c)).map((c) => c.id).sort((a, b) => a - b);
    expect(rows.map((r) => r.id!).sort((a, b) => a - b), qs).toEqual(expected);
    return rows;
  };

  it("provider", async () => { for (const p of ["treg", "firecrawl", "contextdev"]) await expectSubset(`provider=${p}`, (c) => c.provider === p); });
  it("status", async () => { for (const s of ["success", "failed", "empty"]) await expectSubset(`status=${s}`, (c) => c.status === s); });
  it("date range, inclusive of the last day", async () => {
    await expectSubset("from=2026-10-21&to=2026-10-21", (c) => c.created_at.startsWith("2026-10-21"));
    await expectSubset("from=2026-10-22", (c) => c.created_at >= "2026-10-22");
    await expectSubset("to=2026-10-20", (c) => c.created_at < "2026-10-21");
  });
  it("user: by email, by part of the id, by name", async () => {
    await expectSubset("user=real.customer", (c) => c.job_id === "job_r1");
    await expectSubset(`user=${U_TEST.slice(0, 8)}`, (c) => c.job_id === "job_t1");
    await expectSubset(`user=${encodeURIComponent("حساب اختبار")}`, (c) => c.job_id === "job_t1");
    await expectSubset("user=nobody-here", () => false);
  });
  it("test / real", async () => {
    await expectSubset("test=test", (c) => c.job_id === "job_t1");
    const real = await expectSubset("test=real", (c) => c.job_id !== "job_t1");
    expect(real.every((r) => !r.isTestAccount)).toBe(true);
    await expectSubset("test=all", () => true);
  });
  it("job id", async () => { await expectSubset("jobId=job_e1", (c) => c.job_id === "job_e1"); await expectSubset("jobId=job_zzz", () => false); });
  it("filters combine", async () => {
    await expectSubset("provider=firecrawl&test=real&status=success&from=2026-10-22", (c) => c.provider === "firecrawl" && c.job_id !== "job_t1" && c.status === "success" && c.created_at >= "2026-10-22");
  });
  it("before the call metadata exists, the status filter is not applied and the screen is told", async () => {
    db = seed({ metadata: false }); state.client = makeClient(db);
    const log = await listJson("status=failed");
    expect(log.metadataAvailable).toBe(false);
    expect(log.statusFilterUnavailable).toBe(true);
    expect(log.total).toBe(db.costs.filter((c) => c.provider !== "anthropic").length);
    expect(log.rows.every((r) => r.status === null && r.capabilityLabelAr === null && r.durationMs === null)).toBe(true);
  });
});

describe("pagination (server side)", () => {
  it("pages of the fixed size, no row twice or missing, the last page holds the rest", async () => {
    db = seed({ extra: 130 }); state.client = makeClient(db);
    const total = db.costs.filter((c) => c.provider !== "anthropic").length;
    const p1 = await listJson("page=1"); const p2 = await listJson("page=2"); const last = await listJson(`page=${Math.ceil(total / CALLS_LOG_PAGE_SIZE)}`);
    expect(p1.total).toBe(total);
    expect(p1.rows).toHaveLength(CALLS_LOG_PAGE_SIZE);
    expect(p2.rows).toHaveLength(CALLS_LOG_PAGE_SIZE);
    expect(last.rows).toHaveLength(total - CALLS_LOG_PAGE_SIZE * (Math.ceil(total / CALLS_LOG_PAGE_SIZE) - 1));
    const all = await allPages("");
    expect(new Set(all.map((r) => r.id)).size).toBe(total);
    expect((await listJson(`page=${Math.ceil(total / CALLS_LOG_PAGE_SIZE) + 5}`)).rows).toEqual([]);
  });
});

describe("summary equals the sum of the filtered rows", () => {
  it.each(["", "provider=firecrawl", "test=real", "test=test&status=success", "from=2026-10-22&to=2026-10-22", "user=real.customer&provider=treg"])("filters «%s»", async (qs) => {
    const log = await listJson(qs);
    const rows = await allPages(qs);
    expect(log.summary.calls).toBe(rows.length);
    expect(log.summary.costUsd).toBeCloseTo(rows.reduce((a, r) => a + r.costUsd, 0), 9);
    for (const p of ["treg", "firecrawl", "contextdev"] as const) {
      const mine = rows.filter((r) => r.provider === p);
      expect(log.summary.byProvider[p].calls).toBe(mine.length);
      expect(log.summary.byProvider[p].costUsd).toBeCloseTo(mine.reduce((a, r) => a + r.costUsd, 0), 9);
      expect(log.summary.byProvider[p].lastCallAt).toBe(mine.length ? mine.map((r) => r.at).sort().at(-1) : null);
    }
    const { success, failed, empty, unknown } = log.summary.byStatus;
    expect(success + failed + empty + unknown).toBe(rows.length);
    expect(failed).toBe(rows.filter((r) => r.status === "failed").length);
    expect(unknown).toBe(rows.filter((r) => r.status === null).length);
  });

  it("spend today against each provider's daily limit: today's recorded sum and the limit in force", async () => {
    const log = await listJson();
    const today = (p: string) => db.costs.filter((c) => c.provider === p && c.created_at >= todayAt(0)).reduce((a, c) => a + c.cost_usd, 0);
    const by = Object.fromEntries(log.spendToday.map((s) => [s.provider, s]));
    expect(by.firecrawl.todayUsd).toBeCloseTo(today("firecrawl"), 9);
    expect(by.contextdev.todayUsd).toBeCloseTo(today("contextdev"), 9);
    expect(by.firecrawl.limitUsd).toBe(2);
    expect(by.contextdev.limitUsd).toBe(0);
    expect(by.treg.limitUsd).toBe(0.8);
    expect(summarizeCalls([]).calls).toBe(0);
  });
});

describe("export: the CURRENT FILTERED result as CSV and XLSX", () => {
  const body = async (url: string) => { const res = await exportGet(req(url)); expect(res.status).toBe(200); return res; };
  const parseCsv = (text: string): string[][] => {
    const rows: string[][] = []; let cell = ""; let row: string[] = []; let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch; }
      else if (ch === '"') quoted = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\r") { /* skip */ }
      else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    return rows;
  };

  it("CSV: UTF-8 with BOM, an Arabic header, and exactly the filtered rows with their values", async () => {
    const qs = "provider=firecrawl&test=real";
    const res = await body(`/api/admin/calls-log/export?format=csv&${qs}`);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="calls-log-\d{4}-\d{2}-\d{2}\.csv"/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
    const table = parseCsv(text);
    expect(table[0]).toEqual([...EXPORT_COLUMNS]);
    const expected = await allPages(qs);
    expect(table.length - 1).toBe(expected.length);
    expect(res.headers.get("x-export-rows")).toBe(String(expected.length));
    expect(res.headers.get("x-export-capped")).toBe("false");
    for (let i = 0; i < expected.length; i += 1) {
      const r = expected[i]; const line = table[i + 1];
      expect(line[0]).toBe(r.at); expect(line[1]).toBe("Firecrawl"); expect(line[3]).toBe(r.jobId ?? ""); expect(line[4]).toBe(r.userEmail ?? "");
      expect(line[7]).toBe(r.isTestAccount ? "نعم" : "لا"); expect(Number(line[8])).toBe(r.units); expect(Number(line[9])).toBeCloseTo(r.costUsd, 9);
    }
    const summary = summarizeCalls(expected);
    expect(table.slice(1).reduce((a, l) => a + Number(l[9]), 0)).toBeCloseTo(summary.costUsd, 9);
  });

  it("XLSX: the same filtered rows, numbers as numbers, an RTL sheet", async () => {
    const qs = "test=test";
    const res = await body(`/api/admin/calls-log/export?format=xlsx&${qs}`);
    expect(res.headers.get("content-type")).toContain("spreadsheetml.sheet");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as any);
    const sheet = wb.worksheets[0];
    expect((sheet.views[0] as any).rightToLeft).toBe(true);
    const expected = await allPages(qs);
    expect(sheet.rowCount - 1).toBe(expected.length);
    expect(sheet.getRow(1).values).toEqual([undefined, ...EXPORT_COLUMNS]);
    for (let i = 0; i < expected.length; i += 1) {
      const row = sheet.getRow(i + 2); const r = expected[i];
      expect(row.getCell(1).value).toBe(r.at);
      expect(row.getCell(5).value).toBe(r.userEmail);
      expect(typeof row.getCell(9).value).toBe("number");
      expect(row.getCell(10).value).toBeCloseTo(r.costUsd, 9);
      expect(row.getCell(8).value).toBe("نعم");
    }
  });

  it("the export carries the filtered result only: a filter that matches nothing gives a header-only file", async () => {
    const res = await body("/api/admin/calls-log/export?format=csv&user=nobody-here");
    expect(parseCsv(new TextDecoder().decode(await res.arrayBuffer()).replace(/^﻿/, "")).length).toBe(1);
    expect(res.headers.get("x-export-rows")).toBe("0");
  });

  it("row cap: more than the cap is cut at the cap (newest first), the headers and the UI number say so", async () => {
    db = seed({ extra: EXPORT_MAX_ROWS + 50 }); state.client = makeClient(db);
    const total = db.costs.filter((c) => c.provider !== "anthropic").length;
    const res = await body("/api/admin/calls-log/export?format=csv");
    expect(res.headers.get("x-export-cap")).toBe(String(EXPORT_MAX_ROWS));
    expect(res.headers.get("x-export-capped")).toBe("true");
    expect(res.headers.get("x-export-total")).toBe(String(total));
    expect(res.headers.get("x-export-rows")).toBe(String(EXPORT_MAX_ROWS));
    const table = parseCsv(new TextDecoder().decode(await res.arrayBuffer()).replace(/^﻿/, ""));
    expect(table.length - 1).toBe(EXPORT_MAX_ROWS);
    const newest = [...db.costs].filter((c) => c.provider !== "anthropic").sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id));
    expect(table[1][0]).toBe(newest[0].created_at);
    expect((await listJson()).exportCap).toBe(EXPORT_MAX_ROWS);
  }, 60_000);

  it("formula injection: a risky text cell is prefixed, a normal value is not, in both formats", async () => {
    for (const risky of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", "  =1"]) expect(neutralizeCell(risky), JSON.stringify(risky)).toBe(`'${risky}`);
    for (const normal of ["real.customer@example.com", "job_r1", "حساب اختبار", "2026-10-22T01:00:00.000Z", "a-b", "", "firecrawl.scrape", "Test +1"]) expect(neutralizeCell(normal)).toBe(normal);

    const csv = await (await body("/api/admin/calls-log/export?format=csv&jobId=job_e1")).arrayBuffer();
    const csvText = new TextDecoder().decode(csv);
    expect(csvText).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
    expect(csvText).not.toMatch(/(^|,)"?=HYPERLINK/m);
    expect(csvText).not.toContain("''");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await (await body("/api/admin/calls-log/export?format=xlsx&jobId=job_e1")).arrayBuffer()) as any);
    const cell = wb.worksheets[0].getRow(2).getCell(6);
    expect(cell.value).toBe(`'${EVIL_NAME}`);
    expect((cell as any).type).not.toBe(ExcelJS.ValueType.Formula);
    // a normal value in the same file shows no apostrophe
    expect(wb.worksheets[0].getRow(2).getCell(5).value).toBe("evil@example.com");
    expect(wb.worksheets[0].getRow(2).getCell(4).value).toBe("job_e1");
    expect(toCsv([]).startsWith("﻿")).toBe(true);
    expect((await toXlsx([])).length).toBeGreaterThan(100);
  });
});

describe("read only: no write to any money table, nothing but the audit line", () => {
  it("listing and exporting write nothing except the admin audit line, and call no database function", async () => {
    await listJson("provider=firecrawl");
    await body();
    expect(db.writes.filter((w) => !w.endsWith(":admin_audit_log"))).toEqual([]);
    expect(db.writes.every((w) => w.startsWith("insert:"))).toBe(true);
    async function body() { return exportGet(req("/api/admin/calls-log/export?format=csv")); }
  });

  it("the modules never name a write on a table", () => {
    for (const file of ["src/lib/server/adminCallsLog.ts", "src/lib/server/callsLogExport.ts", "src/lib/server/testAccounts.ts", "src/app/api/admin/calls-log/route.ts", "src/app/api/admin/calls-log/export/route.ts"]) {
      const text = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(text, file).not.toMatch(/\.(insert|update|upsert|delete)\(|\.rpc\(/);
    }
  });
});

describe("identical with the multi-provider flag on or off", () => {
  it("the list and the export are byte-for-byte the same", async () => {
    const run = async () => ({ list: JSON.stringify(await listJson("provider=firecrawl")), csv: new TextDecoder().decode(await (await exportGet(req("/api/admin/calls-log/export?format=csv"))).arrayBuffer()) });
    vi.stubEnv("MULTI_PROVIDER_ENABLED", "");
    const off = await run();
    vi.stubEnv("MULTI_PROVIDER_ENABLED", "true");
    const on = await run();
    expect(on).toEqual(off);
  });
});

describe("customer side: nothing of this page is reachable or importable", () => {
  const ROOT = process.cwd();
  const walk = (dir: string, out: string[] = []): string[] => { for (const n of readdirSync(dir)) { const p = path.join(dir, n); if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n)) out.push(p); } return out; };
  const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
  const customer = [...walk(path.join(ROOT, "src/app")), ...walk(path.join(ROOT, "src/components"))].map(rel).filter((f) =>
    !f.startsWith("src/app/admin/") && !f.startsWith("src/app/api/admin/") && !f.startsWith("src/app/api/worker/") && !f.startsWith("src/app/api/cron/") && !f.startsWith("src/components/admin/"));

  it("no customer route, page or component mentions the calls log, its modules, its API paths or the test-account list", () => {
    const VOCAB = /calls-log|adminCallsLog|callsLogExport|AllCallsLog|testAccounts|TEST_ACCOUNT|حساب تجريبي|سجل الاستدعاءات/;
    expect(customer.filter((f) => VOCAB.test(readFileSync(path.join(ROOT, f), "utf8")))).toEqual([]);
  });

  it("the new modules are imported only by admin routes, admin pages and admin components", () => {
    const importers = walk(path.join(ROOT, "src")).map(rel).filter((f) => /adminCallsLog|callsLogExport|server\/testAccounts|AllCallsLog/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(importers.every((f) => /^src\/(app\/api\/admin\/|app\/admin\/|components\/admin\/|lib\/server\/(adminCallsLog|callsLogExport|testAccounts))/.test(f)), importers.join(", ")).toBe(true);
  });

  it("both routes check the admin before anything is read", () => {
    for (const file of ["src/app/api/admin/calls-log/route.ts", "src/app/api/admin/calls-log/export/route.ts"]) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      expect(text.indexOf("authenticateAdmin")).toBeGreaterThan(-1);
      expect(text.indexOf("authenticateAdmin")).toBeLessThan(text.search(/createAdminClient\(\)\s*,|readCallsLog\(|readCallsForExport\(/));
    }
  });

  it("the customer metadata route answers no provider name, USD, email or call-log field", async () => {
    const { GET } = await import("../src/app/api/chat/metadata/route");
    const res = await GET(new NextRequest("http://localhost/api/chat/metadata"));
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/firecrawl|contextdev|context\.dev|treg|usd|cost_usd|duration|capabilityLabelAr|iam\.magdy|userEmail|isTestAccount/i);
  });
});

describe("the page: Arabic, no emoji, English only for provider names", () => {
  it("renders the filters, export buttons and cap note in Arabic", async () => {
    const { AllCallsLog } = await import("../src/components/admin/AllCallsLog");
    const html = renderToStaticMarkup(createElement(AllCallsLog));
    const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    for (const label of ["من تاريخ", "إلى تاريخ", "المزود", "الحالة", "المستخدم", "نوع الحساب", "رقم المهمة", "تجريبي", "حقيقي", "تنزيل ملف نصي", "تنزيل ملف إكسل", "بحد أقصى", "٢٠٬٠٠٠", "TREG", "Firecrawl", "Context.dev"]) expect(text, label).toContain(label);
    const stripped = text.replace(/TREG|Firecrawl|Context\.dev/g, "");
    expect(stripped).not.toMatch(/[A-Za-z]/);
    expect(stripped).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(stripped).not.toMatch(/[0-9]/);
    expect(html).toContain("data-testid=\"export-csv\"");
  });

  it("is a new admin page with its own menu entry; the providers page and its tabs are untouched", async () => {
    const { ADMIN_PAGES, adminHref } = await import("../src/components/admin/icons");
    expect(ADMIN_PAGES.find(([id]) => id === "calls-log")![1]).toBe("سجل الاستدعاءات");
    expect(adminHref("calls-log" as any)).toBe("/admin/calls-log");
    expect(ADMIN_PAGES.find(([id]) => id === "providers")![1]).toBe("مزودو الخدمة");
  });
});
