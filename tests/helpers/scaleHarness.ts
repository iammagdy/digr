/**
 * A deterministic harness that runs a long job through the REAL worker route: chunking, the social source chain, de-duplication,
 * relevance, file generation and settlement all run as in production. Only the edges are fake:
 *  - the database is in memory; claim_job_chunk behaves like the real one (a 60 s lease and the expected step);
 *  - the money functions (reserve, settle, release) are stand-ins that follow the documented rules, so the tests can check what the
 *    worker asks of them: charge = ceil(delivered x unit price), never above the reserve, settled once;
 *  - the provider is a FakeProvider (pages of 10 to 50 records, cursors, repeated records, latency, 402/429/503/timeouts);
 *  - time is a fake clock: latency moves it, so a chunk's duration is measured without waiting.
 */
import { NextRequest } from "next/server";
import { vi } from "vitest";
import type { SocialCall, SocialCallOutcome } from "../../src/lib/server/socialAdapter";
import { runSocialChunk } from "../../src/lib/server/socialAdapter";
import { setProviderAdapterForTesting, type ProviderAdapterFn } from "../../src/lib/server/tregAdapter";
import { jobIdForQuote } from "../../src/lib/server/retryReuse";

export const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
export const CRON_SECRET = "scale-harness-secret";
const iso = (ms: number) => new Date(ms).toISOString();

export interface HarnessDb {
  jobs: any[];
  quotes: any[];
  partials: Map<string, Buffer>;
  results: Map<string, Buffer>;
  rpcCalls: Array<{ name: string; args: any }>;
  events: any[];
  notifications: any[];
  unitPrice: number;
  reserved: number;
  spendAllowed: boolean;
  claimsRefused: string[];
  /** Every storage download of the partials bucket, with its size: the cost of re-reading earlier chunks shows here. */
  downloads: Array<{ bucket: string; path: string; bytes: number; step: number }>;
  uploads: Array<{ bucket: string; path: string; bytes: number }>;
  /** Simulated seconds each chunk took (the clock moved by the fake provider's latency). */
  chunkSeconds: number[];
  settleArgs: any[];
}

export const db: HarnessDb = {
  jobs: [], quotes: [], partials: new Map(), results: new Map(), rpcCalls: [], events: [], notifications: [],
  unitPrice: 0.2, reserved: 0, spendAllowed: true, claimsRefused: [], downloads: [], uploads: [], chunkSeconds: [], settleArgs: [],
};

export function resetDb(): void {
  Object.assign(db, {
    jobs: [], quotes: [], rpcCalls: [], events: [], notifications: [], unitPrice: 0.2, reserved: 0, spendAllowed: true,
    claimsRefused: [], downloads: [], uploads: [], chunkSeconds: [], settleArgs: [],
  });
  db.partials.clear();
  db.results.clear();
}

export const nowMs = () => Date.now();
export const advance = (ms: number) => vi.setSystemTime(nowMs() + ms);
export const jobRow = (id: string) => db.jobs.find((row) => row.id === id);
export const calls = (name: string) => db.rpcCalls.filter((call) => call.name === name);

function jobsQuery() {
  const preds: Array<(row: any) => boolean> = [];
  let max = Infinity;
  let sortKey: string | null = null;
  const run = () => {
    let rows = db.jobs.filter((row) => preds.every((p) => p(row)));
    if (sortKey) rows = [...rows].sort((a, b) => String(a[sortKey!]).localeCompare(String(b[sortKey!])));
    return rows.slice(0, max);
  };
  const api: any = {
    select: () => api,
    eq: (col: string, val: unknown) => { preds.push((row) => row[col] === val); return api; },
    in: (col: string, vals: unknown[]) => { preds.push((row) => vals.includes(row[col])); return api; },
    gt: (col: string, val: string) => { preds.push((row) => String(row[col]) > val); return api; },
    lt: (col: string, val: string) => { preds.push((row) => String(row[col]) < val); return api; },
    lte: () => api, not: () => api, like: () => api,
    or: (expr: string) => {
      const lease = /^lease_until\.is\.null,lease_until\.lt\.(.+)$/.exec(expr);
      if (lease) preds.push((row) => !row.lease_until || String(row.lease_until) < lease[1]);
      return api;
    },
    order: (col: string) => { sortKey = col; return api; },
    limit: (n: number) => { max = n; return api; },
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: any, reject: any) => Promise.resolve({ data: run(), error: null }).then(resolve, reject),
  };
  return api;
}

function notificationsQuery() {
  const api: any = {
    select: () => api, eq: () => api, like: () => api,
    then: (resolve: any, reject: any) => Promise.resolve({ count: db.notifications.length, data: null, error: null }).then(resolve, reject),
    insert: async (row: any) => {
      if (db.notifications.some((existing) => existing.id === row.id)) return { error: { code: "23505" } };
      db.notifications.push(row);
      return { error: null };
    },
  };
  return api;
}

/** The module that replaces ../src/lib/supabase/server: `vi.mock(path, async () => (await import("./helpers/scaleHarness")).supabaseServerMock())`. */
export function supabaseServerMock() {
  return {
    createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) } })),
    createAdminClient: vi.fn(() => ({
      rpc: vi.fn(async (name: string, args: any) => {
        db.rpcCalls.push({ name, args });
        const job = jobRow(args?.p_job_id);
        if (name === "claim_job_chunk") {
          if (!job || !["queued", "running"].includes(job.status)) { db.claimsRefused.push("not_runnable"); return { data: { claimed: false, error: "job_not_runnable" }, error: null }; }
          if (job.lease_until && String(job.lease_until) > iso(nowMs())) { db.claimsRefused.push("lease_held"); return { data: { claimed: false, error: "lease_held" }, error: null }; }
          if (job.step !== args.p_expected_step) { db.claimsRefused.push("step_mismatch"); return { data: { claimed: false, error: "step_mismatch" }, error: null }; }
          Object.assign(job, { status: "running", lease_until: iso(nowMs() + args.p_lease_seconds * 1000), updated_at: iso(nowMs()) });
          return { data: { claimed: true, job_id: job.id, user_id: job.user_id, step: job.step, current_cursor: job.current_cursor, delivered_units: job.delivered_units, target_volume_max: job.target_volume_max, target_volume_min: 1, endpoint_id: job.endpoint_id, unit_price: db.unitPrice }, error: null };
        }
        if (name === "reserve_provider_spend_atomic") return { data: { allowed: db.spendAllowed, cost_id: db.spendAllowed ? 11 : null }, error: null };
        if (name === "commit_provider_spend") return { data: { success: true }, error: null };
        if (name === "complete_chunk") {
          Object.assign(job, { step: job.step + 1, delivered_units: args.p_new_delivered_units, current_cursor: args.p_new_cursor, lease_until: null, updated_at: iso(nowMs()) });
          return { data: { success: true, delivered_units: job.delivered_units }, error: null };
        }
        if (name === "settle_job_atomic") {
          db.settleArgs.push(args);
          if (job.status === "completed") return { data: { success: true, already_settled: true, charged_credits: job.charged }, error: null };
          const charged = Math.min(Math.ceil(job.delivered_units * db.unitPrice), db.reserved, args.p_points_cap ?? Infinity);
          Object.assign(job, { status: "completed", lease_until: null, charged });
          return { data: { success: true, delivered_units: job.delivered_units, charged_credits: charged, released_credits: db.reserved - charged }, error: null };
        }
        if (name === "release_job_atomic") {
          if (job) Object.assign(job, { status: "failed", lease_until: null, charged: 0 });
          return { data: { success: true, released_credits: db.reserved }, error: null };
        }
        return { data: { success: true }, error: null };
      }),
      storage: {
        from: (bucket: string) => {
          const store = bucket === "partials" ? db.partials : db.results;
          return {
            upload: async (path: string, body: any) => {
              const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
              store.set(path, buf);
              db.uploads.push({ bucket, path, bytes: buf.length });
              return { data: { path }, error: null };
            },
            download: async (path: string) => {
              const buf = store.get(path);
              if (!buf) return { data: null, error: { message: "not_found" } };
              const step = Number(/step_(\d+)\.json$/.exec(path)?.[1] ?? -1);
              db.downloads.push({ bucket, path, bytes: buf.length, step });
              return { data: new Blob([new Uint8Array(buf)]), error: null };
            },
            remove: async (paths: string[]) => { for (const p of paths) store.delete(p); return { data: paths, error: null }; },
          };
        },
      },
      from: (table: string) => {
        if (table === "jobs") return jobsQuery();
        if (table === "notifications") return notificationsQuery();
        if (table === "plans_quotes") {
          return { select: () => ({ eq: (col: string, v: unknown) => ({ maybeSingle: async () => ({ data: db.quotes.find((row) => row[col] === v) ?? null, error: null }), then: (r: any) => r({ data: db.quotes.filter((row) => row[col] === v), error: null }) }) }) };
        }
        if (table === "job_events" || table === "artifact_versions") {
          const base: any = { select: () => base, eq: () => base, in: () => base, order: () => base, limit: () => base, maybeSingle: async () => ({ data: null, error: null }), then: (r: any) => r({ data: table === "job_events" ? db.events : [], error: null }) };
          return { ...base, insert: async (row: any) => { if (table === "job_events") db.events.push({ created_at: iso(nowMs()), ...row }); return { data: row, error: null }; }, upsert: async (row: any) => ({ data: row, error: null }) };
        }
        return jobsQuery();
      },
    })),
  };
}

export const sendPlatformEmailMock = () => ({ sendPlatformEmail: vi.fn(async () => ({ ok: true })), getRecipient: vi.fn(async () => null) });

/* ------------------------------------------------------------------ the fake provider */

export type FakeFailure = { kind: "429" | "503" | "402" | "timeout" };

export interface FakeProviderOptions {
  /** Comments available on every video. */
  commentsPerVideo: number;
  /** Videos the search finds. */
  videos?: number;
  /** Records a page holds (10 to 50); a call never returns more than it was asked for. */
  pageSize?: number;
  /** Every Nth page repeats the last `overlap` records of the page before it. */
  duplicateEvery?: number;
  overlap?: number;
  /** Simulated seconds one call takes. */
  latencySeconds?: number;
  /** Call number (1-based, over the whole job) -> failure. */
  failures?: Record<number, FakeFailure>;
  /** Fail every call from this number on. */
  failFrom?: { call: number; failure: FakeFailure };
}

/** A deterministic TikTok-like source: a keyword search that lists videos, and a cursor-paged comment feed per video. */
export class FakeProvider {
  callCount = 0;
  readonly seenCallKeys: string[] = [];
  readonly callLog: Array<{ endpoint: string; call: number; cursor: unknown; returned: number }> = [];
  constructor(readonly options: FakeProviderOptions) {}

  private failureFor(call: number): FakeFailure | null {
    const { failures, failFrom } = this.options;
    if (failures?.[call]) return failures[call];
    if (failFrom && call >= failFrom.call) return failFrom.failure;
    return null;
  }

  private videoId(i: number) {
    return String(7_300_000_000_000_000_000n + BigInt(i));
  }

  readonly call: SocialCall = async (source, params, context): Promise<SocialCallOutcome> => {
    this.callCount += 1;
    const callNumber = this.callCount;
    this.seenCallKeys.push(context.idempotencyKey);
    advance(Math.round((this.options.latencySeconds ?? 2) * 1000));
    const failure = this.failureFor(callNumber);
    if (failure) {
      const status = failure.kind === "timeout" ? 504 : Number(failure.kind);
      return { ok: false, httpStatus: status, data: null, costMicro: 0, tregCallId: `f${callNumber}`, errorCode: failure.kind === "timeout" ? "timeout" : `http_${status}`, errorMessageAr: "تعذر الاتصال بالمصدر." };
    }
    const pageSize = Math.min(this.options.pageSize ?? 20, source.maxPerCall || 20);
    if (/search/.test(source.endpointId)) {
      const total = this.options.videos ?? 20;
      const offset = Number(params.offset ?? params.cursor ?? 0);
      const count = Math.min(Number(params.count ?? pageSize), pageSize);
      const slice = Array.from({ length: Math.max(0, Math.min(count, total - offset)) }, (_, i) => ({ aweme_id: this.videoId(offset + i), desc: `فيديو ${offset + i} عن موضوع البحث`, play_count: 1000 - offset - i }));
      this.callLog.push({ endpoint: source.endpointId, call: callNumber, cursor: params.offset ?? params.cursor ?? null, returned: slice.length });
      return { ok: true, httpStatus: 200, data: { data: { videos: slice } }, costMicro: 1000, tregCallId: `ok${callNumber}` };
    }
    // comments of one video, paged by a numeric cursor
    const videoIndex = Number(BigInt(String(params.aweme_id ?? "0")) - 7_300_000_000_000_000_000n);
    const total = this.options.commentsPerVideo;
    const cursor = Number(params.cursor ?? 0);
    const count = Math.min(Number(params.count ?? pageSize), pageSize);
    const pageNumber = Math.floor(cursor / pageSize);
    let start = cursor;
    const repeats = this.options.duplicateEvery && this.options.overlap && pageNumber > 0 && pageNumber % this.options.duplicateEvery === 0 ? this.options.overlap : 0;
    start = Math.max(0, cursor - repeats);
    const end = Math.min(total, start + count);
    const comments = Array.from({ length: Math.max(0, end - start) }, (_, i) => {
      const n = start + i;
      return { cid: `c_${videoIndex}_${n}`, comment_id: `c_${videoIndex}_${n}`, text: `تعليق رقم ${n} على الفيديو ${videoIndex}`, create_time: 1_790_000_000 + n, digg_count: n % 7 };
    });
    const nextCursor = end < total ? end : total;
    this.callLog.push({ endpoint: source.endpointId, call: callNumber, cursor: params.cursor ?? null, returned: comments.length });
    return { ok: true, httpStatus: 200, data: { data: { comments, cursor: nextCursor, has_more: end < total ? 1 : 0 } }, costMicro: 1000, tregCallId: `ok${callNumber}` };
  };

  /** The adapter the worker is given: the REAL social chunk runner on top of this fake source, on the fake clock. */
  adapter(): ProviderAdapterFn {
    return async (input) => {
      const before = nowMs();
      const out = await runSocialChunk(input, { call: this.call, now: nowMs });
      db.chunkSeconds.push((nowMs() - before) / 1000);
      return out;
    };
  }
}

export function installProvider(provider: FakeProvider): void {
  setProviderAdapterForTesting(provider.adapter());
}

/* ------------------------------------------------------------------ the job and the simulated driver */

export interface SeedOptions {
  target: number;
  quoteId?: string;
  query?: string;
  perVideo?: number;
  videoCount?: number;
  slug?: string;
  outputFormats?: string[];
}

export function seedSocialJob(options: SeedOptions): string {
  const quoteId = options.quoteId ?? "quote_scale";
  const jobId = jobIdForQuote(quoteId);
  const slug = options.slug ?? "social-tiktok-comments";
  db.jobs.push({ id: jobId, user_id: "user_1", status: "running", step: 0, current_cursor: null, delivered_units: 0, target_volume_max: options.target, lease_until: null, next_attempt_at: null, endpoint_id: "tikhub.tiktok.video.comments", created_at: iso(T0 - 60_000), updated_at: iso(T0 - 30_000) });
  db.quotes = [{
    id: quoteId, user_id: "user_1", output_formats: options.outputFormats ?? ["csv"],
    items: [{ capabilitySlug: slug, endpointId: "tikhub.tiktok.video.comments", params: { query: options.query ?? "موضوع البحث", ...(options.perVideo ? { perVideo: options.perVideo } : {}), ...(options.videoCount ? { videoCount: options.videoCount } : {}) }, targetVolumeMax: options.target, paginationStrategy: "cursor" }],
  }];
  db.reserved = Math.ceil(options.target * db.unitPrice * 1.15);
  return jobId;
}

export interface WorkerCallResult { status: number; json: any }

/** One chunk through the REAL worker route, with no self-chain: the caller (the simulated driver) is the only thing that moves the job on. */
export async function callWorker(jobId: string, step?: number): Promise<WorkerCallResult> {
  const { POST } = await import("../../src/app/api/worker/chunk/route");
  const expected = step ?? jobRow(jobId)?.step ?? 0;
  const res = await POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
    method: "POST",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
    body: JSON.stringify({ jobId, expectedStep: expected, disableSelfChain: true }),
  }));
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

export interface DriveResult {
  chunks: number;
  results: WorkerCallResult[];
  finalStatus: string;
}

/**
 * Plays the always-on driver with the page closed: every "minute" it asks the worker for the next chunk of the job, until the job
 * leaves queued/running. `beforeTick(i)` may inject trouble (kill the instance, change the provider).
 */
export async function driveToTheEnd(jobId: string, options: { maxTicks?: number; tickMs?: number; beforeTick?: (i: number) => Promise<void> | void } = {}): Promise<DriveResult> {
  const results: WorkerCallResult[] = [];
  const max = options.maxTicks ?? 400;
  for (let i = 0; i < max; i += 1) {
    const job = jobRow(jobId);
    if (!job || !["queued", "running"].includes(job.status)) break;
    await options.beforeTick?.(i);
    results.push(await callWorker(jobId));
    advance(options.tickMs ?? 60_000);
  }
  return { chunks: results.length, results, finalStatus: jobRow(jobId)?.status ?? "missing" };
}

/** Every stored snapshot of the job's rows (one file per chunk, each holding that chunk's rows), as lists of ids. */
export function storedStepIds(jobId: string, idField = "comment_id"): string[][] {
  return [...db.partials.entries()]
    .filter(([key]) => key.startsWith(`${jobId}/step_`))
    .sort((a, b) => Number(/step_(\d+)/.exec(a[0])![1]) - Number(/step_(\d+)/.exec(b[0])![1]))
    .map(([, buf]) => {
      try {
        const parsed = JSON.parse(buf.toString());
        return (parsed.rows ?? []).map((row: any) => String(row[idField]));
      } catch { return []; }
    });
}

export function finalRows(jobId: string, userId = "user_1"): any[] {
  const buf = db.partials.get(`${userId}/${jobId}/data.json`) ?? db.partials.get(`${jobId}/data.json`);
  if (!buf) return [];
  try { return JSON.parse(buf.toString()).rows ?? []; } catch { return []; }
}

export function setupEnv(): () => void {
  const saved: Record<string, string | undefined> = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.ENABLE_MOCK_PROVIDER = "true";
  (process.env as any).NODE_ENV = "test";
  process.env.VERCEL_ENV = "development";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  resetDb();
  return () => {
    vi.useRealTimers();
    setProviderAdapterForTesting(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete (process.env as any)[key];
      else (process.env as any)[key] = value;
    }
  };
}
