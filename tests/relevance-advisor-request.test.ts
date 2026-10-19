import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  callClaudeRowAdvisor,
  setRowAdvisorForTesting,
} from "../src/lib/server/rowReviewAdvisor";
import { resetProviderKeyCache } from "../src/lib/server/providerKeys";
import { setProviderAdapterForTesting } from "../src/lib/server/tregAdapter";
import { jobIdForQuote } from "../src/lib/server/retryReuse";

const db = vi.hoisted(() => ({
  jobs: [] as any[],
  quotes: [] as any[],
  partials: new Map<string, Buffer>(),
  results: new Map<string, Buffer>(),
  rpcCalls: [] as Array<{ name: string; args: any }>,
  events: [] as any[],
  llmUsage: [] as any[],
  step: 0,
  cursor: null as string | null,
  deliveredUnits: 0,
  targetVolumeMax: 5,
  unitPrice: 3,
  reserved: 20,
  spendAllowed: true,
}));

function builder(rows: () => any[]) {
  const filters: Array<[string, unknown]> = [];
  const apply = () => rows().filter((row) => filters.every(([col, val]) => row[col] === val));
  const api: any = {
    select: () => api,
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return api;
    },
    in: () => api,
    or: () => api,
    not: () => api,
    order: () => api,
    limit: () => api,
    maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
    then: (resolve: any, reject: any) =>
      Promise.resolve({ data: apply(), error: null }).then(resolve, reject),
  };
  return api;
}

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) },
  })),
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async (name: string, args: any) => {
      db.rpcCalls.push({ name, args });
      if (name === "claim_job_chunk") {
        return {
          data: {
            claimed: true,
            job_id: args.p_job_id,
            user_id: "user_test_1",
            step: db.step,
            current_cursor: db.cursor,
            delivered_units: db.deliveredUnits,
            target_volume_max: db.targetVolumeMax,
            target_volume_min: 1,
            endpoint_id: "icypeas.companies.search",
            unit_price: db.unitPrice,
          },
          error: null,
        };
      }
      if (name === "reserve_provider_spend_atomic") {
        return { data: { allowed: db.spendAllowed, cost_id: db.spendAllowed ? 42 : null }, error: null };
      }
      if (name === "commit_provider_spend") return { data: { success: true }, error: null };
      if (name === "complete_chunk") {
        db.step += 1;
        db.deliveredUnits = args.p_new_delivered_units;
        db.cursor = args.p_new_cursor;
        const job = db.jobs.find((row) => row.id === args.p_job_id);
        if (job) {
          Object.assign(job, {
            current_cursor: db.cursor,
            delivered_units: db.deliveredUnits,
            status: "running",
          });
        }
        return { data: { success: true, delivered_units: db.deliveredUnits }, error: null };
      }
      if (name === "settle_job_atomic") {
        const charged = Math.min(Math.ceil(db.deliveredUnits * db.unitPrice), db.reserved);
        return {
          data: {
            success: true,
            charged_credits: charged,
            refunded_credits: db.reserved - charged,
          },
          error: null,
        };
      }
      if (name === "release_job_atomic") {
        return { data: { success: true, released_credits: db.reserved }, error: null };
      }
      return { data: { success: true }, error: null };
    }),
    storage: {
      from: (bucket: string) => {
        const store = bucket === "partials" ? db.partials : db.results;
        return {
          upload: async (path: string, body: any) => {
            store.set(path, Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
            return { data: { path }, error: null };
          },
          download: async (path: string) => {
            const buf = store.get(path);
            return buf
              ? { data: new Blob([new Uint8Array(buf)]), error: null }
              : { data: null, error: { message: "not_found" } };
          },
          remove: async (paths: string[]) => {
            for (const p of paths) store.delete(p);
            return { data: paths, error: null };
          },
        };
      },
    },
    from: (table: string) => {
      if (table === "jobs") return builder(() => db.jobs);
      if (table === "plans_quotes") return builder(() => db.quotes);
      if (table === "llm_usage") {
        return {
          insert: async (row: any) => {
            db.llmUsage.push(row);
            return { data: row, error: null };
          },
        };
      }
      if (table === "job_events" || table === "notifications" || table === "artifact_versions") {
        const base = builder(() => (table === "job_events" ? db.events : []));
        return {
          ...base,
          insert: async (row: any) => {
            if (table === "job_events") db.events.push({ created_at: new Date().toISOString(), ...row });
            return { data: row, error: null };
          },
          upsert: async (row: any) => ({ data: row, error: null }),
        };
      }
      return builder(() => []);
    },
  })),
}));

vi.mock("../src/lib/server/sendPlatformEmail", () => ({
  sendPlatformEmail: vi.fn(async () => undefined),
  getRecipient: vi.fn(async () => null),
}));

vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

const JOB_ID = jobIdForQuote("quote_task1");

function resetWorkerDb(target = 2, unitPrice = 3) {
  db.jobs = [
    {
      id: JOB_ID,
      user_id: "user_test_1",
      status: "running",
      step: 0,
      current_cursor: null,
      delivered_units: 0,
      target_volume_max: target,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];
  db.quotes = [
    {
      id: "quote_task1",
      user_id: "user_test_1",
      items: [
        {
          capabilitySlug: "icypeas-companies-search",
          endpointId: "icypeas.companies.search",
          params: {
            count: target,
            query: {
              keyword: { include: ["electrical"] },
              location: { include: ["Egypt"] },
            },
            country: "مصر",
            industry: "كهرباء",
          },
          targetVolumeMax: target,
          paginationStrategy: "cursor",
          unitCostUsd: 0.00038,
          pricingUnit: "item",
        },
      ],
      output_formats: ["xlsx"],
    },
  ];
  db.partials.clear();
  db.results.clear();
  db.rpcCalls = [];
  db.events = [];
  db.llmUsage = [];
  db.step = 0;
  db.cursor = null;
  db.deliveredUnits = 0;
  db.targetVolumeMax = target;
  db.unitPrice = unitPrice;
  db.reserved = Math.ceil(target * unitPrice * 1.15);
  db.spendAllowed = true;
}

describe("Task 1: Row review advisor request format, failure codes and logging", () => {
  let originalFetch: typeof globalThis.fetch;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    savedEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
      LLM_MODEL: process.env.LLM_MODEL,
      LLM_PROVIDER: process.env.LLM_PROVIDER,
      LLM_ENABLED: process.env.LLM_ENABLED,
      LLM_LIVE: process.env.LLM_LIVE,
      CRON_SECRET: process.env.CRON_SECRET,
      ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER,
      NODE_ENV: process.env.NODE_ENV,
      VERCEL_ENV: process.env.VERCEL_ENV,
    };
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_ENABLED;
    delete process.env.LLM_LIVE;
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.ENABLE_MOCK_PROVIDER = "true";
    (process.env as any).NODE_ENV = "test";
    process.env.VERCEL_ENV = "development";
    resetProviderKeyCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setProviderAdapterForTesting(null);
    setRowAdvisorForTesting(null);
    resetProviderKeyCache();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete (process.env as any)[k];
      else (process.env as any)[k] = v;
    }
  });

  it("calls Anthropic with body omitting temperature, top_p, top_k and with model claude-haiku-5-5", async () => {
    let capturedBody: any = null;
    globalThis.fetch = vi.fn(async (input: any, init?: any) => {
      if (typeof input === "string" && input.includes("api.anthropic.com")) {
        capturedBody = JSON.parse(init?.body as string);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: [{ type: "text", text: JSON.stringify({ reviews: [{ index: 0, verdict: "match", reasonAr: "مطابق" }] }) }],
            usage: { input_tokens: 150, output_tokens: 30 },
          }),
        } as any;
      }
      return originalFetch(input, init);
    });

    const result = await callClaudeRowAdvisor({
      customerRequest: "شركات كهرباء في مصر",
      kind: "companies",
      rows: [
        {
          index: 0,
          row: {
            company_name: "Nile Electric",
            industry: "Electrical/Electronic Manufacturing",
            description: "Transformers and switchgear",
            location: "Cairo, Egypt",
          },
        },
      ],
    });

    expect(capturedBody).not.toBeNull();
    const bodyKeys = Object.keys(capturedBody);
    expect(bodyKeys).not.toContain("temperature");
    expect(bodyKeys).not.toContain("top_p");
    expect(bodyKeys).not.toContain("top_k");
    expect(capturedBody.model).toBe("claude-haiku-5-5");
    expect(result.failure).toBeNull();
    expect(result.verdicts.size).toBe(1);
    expect(result.verdicts.get(0)?.verdict).toBe("match");
    expect(result.usage?.inputTokens).toBe(150);
  });

  it("returns failure http_400 and empty verdicts when Anthropic returns 400", async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "Invalid sampling parameters" } }),
      } as any;
    });

    const result = await callClaudeRowAdvisor({
      customerRequest: "شركات كهرباء في مصر",
      kind: "companies",
      rows: [{ index: 0, row: { company_name: "Alpha Sourcing" } }],
    });

    expect(result.failure).toBe("http_400");
    expect(result.verdicts.size).toBe(0);
    expect(result.usage).toBeNull();
  });

  it("returns failure timeout when fetch rejects with AbortError", async () => {
    globalThis.fetch = vi.fn(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });

    const result = await callClaudeRowAdvisor({
      customerRequest: "شركات كهرباء في مصر",
      kind: "companies",
      rows: [{ index: 0, row: { company_name: "Beta Trading" } }],
    });

    expect(result.failure).toBe("timeout");
    expect(result.verdicts.size).toBe(0);
    expect(result.usage).toBeNull();
  });

  it("worker level: when advisor returns failure http_400, logs llm_usage relevance_review_failed and still delivers deterministic match", async () => {
    resetWorkerDb(1, 3);
    const route = await import("../src/app/api/worker/chunk/route");

    setRowAdvisorForTesting(async () => ({
      verdicts: new Map(),
      usage: null,
      failure: "http_400",
    }));

    setProviderAdapterForTesting(async () => ({
      ok: true,
      httpStatus: 200,
      rows: [
        {
          company_name: "Nile Electric Power",
          industry: "Electrical/Electronic Manufacturing",
          description: "Manufacturing transformers and power substations",
          location: "Cairo, Egypt",
        },
      ],
      nextCursor: null,
      costUsd: 0.00228,
      costMicro: 2280,
      tregCallId: "call_task1_1",
    }));

    const req = new NextRequest("http://localhost:3000/api/worker/chunk", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-cron-secret",
      },
      body: JSON.stringify({ jobId: JOB_ID }),
    });

    const res = await route.POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.deliveredUnits).toBe(1);

    // Assert one llm_usage insert with reason "relevance_review_failed"
    const failedReviewRows = db.llmUsage.filter(
      (u) => u.reason === "relevance_review_failed"
    );
    expect(failedReviewRows.length).toBe(1);
    expect(failedReviewRows[0].tokens_in).toBe(0);
    expect(failedReviewRows[0].tokens_out).toBe(0);
    expect(failedReviewRows[0].cost_usd).toBe(0);
    expect(failedReviewRows[0].model).toBe("claude-haiku-5-5");
  });
});
