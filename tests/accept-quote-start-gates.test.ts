import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The approval route's start gates (read only, before anything is reserved): the reserve against the job cap, the customer's explicit
 * confirmation of a reserve above 600 points, and the provider side (the daily allowance and the real balance) for the cost of the
 * DELIVERED records of the plan. Each refusal is plain Arabic and writes nothing.
 */
const state = vi.hoisted(() => ({ quote: null as any, acceptCalls: 0 }));
vi.mock("../src/lib/supabase/server", () => {
  const user = { id: "user_1", email: "a@b.c", email_confirmed_at: "2026-10-01T00:00:00Z", user_metadata: {} };
  const admin = {
    from: (table: string) => {
      const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, order: () => chain, limit: () => chain, gte: () => chain,
        maybeSingle: async () => (table === "plans_quotes" ? { data: state.quote, error: null } : { data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (resolve: any) => resolve({ data: [], error: null }),
      };
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  return { createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) } })), createAdminClient: vi.fn(() => admin) };
});
vi.mock("../src/lib/server/providerGate", () => ({ getLiveProviderGateStatusFromSettings: vi.fn(async () => ({ isReady: true })) }));
vi.mock("../src/lib/server/busyState", () => ({ getBusyState: vi.fn(async () => ({ busy: false })) }));
vi.mock("../src/lib/server/concurrentJobs", () => ({ countActiveJobs: vi.fn(async () => 0), evaluateConcurrentJobs: vi.fn(() => ({ allowed: true })) }));
vi.mock("../src/lib/server/sendPlatformEmail", () => ({ sendPlatformEmail: vi.fn(async () => ({ ok: true })), getRecipient: vi.fn(async () => null) }));
vi.mock("../src/lib/supabase/quoteAccept", () => ({ acceptQuoteSupabase: vi.fn(async () => { state.acceptCalls += 1; return { success: false, statusCode: 400, errorAr: "reached the accept function" }; }) }));

import { POST as acceptQuote } from "../src/app/api/chat/accept-quote/route";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting, PROVIDER_BALANCE_LOW_MESSAGE_AR, PROVIDER_DAILY_CAP_MESSAGE_AR } from "../src/functions/shared/providerSpend";
import { flushProviderLimitsCache } from "../src/lib/server/providerLimits";

const item = (slug: string, volume: number) => ({ capabilitySlug: slug, endpointId: slug, params: { query: "x" }, targetVolumeMin: 1, targetVolumeMax: volume, unitPricePoints: 0.11715, unitCostUsd: 0.0000213 });
const quoteRow = (reserve: number, slug = "social-x-posts", volume = 100) => ({ items: [item(slug, volume)], total_reserved_credits: reserve });
const approve = (extra: Record<string, unknown> = {}) =>
  acceptQuote(new NextRequest("http://x/api/chat/accept-quote", { method: "POST", body: JSON.stringify({ quoteId: "q1", expectedPlanHash: "a".repeat(64), explicitApproval: true, ...extra }) }));
const saved = { ...process.env };

beforeEach(() => {
  state.acceptCalls = 0;
  state.quote = quoteRow(100);
  process.env.NODE_ENV = "test";
  delete process.env.PRESSURE_FAKE_PROVIDER;
  resetProviderBalanceCacheForTesting();
  flushProviderLimitsCache();
});
afterEach(() => { process.env = { ...saved }; resetProviderBalanceCacheForTesting(); flushProviderLimitsCache(); });

describe("a reserve above 600 points needs the customer's confirmation", () => {
  it("600 is not above the threshold; 601 is", async () => {
    setProviderBalanceForTesting(10);
    state.quote = quoteRow(600);
    expect((await approve()).status).toBe(400);
    expect(state.acceptCalls).toBe(1);
    state.acceptCalls = 0;
    state.quote = quoteRow(601);
    const res = await approve();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, needsConfirmation: true, reservePoints: 601 });
    expect(body.error).toContain("٦٠١ نقطة");
    expect(body.error).toContain("لا يُخصم إلا ما يُسلَّم");
    expect(state.acceptCalls).toBe(0);
  });

  it("with the explicit confirmation the same approval goes through to the reserve", async () => {
    setProviderBalanceForTesting(10);
    state.quote = quoteRow(4500);
    expect((await approve({ confirmedLargeReserve: false })).status).toBe(409);
    expect((await approve({ confirmedLargeReserve: "yes" })).status).toBe(409); // only the boolean true counts
    expect(state.acceptCalls).toBe(0);
    expect((await approve({ confirmedLargeReserve: true })).status).toBe(400); // reached the accept function, which stops the test there
    expect(state.acceptCalls).toBe(1);
  });

  it("a reserve above the 5,000-point job cap is refused whatever was confirmed, and nothing is reserved", async () => {
    setProviderBalanceForTesting(10);
    state.quote = quoteRow(5001);
    const res = await approve({ confirmedLargeReserve: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ success: false, overJobCap: true });
    expect(state.acceptCalls).toBe(0);
    state.quote = quoteRow(5000);
    expect((await approve({ confirmedLargeReserve: true })).status).toBe(400);
    expect(state.acceptCalls).toBe(1);
  });
});

describe("the provider side is checked for the cost of the delivered records, before anything is reserved", () => {
  it("37,500 X posts cost about 0.80 USD of provider spend: the default daily allowance (0.80 USD, 0.72 with the margin) refuses them until the owner raises it", async () => {
    state.quote = quoteRow(4600, "social-x-posts", 37_500);
    setProviderBalanceForTesting(10);
    const res = await approve({ confirmedLargeReserve: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ success: false, providerLimit: "provider_daily_cap", error: PROVIDER_DAILY_CAP_MESSAGE_AR });
    expect(state.acceptCalls).toBe(0);
  });

  it("with the daily allowance raised, the real balance decides: 0.5 USD refuses the same plan with the plain sentence, 1.0 lets it through", async () => {
    state.quote = quoteRow(4600, "social-x-posts", 37_500);
    process.env.PROVIDER_DAILY_SPEND_CAP_USD = "5";
    flushProviderLimitsCache();
    setProviderBalanceForTesting(0.5);
    const refused = await approve({ confirmedLargeReserve: true });
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body).toMatchObject({ success: false, providerLimit: "provider_balance_low", error: PROVIDER_BALANCE_LOW_MESSAGE_AR });
    expect(body.error).not.toMatch(/[A-Za-z]|USD|دولار|مزود/);
    expect(state.acceptCalls).toBe(0);
    resetProviderBalanceCacheForTesting();
    setProviderBalanceForTesting(1.0);
    expect((await approve({ confirmedLargeReserve: true })).status).toBe(400);
    expect(state.acceptCalls).toBe(1);
  });

  it("a small plan is not refused for a balance that holds it (the price of one delivered record is used, not the price of a call)", async () => {
    state.quote = quoteRow(14, "social-x-posts", 100);
    setProviderBalanceForTesting(0.01); // 100 posts cost 0.00213 USD; a call-price estimate (100 x 0.00075 = 0.075) would have refused
    expect((await approve()).status).toBe(400);
    expect(state.acceptCalls).toBe(1);
  });
});
