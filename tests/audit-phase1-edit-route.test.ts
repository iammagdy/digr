import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCompanyPlanEditOperations, buildPeoplePlanEditOperations } from "../src/lib/companyPlanEdits";
import { extractInterpretedParameters } from "../src/lib/planParameters";

/**
 * POINT 2 through the real /api/chat/edit-plan route: the operations the page builds are applied to the stored quote and a NEW quote is
 * created from the result (the one the card shows again and the chat restores). The new quote must carry the edited country, and its summary
 * must never carry the validation sentence.
 */
const state = vi.hoisted(() => ({ user: { id: "u1" } as { id: string } | null, quote: null as any, plans: [] as any[] }));

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
  createAndSaveManagedQuote: vi.fn(async (_db: any, input: any) => { state.plans.push(input.plan); return { quoteId: "q_new", items: input.plan.items, summaryAr: input.plan.summaryAr, targetVolumeMax: input.plan.items[0].targetVolumeMax, quotedPoints: 0, status: "proposed" }; }),
}));

function editRequest(body: Record<string, unknown>) {
  const { NextRequest } = require("next/server");
  return new NextRequest("http://localhost/api/chat/edit-plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /api/chat/edit-plan: the edited country is saved and the summary never holds the validation sentence", () => {
  beforeEach(() => { state.user = { id: "u1" }; state.plans = []; });

  it("a company plan with no country: the page's operations save the country, and reopening reads it", async () => {
    state.quote = { id: "q_c", user_id: "u1", status: "quoted", conversation_id: "c1", summary_ar: "خطة", output_formats: ["xlsx"], items: [{ capabilitySlug: "icypeas-companies-search", params: { industry: "الكهرباء والطاقة الكهربائية", query: { keyword: { include: ["electrical"] } } }, targetVolumeMin: 1, targetVolumeMax: 5, unitPricePoints: 3.168 }] };
    const operations = [
      { action: "set_limit", capabilitySlug: "icypeas-companies-search", targetVolumeMax: 5 },
      { action: "set_formats", formats: ["xlsx"] },
      ...buildCompanyPlanEditOperations("icypeas-companies-search", "", "مصر", "الكهرباء", { keyword: "electrical", country: "", industry: "الكهرباء والطاقة الكهربائية" }),
    ];
    const { POST } = await import("../src/app/api/chat/edit-plan/route");
    const res = await POST(editRequest({ quoteId: "q_c", operations }));
    expect(res.status).toBe(200);
    const saved = state.plans[0];
    expect(saved.items[0].params.country).toBe("Egypt");
    expect(saved.items[0].params.query.location.include).toEqual(["Egypt"]);
    expect(extractInterpretedParameters(saved.items[0].params, saved.summaryAr).countryAr).toBe("مصر");
    expect(saved.summaryAr).toBe("خطة حصر حتى ٥ سجل: الكهرباء والطاقة الكهربائية في مصر");
  });

  it("a plan edited WITHOUT a country keeps a summary with no validation sentence and Arabic digits (it used to read «… في يلزم تحديد الدولة» with Latin digits)", async () => {
    state.quote = { id: "q_n", user_id: "u1", status: "quoted", conversation_id: "c1", summary_ar: "خطة", output_formats: ["xlsx"], items: [{ capabilitySlug: "icypeas-companies-search", params: { industry: "الكهرباء والطاقة الكهربائية", query: { keyword: { include: ["electrical"] } } }, targetVolumeMin: 1, targetVolumeMax: 12, unitPricePoints: 3.168 }] };
    const { POST } = await import("../src/app/api/chat/edit-plan/route");
    const res = await POST(editRequest({ quoteId: "q_n", operations: [{ action: "set_limit", capabilitySlug: "icypeas-companies-search", targetVolumeMax: 12 }, { action: "set_formats", formats: ["xlsx"] }] }));
    expect(res.status).toBe(200);
    expect(state.plans[0].summaryAr).toBe("خطة حصر حتى ١٢ سجل: الكهرباء والطاقة الكهربائية");
    expect(state.plans[0].summaryAr).not.toMatch(/يلزم تحديد|[0-9]/);
  });

  it("a decision-makers plan: the edited country (ISO code) and title are saved; the old behaviour wrote a «query» string and dropped the country", async () => {
    state.quote = { id: "q_p", user_id: "u1", status: "quoted", conversation_id: "c1", summary_ar: "خطة", output_formats: ["xlsx"], items: [{ capabilitySlug: "professional-people-search", params: { q: "مديرين", limit: 5, country: "SA", title: "Director" }, targetVolumeMin: 1, targetVolumeMax: 5, unitPricePoints: 9 }] };
    const operations = [
      { action: "set_limit", capabilitySlug: "professional-people-search", targetVolumeMax: 5 },
      { action: "set_formats", formats: ["xlsx"] },
      ...buildPeoplePlanEditOperations("professional-people-search", "مدير", "ألمانيا"),
    ];
    const { POST } = await import("../src/app/api/chat/edit-plan/route");
    const res = await POST(editRequest({ quoteId: "q_p", operations }));
    expect(res.status).toBe(200);
    const params = state.plans[0].items[0].params;
    expect(params).toMatchObject({ country: "DE", title: "مدير" });
    expect(params).not.toHaveProperty("query");
    expect(extractInterpretedParameters(params, "", true).countryAr).toBe("ألمانيا");
    expect(state.plans[0].summaryAr).toContain("ألمانيا");
  });
});
