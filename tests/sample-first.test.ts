import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SAMPLE_MAX_POINTS,
  SAMPLE_MIN_POINTS,
  approximateTotalPoints,
  excludeKeysFromRows,
  fullEstimatePoints,
  remainingUnits,
  sampleOffer,
  sampleRestMessageAr,
  sampleTargetPoints,
  withoutExcludedRows,
} from "../src/lib/sampleFirst";
import { MAX_EXCLUDED_ROW_KEYS, buildRemainderPlan, dedupeKindForCapability } from "../src/lib/server/sampleRemainder";
import { dedupeIdentityFor, dedupeRows } from "../src/lib/server/rowDedupe";
import { getJobIdForQuote } from "../src/lib/md5";

const comment = (id: string) => ({ comment_id: id, text: `تعليق ${id}` });
const quote = (over: Record<string, unknown> = {}) => ({ items: [{ capabilitySlug: "social-youtube-comments", params: { query: "القهوة" } }], targetVolumeMax: 1000, unitPricePoints: 9, ...over });

describe("when a sample is offered, and how big it is", () => {
  it("only when the estimate of the whole request reaches 1,500 points", () => {
    expect(fullEstimatePoints(quote())).toBe(9000);
    expect(sampleOffer(quote())).not.toBeNull();
    expect(sampleOffer(quote({ targetVolumeMax: 166 }))).toBeNull(); // 1494
    expect(sampleOffer(quote({ targetVolumeMax: 167 }))).not.toBeNull(); // 1503
    expect(sampleOffer(quote({ targetVolumeMax: 20 }))).toBeNull();
  });

  it("the estimate is the whole REQUEST: a plan cut down by the cap is still judged by what was asked", () => {
    expect(fullEstimatePoints(quote({ targetVolumeMax: 57, requestedVolumeMax: 2000 }))).toBe(18000);
    const offer = sampleOffer(quote({ targetVolumeMax: 57, requestedVolumeMax: 2000 }))!;
    expect(offer.fullUnits).toBe(2000);
    expect(offer.sampleUnits).toBeLessThan(57);
  });

  it("is about 5% of the estimate, never below 100 nor above 300 points", () => {
    expect(sampleTargetPoints(1500)).toBe(100);
    expect(sampleTargetPoints(2400)).toBe(120);
    expect(sampleTargetPoints(5000)).toBe(250);
    expect(sampleTargetPoints(9000)).toBe(300);
    expect(sampleTargetPoints(900000)).toBe(300);
    expect(SAMPLE_MIN_POINTS).toBe(100);
    expect(SAMPLE_MAX_POINTS).toBe(300);
  });

  it("holds a reserve (with the 15% buffer) that never exceeds the target, from the quote's own unit price", () => {
    for (const unit of [1, 3, 5, 6, 9, 11, 83]) {
      for (const volume of [300, 1000, 5000]) {
        const q = quote({ unitPricePoints: unit, targetVolumeMax: volume });
        const offer = sampleOffer(q);
        if (!offer) continue;
        const target = sampleTargetPoints(fullEstimatePoints(q));
        expect(offer.samplePoints).toBe(Math.ceil(offer.sampleUnits * unit * 1.15));
        expect(offer.sampleExpectedPoints).toBe(Math.ceil(offer.sampleUnits * unit));
        if (offer.sampleUnits > 1) expect(offer.samplePoints).toBeLessThanOrEqual(target);
        expect(offer.sampleUnits).toBeLessThan(volume);
      }
    }
  });

  it("is not offered for a single link, several items, or when one record already costs more than a sample may", () => {
    expect(sampleOffer(quote({ items: [{ capabilitySlug: "social-youtube-comments", params: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } }] }))).toBeNull();
    expect(sampleOffer(quote({ items: [{ capabilitySlug: "a" }, { capabilitySlug: "b" }] }))).toBeNull();
    expect(sampleOffer(quote({ unitPricePoints: 400, targetVolumeMax: 100 }))).toBeNull();
    expect(sampleOffer(quote({ unitPricePoints: 0 }))).toBeNull();
  });
});

describe("the rest after a delivered sample", () => {
  it("is the same request on the remaining volume", () => {
    expect(remainingUnits(2000, 28)).toBe(1972);
    expect(remainingUnits(100, 100)).toBe(0);
    expect(remainingUnits(100, 250)).toBe(0);
    expect(remainingUnits(100, -5)).toBe(100);
  });

  it("the approximate total is what the sample was charged plus the rest's expected points, nothing invented", () => {
    expect(approximateTotalPoints({ sampleChargedPoints: 252, remainingUnits: 100, unitPricePoints: 9 })).toBe(252 + 900);
    expect(approximateTotalPoints({ sampleChargedPoints: 0, remainingUnits: 0, unitPricePoints: 9 })).toBe(0);
  });

  it("excludes the sample's rows from the rest, counts them, and never delivers or bills them again", () => {
    const delivered = Array.from({ length: 28 }, (_, i) => comment(`c${i + 1}`));
    const keys = excludeKeysFromRows(delivered, dedupeIdentityFor("social"));
    expect(keys).toHaveLength(28);
    const provider = [...delivered.slice(0, 10), ...Array.from({ length: 40 }, (_, i) => comment(`n${i + 1}`))];
    const { rows, excludedCount } = withoutExcludedRows(provider, dedupeIdentityFor("social"), keys);
    expect(excludedCount).toBe(10);
    expect(rows).toHaveLength(40);
    expect(rows.some((r) => delivered.some((d) => d.comment_id === r.comment_id))).toBe(false);
    // the worker's own de-duplication, seeded with the same keys, drops them the same way
    const seen = new Set<string>(keys);
    const out = dedupeRows(provider, dedupeIdentityFor("social"), seen);
    expect(out.duplicates).toBe(10);
    expect(out.rows).toHaveLength(40);
  });

  it("rows without an identity cannot be excluded and are skipped, never invented", () => {
    expect(excludeKeysFromRows([{ x: 1 }, comment("a"), comment("a")], dedupeIdentityFor("social"))).toHaveLength(1);
  });

  it("the offer after the sample is plain Arabic, Arabic digits, and states the total with the sample", () => {
    const text = sampleRestMessageAr({ deliveredInSample: 28, sampleChargedPoints: 252, remainingUnits: 1972, approximateTotalPoints: 18000 });
    expect(text).toContain("سُلّم ٢٨ سجل");
    expect(text).toContain("وخُصم ٢٥٢ نقطة");
    expect(text).toContain("١٩٧٢ سجل");
    expect(text).toContain("الإجمالي التقريبي مع العينة حوالي ١٨٠٠٠ نقطة");
    expect(text).not.toMatch(/[A-Za-z0-9]|undefined|null|NaN|\p{Extended_Pictographic}/u);
    expect(sampleRestMessageAr({ deliveredInSample: 40, sampleChargedPoints: 360, remainingUnits: 0, approximateTotalPoints: 360 })).toContain("لا يوجد باقٍ");
  });
});

describe("the plan for the rest", () => {
  const items = [{ capabilitySlug: "social-youtube-comments", params: { query: "القهوة", dateFrom: "2026-01-01" }, targetVolumeMin: 1, targetVolumeMax: 1000, unitPricePoints: 9 }];
  const sampleRows = Array.from({ length: 28 }, (_, i) => comment(`c${i + 1}`));

  it("keeps the same plan on the remaining volume and carries the identities of the sample's rows", () => {
    const plan = buildRemainderPlan({ items, fullVolume: 2000, sampleRows, sampleDelivered: 28, sampleChargedPoints: 252 }, 9)!;
    expect(plan.remaining).toBe(1972);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ capabilitySlug: "social-youtube-comments", targetVolumeMax: 1972, params: { query: "القهوة", dateFrom: "2026-01-01" } });
    expect(plan.items[0].params!.excludeRowKeys).toHaveLength(28);
    expect(plan.rest).toEqual({ deliveredInSample: 28, sampleChargedPoints: 252, remainingUnits: 1972, approximateTotalPoints: 252 + 1972 * 9 });
  });

  it("does not touch the sample's own charge: it is only read to state the total", () => {
    const plan = buildRemainderPlan({ items, fullVolume: 2000, sampleRows, sampleDelivered: 28, sampleChargedPoints: 252 }, 9)!;
    expect(plan.rest.sampleChargedPoints).toBe(252);
  });

  it("nothing left when the sample delivered everything asked; several items are refused", () => {
    expect(buildRemainderPlan({ items, fullVolume: 28, sampleRows, sampleDelivered: 28, sampleChargedPoints: 252 }, 9)).toMatchObject({ remaining: 0, items: [] });
    expect(buildRemainderPlan({ items: [...items, ...items], fullVolume: 2000, sampleRows, sampleDelivered: 28, sampleChargedPoints: 252 }, 9)).toBeNull();
  });

  it("carries no more than the allowed identities, and none when the sample result could not be read", () => {
    const many = Array.from({ length: 900 }, (_, i) => comment(`m${i}`));
    expect(buildRemainderPlan({ items, fullVolume: 5000, sampleRows: many, sampleDelivered: 900, sampleChargedPoints: 1 }, 9)!.items[0].params!.excludeRowKeys).toHaveLength(MAX_EXCLUDED_ROW_KEYS);
    expect(buildRemainderPlan({ items, fullVolume: 100, sampleRows: [], sampleDelivered: 10, sampleChargedPoints: 90 }, 9)!.items[0].params).not.toHaveProperty("excludeRowKeys");
  });

  it("each kind of capability identifies its rows its own way", () => {
    expect(dedupeKindForCapability("social-youtube-comments")).toBe("social");
    expect(dedupeKindForCapability("icypeas-companies-search")).toBe("company");
    expect(dedupeKindForCapability("professional-people-search")).toBe("person");
  });
});

describe("the worker drops the rows a sample delivered", () => {
  it("seeds its de-duplication set from the plan's excluded keys, so those rows are not delivered and not billed", () => {
    const worker = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(worker).toContain("spec.params?.excludeRowKeys");
    const seeded = worker.slice(worker.indexOf("const seen = new Set<string>();"), worker.indexOf("// Rows reused from a failed earlier run are already accepted rows of this job."));
    expect(seeded).toContain("seen.add(key)");
    expect(worker).toContain("duplicateExcludedCount += 1; return false;");
  });
});

/* ---------------------------------------------------------------- the route */

const state = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  quote: null as any,
  job: null as any,
  files: new Map<string, string>(),
  inserted: [] as any[],
  rpcCalls: [] as string[],
  createdPlans: [] as any[],
}));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async (name: string) => { state.rpcCalls.push(name); return { data: null, error: null }; }),
    storage: { from: () => ({ download: async (path: string) => (state.files.has(path) ? { data: new Blob([state.files.get(path)!]), error: null } : { data: null, error: { message: "nf" } }) }) },
    from: (table: string) => {
      const api: any = {
        select: () => api, eq: () => api,
        maybeSingle: async () => ({ data: table === "plans_quotes" ? state.quote : table === "jobs" ? state.job : null, error: null }),
        insert: async (row: any) => { state.inserted.push({ table, row }); return { error: null }; },
      };
      return api;
    },
  })),
}));
vi.mock("../src/functions/shared/planManager", () => ({
  createAndSaveManagedQuote: vi.fn(async (_db: any, input: any) => {
    state.createdPlans.push(input.plan);
    return { quoteId: "q_rest_1", planHash: "h", summaryAr: input.plan.summaryAr, items: input.plan.items, targetVolumeMax: input.plan.items[0].targetVolumeMax, unitPricePoints: 9, expectedPoints: 100, quotedPoints: 115, isAffordable: true, userBalance: input.userBalance, outputFormats: input.plan.outputFormats, expiresAt: new Date(Date.now() + 3600_000).toISOString(), status: "proposed" };
  }),
}));
vi.mock("../src/functions/shared/capabilityRegistry", () => ({ getEnabledCapabilitiesWithCoreServices: vi.fn(async () => []), getCatalogCapabilities: vi.fn(async () => []) }));
vi.mock("../src/lib/supabase/ledger", () => ({ calculateBalance: vi.fn(async () => 5000) }));

const QUOTE_ID = "q_sample_1";
function request(body: Record<string, unknown>) {
  const { NextRequest } = require("next/server");
  return new NextRequest("http://localhost/api/chat/sample-remainder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /api/chat/sample-remainder", () => {
  beforeEach(() => {
    state.user = { id: "u1" };
    state.quote = { id: QUOTE_ID, user_id: "u1", conversation_id: "c1", summary_ar: "خطة", output_formats: ["xlsx"], items: [{ capabilitySlug: "social-youtube-comments", params: { query: "القهوة" }, targetVolumeMin: 1, targetVolumeMax: 1000, unitPricePoints: 9 }] };
    state.job = { id: getJobIdForQuote(QUOTE_ID), user_id: "u1", status: "completed", delivered_units: 28, charged_credits: 252, unit_price: 9 };
    state.files = new Map([[`u1/${getJobIdForQuote(QUOTE_ID)}/data.json`, JSON.stringify({ rows: Array.from({ length: 28 }, (_, i) => comment(`c${i + 1}`)) })]]);
    state.inserted = [];
    state.rpcCalls = [];
    state.createdPlans = [];
  });

  it("builds the rest on the remaining volume without the sample's rows, as a NEW quote, with no reserve, no ledger and no refund", async () => {
    const { POST } = await import("../src/app/api/chat/sample-remainder/route");
    const res = await POST(request({ sampleQuoteId: QUOTE_ID, fullVolume: 2000 }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(state.createdPlans).toHaveLength(1);
    expect(state.createdPlans[0].items[0]).toMatchObject({ targetVolumeMax: 1972 });
    expect(state.createdPlans[0].items[0].params.excludeRowKeys).toHaveLength(28);
    expect(data.planQuote.afterSample).toMatchObject({ deliveredInSample: 28, sampleChargedPoints: 252, remainingUnits: 1972 });
    expect(data.planQuote.status).toBe("quoted");
    // nothing is reserved, charged or refunded here: the only writes are the new assistant message
    expect(state.rpcCalls).toEqual([]);
    expect(state.inserted.map((i) => i.table)).toEqual(["messages"]);
    expect(state.inserted[0].row.quote.quoteId).toBe("q_rest_1");
    expect(JSON.stringify(state.inserted)).not.toMatch(/credit_ledger|refund|reserve_|release_|settle_|chg_|res_|rel_/i);
    expect(data.messageAr).toContain("الإجمالي التقريبي مع العينة");
  });

  it("refuses without a session, for another customer's sample, and before the sample is delivered", async () => {
    const { POST } = await import("../src/app/api/chat/sample-remainder/route");
    state.user = null;
    expect((await POST(request({ sampleQuoteId: QUOTE_ID, fullVolume: 2000 }))).status).toBe(401);
    state.user = { id: "u2" };
    expect((await POST(request({ sampleQuoteId: QUOTE_ID, fullVolume: 2000 }))).status).toBe(403);
    state.user = { id: "u1" };
    state.job = { ...state.job, status: "running" };
    expect((await POST(request({ sampleQuoteId: QUOTE_ID, fullVolume: 2000 }))).status).toBe(409);
    expect(state.createdPlans).toHaveLength(0);
    expect(state.rpcCalls).toEqual([]);
  });

  it("creates no quote when the sample already delivered everything", async () => {
    const { POST } = await import("../src/app/api/chat/sample-remainder/route");
    const res = await POST(request({ sampleQuoteId: QUOTE_ID, fullVolume: 28 }));
    const data = await res.json();
    expect(data).toMatchObject({ success: true, remaining: 0 });
    expect(state.createdPlans).toHaveLength(0);
    expect(state.inserted).toHaveLength(0);
  });

  it("rejects a malformed request", async () => {
    const { POST } = await import("../src/app/api/chat/sample-remainder/route");
    expect((await POST(request({ sampleQuoteId: "", fullVolume: 5 }))).status).toBe(400);
    expect((await POST(request({ sampleQuoteId: QUOTE_ID, fullVolume: 0 }))).status).toBe(400);
    expect((await POST(request({ sampleQuoteId: QUOTE_ID, fullVolume: 1.5 }))).status).toBe(400);
  });
});

describe("the chat offers the rest after the sample", () => {
  const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
  const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
  it("shows «اطلب الباقي» under the delivered-sample message, and the new plan states the total with the sample", () => {
    expect(page).toContain('data-testid="request-rest-btn"');
    expect(page).toContain("sampleRestMessageAr({");
    expect(page).toContain("setRestPlanQuoteId(planQuote.quoteId)");
    expect(card).toContain('data-testid="plan-after-sample"');
    expect(card).toContain("الإجمالي التقريبي مع العينة");
  });
});
