import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/functions/shared/catalogClient")>();
  return {
    ...actual,
    getEndpointDetails: vi.fn(async (endpointId: string) => {
      const prices: Record<string, number> = { "treg.people.search": 0.015, "treg.people.email.find": 0.01, "treg.people.phone.find": 0.01 };
      const catalogPriceUsd = prices[endpointId];
      return catalogPriceUsd ? { catalogPriceUsd } : null;
    }),
  };
});
vi.mock("../src/lib/server/providerGate", () => ({
  getLiveProviderGateStatus: () => ({ isReady: true, reasonCode: "ready", messageAr: "" }),
}));
vi.mock("../src/functions/shared/tregClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/functions/shared/tregClient")>();
  return { ...actual, executeTregCall: mocks.call };
});

import { defaultTregAdapter, normalizeTregPeopleParams, peopleSearchTimeoutMs, providerFailureMessageAr } from "../src/lib/server/tregAdapter";
import { DEFAULT_DECISION_MAKER_TITLE, hasPeopleIdentityKey, withPeopleIdentity } from "../src/lib/peopleSearchInput";
import { extractRequestIntent, peopleParamsFromIntent } from "../src/lib/requestIntent";
import { quoteScopeGaps } from "../src/lib/quoteScopeGaps";
import { ChatRequestError, customerFacingFailure, isRetryableFailure, TEMPORARY_FAILURE_NO_CHARGE_AR } from "../src/lib/customerError";
import { reasonCodeToCustomerMessage } from "../src/functions/shared/chatErrors";
import { decisionMakerDeliveredUnits, markContactRowsForReview } from "../src/functions/shared/decisionMakerPricing";
import { isDeterministicFailureAr, PROVIDER_GENERIC_FAILURE_AR, PROVIDER_INPUT_REJECTED_AR, PROVIDER_UNAVAILABLE_AR } from "../src/lib/providerFailureText";
import { CONTACT_AVAILABILITY_AR, DEFAULT_TITLE_NOTE_AR } from "../src/lib/contactExpectation";
import { normalizeCatalogEndpoint } from "../src/functions/shared/catalogClient";
import { catalogEndpointToCapability } from "../src/functions/shared/chatHandler";
import { createAndSaveManagedQuote } from "../src/functions/shared/planManager";
import { DEFAULT_PRICING_SETTINGS } from "../src/functions/shared/quotes";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";

/** The customer's request of the live failure (test account, production, 2026-10-25). */
const LIVE_REQUEST = "عايز ٣ من صناع القرار في شركات تكنولوجيا في مصر، مع البريد المهني والهاتف";
/** The params the failed plan stored (read from plans_quotes): filters and contact fields, and NO title, q, company or name. */
const STORED_LIVE_PARAMS = {
  limit: 3,
  country: "EG",
  keywords: ["information technology", "software", "technology"],
  requiredContactFields: ["work_email", "phone"],
  contactFieldsToAttempt: ["work_email", "phone"],
};
const SEARCH_KEYS = ["q", "company_domain", "full_name", "title", "country", "location", "keywords", "limit"];

describe("decision makers, live failure 1: a people search with no identity key is refused by the source (HTTP 422)", () => {
  it("the stored plan of the failed job had filters only: no identity key", () => {
    expect(hasPeopleIdentityKey(STORED_LIVE_PARAMS)).toBe(false);
    expect(hasPeopleIdentityKey({ ...STORED_LIVE_PARAMS, title: "CEO" })).toBe(true);
    expect(hasPeopleIdentityKey({ q: "chief executives of software companies in Egypt" })).toBe(true);
    expect(hasPeopleIdentityKey({ company_domain: "example.com" })).toBe(true);
    expect(hasPeopleIdentityKey({ full_name: "Mona Saleh" })).toBe(true);
    expect(hasPeopleIdentityKey({ title: "  ", q: "" })).toBe(false);
  });

  it("the request names «صناع القرار» and no role, so the builder used to send no title", () => {
    const intent = extractRequestIntent(LIVE_REQUEST);
    expect(intent.dataType).toBe("people");
    expect(intent.roles).toEqual([]);
    expect(intent.contactFields).toEqual(["work_email", "phone"]);
    const built = peopleParamsFromIntent(intent, { ...STORED_LIVE_PARAMS }, 3);
    expect(built.title).toBe(DEFAULT_DECISION_MAKER_TITLE);
    expect(hasPeopleIdentityKey(built)).toBe(true);
    expect(built).toMatchObject({ country: "EG", limit: 3, requiredContactFields: ["work_email", "phone"] });
  });

  it("a role the customer names is kept: the default never replaces it", () => {
    const intent = extractRequestIntent("عايز ٥ مديرين في شركات الطاقة في السعودية");
    expect(intent.roles).toEqual(["Director"]);
    expect(peopleParamsFromIntent(intent, {}, 5).title).toBe("Director");
    expect(withPeopleIdentity({ title: "CFO", country: "EG" })).toEqual({ title: "CFO", country: "EG" });
  });

  it("the search body of the stored live plan now carries an identity and only the keys the endpoint declares", () => {
    const body = normalizeTregPeopleParams(STORED_LIVE_PARAMS, 3);
    expect(body).toEqual({ title: "CEO", country: "EG", keywords: ["information technology", "software", "technology"], limit: 3 });
    expect(Object.keys(body).every((key) => SEARCH_KEYS.includes(key))).toBe(true);
  });

  describe("through the adapter, against a source that enforces the catalog rule", () => {
    beforeEach(() => { mocks.call.mockReset(); });

    // The search goes to the direct source (icypeas.people.search): it refuses a body with no query filter (422), and answers {total, success, leads}.
    // Email and phone lookups take domain + name or a profile link.
    const source = async (options: { endpointId: string; params?: Record<string, any>; timeoutMs?: number }) => {
      const params = options.params || {};
      if (options.endpointId === "icypeas.people.search") {
        const identified = Boolean(params.query?.currentJobTitle?.include?.length || params.query?.keyword?.include?.length);
        if (!identified) {
          return { ok: false, httpStatus: 422, tregCallId: "", costMicro: 0, latencyMs: 360, data: { error: "no_identity" }, error: "no_identity", isRouteMaxCost: false, isPlatformBalanceLow: false };
        }
        return {
          ok: true, httpStatus: 200, tregCallId: "search_1", costMicro: 100, latencyMs: 1,
          data: { total: 2560, success: true, leads: [{ firstname: "Mona", lastname: "Saleh", headline: "CEO", lastJobTitle: "CEO", lastCompanyName: "Example Software", lastCompanyWebsite: "https://example.com", lastCompanyIndustry: "Information Technology & Services", lastCompanyAddress: "Cairo, Egypt", address: "Cairo, Egypt", profileUrl: "https://www.linkedin.com/in/mona-saleh" }], pagination: { token: "t", size: 9 } },
          isRouteMaxCost: false, isPlatformBalanceLow: false,
        };
      }
      if (options.endpointId === "treg.people.email.find") {
        return { ok: true, httpStatus: 200, tregCallId: "email_1", costMicro: 20, latencyMs: 1, data: { output: { work_email: "mona@example.com" } }, isRouteMaxCost: false, isPlatformBalanceLow: false };
      }
      return { ok: true, httpStatus: 200, tregCallId: "phone_1", costMicro: 30, latencyMs: 1, data: { output: { phone_number: "+201000000000" } }, isRouteMaxCost: false, isPlatformBalanceLow: false };
    };
    const callInput = (params: Record<string, any>, extra: Record<string, any> = {}) => ({
      jobId: "job_quote_live", userId: "user_live", step: 0,
      endpointId: "treg.people.search", capabilitySlug: "professional-people-search",
      method: "POST" as const, params,
      paginationStrategy: "none" as const, cursor: null, pageSize: 3, remainingNeeded: 3,
      targetVolumeMax: 3, deliveredSoFar: 0, ...extra,
    });

    it("the stored live plan is served: a person with a work email and a phone, from the direct source body that carries the title", async () => {
      mocks.call.mockImplementation(source);
      const result = await defaultTregAdapter(callInput(STORED_LIVE_PARAMS));
      expect(result.ok).toBe(true);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ contact_name: "Mona Saleh", work_email: "mona@example.com", phone: "+201000000000" });
      const sent = mocks.call.mock.calls[0][0];
      expect(sent.endpointId).toBe("icypeas.people.search");
      expect(sent.params).toEqual({
        query: { currentJobTitle: { include: ["CEO"] }, location: { include: ["EG"] }, keyword: { include: ["information technology", "software", "technology"] } },
        pagination: { size: 9 },
      });
    });

    it("a plan that already names its role is sent with that role", async () => {
      mocks.call.mockImplementation(source);
      await defaultTregAdapter(callInput({ ...STORED_LIVE_PARAMS, title: "Director" }));
      expect(mocks.call.mock.calls[0][0].params.query.currentJobTitle).toEqual({ include: ["Director"] });
    });

    it("a source that still refuses the body fails the job at once, with the input sentence, no enrichment calls and no cost", async () => {
      mocks.call.mockResolvedValue({ ok: false, httpStatus: 422, tregCallId: "", costMicro: 0, latencyMs: 360, data: null, error: "http_422", isRouteMaxCost: false, isPlatformBalanceLow: false });
      const result = await defaultTregAdapter(callInput(STORED_LIVE_PARAMS));
      expect(result.ok).toBe(false);
      expect(result.httpStatus).toBe(422);
      expect(result.errorMessageAr).toBe(PROVIDER_INPUT_REJECTED_AR);
      expect(result.costMicro).toBe(0);
      expect(mocks.call).toHaveBeenCalledTimes(1);
      expect(isDeterministicFailureAr(result.errorMessageAr)).toBe(true);
    });
  });
});

describe("decision makers, live failure 1b: the search may use the time the worker's deadline leaves", () => {
  beforeEach(() => { mocks.call.mockReset(); });

  it("12 s without a deadline or with little time left, up to 30 s when the deadline allows", () => {
    const now = 1_000_000;
    expect(peopleSearchTimeoutMs(undefined, now)).toBe(12_000);
    expect(peopleSearchTimeoutMs(now + 20_000, now)).toBe(12_000);
    expect(peopleSearchTimeoutMs(now + 30_000, now)).toBe(18_000);
    expect(peopleSearchTimeoutMs(now + 45_000, now)).toBe(30_000);
    expect(peopleSearchTimeoutMs(now - 5_000, now)).toBe(12_000);
  });

  it("the search call is given that time; the per-person lookups keep 12 s", async () => {
    mocks.call.mockImplementation(async (options: { endpointId: string }) => options.endpointId === "icypeas.people.search"
      ? { ok: true, httpStatus: 200, tregCallId: "s", costMicro: 10, latencyMs: 1, data: { output: { people: [{ first_name: "A", last_name: "B", title: "CEO", company_name: "Example Software", industry: "Information Technology & Services", company_domain: "example.com", linkedin_url: "https://www.linkedin.com/in/a-b" }] } }, isRouteMaxCost: false, isPlatformBalanceLow: false }
      : { ok: true, httpStatus: 200, tregCallId: "x", costMicro: 1, latencyMs: 1, data: { output: {} }, isRouteMaxCost: false, isPlatformBalanceLow: false });
    await defaultTregAdapter({
      jobId: "job_t", userId: "user_t", step: 0, endpointId: "treg.people.search", capabilitySlug: "professional-people-search", method: "POST",
      params: { ...STORED_LIVE_PARAMS, title: "CEO" }, paginationStrategy: "none", cursor: null, pageSize: 3, remainingNeeded: 3, targetVolumeMax: 3, deliveredSoFar: 0,
      deadlineMs: Date.now() + 100_000,
    });
    const timeouts = new Map(mocks.call.mock.calls.map(([options]: any[]) => [options.endpointId, options.timeoutMs]));
    expect(timeouts.get("icypeas.people.search")).toBe(20_000);
    expect(timeouts.get("treg.people.email.find")).toBe(12_000);
  });
});

describe("decision makers, live failure 2: the plan is priced by the registry capability, never by the live zero-cost listing", () => {
  // The listing the live catalog returns for treg.people.search (read from the public catalog): routed wrapper, cost 0 per call.
  const LIVE_LISTING = {
    id: "treg.people.search",
    name: "people.search — routed: best of 26 providers, own keys first",
    summary: "Find people by a free-text description, or by company domain / title / country — provider-native rows in `people`",
    method: "POST", path: "/people.search", platform: "people", platform_label: "People & contact data", scope: "",
    cost: { type: "per_success", value: 0, currency: "USD", per: 1, unit: "call", usd: 0 },
    observed: { ok_rate: 0.911, samples: 2220733 },
    input: { bodyType: "json", body: { q: { type: "str", required: false }, company_domain: { type: "str", required: false }, title: { type: "str", required: false }, full_name: { type: "str", required: false }, country: { type: "str", required: false }, location: { type: "str", required: false }, limit: { type: "int", required: false }, keywords: { type: "list", required: false } } },
  };
  const peopleCapability: any = {
    slug: "professional-people-search", category: "people", nameAr: "بحث وإثراء بيانات المهنيين", nameEn: "People Search and Contact Enrichment", descriptionAr: "بحث مهني",
    paramsSchema: JSON.stringify({ type: "object" }), tregEndpointId: "treg.people.search", tregMethod: "POST", pricingUnit: "item", unitCostUsd: 0.015, maxRows: 500, paginationType: "none", enabled: true,
  };
  const makeClient = () => {
    const inserted: any[] = [];
    return {
      inserted,
      rpc: vi.fn(async (name: string, args: any) => name === "settle_people_job_atomic"
        ? { data: null, error: { code: "P0001", message: `Job ${args.p_job_id} not found` } }
        : { data: null, error: { code: "PGRST202", message: "Could not find the function" } }),
      from: vi.fn((table: string) => {
        if (table === "messages") {
          const query: any = { select: () => query, eq: () => query, not: () => query, order: () => query, limit: async () => ({ data: [], error: null }) };
          return query;
        }
        if (table === "plans_quotes") return { insert: async (row: any) => { inserted.push(row); return { data: row, error: null }; } };
        return { select: () => ({ eq: async () => ({ data: null, error: null }) }) };
      }),
    };
  };
  beforeEach(() => { resetProviderBalanceCacheForTesting(); setProviderBalanceForTesting(10); });

  it("the live listing is a zero-cost capability with the endpoint's own id (the thing the quote used to match first)", () => {
    const listing = catalogEndpointToCapability(normalizeCatalogEndpoint(LIVE_LISTING));
    expect(listing.unitCostUsd).toBe(0);
    expect(listing.tregEndpointId).toBe("treg.people.search");
    expect(listing.slug).not.toBe("professional-people-search");
  });

  it("with the listing BEFORE the registry (the order of a turn's capabilities) the quote is 193 points a person, not «سعر الوحدة غير صالح»", async () => {
    const listing = catalogEndpointToCapability(normalizeCatalogEndpoint(LIVE_LISTING));
    const client = makeClient();
    const quote = await createAndSaveManagedQuote(client as any, {
      conversationId: "live-retry-conversation",
      userId: "live-test-user",
      plan: {
        summaryAr: "بحث ٣ من صناع القرار والمهنيين في قطاع تقنية المعلومات والبرمجيات في مصر",
        items: [{
          capabilitySlug: "professional-people-search",
          endpointId: "treg.people.search",
          params: peopleParamsFromIntent(extractRequestIntent(LIVE_REQUEST), { ...STORED_LIVE_PARAMS }, 3),
          targetVolumeMin: 1,
          targetVolumeMax: 3,
        }],
        outputFormats: ["xlsx"],
      },
      userBalance: 5000,
      capabilities: [listing, peopleCapability],
      pricingSettings: DEFAULT_PRICING_SETTINGS,
    });
    const item = quote.items[0] as any;
    expect(item.capabilitySlug).toBe("professional-people-search");
    expect(item.contactUnitPricesPoints).toEqual({ basePerson: 83, workEmail: 55, phone: 55 });
    expect(item.unitPricePoints).toBe(193);
    expect(quote.expectedPoints).toBe(579);
    expect(item.params.title).toBe("CEO");
  });
});

describe("decision makers: a plan with no identity key is not offered, and the notice tells the truth before approval", () => {
  it("keywords, a country and the contact fields are filters: the stored live plan is incomplete, the repaired one is not", () => {
    const item = { capabilitySlug: "professional-people-search", endpointId: "treg.people.search", params: { ...STORED_LIVE_PARAMS }, targetVolumeMax: 3 };
    expect(quoteScopeGaps([item])).toContain("title");
    expect(quoteScopeGaps([{ ...item, params: { ...STORED_LIVE_PARAMS, title: "CEO" } }])).not.toContain("title");
    expect(quoteScopeGaps([{ ...item, params: { country: "EG", q: "chief executives of software companies" } }])).not.toContain("title");
  });

  it("the notice says a contact field does not reach every person and what the default title is, in Arabic only", () => {
    expect(CONTACT_AVAILABILITY_AR).toContain("لا يتوفر البريد المهني ولا الهاتف المكتبي لكل شخص");
    expect(DEFAULT_TITLE_NOTE_AR).toContain("الرئيس التنفيذي");
    for (const text of [CONTACT_AVAILABILITY_AR, DEFAULT_TITLE_NOTE_AR]) expect(/[A-Za-z]/.test(text)).toBe(false);
    const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
    expect(card).toContain("{CONTACT_AVAILABILITY_AR}");
    const handler = readFileSync("src/functions/shared/chatHandler.ts", "utf8");
    expect(handler.match(/CONTACT_AVAILABILITY_AR/g)?.length).toBeGreaterThanOrEqual(3);
    expect(handler.match(/DEFAULT_TITLE_NOTE_AR/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe("decision makers: what the source marked invalid is neither delivered nor charged", () => {
  const requested = ["work_email", "phone"] as const;

  it("an email marked «غير صالح» is not counted; a value with no report or still to review is", () => {
    const rows = [
      { work_email: "a@example.com", work_email_verification_status: "غير صالح", phone: "+201000000001", phone_verification_status: "لم يتوفر تأكيد" },
      { work_email: "b@example.com", work_email_verification_status: "يحتاج مراجعة", phone: "", phone_verification_status: "غير متاح" },
      { work_email: "c@example.com", phone: "+201000000003" },
    ];
    expect(decisionMakerDeliveredUnits(rows, [...requested])).toEqual({ baseUnits: 3, emailUnits: 2, phoneUnits: 2 });
  });

  it("a person whose only contact value was marked invalid is not charged at all, and waits for review", () => {
    const rows = [{ work_email: "bad@example.com", work_email_verification_status: "غير صالح", phone: "", phone_verification_status: "غير متاح" }];
    expect(decisionMakerDeliveredUnits(rows, [...requested])).toEqual({ baseUnits: 0, emailUnits: 0, phoneUnits: 0 });
    expect(markContactRowsForReview(rows, [...requested])[0].contact_review_status).toContain("لم يتوفر");
  });
});

describe("decision makers: a refusal caused by the request is not shown as a hiccup, and offers no retry", () => {
  it("plan_build_failed passes the server's own sentence through and is not retryable", () => {
    const serverText = reasonCodeToCustomerMessage("plan_build_failed");
    const err = new ChatRequestError(serverText, 500, "plan_build_failed");
    expect(isRetryableFailure(err)).toBe(false);
    expect(customerFacingFailure(err, { noCharge: true }).text).toBe(serverText);
    expect(customerFacingFailure(err, { noCharge: true }).text).not.toBe(TEMPORARY_FAILURE_NO_CHARGE_AR);
  });

  it("a network drop, a timeout and a server hiccup stay retryable and keep the temporary sentence", () => {
    expect(isRetryableFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isRetryableFailure(new ChatRequestError("", 504, "deadline_exceeded"))).toBe(true);
    expect(isRetryableFailure(new ChatRequestError("", 500, "internal_error"))).toBe(true);
    expect(customerFacingFailure(new ChatRequestError("", 504, "deadline_exceeded"), { noCharge: true }).text).toBe(TEMPORARY_FAILURE_NO_CHARGE_AR);
  });

  it("the chat page adds the retry button only for a retryable failure", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("...(isRetryableFailure(err) ? { errorRetryPrompt: textToSend } : {})");
  });

  it("a failed job whose source refused the request's own input offers no «إعادة المحاولة»; a busy source still does", () => {
    const liveJobText = "تعذر استكمال الاستخراج: تعذر معالجة مدخلات الطلب لدى المصدر. (حجز مؤقت مُحرَّر ٦٦٦ نقطة، ولم يُخصم شيء).";
    expect(providerFailureMessageAr({ httpStatus: 422, isRouteMaxCost: false, isPlatformBalanceLow: false })).toBe(PROVIDER_INPUT_REJECTED_AR);
    expect(isDeterministicFailureAr(liveJobText)).toBe(true);
    expect(isDeterministicFailureAr(PROVIDER_INPUT_REJECTED_AR)).toBe(true);
    expect(isDeterministicFailureAr(PROVIDER_GENERIC_FAILURE_AR)).toBe(false);
    expect(isDeterministicFailureAr(PROVIDER_UNAVAILABLE_AR)).toBe(false);
    expect(isDeterministicFailureAr(undefined)).toBe(false);
    const page = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    expect(page).toContain("retry = retry && !isDeterministicFailureAr(job.errorAr);");
    expect(page).toContain('k === "refunded" && !isDeterministicFailureAr(j.errorAr) ? "إعادة المحاولة"');
  });
});
