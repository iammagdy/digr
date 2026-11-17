import { describe, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { toArabicDigits } from "../src/lib/arabicDigits";
import { CHAIN_CARD_LIMITS_AR } from "../src/lib/multiProvider/copy";
import { chainQuoteCopyFor } from "../src/lib/server/multiProvider/planUpgrade";
import { setRouterStateForTesting, setRouteChooserForTesting } from "../src/lib/server/multiProvider/planRouting";
import { persistEditedQuoteMessage } from "../src/functions/shared/quoteMessagePersistence";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";
import { withMultiProviderCapabilities } from "../src/functions/shared/multiProviderCapability";
import { JOB_MAX_POINTS_CAP } from "../src/lib/jobPointsCap";
import { CHAIN_CAPABILITY_SLUG } from "../src/lib/multiProvider/routes";
import type { ProviderState, RouterState } from "../src/lib/multiProvider/router";

const state = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  quote: null as any,
  plans: [] as any[],
  messages: new Map<string, any>(),
  savedQuoteMessage: null as any,
  briefs: new Map<string, any>(),
}));

const mockTables: any = {
  from: () => {
    const chain: any = {
      select() { return this; },
      eq() { return this; },
      not() { return this; },
      order() { return this; },
      limit: async () => ({ data: [], error: null }),
      insert: async () => ({ error: null }),
      update() { return this; },
      in() { return this; },
      then(resolve: any) { resolve({ error: null }); },
    };
    return chain;
  },
};

vi.mock("../src/lib/agentMission/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/agentMission/constants")>()),
  AGENT_SERVES_CHAT: false,
}));

vi.mock("../src/functions/shared/quoteMessagePersistence", async (original) => ({
  ...(await original<any>()),
  persistEditedQuoteMessage: vi.fn(async (_client: any, _convId: string, quote: any) => {
    state.savedQuoteMessage = quote;
  }),
}));

vi.mock("../src/functions/shared/planManager", async (original) => {
  const actual = await original<typeof import("../src/functions/shared/planManager")>();
  return {
    ...actual,
    validatePlanAgainstSchemas: () => ({ valid: true, errors: [] }),
    createAndSaveManagedQuote: vi.fn(async (_db: any, input: any) => {
      return actual.createAndSaveManagedQuote(mockTables, {
        ...input,
        capabilities: withMultiProviderCapabilities(APPROVED_CAPABILITY_CATALOG, { MULTI_PROVIDER_ENABLED: "true" }),
      });
    }),
  };
});

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })),
    },
  })),
  createAdminClient: vi.fn(() => ({
    storage: {
      from: vi.fn(() => ({
        download: vi.fn(async () => ({
          data: { arrayBuffer: async () => Buffer.from("").buffer },
          error: null,
        })),
      })),
    },
    from: vi.fn((table: string) => {
      let queryCol = "";
      let queryVal = "";
      const chain: any = {
        select: vi.fn(() => chain),
        eq: vi.fn((col: string, val: string) => {
          queryCol = col;
          queryVal = val;
          return chain;
        }),
        not: vi.fn(() => chain),
        gte: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        single: vi.fn(async () => ({ data: state.quote, error: null })),
        maybeSingle: vi.fn(async () => {
          if (table === "conversations") {
            const entry = state.briefs.get(queryVal);
            if (!entry) return { data: null, error: null };
            return { data: { id: queryVal, user_id: entry.user_id || state.user?.id, brief: entry.brief || entry }, error: null };
          }
          if (table === "quotes") {
            return { data: state.quote, error: null };
          }
          if (table === "settings_public") {
            return { data: { value: { daily_cap_usd: 100 } }, error: null };
          }
          return { data: state.quote, error: null };
        }),
        insert: vi.fn(async () => ({ data: null, error: null })),
        update: vi.fn((updateData: any) => {
          if (table === "messages") {
            state.messages.set(queryVal, updateData);
          }
          return {
            eq: vi.fn((col: string, val: string) => {
              if (table === "conversations" && updateData.brief) {
                state.briefs.set(val, updateData.brief);
              }
              if (table === "messages") {
                state.messages.set(val, updateData);
              }
              return chain;
            }),
          };
        }),
        then: (resolve: any) => resolve({ data: [], error: null }),
      };
      return chain;
    }),
    rpc: vi.fn(async () => ({ data: { allowed: true }, error: null })),
  })),
}));

vi.mock("../src/functions/shared/capabilityRegistry", async (original) => ({
  ...(await original<any>()),
  getEnabledCapabilitiesWithCoreServices: vi.fn(async () => withMultiProviderCapabilities(APPROVED_CAPABILITY_CATALOG, { MULTI_PROVIDER_ENABLED: "true" })),
  getCatalogCapabilities: vi.fn(async () => withMultiProviderCapabilities(APPROVED_CAPABILITY_CATALOG, { MULTI_PROVIDER_ENABLED: "true" })),
}));

vi.mock("../src/functions/shared/catalogClient", async (original) => ({
  ...(await original<any>()),
  getEndpointDetails: vi.fn(async () => null),
}));

vi.mock("../src/lib/supabase/ledger", async (original) => ({
  ...(await original<any>()),
  calculateBalance: vi.fn(async () => 50000),
}));

const ok = (over: Partial<ProviderState> = {}): ProviderState => ({
  enabled: true,
  keyPresent: true,
  healthOk: true,
  dailyCapUsd: 100,
  spentTodayUsd: 0,
  ...over,
});

const stateOf = (providers: Partial<Record<"treg" | "firecrawl" | "contextdev", ProviderState>> = {}, flagOn = true): RouterState => ({
  flagOn,
  jobCapPoints: JOB_MAX_POINTS_CAP,
  providers: { treg: ok(), firecrawl: ok(), contextdev: ok(), ...providers },
});

describe("T-5 chain card builders (first quote, chat edit, edit-plan API)", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.MULTI_PROVIDER_ENABLED;
    process.env.MULTI_PROVIDER_ENABLED = "true";
    setRouterStateForTesting(stateOf());
    setRouteChooserForTesting(null);
    state.user = { id: "u1" };
    state.plans = [];
    state.savedQuoteMessage = null;
    state.messages.clear();
    state.briefs.clear();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MULTI_PROVIDER_ENABLED;
    else process.env.MULTI_PROVIDER_ENABLED = savedEnv;
    setRouterStateForTesting(null);
    setRouteChooserForTesting(undefined);
    vi.restoreAllMocks();
  });

  it("T-5(a) edit-plan API, cut plan: cap cuts the volume, summary and methodology notes are honest", async () => {
    state.quote = {
      id: "q_chain_50",
      user_id: "u1",
      conversation_id: "c1",
      status: "quoted",
      summary_ar: "خطة سابقة",
      output_formats: ["xlsx"],
      items: [{
        capabilitySlug: CHAIN_CAPABILITY_SLUG,
        params: { industry: "مقاولات", country: "مصر", requiredFields: ["work_email"] },
        targetVolumeMin: 1,
        targetVolumeMax: 50,
      }],
    };
    const { POST } = await import("../src/app/api/chat/edit-plan/route");
    const req = new NextRequest("http://localhost/api/chat/edit-plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteId: "q_chain_50",
        operations: [{ action: "set_limit", capabilitySlug: CHAIN_CAPABILITY_SLUG, targetVolumeMax: 50 }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    const card = data.quote;
    const cutN = card.targetVolumeMax;
    expect(cutN).toBeLessThan(50);
    expect(card.summaryAr).toContain(toArabicDigits(cutN));
    expect(card.summaryAr).toContain("شركة");
    expect(card.methodologyNotes).toContain("العدد المستهدف تسليمه");
    expect(card.methodologyNotes).toContain("من أصل ٥٠");
    expect(card.methodologyNotes).toContain(CHAIN_CARD_LIMITS_AR.join(" "));
    for (const forbidden of ["نواصل", "حتى يكتمل", "بالضبط", "سجل"]) {
      expect(card.methodologyNotes).not.toContain(forbidden);
    }

    const saved = state.savedQuoteMessage;
    expect(saved).toBeTruthy();
    expect(saved.summaryAr).toBe(card.summaryAr);
    expect(saved.methodologyNotes).toBe(card.methodologyNotes);

    const reloaded = JSON.parse(JSON.stringify(saved));
    expect(reloaded.summaryAr).toBe(card.summaryAr);
    expect(reloaded.methodologyNotes).toBe(card.methodologyNotes);
  });

  it("T-5(a) edit-plan API, uncut plan: cap does not cut volume, methodology notes says as asked", async () => {
    state.quote = {
      id: "q_chain_3",
      user_id: "u1",
      conversation_id: "c1",
      status: "quoted",
      summary_ar: "خطة سابقة",
      output_formats: ["xlsx"],
      items: [{
        capabilitySlug: CHAIN_CAPABILITY_SLUG,
        params: { industry: "مقاولات", country: "مصر", requiredFields: ["work_email"] },
        targetVolumeMin: 1,
        targetVolumeMax: 3,
      }],
    };
    const { POST } = await import("../src/app/api/chat/edit-plan/route");
    const req = new NextRequest("http://localhost/api/chat/edit-plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteId: "q_chain_3",
        operations: [{ action: "set_limit", capabilitySlug: CHAIN_CAPABILITY_SLUG, targetVolumeMax: 3 }],
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    const card = data.quote;
    expect(card.targetVolumeMax).toBe(3);
    expect(card.methodologyNotes).toContain("كما طلبت");
    expect(card.methodologyNotes).not.toContain("من أصل");
  });

  it("T-5(b) chat route, first quote: upgraded chain plan carries post-cut card summary and notes", async () => {
    setRouterStateForTesting(stateOf());
    setRouteChooserForTesting(null);
    const { POST } = await import("../src/app/api/chat/route");
    const req = new NextRequest("http://localhost:3000/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer valid_jwt_token",
      },
      body: JSON.stringify({
        conversationId: "conv_first_quote",
        message: "عايز 50 شركة مقاولات في مصر مع البريد الإلكتروني",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.planQuote).toBeTruthy();
    const card = data.planQuote;
    const cutN = card.targetVolumeMax;
    expect(cutN).toBeLessThan(50);
    expect(card.summaryAr).toContain(toArabicDigits(cutN));
    expect(card.summaryAr).toContain("شركة");
    expect(card.methodologyNotes).toContain("العدد المستهدف تسليمه");
    expect(card.methodologyNotes).toContain("من أصل ٥٠");
    expect(card.methodologyNotes).toContain(CHAIN_CARD_LIMITS_AR.join(" "));
    for (const forbidden of ["نواصل", "حتى يكتمل", "بالضبط", "سجل"]) {
      expect(card.methodologyNotes).not.toContain(forbidden);
    }

    const saved = state.savedQuoteMessage;
    expect(saved).toBeTruthy();
    expect(saved.summaryAr).toBe(card.summaryAr);
    expect(saved.methodologyNotes).toBe(card.methodologyNotes);

    const reloaded = JSON.parse(JSON.stringify(saved));
    expect(reloaded.summaryAr).toBe(card.summaryAr);
    expect(reloaded.methodologyNotes).toBe(card.methodologyNotes);
  });

  it("T-5(b) chat route, chat edit: edited chain plan carries post-cut card summary and notes", async () => {
    setRouterStateForTesting(stateOf());
    setRouteChooserForTesting(null);
    state.quote = {
      id: "q_chain_edit",
      user_id: "u1",
      conversation_id: "conv_edit_quote",
      status: "quoted",
      summary_ar: "خطة سابقة",
      output_formats: ["xlsx"],
      items: [{
        capabilitySlug: CHAIN_CAPABILITY_SLUG,
        params: { industry: "مقاولات", country: "مصر", requiredFields: ["work_email"] },
        targetVolumeMin: 1,
        targetVolumeMax: 50,
      }],
    };

    const llmModule = await import("../src/functions/shared/llmClient");
    const spy = vi.spyOn(llmModule.LlmClient.prototype, "executeTurn").mockResolvedValueOnce({
      output: {
        type: "edit_plan",
        operations: [
          { action: "set_limit", capabilitySlug: CHAIN_CAPABILITY_SLUG, targetVolumeMax: 50 },
        ],
      },
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0,
      model: "fake",
      promptVersion: "2.0.0",
      textBlockAr: "",
    } as any);

    try {
      const { POST } = await import("../src/app/api/chat/route");
      const req = new NextRequest("http://localhost:3000/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer valid_jwt_token",
        },
        body: JSON.stringify({
          conversationId: "conv_edit_quote",
          message: "عدل العدد إلى 50 شركة",
        }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.planQuote).toBeTruthy();
      const card = data.planQuote;
      const cutN = card.targetVolumeMax;
      expect(cutN).toBeLessThan(50);
      expect(card.summaryAr).toContain(toArabicDigits(cutN));
      expect(card.summaryAr).toContain("شركة");
      expect(card.methodologyNotes).toContain("العدد المستهدف تسليمه");
      expect(card.methodologyNotes).toContain("من أصل ٥٠");
      expect(card.methodologyNotes).toContain(CHAIN_CARD_LIMITS_AR.join(" "));
      for (const forbidden of ["نواصل", "حتى يكتمل", "بالضبط", "سجل"]) {
        expect(card.methodologyNotes).not.toContain(forbidden);
      }

      const saved = state.messages.get("conv_edit_quote")?.quote || state.savedQuoteMessage;
      expect(saved).toBeTruthy();
      expect(saved.summaryAr).toBe(card.summaryAr);
      expect(saved.methodologyNotes).toBe(card.methodologyNotes);

      const reloaded = JSON.parse(JSON.stringify(saved));
      expect(reloaded.summaryAr).toBe(card.summaryAr);
      expect(reloaded.methodologyNotes).toBe(card.methodologyNotes);
    } finally {
      spy.mockRestore();
    }
  });

  it("T-5(c) purity: does not mutate input, returns null for non-chain, non-display keys byte-identical", () => {
    const inputItem = {
      capabilitySlug: CHAIN_CAPABILITY_SLUG,
      params: { industryAr: "مقاولات", countryAr: "مصر", requiredFields: ["work_email"] },
      targetVolumeMax: 10,
    };
    const clone = structuredClone(inputItem);
    const result = chainQuoteCopyFor({ item: inputItem, askedCount: 20 });
    expect(inputItem).toEqual(clone);
    expect(result).toBeTruthy();

    const nonChainItem = {
      capabilitySlug: "social-x-posts",
      params: { query: "tech" },
      targetVolumeMax: 50,
    };
    expect(chainQuoteCopyFor({ item: nonChainItem, askedCount: 50 })).toBeNull();

    const originalCard = {
      summaryAr: "خطة سابقة",
      methodologyNotes: "ملاحظات سابقة",
      items: [inputItem],
      quotedPoints: 1200,
      expectedPoints: 1000,
      unitPricePoints: 100,
      targetVolumeMax: 10,
    };
    const clonedCard = structuredClone(originalCard);

    const chainCopy = chainQuoteCopyFor({ item: clonedCard.items[0], askedCount: 20 });
    if (chainCopy) {
      clonedCard.summaryAr = chainCopy.summaryAr;
      clonedCard.methodologyNotes = chainCopy.methodologyNotes;
    }

    for (const key of ["items", "quotedPoints", "expectedPoints", "unitPricePoints", "targetVolumeMax"] as const) {
      expect(JSON.stringify(clonedCard[key])).toBe(JSON.stringify(originalCard[key]));
    }
  });
});
