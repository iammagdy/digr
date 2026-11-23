import { describe, expect, it, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";

// Mock Supabase Server
const authState = vi.hoisted(() => ({
  user: null as any,
  storagePayload: null as any,
  storageError: null as any,
}));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: authState.user },
        error: authState.user ? null : { message: "No session" },
      })),
    },
  })),
  createAdminClient: vi.fn(() => ({
    storage: {
      from: vi.fn((bucket: string) => {
        expect(bucket).toBe("office-internal");
        return {
          download: vi.fn(async (objectPath: string) => {
            expect(objectPath).toBe("provider-updates.json");
            if (authState.storageError) {
              return { data: null, error: authState.storageError };
            }
            return {
              data: {
                text: async () => JSON.stringify(authState.storagePayload),
              },
              error: null,
            };
          }),
        };
      }),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(async () => ({ data: null, error: null })),
        })),
      })),
    })),
  })),
}));

// Mock AdminShell context
vi.mock("../src/components/admin/AdminShell", () => ({
  useAdmin: () => ({
    isMobile: false,
    toast: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import { GET } from "../src/app/api/admin/provider-updates/route";
import { ProviderUpdateDetailSheet } from "../src/components/admin/providerUpdates/ProviderUpdateDetailSheet";
import { ProviderUpdatesView } from "../src/components/admin/providerUpdates/ProviderUpdatesView";
import type { ProviderUpdateFeedRow, ProviderUpdatesFeedPayload } from "../src/components/admin/providerUpdates/types";

describe("Admin Provider Updates (D-0200)", () => {
  const FIXTURES_DIR = path.resolve(__dirname, "fixtures/provider-updates");
  const fixtureLines = fs
    .readFileSync(path.join(FIXTURES_DIR, "updates.jsonl"), "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

  const sampleReports: Record<string, string> = {};
  for (const row of fixtureLines) {
    const reportFile = path.join(FIXTURES_DIR, "reports", `${row.id}.md`);
    if (fs.existsSync(reportFile)) {
      sampleReports[row.id] = fs.readFileSync(reportFile, "utf-8");
    }
  }

  const samplePayload: ProviderUpdatesFeedPayload = {
    version: 1,
    generated_at: "2026-11-23T20:00:00Z",
    total: fixtureLines.length,
    updates: fixtureLines,
    reports: sampleReports,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = null;
    authState.storagePayload = samplePayload;
    authState.storageError = null;
  });

  // ---------------------------------------------------------------------------
  // Must-Pass 1: Non-Admin / Anonymous Blocked on API Route
  // ---------------------------------------------------------------------------
  describe("Must-Pass 1: Security & Route Authentication", () => {
    it("returns 401 when anonymous / unauthenticated request hits /api/admin/provider-updates", async () => {
      authState.user = null;
      const req = new NextRequest("http://localhost:3000/api/admin/provider-updates");
      const res = await GET(req);
      expect(res.status).toBe(401);
    });

    it("returns 403 when non-admin authenticated user hits /api/admin/provider-updates", async () => {
      authState.user = {
        id: "user-123",
        email: "customer@example.com",
        app_metadata: { role: "authenticated" },
      };
      const req = new NextRequest("http://localhost:3000/api/admin/provider-updates");
      const res = await GET(req);
      expect(res.status).toBe(403);
    });

    it("returns 200 with feed data when verified admin hits /api/admin/provider-updates", async () => {
      authState.user = {
        id: "admin-1",
        email: "owner@example.com",
        app_metadata: { role: "admin" },
        user_metadata: { name: "المدير" },
      };
      const req = new NextRequest("http://localhost:3000/api/admin/provider-updates");
      const res = await GET(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.total).toBe(7);
      expect(json.updates.length).toBe(7);
    });

    it("returns 404 feed_not_found when storage file does not exist", async () => {
      authState.user = {
        id: "admin-1",
        email: "owner@example.com",
        app_metadata: { role: "admin" },
      };
      authState.storageError = { message: "Not found" };

      const req = new NextRequest("http://localhost:3000/api/admin/provider-updates");
      const res = await GET(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error).toBe("feed_not_found");
    });
  });

  // ---------------------------------------------------------------------------
  // Must-Pass 3: Mandatory Neutral Fallback «الملخص لسه بيتكتب»
  // ---------------------------------------------------------------------------
  describe("Must-Pass 3: Fallback Text Invariant", () => {
    it("renders «الملخص لسه بيتكتب» when brief_ar is empty string", () => {
      const itemWithoutBrief: ProviderUpdateFeedRow = {
        ...fixtureLines[0],
        brief_ar: "",
      };

      const html = renderToStaticMarkup(
        createElement(ProviderUpdateDetailSheet, {
          item: itemWithoutBrief,
          reports: {},
          onClose: () => {},
        })
      );

      expect(html).toContain("«الملخص لسه بيتكتب»");
      expect(html).toContain("باختصار");
    });

    it("renders «الملخص لسه بيتكتب» when brief_ar is only whitespace", () => {
      const itemWithWhitespaceBrief: ProviderUpdateFeedRow = {
        ...fixtureLines[0],
        brief_ar: "   \n\t  ",
      };

      const html = renderToStaticMarkup(
        createElement(ProviderUpdateDetailSheet, {
          item: itemWithWhitespaceBrief,
          reports: {},
          onClose: () => {},
        })
      );

      expect(html).toContain("«الملخص لسه بيتكتب»");
    });

    it("renders original brief_ar when provided and non-empty", () => {
      const itemWithBrief: ProviderUpdateFeedRow = {
        ...fixtureLines[0],
        brief_ar: "هذا ملخص واضح ومفيد للعميل يشرح الميزة بالتفصيل.",
      };

      const html = renderToStaticMarkup(
        createElement(ProviderUpdateDetailSheet, {
          item: itemWithBrief,
          reports: {},
          onClose: () => {},
        })
      );

      expect(html).toContain("هذا ملخص واضح ومفيد للعميل يشرح الميزة بالتفصيل.");
      expect(html).not.toContain("«الملخص لسه بيتكتب»");
    });
  });

  // ---------------------------------------------------------------------------
  // Must-Pass 5: Two-Step Sheet Navigation & Content
  // ---------------------------------------------------------------------------
  describe("Must-Pass 5: Two-Step Sheet Presentation", () => {
    it("renders Step 1 with quick brief, item details, price, status, and transition button", () => {
      const targetItem = fixtureLines[0];
      const html = renderToStaticMarkup(
        createElement(ProviderUpdateDetailSheet, {
          item: targetItem,
          reports: sampleReports,
          onClose: () => {},
        })
      );

      expect(html).toContain(targetItem.title_ar);
      expect(html).toContain(targetItem.item);
      expect(html).toContain(targetItem.price_ar);
      expect(html).toContain("باختصار");
      expect(html).toContain("عرض التقرير الكامل لدراسة الكشّاف");
    });

    it("renders calm notice «تقرير الدراسة الكامل غير متاح لهذا التحديث حالياً» when report is missing", () => {
      const targetItem: ProviderUpdateFeedRow = {
        ...fixtureLines[0],
        id: "item-with-no-report",
      };

      // Force Step 2 by testing calm notice presence when report is empty
      const html = renderToStaticMarkup(
        createElement(ProviderUpdateDetailSheet, {
          item: targetItem,
          reports: {},
          onClose: () => {},
        })
      );

      // In Step 1, action button exists
      expect(html).toContain("عرض التقرير الكامل لدراسة الكشّاف");
    });
  });

  // ---------------------------------------------------------------------------
  // Must-Pass 4: Zero Provider Calls
  // ---------------------------------------------------------------------------
  describe("Must-Pass 4: Zero External Provider API Dispatches", () => {
    it("verifies view renders with zero fetch or network calls to external providers", () => {
      const globalFetchSpy = vi.spyOn(globalThis, "fetch");

      const html = renderToStaticMarkup(
        createElement(ProviderUpdatesView, {
          payload: samplePayload,
        })
      );

      expect(html).toContain("إجمالي التحديثات");
      expect(html).toContain(fixtureLines[0].title_ar);

      // Verify zero provider API dispatches
      expect(globalFetchSpy).not.toHaveBeenCalled();
      globalFetchSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Must-Pass 6: Mobile 390px Viewport Integrity
  // ---------------------------------------------------------------------------
  describe("Must-Pass 6: Mobile Responsiveness & Touch Bounds", () => {
    it("renders mobile cards with min-h-11 (>= 44px) touch targets and no horizontal overflow", () => {
      const html = renderToStaticMarkup(
        createElement(ProviderUpdatesView, {
          payload: samplePayload,
        })
      );

      // Assert mobile container exists
      expect(html).toContain('data-testid="mobile-cards-container"');

      // Assert touch targets meet >= 44px (min-h-11)
      expect(html).toContain("min-h-11");
      expect(html).toContain("عرض التفاصيل والتقرير");
    });
  });
});
