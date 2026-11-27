import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { AGENT_CAPABILITY_SLUG } from "../src/lib/agentMission/constants";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { getJobIdForQuote } from "../src/lib/md5";

const state = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof createMemoryDb>,
  rpc: vi.fn(),
  download: vi.fn(),
  overridePreflightQuote: false,
}));
const USER = { id: "u1", email_confirmed_at: "2026-01-01T00:00:00Z" };
const QUOTE_ID = "quote_existing";
const JOB_ID = getJobIdForQuote(QUOTE_ID);
const HASH = "f".repeat(64);
const REFUSAL = "العرض ده قديم ومبقاش متاح، اكتب طلبك من جديد";
const agentItem = {
  capabilitySlug: AGENT_CAPABILITY_SLUG,
  endpointId: AGENT_CAPABILITY_SLUG,
  targetVolumeMin: 1,
  targetVolumeMax: 20,
  unitPricePoints: 2,
  unitCostUsd: 0.001,
  params: {},
};
const legacyItem = { ...agentItem, endpointId: "tikhub.tiktok.video.comments" };

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: async () => ({
    auth: { getUser: async () => ({ data: { user: USER }, error: null }) },
  }),
  createAdminClient: () => ({
    ...state.db,
    from: (table: string) => {
      const builder = state.db.from(table);
      // All saved messages in this fixture have a quote when the route filters for it.
      if (table === "messages") builder.not = () => builder;
      if (table === "plans_quotes" && state.overridePreflightQuote) {
        builder.maybeSingle = async () => {
          state.overridePreflightQuote = false;
          return { data: { user_id: USER.id, status: "quoted", items: [agentItem] }, error: null };
        };
      }
      return builder;
    },
    rpc: state.rpc,
    storage: { from: () => ({ download: state.download }) },
  }),
}));
vi.mock("../src/lib/server/providerGate", () => ({
  getLiveProviderGateStatusFromSettings: async () => ({ isReady: true }),
}));
vi.mock("../src/lib/server/workerDispatch", () => ({
  dispatchWorkerChunk: async () => ({ started: true, status: 200, body: {} }),
}));
vi.mock("../src/lib/server/cronAuth", () => ({
  resolveInternalBaseUrl: () => "http://localhost",
  createInternalWorkerAuthHeaders: () => ({}),
}));
import { POST as accept } from "../src/app/api/chat/accept-quote/route";
import { POST as edit } from "../src/app/api/chat/edit-plan/route";
import { POST as remainder } from "../src/app/api/chat/sample-remainder/route";

const actions = {
  "accept-quote": (request: NextRequest) => accept(request),
  "edit-plan": (request: NextRequest) => edit(request),
  "sample-remainder": (request: NextRequest) => remainder(request),
};
type Action = keyof typeof actions;
const payloads = {
  "accept-quote": { quoteId: QUOTE_ID, expectedPlanHash: HASH, explicitApproval: true },
  "edit-plan": { quoteId: QUOTE_ID, operations: [{ action: "set_formats", formats: ["xlsx"] }] },
  "sample-remainder": { sampleQuoteId: QUOTE_ID, fullVolume: 20 },
};

function call(action: Action) {
  return actions[action](new NextRequest(`http://localhost/api/chat/${action}`, {
    method: "POST",
    body: JSON.stringify(payloads[action]),
  }));
}

function seedQuote(items: unknown, over: Record<string, unknown> = {}) {
  state.db.seed("plans_quotes", [{
    id: QUOTE_ID, quote_hash: HASH, user_id: USER.id, status: "quoted", items,
    expires_at: "2099-01-01T00:00:00Z", conversation_id: "c1", summary_ar: "خطة", output_formats: ["xlsx"],
    ...over,
  }]);
}

function seedCompletedSample() {
  state.db.seed("jobs", [{
    id: JOB_ID, user_id: USER.id, status: "completed",
    delivered_units: 5, charged_credits: 10, unit_price: 2,
  }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request"); }));
  state.db = createMemoryDb();
  state.overridePreflightQuote = false;
  state.db.seed("capability_registry", [{
    slug: AGENT_CAPABILITY_SLUG, endpoint_id: AGENT_CAPABILITY_SLUG, enabled: true,
    unit_cost_usd: 0.001, unit_price_credits: 2, max_rows: 100, paramsSchema: "{}",
  }]);
  state.db.seed("messages", [{ id: "message", user_id: USER.id, conversation_id: "c1", quote: { quoteId: QUOTE_ID } }]);
  state.db.seed("credit_ledger", [{ id: "grant", user_id: USER.id, delta: 1000 }]);
  state.download.mockResolvedValue({ data: null });
  state.rpc.mockImplementation(async (name, args) => {
    if (name === "accept_quote_atomic") {
      return { data: { success: true, job_id: JOB_ID, reserved_credits: 40 }, error: null };
    }
    if (name === "create_quote_atomic") {
      state.db.seed("plans_quotes", [{ id: args.p_quote_id, user_id: args.p_user_id, items: args.p_items }]);
      return { data: { success: true }, error: null };
    }
    return { data: null, error: null };
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("D-0248 legacy chat quote retirement", () => {
  it.each([
    ["accept-quote", "quoted and expired", [legacyItem], { expires_at: "2000-01-01T00:00:00Z" }],
    ["accept-quote", "quoted and fresh", [legacyItem], {}],
    ["accept-quote", "mixed nested items", { items: [agentItem, legacyItem] }, {}],
    ["accept-quote", "people readiness before any RPC", [{ ...legacyItem, capabilitySlug: "professional-people-search" }], {}],
    ["edit-plan", "quoted and expired", [legacyItem], { expires_at: "2000-01-01T00:00:00Z" }],
    ["edit-plan", "mixed legacy JSON fallback", JSON.stringify([agentItem]), { items_json: JSON.stringify([agentItem, legacyItem]) }],
    ["sample-remainder", "accepted sample", [legacyItem], { status: "accepted" }],
    ["sample-remainder", "mixed accepted sample", [agentItem, legacyItem], { status: "accepted" }],
  ] as const)("%s refuses %s before any side effect", async (action, _label, items, over) => {
    seedQuote(items, over);
    if (action === "sample-remainder") seedCompletedSample();
    const before = structuredClone([...state.db.tables]);

    const response = await call(action);

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ success: false, error: REFUSAL });
    expect(checkCustomerText(REFUSAL).issues).toEqual([]);
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.download).not.toHaveBeenCalled();
    for (const [table, rows] of before) expect(state.db.rows(table)).toEqual(rows);
    expect(state.db.rows("jobs")).toHaveLength(action === "sample-remainder" ? 1 : 0);
  });

  it("rechecks the acceptance snapshot when the first read saw different items", async () => {
    seedQuote([legacyItem]);
    state.overridePreflightQuote = true;

    const response = await call("accept-quote");

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ success: false, error: REFUSAL });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("checks ownership before revealing retirement of a stored quote", async () => {
    seedQuote([legacyItem], { user_id: "another-user" });

    const response = await call("accept-quote");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: "غير مصرح لك باعتماد هذا العرض." });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["quoted agent quote", agentItem, "quoted"],
    ["already accepted legacy quote", legacyItem, "accepted"],
  ])("keeps the acceptance response and atomic arguments for a %s", async (_label, item, status) => {
    seedQuote([item], { status });

    const response = await call("accept-quote");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      jobId: JOB_ID,
      quoteId: QUOTE_ID,
      reservedCredits: 40,
      workerDispatch: { started: true, status: 200, body: {} },
      driverMode: "tab",
      messageAr: "تم قبول الطلب وبدء التنفيذ.",
    });
    expect(state.rpc.mock.calls.filter(([name]) => name === "accept_quote_atomic")).toEqual([
      ["accept_quote_atomic", { p_quote_id: QUOTE_ID, p_user_id: USER.id, p_expected_quote_hash: HASH }],
    ]);
  });

  it("keeps the already-accepted edit refusal", async () => {
    seedQuote([legacyItem], { status: "accepted" });
    const response = await call("edit-plan");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false, error: "لا يمكن تعديل الخطة بعد بدء التنفيذ بالفعل.",
    });
  });

  it("edits an agent quote using the existing create-quote call and edit response", async () => {
    seedQuote([agentItem]);
    const response = await call("edit-plan");
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toEqual({
      success: true, quote: result.planQuote, planQuote: result.planQuote,
      messageAr: "تم تحديث الخطة وإعادة احتساب عرض السعر بنجاح!",
    });
    expect(result.quote).toMatchObject({ status: "quoted", outputFormats: ["xlsx"], targetVolumeMax: 20 });
    expect(state.db.rows("messages")[0]?.quote).toEqual(result.quote);
    expect(state.rpc.mock.calls).toEqual([
      ["create_quote_atomic", {
        p_user_id: USER.id, p_quote_id: result.quote.quoteId, p_quote_hash: result.quote.planHash,
        p_items: result.quote.items, p_total_points: result.quote.quotedPoints, p_output_formats: ["xlsx"],
        p_expires_at: result.quote.expiresAt, p_previous_quote_ids: [QUOTE_ID],
      }],
    ]);
  });

  it("quotes the remainder of an agent sample without reserving points", async () => {
    seedQuote([agentItem], { status: "accepted" });
    seedCompletedSample();
    const response = await call("sample-remainder");
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({
      success: true, remaining: 15,
      quote: { status: "quoted", items: [{ endpointId: AGENT_CAPABILITY_SLUG, targetVolumeMax: 15 }] },
    });
    expect(result).toEqual({
      success: true, remaining: 15, messageAr: result.messageAr, planQuote: result.quote,
      quote: result.quote, rest: { ...result.quote.afterSample },
    });
    expect(state.rpc.mock.calls).toEqual([
      ["create_quote_atomic", {
        p_user_id: USER.id, p_quote_id: result.quote.quoteId, p_quote_hash: result.quote.planHash,
        p_items: result.quote.items, p_total_points: result.quote.quotedPoints, p_output_formats: ["xlsx"],
        p_expires_at: result.quote.expiresAt, p_previous_quote_ids: [QUOTE_ID],
      }],
    ]);
    expect(state.db.rows("plans_quotes")).toHaveLength(2);
  });
});
