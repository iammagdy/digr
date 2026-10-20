import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { applyCustomerCap, reserveForUnits, volumeForPointsCap } from "../src/lib/pointsCap";
import { capQuestionFor, nextStep, understandMission } from "../src/lib/consultantCopy";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";

describe("the customer's own budget cap (points)", () => {
  it("is the most records whose reserve (with the 15% buffer) fits under it", () => {
    expect(volumeForPointsCap(590, 9)).toBe(57);
    expect(reserveForUnits(57, 9)).toBe(590);
    expect(volumeForPointsCap(100, 6)).toBe(14);
    expect(volumeForPointsCap(5, 6)).toBe(0); // not even one record
    expect(volumeForPointsCap(0, 6)).toBe(0);
    expect(volumeForPointsCap(100, 0)).toBe(0);
    expect(volumeForPointsCap(Number.NaN, 6)).toBe(0);
  });

  it("the reserve never passes the cap, for any cap and unit price", () => {
    for (const unit of [1, 2, 3, 5, 6, 9, 11, 83]) {
      for (let cap = 1; cap <= 700; cap += 7) {
        const units = volumeForPointsCap(cap, unit);
        expect(reserveForUnits(units, unit)).toBeLessThanOrEqual(cap);
        // and one more record would pass it (the largest volume that fits)
        expect(reserveForUnits(units + 1, unit)).toBeGreaterThan(cap);
      }
    }
  });

  it("only lowers a plan, never raises it", () => {
    expect(applyCustomerCap({ capPoints: 590, unitPricePoints: 9, currentVolume: 30 })).toEqual({ ok: true, volume: 30, reservePoints: reserveForUnits(30, 9) });
    expect(applyCustomerCap({ capPoints: 590, unitPricePoints: 9, currentVolume: 500 })).toEqual({ ok: true, volume: 57, reservePoints: 590 });
    expect(applyCustomerCap({ capPoints: 100000, unitPricePoints: 9, currentVolume: 57 })).toMatchObject({ ok: true, volume: 57 });
  });

  it("refuses a cap that cannot hold one record, in plain Arabic with the lowest possible cap", () => {
    const result = applyCustomerCap({ capPoints: 5, unitPricePoints: 9, currentVolume: 50 });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reasonAr).toContain("لا يكفي لسجل واحد");
      expect(result.reasonAr).toContain("١١ نقطة"); // ceil(9 x 1.15)
      expect(result.reasonAr).not.toMatch(/[A-Za-z0-9]/);
    }
  });
});

describe("«all …» always carries a cap", () => {
  const URL_ALL = "عايز كل التعليقات على https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  it("all comments of a link, with no number: ONE question for the cap (comments)", () => {
    const u = understandMission(URL_ALL);
    expect(u.missing).toEqual(["cap"]);
    expect(nextStep(u)).toMatchObject({ type: "ask_one", id: "volume_cap_required", textAr: "ما الحد الأقصى لعدد التعليقات الذي تريده؟", options: ["٥٠٠ تعليق", "١٠٠٠ تعليق", "٢٠٠٠ تعليق", "٥٠٠٠ تعليق"] });
    expect(capQuestionFor(u)?.id).toBe("volume_cap_required");
  });

  it("all posts about a subject, with no number: ONE question for the cap (records)", () => {
    const u = understandMission("عايز كل المنشورات عن القهوة على إكس آخر شهر");
    expect(u.missing).toEqual(["cap"]);
    expect(nextStep(u)).toMatchObject({ id: "volume_cap_required", textAr: "ما الحد الأقصى لعدد السجلات الذي تريده؟" });
  });

  it("with a number, or without «all», there is no cap question", () => {
    expect(understandMission("عايز كل التعليقات على https://www.youtube.com/watch?v=dQw4w9WgXcQ حتى ٥٠٠ تعليق").missing).toEqual([]);
    expect(understandMission("عايز ١٠٠ تعليق على https://www.youtube.com/watch?v=dQw4w9WgXcQ").missing).toEqual([]);
  });
});

describe("the cap on the plan", () => {
  const quote: PlanQuoteData = {
    quoteId: "q_cap", summaryAr: "تغريدات عن القهوة",
    items: [{ capabilitySlug: "social-x-posts", params: { query: "القهوة" }, targetVolumeMin: 1, targetVolumeMax: 57 }],
    targetVolumeMax: 57, unitPricePoints: 9, expectedPoints: 513, quotedPoints: 590, isAffordable: true, userBalance: 5000,
    outputFormats: ["xlsx"], expiresAt: new Date(Date.now() + 3600_000).toISOString(), status: "quoted",
  };
  const render = (locked = false) => renderToStaticMarkup(createElement(PlanQuoteCard, { quote, locked, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {} } as any));

  it("states the plan's cap, from the quote's own reserve, and that only what is delivered is charged", () => {
    const html = render();
    expect(html).toContain('data-testid="plan-cap-line"');
    expect(html).toContain("سقف هذا الطلب: حتى ٥٩٠ نقطة");
    expect(html).toContain("ويُخصم فقط مقابل ما يُسلَّم");
    expect(html).toContain("تعديل الخطة");
  });

  it("an approved plan states its cap and offers no change", () => {
    const html = render(true);
    expect(html).toContain("سقف هذا الطلب: حتى ٥٩٠ نقطة");
    expect(html).not.toContain("تقدر تخفضه");
  });

  it("the edit form has the optional cap field, sent with the edit", () => {
    const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
    expect(card).toContain("حد أقصى للنقاط (اختياري)");
    expect(card).toContain("onSaveEdit(quote, editLimit, editParamVal, editFormats, editCountry, editIndustry,");
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("...(pointsCap && pointsCap > 0 ? { pointsCap } : {})");
  });
});

/* ---------------------------------------------------------------- the edit route */

const state = vi.hoisted(() => ({ user: { id: "u1" } as { id: string } | null, quote: null as any, ops: [] as any[], plans: [] as any[] }));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    from: () => { const api: any = { select: () => api, eq: () => api, not: () => api, limit: () => api, update: () => api, single: async () => ({ data: state.quote, error: null }), maybeSingle: async () => ({ data: state.quote, error: null }), then: (r: any) => r({ data: [], error: null }) }; return api; },
  })),
}));
vi.mock("../src/functions/shared/capabilityRegistry", async (original) => ({ ...(await original<any>()), getEnabledCapabilitiesWithCoreServices: vi.fn(async () => []), getCatalogCapabilities: vi.fn(async () => []) }));
vi.mock("../src/functions/shared/catalogClient", async (original) => ({ ...(await original<any>()), getEndpointDetails: vi.fn(async () => null) }));
vi.mock("../src/lib/supabase/ledger", async (original) => ({ ...(await original<any>()), calculateBalance: vi.fn(async () => 5000) }));
vi.mock("../src/functions/shared/quoteMessagePersistence", async (original) => ({ ...(await original<any>()), persistEditedQuoteMessage: vi.fn(async () => undefined) }));
vi.mock("../src/functions/shared/planManager", async (original) => ({
  ...(await original<any>()),
  validatePlanAgainstSchemas: () => ({ valid: true, errors: [] }),
  createAndSaveManagedQuote: vi.fn(async (_db: any, input: any) => { state.plans.push(input.plan); return { quoteId: "q_new", items: input.plan.items, targetVolumeMax: input.plan.items[0].targetVolumeMax, quotedPoints: 0, status: "proposed" }; }),
}));

function editRequest(body: Record<string, unknown>) {
  const { NextRequest } = require("next/server");
  return new NextRequest("http://localhost/api/chat/edit-plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /api/chat/edit-plan with a points cap", () => {
  beforeEach(() => {
    state.user = { id: "u1" };
    state.plans = [];
    state.quote = { id: "q_cap", user_id: "u1", status: "quoted", conversation_id: "c1", summary_ar: "خطة", output_formats: ["xlsx"], items: [{ capabilitySlug: "social-x-posts", params: { query: "القهوة" }, targetVolumeMin: 1, targetVolumeMax: 57, unitPricePoints: 9 }] };
  });
  const ops = [{ action: "set_limit", capabilitySlug: "social-x-posts", targetVolumeMax: 500 }, { action: "set_formats", formats: ["xlsx"] }];

  it("turns the cap into the volume the reserve can hold, computed on the server from the stored unit price; it never raises the plan", async () => {
    const { POST } = await import("../src/app/api/chat/edit-plan/route");
    const res = await POST(editRequest({ quoteId: "q_cap", operations: ops, pointsCap: 300 }));
    expect(res.status).toBe(200);
    expect(state.plans[0].items[0].targetVolumeMax).toBe(volumeForPointsCap(300, 9)); // 28
    expect(state.plans[0].items[0].targetVolumeMax).toBeLessThan(500);
  });

  it("refuses a cap that cannot hold one record, and a malformed cap, without creating a quote", async () => {
    const { POST } = await import("../src/app/api/chat/edit-plan/route");
    const tooSmall = await POST(editRequest({ quoteId: "q_cap", operations: ops, pointsCap: 5 }));
    expect(tooSmall.status).toBe(400);
    expect((await tooSmall.json()).error).toContain("لا يكفي لسجل واحد");
    expect((await POST(editRequest({ quoteId: "q_cap", operations: ops, pointsCap: -3 }))).status).toBe(400);
    expect((await POST(editRequest({ quoteId: "q_cap", operations: ops, pointsCap: 12.5 }))).status).toBe(400);
    expect(state.plans).toHaveLength(0);
  });

  it("without a cap the edit is unchanged", async () => {
    const { POST } = await import("../src/app/api/chat/edit-plan/route");
    await POST(editRequest({ quoteId: "q_cap", operations: ops }));
    expect(state.plans[0].items[0].targetVolumeMax).toBe(500);
  });
});
