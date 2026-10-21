import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { measureCpu, recordSamples, type CpuSample } from "./helpers/cpuMeter";
import { createLatencyDb } from "./helpers/loadHarness";

/**
 * What one visitor's actions cost the database and file storage, and the CPU of the heavy routes, through the REAL routes with an
 * in-memory database that counts every query, row, byte and storage byte. Written to DBLOAD_OUT / CPU_OUT when set
 * (docs/capacity/db-load.json, docs/capacity/cpu-measurements.json). No network, no model, no provider.
 */
const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async (token?: string) => ({ data: { user: token ? { id: String(token), email: `${token}@x.test`, email_confirmed_at: "2026-10-01T00:00:00Z", user_metadata: {} } : null }, error: token ? null : new Error("no session") })) },
  })),
  createAdminClient: vi.fn(() => h.db.client),
}));
vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
  getEndpointDetails: vi.fn(async (id: string) => ({ id, catalogPriceUsd: 0.005, pointsPerUnit: 28 })),
}));
vi.mock("../src/lib/server/sendPlatformEmail", () => ({ sendPlatformEmail: vi.fn(async () => ({ ok: true })), getRecipient: vi.fn(async () => null) }));
vi.mock("../src/functions/shared/llmClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/functions/shared/llmClient")>();
  class NoModelClient extends original.LlmClient {
    async executeTurn(): Promise<never> { throw new Error("no model"); }
  }
  return { ...original, LlmClient: NoModelClient };
});

import { POST as chatRoute } from "../src/app/api/chat/route";
import { GET as dataRoute } from "../src/app/api/jobs/[id]/data/route";
import { GET as downloadRoute } from "../src/app/api/jobs/[id]/download/route";

const USER = "viewer_1";
const TODAY = "2026-10-21T08:00:00.000Z";

/** A delivered comments dataset of `n` rows with the fields a real job stores (Arabic text, author, date, video columns). */
function dataset(n: number) {
  return JSON.stringify({
    metadata: { platform: "tiktok", title: "تعليقات كرة القدم", entityType: "comments", collectedAt: TODAY },
    rows: Array.from({ length: n }, (_, i) => ({
      comment_id: `c_${i}`, comment_text: `تعليق رقم ${i} عن مباراة الأمس وأداء الفريق في الشوط الثاني، كان رائعًا`, author: `user_${i % 97}`, likes: i % 50,
      published_at: "2026-10-12T10:00:00Z", comment_language: "ar", video_title: "ملخص المباراة", video_url: `https://example.test/v/${i % 5}`, video_published_at: "2026-10-11T10:00:00Z",
    })),
  });
}

function seed(rows: number) {
  const jobId = `job_rows_${rows}`;
  h.db = createLatencyDb({
    tables: {
      jobs: [{ id: jobId, user_id: USER, status: "completed", delivered_units: rows, endpoint_id: "tikhub.tiktok.video.comments", template_slug: "social-tiktok-comments", created_at: TODAY, finished_at: TODAY, title: "تعليقات" }],
      artifact_versions: [], plans_quotes: [], profiles: [{ id: USER, email: "v@x.test" }], credit_ledger: [{ id: "l1", user_id: USER, delta: 500, type: "topup", created_at: TODAY }],
    },
    files: { [`results/${USER}/${jobId}/data.json`]: dataset(rows) },
  }, 0);
  return jobId;
}

const call = (route: any, jobId: string, query = "") => route(new NextRequest(`http://x/api/jobs/${jobId}/x${query}`, { headers: { authorization: `Bearer ${USER}` } }), { params: Promise.resolve({ id: jobId }) });
const send = (user: string, message: string) => chatRoute(new NextRequest("http://localhost:3000/api/chat", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${user}` }, body: JSON.stringify({ message }) }));

const load: Record<string, any> = {};
const cpu: CpuSample[] = [];
const snapshot = (name: string, extra: Record<string, unknown> = {}) => {
  const s = h.db.stats;
  load[name] = { queries: s.ops.filter((o: any) => o.table !== "storage").length, storageCalls: s.ops.filter((o: any) => o.table === "storage").length, rows: s.rowsRead, dbKb: Math.round((s.bytesRead / 1024) * 10) / 10, storageReadKb: Math.round((s.storageBytesRead / 1024) * 10) / 10, storageWriteKb: Math.round((s.storageBytesWritten / 1024) * 10) / 10, ...extra };
};

describe("database, storage and CPU per action of one visitor (real routes, in-memory fakes)", () => {
  beforeAll(() => {
    for (const method of ["warn", "error", "log", "info"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  });

  it("a chat turn: a greeting and the turn that builds a plan", async () => {
    seed(0);
    h.db.reset();
    const greeting = await send("turn_g", "مرحبا");
    snapshot("chat_greeting", { responseKb: Math.round((await greeting.text()).length / 102.4) / 10 });
    h.db.reset();
    const plan = await send("turn_p", "أريد ٣٠ تعليق على يوتيوب عن كرة القدم خلال الشهر الماضي");
    snapshot("chat_plan", { responseKb: Math.round((await plan.text()).length / 102.4) / 10 });
    expect(load.chat_greeting.queries).toBeGreaterThan(0);
    expect(load.chat_plan.queries).toBeGreaterThanOrEqual(load.chat_greeting.queries);
    expect(load.chat_plan.dbKb).toBeLessThan(100);
  });

  it("the results view of a 100-row and a 1000-row result: one job read, one stored file, and what leaves the server", async () => {
    for (const rows of [100, 1000]) {
      const jobId = seed(rows);
      h.db.reset();
      const res = await call(dataRoute, jobId);
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(JSON.parse(body).rows.length).toBe(rows);
      snapshot(`results_view_${rows}`, { responseKb: Math.round(body.length / 102.4) / 10 });
      expect(load[`results_view_${rows}`].queries).toBeLessThanOrEqual(3);
      cpu.push(await measureCpu(`results_view_${rows}`, async () => { await (await call(dataRoute, jobId)).text(); }, { runs: rows === 1000 ? 8 : 15 }));
    }
    expect(load.results_view_1000.responseKb).toBeGreaterThan(load.results_view_100.responseKb);
  });

  it("a download: the file is built again from the saved data every time (a stored file is never served stale)", async () => {
    for (const format of ["csv", "xlsx", "pdf"] as const) {
      const jobId = seed(100);
      h.db.reset();
      const res = await call(downloadRoute, jobId, `?format=${format}`);
      const body = await res.json();
      expect(res.status, format).toBe(200);
      expect(body.signedUrl, format).toContain("signed.test");
      snapshot(`download_${format}_100`, {});
      expect(load[`download_${format}_100`].storageReadKb).toBeGreaterThan(0);
      expect(load[`download_${format}_100`].storageWriteKb).toBeGreaterThan(0);
      cpu.push(await measureCpu(`download_${format}_100`, async () => { await (await call(downloadRoute, jobId, `?format=${format}`)).text(); }, { runs: format === "pdf" ? 6 : 10 }));
    }
    const big = seed(1000);
    cpu.push(await measureCpu("download_xlsx_1000", async () => { await (await call(downloadRoute, big, "?format=xlsx")).text(); }, { runs: 4, warmup: 1 }));
    expect(cpu.find((s) => s.name === "download_pdf_100")!.medianMs).toBeGreaterThan(cpu.find((s) => s.name === "download_csv_100")!.medianMs);
    recordSamples(process.env.CPU_OUT, cpu);
    if (process.env.DBLOAD_OUT) { mkdirSync(dirname(process.env.DBLOAD_OUT), { recursive: true }); writeFileSync(process.env.DBLOAD_OUT, JSON.stringify(load, null, 2) + "\n"); }
  }, 180_000);
});
