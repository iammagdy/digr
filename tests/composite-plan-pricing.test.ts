import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createAndSaveManagedQuote,
  PlanState,
  PlanItem,
  computePlanHash,
} from "../src/functions/shared/planManager";
import { Capability } from "../src/functions/shared/capabilityRegistry";
import { DEFAULT_PRICING_SETTINGS } from "../src/functions/shared/quotes";
import {
  setProviderBalanceForTesting,
  resetProviderBalanceCacheForTesting,
} from "../src/functions/shared/providerSpend";
import { acceptQuote } from "../src/functions/shared/quoteAccept";

function makeMockSupabase() {
  const insertedQuotes: any[] = [];
  const updatedQuotes: any[] = [];
  return {
    insertedQuotes,
    updatedQuotes,
    from: vi.fn((table: string) => ({
      update: vi.fn((data: any) => ({
        eq: vi.fn(() => ({
          eq: vi.fn(async () => {
            updatedQuotes.push({ table, data });
            return { data: [], error: null };
          }),
        })),
      })),
      insert: vi.fn(async (doc: any) => {
        insertedQuotes.push({ table, doc });
        return { data: doc, error: null };
      }),
    })),
  };
}

function makeMockAppwriteTables() {
  const store = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  return {
    store,
    async createRow({ tableId, rowId, data }: any) {
      const id = rowId || `row_${Math.random().toString(36).slice(2)}`;
      const doc = { $id: id, ...data };
      table(tableId).set(id, doc);
      return doc;
    },
    async listRows({ tableId }: any) {
      return { total: table(tableId).size, rows: Array.from(table(tableId).values()) };
    },
    async updateRow({ tableId, rowId, data }: any) {
      const existing = table(tableId).get(rowId) || {};
      const updated = { ...existing, ...data };
      table(tableId).set(rowId, updated);
      return updated;
    },
    async getRow({ tableId, rowId }: any) {
      return table(tableId).get(rowId) || null;
    },
  };
}

describe("Composite Multi-Capability Research Plan Pricing & Execution Safety", () => {
  beforeEach(() => {
    resetProviderBalanceCacheForTesting();
  });

  const capTikTok: Capability = {
    slug: "tiktok-profile",
    category: "tiktok",
    nameAr: "استخراج ملف تيك توك الشخصي",
    nameEn: "TikTok User Profile",
    descriptionAr: "استخراج إحصائيات الحساب",
    paramsSchema: JSON.stringify({ type: "object", properties: { username: { type: "string" } }, required: ["username"] }),
    tregEndpointId: "tikhub.tiktok.user.profile",
    tregMethod: "GET",
    pricingUnit: "call",
    unitCostUsd: 0.001, // 6 points unit price
    maxRows: 1000,
    paginationType: "none",
    enabled: true,
  };

  const capFacebook: Capability = {
    slug: "facebook-post-comments",
    category: "facebook",
    nameAr: "استخراج تعليقات فيسبوك",
    nameEn: "Facebook Comments",
    descriptionAr: "جمع التعليقات العامة",
    paramsSchema: JSON.stringify({ type: "object", properties: { postUrl: { type: "string" } }, required: ["postUrl"] }),
    tregEndpointId: "facebook.comments.v1",
    tregMethod: "POST",
    pricingUnit: "item",
    unitCostUsd: 0.0019, // ceil(0.0019 * 5500) = 11 points unit price
    maxRows: 5000,
    paginationType: "cursor",
    enabled: true,
  };

  const capXSearch: Capability = {
    slug: "x-post-search",
    category: "x",
    nameAr: "البحث في تدوينات إكس",
    nameEn: "X Post Search",
    descriptionAr: "البحث في التغريدات العامة",
    paramsSchema: JSON.stringify({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }),
    tregEndpointId: "x.search.v1",
    tregMethod: "GET",
    pricingUnit: "item",
    unitCostUsd: 0.00075, // ceil(0.00075 * 5500) = 5 points unit price
    maxRows: 1000,
    paginationType: "cursor",
    enabled: true,
  };

  const allCapabilities = [capTikTok, capFacebook, capXSearch];

  // 1. One capability, preserving existing pricing
  it("1. preserves exact existing pricing for single-capability quote", async () => {
    const mockDb = makeMockSupabase();
    const plan: PlanState = {
      summaryAr: "استخراج ملف تيك توك",
      items: [
        {
          capabilitySlug: "tiktok-profile",
          params: { username: "magdy" },
          targetVolumeMin: 1,
          targetVolumeMax: 10,
        },
      ],
      outputFormats: ["xlsx", "csv"],
    };

    const quote = await createAndSaveManagedQuote(mockDb as any, {
      conversationId: "conv-single",
      userId: "user-1",
      plan,
      userBalance: 500,
      capabilities: allCapabilities,
      pricingSettings: DEFAULT_PRICING_SETTINGS,
    });

    // 0.001 USD -> ceil(0.001 * 5500) = 6 points/unit
    expect(quote.unitPricePoints).toBe(6);
    expect(quote.items[0].unitPricePoints).toBe(6);
    // Base: 10 * 6 = 60 points. Quoted: ceil(60 * 1.15) = 69 points
    expect(quote.quotedPoints).toBe(69);
    expect(quote.targetVolumeMax).toBe(10);
    expect(quote.items[0].itemReservation).toBe(69);
    expect(quote.items[0].reservedPoints).toBe(69);

    // Supabase insert verification
    expect(mockDb.insertedQuotes).toHaveLength(1);
    expect(mockDb.insertedQuotes[0].doc.total_reserved_credits).toBe(69);
  });

  // 2. Two capabilities with different unit costs (IMPORTANT NUMERIC TEST)
  it("2. prices two capabilities independently with per-item rounding preservation (numeric test: 22+10=32 base -> 26+12=38 reserve)", async () => {
    const mockDb = makeMockSupabase();
    // Capability A: 2 units * 11 points = 22 points -> ceil(22 * 1.15) = 26 points
    // Capability B: 2 units * 5 points = 10 points -> ceil(10 * 1.15) = 12 points
    // Base total = 32 points. Total reservation = 26 + 12 = 38 points.
    const plan: PlanState = {
      summaryAr: "خطة مجمعة: فيسبوك وإكس",
      items: [
        {
          capabilitySlug: "facebook-post-comments",
          params: { postUrl: "https://facebook.com/post/1" },
          targetVolumeMin: 1,
          targetVolumeMax: 2,
        },
        {
          capabilitySlug: "x-post-search",
          params: { query: "بيانات مصر" },
          targetVolumeMin: 1,
          targetVolumeMax: 2,
        },
      ],
      outputFormats: ["xlsx", "csv", "pdf"],
    };

    const quote = await createAndSaveManagedQuote(mockDb as any, {
      conversationId: "conv-composite-2",
      userId: "user-2",
      plan,
      userBalance: 1000,
      capabilities: allCapabilities,
      pricingSettings: DEFAULT_PRICING_SETTINGS,
    });

    const [itemA, itemB] = quote.items;
    expect(itemA.unitPricePoints).toBe(11);
    expect(itemA.rawPoints).toBe(22);
    expect(itemA.itemReservation).toBe(26);
    expect(itemA.reservedPoints).toBe(26);

    expect(itemB.unitPricePoints).toBe(5);
    expect(itemB.rawPoints).toBe(10);
    expect(itemB.itemReservation).toBe(12);
    expect(itemB.reservedPoints).toBe(12);

    // Crucial: sum of item reservations is 26 + 12 = 38
    // (If incorrectly computed on aggregate base 32, ceil(32 * 1.15) would yield 37)
    expect(quote.quotedPoints).toBe(38);
    expect(quote.targetVolumeMax).toBe(4);

    expect(mockDb.insertedQuotes[0].doc.total_reserved_credits).toBe(38);
  });

  // 3. Three capabilities with different volumes
  it("3. computes three capabilities with varying volumes and different rates", async () => {
    const mockDb = makeMockSupabase();
    // Cap TikTok: 5 units * 6 points = 30 -> ceil(30 * 1.15) = 35
    // Cap Facebook: 10 units * 11 points = 110 -> ceil(110 * 1.15) = 127
    // Cap X: 20 units * 5 points = 100 -> ceil(100 * 1.15) = 115
    // Total reservation: 35 + 127 + 115 = 277
    const plan: PlanState = {
      summaryAr: "خطة ثلاثية المنصات",
      items: [
        {
          capabilitySlug: "tiktok-profile",
          params: { username: "user_tt" },
          targetVolumeMin: 1,
          targetVolumeMax: 5,
        },
        {
          capabilitySlug: "facebook-post-comments",
          params: { postUrl: "https://facebook.com/post/2" },
          targetVolumeMin: 1,
          targetVolumeMax: 10,
        },
        {
          capabilitySlug: "x-post-search",
          params: { query: "تكنولوجيا" },
          targetVolumeMin: 1,
          targetVolumeMax: 20,
        },
      ],
      outputFormats: ["xlsx"],
    };

    const quote = await createAndSaveManagedQuote(mockDb as any, {
      conversationId: "conv-3-caps",
      userId: "user-3",
      plan,
      userBalance: 500,
      capabilities: allCapabilities,
      pricingSettings: DEFAULT_PRICING_SETTINGS,
    });

    expect(quote.items[0].itemReservation).toBe(35);
    expect(quote.items[1].itemReservation).toBe(127);
    expect(quote.items[2].itemReservation).toBe(115);
    expect(quote.quotedPoints).toBe(277);
    expect(quote.targetVolumeMax).toBe(35);
  });

  // 4. Correct per-item and total reservation metadata retention
  it("4. retains capability identifier, verified provider cost, unit price, volume, and reservation on every item", async () => {
    const mockDb = makeMockSupabase();
    const plan: PlanState = {
      summaryAr: "خطة فحص الحقول والبيانات",
      items: [
        {
          capabilitySlug: "facebook-post-comments",
          endpointId: "facebook.comments.v1",
          params: { postUrl: "https://facebook.com/post/4" },
          targetVolumeMin: 1,
          targetVolumeMax: 50,
        },
        {
          capabilitySlug: "x-post-search",
          endpointId: "x.search.v1",
          params: { query: "اقتصاد" },
          targetVolumeMin: 1,
          targetVolumeMax: 100,
        },
      ],
      outputFormats: ["xlsx", "csv"],
    };

    const quote = await createAndSaveManagedQuote(mockDb as any, {
      conversationId: "conv-fields",
      userId: "user-4",
      plan,
      userBalance: 5000,
      capabilities: allCapabilities,
      pricingSettings: DEFAULT_PRICING_SETTINGS,
    });

    for (const it of quote.items) {
      expect(it.capabilitySlug).toBeDefined();
      expect(it.endpointId).toBeDefined();
      expect(it.unitCostUsd).toBeGreaterThan(0);
      expect(it.unitPricePoints).toBeGreaterThan(0);
      expect(it.targetVolumeMax).toBeGreaterThan(0);
      expect(it.itemReservation).toBeGreaterThan(0);
      expect(it.reservedPoints).toBe(it.itemReservation);
      expect(it.rawPoints).toBe(it.targetVolumeMax * it.unitPricePoints!);
    }

    const sumRes = quote.items.reduce((s, it) => s + (it.itemReservation || 0), 0);
    expect(quote.quotedPoints).toBe(sumRes);
  });

  // 5. Missing or invalid provider costs fail closed
  it("5. fails closed when a capability has missing, zero, or negative cost (never invents prices)", async () => {
    const mockDb = makeMockSupabase();
    const unpricedCap: Capability = {
      slug: "unpriced-capability",
      category: "web",
      nameAr: "خدمة غير مسعرة",
      nameEn: "Unpriced Cap",
      descriptionAr: "خدمة تجريبية",
      paramsSchema: "{}",
      tregEndpointId: "unpriced.v1",
      tregMethod: "GET",
      pricingUnit: "call",
      unitCostUsd: 0, // Invalid!
      maxRows: 100,
      paginationType: "none",
      enabled: true,
    };

    const plan: PlanState = {
      summaryAr: "خطة بخدمة غير مسعرة",
      items: [
        {
          capabilitySlug: "unpriced-capability",
          params: {},
          targetVolumeMin: 1,
          targetVolumeMax: 10,
        },
      ],
      outputFormats: ["xlsx"],
    };

    await expect(
      createAndSaveManagedQuote(mockDb as any, {
        conversationId: "conv-unpriced",
        userId: "user-5",
        plan,
        userBalance: 500,
        capabilities: [unpricedCap],
        pricingSettings: DEFAULT_PRICING_SETTINGS,
      })
    ).rejects.toThrow("سعر الوحدة غير صالح للخدمة المطلوبة.");
  });

  // 6. Incorrect capability identifier fails closed without fallback to capabilities[0]
  it("6. fails closed on unknown capability identifier without substituting capabilities[0]", async () => {
    const mockDb = makeMockSupabase();
    const plan: PlanState = {
      summaryAr: "خطة بقدرة غير موجودة",
      items: [
        {
          capabilitySlug: "non-existent-capability-slug",
          params: {},
          targetVolumeMin: 1,
          targetVolumeMax: 10,
        },
      ],
      outputFormats: ["xlsx"],
    };

    await expect(
      createAndSaveManagedQuote(mockDb as any, {
        conversationId: "conv-unknown",
        userId: "user-6",
        plan,
        userBalance: 500,
        capabilities: allCapabilities, // has tiktok, facebook, x
        pricingSettings: DEFAULT_PRICING_SETTINGS,
      })
    ).rejects.toThrow("غير معتمدة أو غير موجودة في الكتالوج");
  });

  // 7. Insufficient user balance triggers affordability false and composite downscale offer
  it("7. handles insufficient balance and produces proportional downscale offer", async () => {
    const mockDb = makeMockSupabase();
    // Cap A: 100 units * 11 = 1100 -> res = 1265
    // Cap B: 100 units * 5 = 500 -> res = 575
    // Total reservation = 1840 points. User balance = 500 points.
    const plan: PlanState = {
      summaryAr: "خطة تتجاوز الرصيد",
      items: [
        {
          capabilitySlug: "facebook-post-comments",
          params: { postUrl: "https://facebook.com/post/7" },
          targetVolumeMin: 1,
          targetVolumeMax: 100,
        },
        {
          capabilitySlug: "x-post-search",
          params: { query: "ذكاء اصطناعي" },
          targetVolumeMin: 1,
          targetVolumeMax: 100,
        },
      ],
      outputFormats: ["xlsx", "csv"],
    };

    const quote = await createAndSaveManagedQuote(mockDb as any, {
      conversationId: "conv-unaffordable",
      userId: "user-7",
      plan,
      userBalance: 500,
      capabilities: allCapabilities,
      pricingSettings: DEFAULT_PRICING_SETTINGS,
    });

    expect(quote.isAffordable).toBe(false);
    expect(quote.quotedPoints).toBe(1840);
    expect(quote.downscaledOffer).toBeDefined();
    expect(quote.downscaledOffer!.affordableQuotedPoints).toBeLessThanOrEqual(500);
    expect(quote.downscaledOffer!.maxAffordableUnits).toBeLessThan(200);
  });

  // 8. Capacity downscaling and final quote hash integrity
  it("8. downscales volume proportionally when provider balance is low and recomputes hash", async () => {
    const mockDb = makeMockSupabase();
    // Set provider balance to very low USD (e.g. 0.05 USD available)
    setProviderBalanceForTesting(0.05);

    // Plan requests 50 Facebook comments (50 * 0.0019 = 0.095 USD, exceeds 0.05 * 0.90 = 0.045 USD)
    const plan: PlanState = {
      summaryAr: "خطة تفحص سعة المزود",
      items: [
        {
          capabilitySlug: "facebook-post-comments",
          params: { postUrl: "https://facebook.com/post/8" },
          targetVolumeMin: 1,
          targetVolumeMax: 50,
        },
      ],
      outputFormats: ["xlsx"],
    };

    const quote = await createAndSaveManagedQuote(mockDb as any, {
      conversationId: "conv-capacity",
      userId: "user-8",
      plan,
      userBalance: 1000,
      capabilities: allCapabilities,
      pricingSettings: DEFAULT_PRICING_SETTINGS,
    });

    expect(quote.capacityConstrained).toBe(true);
    expect(quote.targetVolumeMax).toBeLessThan(50);
    // Hash matches downscaled item volume
    const expectedHash = computePlanHash(quote.items, quote.outputFormats);
    expect(quote.planHash).toBe(expectedHash);
  });

  // 9. No spending before explicit Start
  it("9. quoting persists quote state only without modifying user balance or ledger", async () => {
    const mockTables = makeMockAppwriteTables();
    const plan: PlanState = {
      summaryAr: "خطة بدون بدء",
      items: [
        {
          capabilitySlug: "tiktok-profile",
          params: { username: "user_test_9" },
          targetVolumeMin: 1,
          targetVolumeMax: 1,
        },
      ],
      outputFormats: ["xlsx"],
    };

    const quote = await createAndSaveManagedQuote(mockTables as any, {
      conversationId: "conv-no-spend",
      userId: "user-9",
      plan,
      userBalance: 100,
      capabilities: allCapabilities,
      pricingSettings: DEFAULT_PRICING_SETTINGS,
    });

    expect(quote.status).toBe("proposed");
    // Verify no ledger entries created
    expect(mockTables.store.get("credit_ledger")?.size || 0).toBe(0);
    // Verify no job created
    expect(mockTables.store.get("jobs")?.size || 0).toBe(0);
  });

  // 10. No partial execution of an approved multi-capability plan
  it("10. blocks execution of multi-capability quotes before reservation until multi-step worker is supported", async () => {
    const mockTables = makeMockAppwriteTables();
    const plan: PlanState = {
      summaryAr: "خطة متعددة القدرات للاختبار الأمني",
      items: [
        {
          capabilitySlug: "facebook-post-comments",
          params: { postUrl: "https://facebook.com/post/10" },
          targetVolumeMin: 1,
          targetVolumeMax: 10,
        },
        {
          capabilitySlug: "x-post-search",
          params: { query: "أمن المعلومات" },
          targetVolumeMin: 1,
          targetVolumeMax: 10,
        },
      ],
      outputFormats: ["xlsx", "csv"],
    };

    // User has 500 credits in ledger
    await mockTables.createRow({
      tableId: "credit_ledger",
      rowId: "top_init",
      data: {
        userId: "user-10",
        delta: 500,
        type: "topup",
        referenceId: "top_init",
        description: "شحن مبدئي",
        createdAt: new Date().toISOString(),
      },
    });

    const quote = await createAndSaveManagedQuote(mockTables as any, {
      conversationId: "conv-multi-block",
      userId: "user-10",
      plan,
      userBalance: 500,
      capabilities: allCapabilities,
      pricingSettings: DEFAULT_PRICING_SETTINGS,
    });

    // Attempting to accept the multi-capability quote must fail cleanly before reservation
    const acceptRes = await acceptQuote(mockTables as any, {
      userId: "user-10",
      quoteId: quote.quoteId,
      expectedPlanHash: quote.planHash,
    });
    expect(acceptRes.success).toBe(false);
    expect(acceptRes.statusCode).toBe(400);
    expect(acceptRes.errorAr).toContain("تدعم تنفيذ قدرة بحثية واحدة لكل طلب حالياً");

    // Zero reservations created in ledger
    const ledgerRows = Array.from(mockTables.store.get("credit_ledger")?.values() || []);
    const reservationRows = ledgerRows.filter((r) => r.type === "reserve");
    expect(reservationRows).toHaveLength(0);

    // Zero jobs created
    expect(mockTables.store.get("jobs")?.size || 0).toBe(0);
  });
});
