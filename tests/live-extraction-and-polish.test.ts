import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getLiveProviderGateStatus,
  getLiveProviderGateStatusFromSettings,
  isLiveProviderConfigured,
  getSanitizedProviderToken,
  mapProviderReasonToUserMessage,
} from "../src/lib/server/providerGate";
import {
  sanitizeCustomerErrorMessage,
  scrubProviderNames,
} from "../src/functions/shared/catalogClient";
import {
  validatePlanAgainstSchemas,
  PlanItem,
} from "../src/functions/shared/planManager";
import {
  extractTargetVolume,
} from "../src/functions/shared/briefManager";
import { Capability } from "../src/functions/shared/capabilityRegistry";

describe("Live Data Extraction Gate & Provider Diagnostics", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("evaluates TREG_LIVE case-insensitively with trimming", () => {
    process.env.TREG_LIVE = "  TRUE  ";
    process.env.TREG_TOKEN = "valid-token-123";
    expect(getLiveProviderGateStatus().isReady).toBe(true);
    expect(getLiveProviderGateStatus().reasonCode).toBe("ok");

    process.env.TREG_LIVE = "1";
    expect(getLiveProviderGateStatus().isReady).toBe(true);

    process.env.TREG_LIVE = "yes";
    expect(getLiveProviderGateStatus().isReady).toBe(true);

    process.env.TREG_LIVE = "on";
    expect(getLiveProviderGateStatus().isReady).toBe(true);

    process.env.TREG_LIVE = "false";
    const statusOff = getLiveProviderGateStatus();
    expect(statusOff.isReady).toBe(false);
    expect(statusOff.reasonCode).toBe("flag_off");
    expect(statusOff.messageAr).toContain("محرك استخراج البيانات المباشر غير مفعل حالياً");
  });

  it("checks TREG_TOKEN and fallback TREG_API_KEY with quotes/whitespace stripped", () => {
    process.env.TREG_LIVE = "true";
    delete process.env.TREG_TOKEN;
    delete process.env.TREG_API_KEY;

    // Both missing
    let status = getLiveProviderGateStatus();
    expect(status.isReady).toBe(false);
    expect(status.reasonCode).toBe("token_missing");

    // TREG_API_KEY fallback with quotes and whitespace
    process.env.TREG_API_KEY = '  "secret-fallback-key"  ';
    expect(getSanitizedProviderToken()).toBe("secret-fallback-key");
    status = getLiveProviderGateStatus();
    expect(status.isReady).toBe(true);
    expect(status.reasonCode).toBe("ok");

    // TREG_TOKEN takes precedence
    process.env.TREG_TOKEN = "'primary-token-abc'";
    expect(getSanitizedProviderToken()).toBe("primary-token-abc");
    expect(isLiveProviderConfigured()).toBe(true);
  });

  it("loads the persisted non-secret live switch for serverless routes while keeping tokens env-only", async () => {
    delete process.env.TREG_LIVE;
    process.env.TREG_TOKEN = "env-only-test-token";

    const source = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: { value: { TREG_LIVE: "true", TREG_TOKEN: "must-not-be-used" } }, error: null })),
          })),
        })),
      })),
    };

    const status = await getLiveProviderGateStatusFromSettings(source);
    expect(status.isReady).toBe(true);
    expect(process.env.TREG_LIVE).toBe("true");
    expect(source.from).toHaveBeenCalledWith("settings_private");
    expect(getLiveProviderGateStatus().reasonCode).toBe("ok");
  });

  it("honors a persisted off switch even when a deployment env flag is on", async () => {
    process.env.TREG_LIVE = "true";
    process.env.TREG_TOKEN = "env-only-test-token";
    const source = {
      getRow: vi.fn(async () => ({ TREG_LIVE: false })),
    };

    const status = await getLiveProviderGateStatusFromSettings(source);
    expect(status.isReady).toBe(false);
    expect(status.reasonCode).toBe("flag_off");
    expect(process.env.TREG_LIVE).toBe("false");
  });

  it("maps provider reason codes to safe Arabic messages without leaking provider names", () => {
    const codes = ["flag_off", "token_missing", "token_rejected", "catalog_unavailable", "spend_cap"] as const;
    for (const code of codes) {
      const msg = mapProviderReasonToUserMessage(code);
      expect(msg).toBeTruthy();
      expect(msg).not.toMatch(/treg|diffbot|tikhub|api_key|token/i);
    }
  });
});

describe("Customer Error Message Sanitization (Zero Provider Leaks)", () => {
  it("scrubs provider names and bare slugs from error messages", () => {
    const rawError = "خطأ في معاملات الخطة: الخدمة 'diffbot-x-extract-discussion' غير متوافقة مع متطلبات البحث";
    const sanitized = sanitizeCustomerErrorMessage(rawError);

    expect(sanitized).not.toContain("diffbot");
    expect(sanitized).not.toContain("diffbot-x-extract-discussion");
    expect(sanitized).toContain("الخدمة المحددة غير متوافقة مع متطلبات البحث");
  });

  it("scrubs multiple provider names and endpoints", () => {
    const providers = ["diffbot", "tikhub", "scrapecreators", "apify", "brightdata", "treg"];
    for (const p of providers) {
      const text = `Failed to contact ${p} provider endpoint ${p}.x.search for query`;
      const scrubbed = scrubProviderNames(text);
      expect(scrubbed.toLowerCase()).not.toContain(p);
    }
  });

  it("handles empty or unknown inputs safely", () => {
    expect(sanitizeCustomerErrorMessage(null)).toBeTruthy();
    expect(sanitizeCustomerErrorMessage(undefined)).toBeTruthy();
    expect(sanitizeCustomerErrorMessage("")).toBeTruthy();
  });
});

describe("Catalog Capability Schema Validation for Plan Editing", () => {
  const mockCatalogCap: Capability = {
    id: "diffbot-x-extract-discussion",
    slug: "diffbot-x-extract-discussion",
    nameAr: "استخراج مناقشات منصة X",
    nameEn: "Diffbot X Extract Discussion",
    descriptionAr: "جمع واستخراج التغريدات والمناقشات من منصة X",
    category: "x",
    platform: "x",
    unitCostUsd: 0.0028,
    pointsPerUnit: 2,
    maxRows: 5000,
    enabled: true,
    paramsSchema: JSON.stringify({
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    }),
    pricingUnit: "item",
    paginationType: "cursor",
    tregEndpointId: "diffbot.x.extract-discussion",
    tregMethod: "GET",
  };

  it("successfully validates plan items using catalog capabilities", () => {
    const planItems: PlanItem[] = [
      {
        capabilitySlug: "diffbot-x-extract-discussion",
        params: { query: "الذكاء الاصطناعي" },
        targetVolumeMin: 1,
        targetVolumeMax: 50,
      },
    ];

    const result = validatePlanAgainstSchemas(planItems, [mockCatalogCap]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails validation cleanly without leaking provider names when parameters are invalid", () => {
    const planItems: PlanItem[] = [
      {
        capabilitySlug: "diffbot-x-extract-discussion",
        params: {}, // missing required query
        targetVolumeMin: 1,
        targetVolumeMax: 50,
      },
    ];

    const result = validatePlanAgainstSchemas(planItems, [mockCatalogCap]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    const sanitized = sanitizeCustomerErrorMessage(result.errors.join(", "));
    expect(sanitized).not.toContain("diffbot");
  });
});

describe("Volume Extraction with Custom and Small (<100) Numbers", () => {
  it("extracts bare numbers under 100", () => {
    expect(extractTargetVolume("5")).toBe(5);
    expect(extractTargetVolume("25")).toBe(25);
    expect(extractTargetVolume("50")).toBe(50);
  });

  it("extracts custom volumes from Arabic requests", () => {
    expect(extractTargetVolume("أريد 25 سجلاً فقط")).toBe(25);
    expect(extractTargetVolume("حتى 50 سجلاً")).toBe(50);
    expect(extractTargetVolume("عايز 15 نتيجة")).toBe(15);
    expect(extractTargetVolume("اسحب 30 تعليق")).toBe(30);
  });

  it("extracts Arabic-Indic numerals correctly", () => {
    expect(extractTargetVolume("حتى ٥٠ سجلاً")).toBe(50);
    expect(extractTargetVolume("٢٥")).toBe(25);
  });

  it("does not mistake future years for volume limits", () => {
    expect(extractTargetVolume("بيانات عام 2026")).toBeUndefined();
  });
});
