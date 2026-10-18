import { describe, it, expect, vi } from "vitest";
import {
  APPROVED_CAPABILITY_CATALOG,
  buildApprovedCatalog,
  computeRegistryPointsPerUnit,
  getRegistryPricingSettings,
  sanitizeCapabilitiesForLlm,
  validatePlanPlatformMatch,
  VERIFICATION_NOTE,
  UNVERIFIED_PLATFORM_MESSAGE_AR,
} from "../src/functions/shared/capabilityRegistry";
import { ChatHandler } from "../src/functions/shared/chatHandler";

describe("Phase 2: Approved Capability Catalog, Settings-Driven Points, and Platform Match Guard", () => {
  it("contains all required seed capabilities with status, unit, maxItemsPerCall, estimatedSuccessRate, and verification note", () => {
    const ids = APPROVED_CAPABILITY_CATALOG.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "tiktok-profile",
        "facebook-post-comments",
        "facebook-post-search",
        "x-keyword-search",
        "youtube-comments",
        "youtube-search",
        "instagram-profile",
        "instagram-comments",
        "reddit-post-comments",
      ])
    );

    for (const entry of APPROVED_CAPABILITY_CATALOG) {
      expect(entry.id).toBeTruthy();
      expect(entry.nameAr).toBeTruthy();
      expect(entry.platform).toBeTruthy();
      expect(["verified", "pending_verification", "planned"]).toContain(entry.status);
      expect(["page", "query", "profile", "1000 items"]).toContain(entry.unit);
      expect(entry.estimatedCostUsdPerUnit).toBeGreaterThan(0);
      expect(entry.pointsPerUnit).toBeGreaterThan(0);
      expect(entry.maxItemsPerCall).toBeGreaterThan(0);
      expect(entry.estimatedSuccessRate).toBeGreaterThan(0);
      expect(entry.estimatedSuccessRate).toBeLessThan(1);
      expect(entry.verificationNote).toBe(VERIFICATION_NOTE);
    }

    const tiktok = APPROVED_CAPABILITY_CATALOG.find((c) => c.id === "tiktok-profile")!;
    expect(tiktok.status).toBe("verified");
    expect(tiktok.enabled).toBe(true);
  });

  it("computes pointsPerUnit dynamically from settings (ceil(cost_usd * usdToEgp * markup / 0.10)) and respects settings overrides", () => {
    const defaultSettings = getRegistryPricingSettings({ usdToEgp: 53, markup: 10, pointValueEgp: 0.10 });
    expect(defaultSettings.minimumOrderPoints).toBe(50);

    // x/twitter search: 0.00075 * 53 * 10 / 0.10 = 3.975 -> ceil = 4 points
    expect(computeRegistryPointsPerUnit(0.00075, defaultSettings)).toBe(4);
    // facebook post search: 0.03 * 53 * 10 / 0.10 = 159 points (~160)
    expect(computeRegistryPointsPerUnit(0.03, defaultSettings)).toBe(159);
    // facebook post comments: 0.0019 * 53 * 10 / 0.10 = 10.07 -> ceil = 11 (~10)
    expect(computeRegistryPointsPerUnit(0.0019, { usdToEgp: 52.6, markup: 10, pointValueEgp: 0.10, minimumOrderPoints: 50 })).toBe(10);

    // Changing settings changes catalog points without hardcoding
    const customCatalog = buildApprovedCatalog({
      usdToEgp: 50,
      markup: 10,
      pointValueEgp: 0.10,
      minimumOrderPoints: 50,
    });
    const tiktokCustom = customCatalog.find((c) => c.id === "tiktok-profile")!;
    // 0.001 * 50 * 10 / 0.10 = 5 points (with custom override)
    expect(tiktokCustom.pointsPerUnit).toBe(5);

    // Default settings: 0.001 * 55 * 10 / 0.10 = 5.5 -> ceil = 6 points
    const defaultCatalog = buildApprovedCatalog();
    const tiktokDefault = defaultCatalog.find((c) => c.id === "tiktok-profile")!;
    expect(tiktokDefault.pointsPerUnit).toBe(6);
  });

  it("gives the LLM capabilities from the registry with status while leaking zero provider names or endpoint IDs", () => {
    const sanitized = sanitizeCapabilitiesForLlm(APPROVED_CAPABILITY_CATALOG);
    expect(sanitized.length).toBe(APPROVED_CAPABILITY_CATALOG.length);

    for (const item of sanitized) {
      expect(item.id).toBeTruthy();
      expect(item.status).toBeDefined();
      expect(item.platform).toBeDefined();
      expect(item.unit).toBeDefined();
      expect(item.pointsPerUnit).toBeGreaterThan(0);
      expect((item as any).tregEndpointId).toBeUndefined();
      expect((item as any).unitCostUsd).toBeUndefined();
      expect((item as any).estimatedCostUsdPerUnit).toBeUndefined();
    }
  });

  it("deterministic platform check blocks a plan when the proposed capability platform does not match the platform mentioned by the user", () => {
    const mismatch = validatePlanPlatformMatch(
      "عايز تعليقات فيسبوك عن قائمة المنقولات",
      [{ capabilitySlug: "tiktok-profile" }]
    );
    expect(mismatch.valid).toBe(false);
    expect(mismatch.userPlatforms).toContain("facebook");
    expect(mismatch.planPlatforms).toContain("tiktok");
    expect(mismatch.errorAr).toContain("لا تطابق المنصة المذكورة");

    const matching = validatePlanPlatformMatch(
      "أريد بيانات حساب تيك توك @tiktok",
      [{ capabilitySlug: "tiktok-profile" }]
    );
    expect(matching.valid).toBe(true);
  });

  it("ChatHandler blocks mismatched platform plans without proposing an unrelated platform", async () => {
    const mockTables: any = {
      createRow: vi.fn().mockResolvedValue({ $id: "row-1" }),
      getRow: vi.fn().mockResolvedValue({ totalTokens: 0 }),
      listRows: vi.fn().mockImplementation(({ tableId }: any) => {
        if (tableId === "messages") {
          return Promise.resolve({
            rows: [{ role: "user", content: "عايز تعليقات فيسبوك عن قائمة المنقولات" }],
          });
        }
        return Promise.resolve({ rows: [] });
      }),
      updateRow: vi.fn().mockResolvedValue({}),
    };

    const handler = new ChatHandler(mockTables);
    // Simulate a rogue LLM response proposing a TikTok plan for a Facebook request
    vi.spyOn((handler as any).llm, "executeTurn").mockResolvedValue({
      output: {
        type: "propose_plan",
        summaryAr: "استخراج حساب تيك توك",
        capabilities: [
          {
            capabilitySlug: "tiktok-profile",
            params: { username: "someuser" },
            targetVolumeMin: 1,
            targetVolumeMax: 1,
          },
        ],
        outputFormats: ["xlsx", "pdf", "csv"],
        methodologyNotes: "منهجية",
      },
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0001,
      model: "claude-haiku-5-5",
    });

    const response = await handler.handleUserMessage({
      userId: "user-1",
      conversationId: "conv-1",
      message: "عايز تعليقات فيسبوك عن قائمة المنقولات",
      userBalance: 100,
    });

    expect(response.planQuote).toBeUndefined();
    expect(response.contentAr).toContain(UNVERIFIED_PLATFORM_MESSAGE_AR);
    expect(response.contentAr).not.toContain("أقرب خدمة");
    expect(response.contentAr).not.toContain("تيك توك");
    expect(response.contentAr).not.toContain("LinkedIn");
  });
});
