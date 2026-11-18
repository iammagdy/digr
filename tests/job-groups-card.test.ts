import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAndSaveManagedQuote } from "../src/functions/shared/planManager";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";
import { withMultiProviderCapabilities } from "../src/functions/shared/multiProviderCapability";
import { DEFAULT_PRICING_SETTINGS } from "../src/functions/shared/quotes";
import { planSplit } from "../src/lib/server/multiProvider/jobGroupPlan";
import { chainQuoteCopyFor } from "../src/lib/server/multiProvider/planUpgrade";
import { CHAIN_CAPABILITY_SLUG } from "../src/lib/multiProvider/routes";
import { reserveForUnits, DEFAULT_PRICING_BASIS } from "../src/lib/recordPricing";
import { splitCardLineAr, CHAIN_CARD_LIMITS_AR } from "../src/lib/multiProvider/copy";
import { setRouterStateForTesting } from "../src/lib/server/multiProvider/planRouting";
import type { RouterState, ProviderState } from "../src/lib/multiProvider/router";

const ok = (over: Partial<ProviderState> = {}): ProviderState => ({
  enabled: true,
  keyPresent: true,
  healthOk: true,
  dailyCapUsd: 100,
  spentTodayUsd: 0,
  ...over,
});

const stateOf = (): RouterState => ({
  flagOn: true,
  jobCapPoints: 25_000,
  providers: {
    treg: ok(),
    firecrawl: ok(),
    contextdev: ok(),
  },
});

function createMockTables(options: { probeAnswer?: any; quoteCaptor?: (quote: any) => void }) {
  const { probeAnswer = { success: false, error: "quote_not_found" }, quoteCaptor } = options;
  return {
    from: (table: string) => {
      const chain: any = {
        select() { return this; },
        eq() { return this; },
        not() { return this; },
        order() { return this; },
        limit: async () => ({ data: [], error: null }),
        insert: async (row: any) => {
          if (table === "plans_quotes" && quoteCaptor) {
            quoteCaptor(row);
          }
          return { error: null };
        },
        update() { return this; },
        in() { return this; },
        then(resolve: any) { resolve({ error: null }); },
      };
      return chain;
    },
    rpc: vi.fn(async (name: string, args: any) => {
      if (name === "accept_group_quote_atomic" && String(args.p_quote_id).startsWith("__diger_group_probe_")) {
        return { data: probeAnswer, error: null };
      }
      if (name === "create_quote_atomic") {
        if (quoteCaptor) {
          quoteCaptor(args);
        }
        return { data: { success: true }, error: null };
      }
      return { data: null, error: null };
    }),
  } as any;
}

const chainItem = (volume: number, over: Record<string, any> = {}) => ({
  capabilitySlug: CHAIN_CAPABILITY_SLUG,
  params: { industry: "مقاولات", country: "مصر", requiredFields: ["work_email"], ...over },
  targetVolumeMin: 1,
  targetVolumeMax: volume,
});

// The router assigns unitPricePoints = 88 for the chain route with requiredFields: ["work_email"].
const CHAIN_UNIT = 88;

describe("DT-05 PR-10 job groups card", () => {
  let savedEnv: string | undefined;
  let savedCap: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.MULTI_PROVIDER_ENABLED;
    savedCap = process.env.JOB_MAX_POINTS_CAP;
    process.env.MULTI_PROVIDER_ENABLED = "true";
    setRouterStateForTesting(stateOf());
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MULTI_PROVIDER_ENABLED;
    else process.env.MULTI_PROVIDER_ENABLED = savedEnv;
    if (savedCap === undefined) delete process.env.JOB_MAX_POINTS_CAP;
    else process.env.JOB_MAX_POINTS_CAP = savedCap;
    setRouterStateForTesting(null);
    vi.restoreAllMocks();
  });

  // T3 (a): planSplit table tests (pure unit calculation with V = 40, UNIT = 7)
  const V = 40, UNIT = 7, BUF = DEFAULT_PRICING_BASIS.safetyBuffer;
  it.each([
    ["X = V + 1", V + 1, 41, 2, [40, 1]],
    ["X = 3V", 3 * V, 120, 3, [40, 40, 40]],
    ["X = 40V", 40 * V, 1600, 40, Array(40).fill(40)],
    ["X = 40V + 1 (beyond the part limit)", 40 * V + 1, 1600, 40, Array(40).fill(40)],
  ] as Array<[string, number, number, number, number[]]>)("(T3 a) planSplit %s", (_n, X, Y, K, volumes) => {
    const r = planSplit({ X, V, unit: UNIT, safetyBuffer: BUF });
    expect(r.Y).toBe(Y);
    expect(r.K).toBe(K);
    expect(r.partVolumes).toEqual(volumes);
    expect(r.partReserves).toEqual(volumes.map((v) => Math.max(1, reserveForUnits(v, UNIT, BUF))));
    expect(r.hold).toBe(r.partReserves.reduce((a, b) => a + b, 0));
    expect(r.partReserves[0]).toBe(Math.max(1, reserveForUnits(V, UNIT, BUF))); // = item.itemReservation

    if (X === V + 1) {
      expect(r.partReserves).toEqual([322, 9]);
      expect(r.hold).toBe(331);
    } else if (X === 3 * V) {
      expect(r.hold).toBe(966);
    } else if (X === 40 * V) {
      expect(r.hold).toBe(12_880);
    }
  });

  // T3 (b) & AC1: createAndSaveManagedQuote with probe true
  it("(T3 b / AC1) A 120-company chain request with one-job volume 40 shows ONE card: 3 parts, quotedPoints = hold, stored = r_1", async () => {
    // With CHAIN_UNIT = 88, 40 units reserve is 4048 points. Setting cap to 4048 fits exactly volume 40.
    const r1 = reserveForUnits(40, CHAIN_UNIT, DEFAULT_PRICING_SETTINGS.safetyBuffer); // 4048
    process.env.JOB_MAX_POINTS_CAP = String(r1);

    let storedQuote: any = null;
    const tables = createMockTables({
      probeAnswer: { success: false, error: "quote_not_found" },
      quoteCaptor: (row) => { storedQuote = row; },
    });

    const quoteResult = await createAndSaveManagedQuote(tables, {
      conversationId: "c_group_1",
      userId: "u1",
      userBalance: 50_000,
      capabilities: withMultiProviderCapabilities(APPROVED_CAPABILITY_CATALOG, { MULTI_PROVIDER_ENABLED: "true" }),
      pricingSettings: DEFAULT_PRICING_SETTINGS,
      plan: {
        summaryAr: "خطة 120 شركة",
        items: [chainItem(120)],
        outputFormats: ["xlsx"],
      },
    });

    // 1. Quoted points equals hold (3 * 4048 = 12144)
    expect(quoteResult.quotedPoints).toBe(12_144);
    // 1b. Expected points equals sum of charges (3 * chargeForUnits(40, 88) = 3 * 3520 = 10560)
    expect(quoteResult.expectedPoints).toBe(10_560);
    // 2. targetVolumeMax equals Y = 120
    expect(quoteResult.targetVolumeMax).toBe(120);
    // 3. splitGroup metadata is present
    expect(quoteResult.splitGroup).toEqual({
      parts: 3,
      perPart: 40,
      reachable: 120,
      askedOriginal: 120,
      hold: 12_144,
    });
    // 4. Stored reservation in DB is r_1 (<= cap)
    const storedReserved = storedQuote?.total_reserved_credits ?? storedQuote?.p_total_points;
    expect(storedReserved).toBe(r1);
    expect(storedReserved).toBeLessThanOrEqual(r1);

    // 5. Item params has split v3
    expect(quoteResult.items[0].params?.split).toEqual({
      v: 3,
      part: 1,
      parts: 3,
      perPart: 40,
      partVolumes: [40, 40, 40],
      partReserves: [4048, 4048, 4048],
      hold: 12_144,
      reachable: 120,
      askedOriginal: 120,
    });

    // 6. No downscaled offer
    expect(quoteResult.downscaledOffer).toBeUndefined();
    // 7. isAffordable evaluated against hold (50_000 >= 12_144)
    expect(quoteResult.isAffordable).toBe(true);

    // 8. Chain card copy notes start with C1
    const copy = chainQuoteCopyFor({
      item: quoteResult.items[0],
      askedCount: 120,
    });
    expect(copy).not.toBeNull();
    const expectedC1 = splitCardLineAr(quoteResult.items[0].params.split);
    expect(copy!.methodologyNotes.startsWith(expectedC1)).toBe(true);
    expect(copy!.summaryAr).toMatch(/١٢٠/);
  });

  it("(T3 b) over 40 parts: reachable Y = 1600, notes start with C1b", async () => {
    const r1 = reserveForUnits(40, CHAIN_UNIT, DEFAULT_PRICING_SETTINGS.safetyBuffer);
    process.env.JOB_MAX_POINTS_CAP = String(r1);

    const tables = createMockTables({
      probeAnswer: { success: false, error: "quote_not_found" },
    });

    const quoteResult = await createAndSaveManagedQuote(tables, {
      conversationId: "c_group_over",
      userId: "u1",
      userBalance: 200_000,
      capabilities: withMultiProviderCapabilities(APPROVED_CAPABILITY_CATALOG, { MULTI_PROVIDER_ENABLED: "true" }),
      pricingSettings: DEFAULT_PRICING_SETTINGS,
      plan: {
        summaryAr: "خطة 2000 شركة",
        items: [chainItem(2000)],
        outputFormats: ["xlsx"],
      },
    });

    expect(quoteResult.targetVolumeMax).toBe(1600);
    expect(quoteResult.quotedPoints).toBe(161_920);
    expect(quoteResult.splitGroup).toEqual({
      parts: 40,
      perPart: 40,
      reachable: 1600,
      askedOriginal: 2000,
      hold: 161_920,
    });

    const copy = chainQuoteCopyFor({
      item: quoteResult.items[0],
      askedCount: 2000,
    });
    const expectedC1b = splitCardLineAr(quoteResult.items[0].params.split);
    expect(copy!.methodologyNotes.startsWith(expectedC1b)).toBe(true);
    expect(expectedC1b).toContain("٤٠");
    expect(expectedC1b).toContain("١٦٠٠");
  });

  it("(T3 b) affordability: balance < hold ⇒ isAffordable is false, and downscaledOffer is undefined", async () => {
    const r1 = reserveForUnits(40, CHAIN_UNIT, DEFAULT_PRICING_SETTINGS.safetyBuffer);
    process.env.JOB_MAX_POINTS_CAP = String(r1);

    const tables = createMockTables({
      probeAnswer: { success: false, error: "quote_not_found" },
    });

    const quoteResult = await createAndSaveManagedQuote(tables, {
      conversationId: "c_group_unaffordable",
      userId: "u1",
      userBalance: 5_000, // hold is 12,144
      capabilities: withMultiProviderCapabilities(APPROVED_CAPABILITY_CATALOG, { MULTI_PROVIDER_ENABLED: "true" }),
      pricingSettings: DEFAULT_PRICING_SETTINGS,
      plan: {
        summaryAr: "خطة 120 شركة",
        items: [chainItem(120)],
        outputFormats: ["xlsx"],
      },
    });

    expect(quoteResult.quotedPoints).toBe(12_144);
    expect(quoteResult.isAffordable).toBe(false);
    expect(quoteResult.downscaledOffer).toBeUndefined();
  });

  // T3 (b) / AC9: probe false ⇒ card equals main's (no split)
  it("(AC9) probe false ⇒ card equals main (no split, single part fitted to cap, no splitGroup)", async () => {
    const r1 = reserveForUnits(40, CHAIN_UNIT, DEFAULT_PRICING_SETTINGS.safetyBuffer);
    process.env.JOB_MAX_POINTS_CAP = String(r1);

    const tablesProbeFalse = createMockTables({
      probeAnswer: null, // rpc fails/returns null for probe
    });

    const quoteResult = await createAndSaveManagedQuote(tablesProbeFalse, {
      conversationId: "c_probe_false",
      userId: "u1",
      userBalance: 50_000,
      capabilities: withMultiProviderCapabilities(APPROVED_CAPABILITY_CATALOG, { MULTI_PROVIDER_ENABLED: "true" }),
      pricingSettings: DEFAULT_PRICING_SETTINGS,
      plan: {
        summaryAr: "خطة 120 شركة",
        items: [chainItem(120)],
        outputFormats: ["xlsx"],
      },
    });

    // Without group rpc: fitted to single job cap volume (40)
    expect(quoteResult.targetVolumeMax).toBe(40);
    expect(quoteResult.quotedPoints).toBe(r1);
    expect(quoteResult.splitGroup).toBeUndefined();
    expect(quoteResult.items[0].params?.split).toBeUndefined();

    const copy = chainQuoteCopyFor({
      item: quoteResult.items[0],
      askedCount: 120,
    });
    expect(copy).not.toBeNull();
    expect(copy!.methodologyNotes).toContain(CHAIN_CARD_LIMITS_AR[1]);
    expect(copy!.summaryAr).toMatch(/٤٠/);
  });

  it("(AC9 low balance) probe false with low balance ⇒ ordinary card with downscaledOffer and base numbers", async () => {
    const r1 = reserveForUnits(40, CHAIN_UNIT, DEFAULT_PRICING_SETTINGS.safetyBuffer); // 4048
    process.env.JOB_MAX_POINTS_CAP = String(r1);

    let storedQuote: any = null;
    const tablesProbeFalse = createMockTables({
      probeAnswer: null, // rpc fails/returns null for probe (hasJobGroupRpc false)
      quoteCaptor: (row) => { storedQuote = row; },
    });

    const quoteResult = await createAndSaveManagedQuote(tablesProbeFalse, {
      conversationId: "c_probe_false_low",
      userId: "u1",
      userBalance: 1_000,
      capabilities: withMultiProviderCapabilities(APPROVED_CAPABILITY_CATALOG, { MULTI_PROVIDER_ENABLED: "true" }),
      pricingSettings: DEFAULT_PRICING_SETTINGS,
      plan: {
        summaryAr: "خطة 120 شركة",
        items: [chainItem(120)],
        outputFormats: ["xlsx"],
      },
    });

    // Full comparison of the complete returned card object with normalized volatile fields
    const { quoteId, planHash, expiresAt, createdAt, ...stableCard } = quoteResult;
    expect(quoteId).toBeTruthy();
    expect(planHash).toBeTruthy();
    expect(expiresAt).toBeTruthy();
    expect(createdAt).toBeTruthy();
    expect(stableCard).toEqual({
      status: "proposed",
      summaryAr: "خطة 120 شركة",
      items: [
        {
          capabilitySlug: CHAIN_CAPABILITY_SLUG,
          params: {
            industry: "مقاولات",
            country: "مصر",
            requiredFields: ["work_email"],
            routeCode: expect.any(String),
          },
          targetVolumeMin: 1,
          targetVolumeMax: 40,
          endpointId: "mp.business.contacts",
          unitCostUsd: expect.any(Number),
          unitPricePoints: 88,
          rawPoints: 3520,
          itemReservation: 4048,
          reservedPoints: 4048,
          pricingUnit: "item",
        },
      ],
      outputFormats: ["xlsx"],
      targetVolumeMax: 40,
      unitPricePoints: 88,
      expectedPoints: 3520,
      quotedPoints: 4048,
      isAffordable: false,
      downscaledOffer: {
        maxAffordableUnits: 9,
        affordableQuotedPoints: 911,
        rawCostPoints: 792,
      },
      capacityConstrained: false,
      pointsCapConstrained: true,
      requestedVolumeMax: 120,
      pointsCap: 4048,
      userBalance: 1_000,
    });

    // Stored quote row items and total reservation
    const storedItems = storedQuote?.p_items ?? storedQuote?.items;
    const storedTotal = storedQuote?.p_total_points ?? storedQuote?.total_reserved_credits;
    expect(storedTotal).toBe(4048);
    expect(storedItems).toEqual(quoteResult.items);

    // Copy full comparison: exact summaryAr and methodologyNotes equal base code
    const copy = chainQuoteCopyFor({
      item: quoteResult.items[0],
      askedCount: 120,
    });
    expect(copy).toEqual({
      summaryAr: "نجمع حتى ٤٠ شركة من مصادر متاحة، ومع كل شركة: اسم الشركة، الموقع الإلكتروني، البريد الإلكتروني المهني.",
      methodologyNotes:
        "العدد المستهدف تسليمه: ٤٠ شركة من أصل ١٢٠ شركة مطلوبة، لأن الحد الأقصى لحجز المهمة الواحدة لا يتسع لأكثر من ذلك. " +
        "وقد يكون العدد المسلَّم أقل من المستهدف لأسباب قد تتعلق بالمصادر المتاحة أو بحدود المعالجة، وسنذكر لك العدد الفعلي والسبب، ولا يُحتسب عليك إلا ما يُسلَّم. " +
        "نجمع بيانات التواصل المنشورة للعامة على المواقع الرسمية للشركات ومن مصادر بيانات تجارية متاحة. " +
        "عمودا النشاط والدولة في الملف يعكسان معايير بحثك، ولا يُتحقق منهما لكل شركة على حدة. " +
        "قد لا يتوفر البريد الإلكتروني أو الهاتف لبعض الشركات، ولا نحتسب إلا الشركات التي تحققنا من الحقول المطلوبة فيها. " +
        "لا نجمع عناوين المنازل ولا معلومات العائلة ولا الحسابات الخاصة ولا أي صفحة تتطلب تسجيل دخول. " +
        "لا نضمن دقة تامة؛ نبذل أفضل جهد ممكن، وقد يكون عدد الشركات المسلَّمة أقل من المطلوب.",
    });
  });

  it("X = V non-split: when requested count fits single-job cap, ordinary card with no split", async () => {
    const r1 = reserveForUnits(40, CHAIN_UNIT, DEFAULT_PRICING_SETTINGS.safetyBuffer);
    process.env.JOB_MAX_POINTS_CAP = String(r1);

    const tables = createMockTables({
      probeAnswer: { success: false, error: "quote_not_found" },
    });

    const quoteResult = await createAndSaveManagedQuote(tables, {
      conversationId: "c_xv",
      userId: "u1",
      userBalance: 50_000,
      capabilities: withMultiProviderCapabilities(APPROVED_CAPABILITY_CATALOG, { MULTI_PROVIDER_ENABLED: "true" }),
      pricingSettings: DEFAULT_PRICING_SETTINGS,
      plan: {
        summaryAr: "خطة 40 شركة",
        items: [chainItem(40)],
        outputFormats: ["xlsx"],
      },
    });

    expect(quoteResult.targetVolumeMax).toBe(40);
    expect(quoteResult.quotedPoints).toBe(4048);
    expect(quoteResult.expectedPoints).toBe(3520);
    expect(quoteResult.splitGroup).toBeUndefined();
    expect(quoteResult.items[0].params?.split).toBeUndefined();
  });

  it("non-chain items: even if constrained by points cap, never split", async () => {
    process.env.JOB_MAX_POINTS_CAP = "500";
    const tables = createMockTables({
      probeAnswer: { success: false, error: "quote_not_found" },
    });

    const quoteResult = await createAndSaveManagedQuote(tables, {
      conversationId: "c_non_chain",
      userId: "u1",
      userBalance: 10_000,
      capabilities: APPROVED_CAPABILITY_CATALOG,
      pricingSettings: DEFAULT_PRICING_SETTINGS,
      plan: {
        summaryAr: "بحث منشورات عادي",
        items: [{
          capabilitySlug: "social-x-posts",
          params: { query: "x" },
          targetVolumeMin: 1,
          targetVolumeMax: 5000,
        }],
        outputFormats: ["xlsx"],
      },
    });

    expect(quoteResult.splitGroup).toBeUndefined();
    expect(quoteResult.items[0].params?.split).toBeUndefined();
  });

  it("multi-item plans: never split", async () => {
    process.env.JOB_MAX_POINTS_CAP = "500";
    const tables = createMockTables({
      probeAnswer: { success: false, error: "quote_not_found" },
    });

    const quoteResult = await createAndSaveManagedQuote(tables, {
      conversationId: "c_multi",
      userId: "u1",
      userBalance: 10_000,
      capabilities: withMultiProviderCapabilities(APPROVED_CAPABILITY_CATALOG, { MULTI_PROVIDER_ENABLED: "true" }),
      pricingSettings: DEFAULT_PRICING_SETTINGS,
      plan: {
        summaryAr: "خطة متعددة",
        items: [
          chainItem(120),
          {
            capabilitySlug: "social-x-posts",
            params: { query: "x" },
            targetVolumeMin: 1,
            targetVolumeMax: 10,
          },
        ],
        outputFormats: ["xlsx"],
      },
    });

    expect(quoteResult.splitGroup).toBeUndefined();
  });
});
