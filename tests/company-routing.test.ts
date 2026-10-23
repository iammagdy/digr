import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 22 Oct 2026: «عايز ٥٠ شركة مقاولات في مصر» was planned on `blitzapi-jobs-search`, a job-postings endpoint the live catalog labelled with the
 * companies platform, and delivered nothing. A company request may only use a company search by its endpoint or slug (the approved
 * `icypeas-companies-search` first); the catalog's platform/category label never routes it. Fake catalog data only; nothing is called.
 */
const live = vi.hoisted(() => ({ icypeasLive: true, liveEndpoints: [] as any[] }));

vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getCachedCatalogEndpoints: () => live.liveEndpoints,
}));
vi.mock("../src/functions/shared/capabilityRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/functions/shared/capabilityRegistry")>();
  const withoutIcypeas = (list: any[]) => (live.icypeasLive ? list : list.filter((c) => c.slug !== "icypeas-companies-search"));
  return {
    ...actual,
    getEnabledCapabilitiesWithCoreServices: async () => withoutIcypeas(await actual.getEnabledCapabilities()),
    getCatalogCapabilities: async () => withoutIcypeas(actual.APPROVED_CAPABILITY_CATALOG as any[]),
  };
});

import {
  APPROVED_CAPABILITY_CATALOG, COMPANY_SOURCE_UNAVAILABLE_AR, PEOPLE_SOURCE_UNAVAILABLE_AR, isCompanySearchCapabilityRef,
  isPeopleSearchCapabilityRef, pickCompanySearchCapability, pickPeopleSearchCapability, validatePlanPlatformMatch, type Capability,
} from "../src/functions/shared/capabilityRegistry";
import { buildAutoPlanProposal, buildDeterministicPlanFromIntent, routeCompanySearchRequest, routePeopleAlternative } from "../src/functions/shared/chatHandler";
import { extractRequestIntent } from "../src/lib/requestIntent";
import { runConversation } from "./helpers/chatSession";

const REQUEST = "عايز ٥٠ شركة مقاولات في مصر";
const REQUEST_EN = "50 contractor companies in Egypt";
const brief: any = { platforms: ["companies"], topics: ["مقاولات"], targetVolume: 50 };

const icypeas = (APPROVED_CAPABILITY_CATALOG as Capability[]).find((c) => c.slug === "icypeas-companies-search")!;
const peopleSeed = (APPROVED_CAPABILITY_CATALOG as Capability[]).find((c) => c.slug === "professional-people-search")!;
/** The job-postings endpoint, labelled as a companies platform by the catalog. */
const mislabelled: Capability = { ...icypeas, id: "blitzapi-jobs-search", slug: "blitzapi-jobs-search", tregEndpointId: "blitzapi.jobs.search", nameEn: "Jobs search", platform: "companies" as any, category: "companies" as any };
/** The same endpoint as the live catalog presents it (a catalog endpoint summary). */
const liveBlitz = {
  id: "blitzapi.jobs.search", slug: "blitzapi-jobs-search", nameAr: "بحث", nameEn: "Jobs search", summaryAr: "بحث", summaryEn: "Jobs search", platform: "companies",
  method: "POST", path: "/x", paramsSchema: {}, billingUnit: "item", catalogPriceUsd: 0.000495, pointsPerUnit: 3,
  pagination: { type: "cursor", maxLimit: 100 }, observedSuccessRate: 0.99, observedSamples: 1000, scope: "public",
};

describe("which capability a company request may use", () => {
  it("the mislabelled endpoint is not a company search; the approved one and any endpoint or slug with «compan» are", () => {
    expect(isCompanySearchCapabilityRef("blitzapi-jobs-search", "blitzapi.jobs.search")).toBe(false);
    expect(isCompanySearchCapabilityRef("icypeas-companies-search", "icypeas.companies.search")).toBe(true);
    expect(isCompanySearchCapabilityRef("x", "blitzapi.companies.search")).toBe(true);
    expect(isCompanySearchCapabilityRef("professional-people-search", "treg.people.search")).toBe(false);
  });

  it("icypeas is chosen even when the mislabelled endpoint comes first in the catalog order", () => {
    expect(pickCompanySearchCapability([mislabelled, icypeas])?.slug).toBe("icypeas-companies-search");
    expect(pickCompanySearchCapability([icypeas, mislabelled])?.slug).toBe("icypeas-companies-search");
  });

  it("the mislabelled endpoint alone is never chosen, a disabled approved service is not used, and the code catalog is not a fallback", () => {
    expect(pickCompanySearchCapability([mislabelled])).toBeNull();
    expect(pickCompanySearchCapability([mislabelled, { ...icypeas, enabled: false }])).toBeNull();
    expect(pickCompanySearchCapability([])).toBeNull();
  });

  it("another company search by endpoint is used only when the approved one is not live", () => {
    const other: Capability = { ...icypeas, id: "acme-companies-search", slug: "acme-companies-search", tregEndpointId: "acme.companies.search" };
    expect(pickCompanySearchCapability([other, icypeas])?.slug).toBe("icypeas-companies-search");
    expect(pickCompanySearchCapability([other, mislabelled])?.slug).toBe("acme-companies-search");
  });
});

describe("every planning path honours the rule", () => {
  it("routeCompanySearchRequest: a model plan or a stall on a catalog with the mislabelled endpoint first ends on icypeas", () => {
    for (const output of [{ type: "suggest_alternative", explanationAr: "x" }, { type: "propose_plan", capabilities: [{ capabilitySlug: "blitzapi-jobs-search", endpointId: "blitzapi.jobs.search" }] }]) {
      const routed = routeCompanySearchRequest(output, brief, [mislabelled, icypeas], REQUEST);
      expect(routed.type).toBe("propose_plan");
      expect(routed.capabilities).toHaveLength(1);
      expect(routed.capabilities[0].capabilitySlug).toBe("icypeas-companies-search");
      expect(routed.capabilities[0].endpointId).toBe("icypeas.companies.search");
    }
  });

  it("routeCompanySearchRequest: an English company request is routed the same way (the mislabelled plan never survives)", () => {
    const proposed = { type: "propose_plan", capabilities: [{ capabilitySlug: "blitzapi-jobs-search", endpointId: "blitzapi.jobs.search" }] };
    const routed = routeCompanySearchRequest(proposed, brief, [mislabelled, icypeas], REQUEST_EN);
    expect(routed).not.toBe(proposed);
    expect(JSON.stringify(routed)).not.toMatch(/blitz/i);
    const complete = routeCompanySearchRequest(proposed, brief, [mislabelled, icypeas], "50 construction companies in Egypt for sales outreach, with websites");
    expect(JSON.stringify(complete)).not.toMatch(/blitz/i);
  });

  it("routeCompanySearchRequest: with no allowed company source the answer is honest Arabic, with no plan", () => {
    const routed = routeCompanySearchRequest({ type: "suggest_alternative", explanationAr: "x" }, brief, [mislabelled], REQUEST);
    expect(routed.type).toBe("answer_question");
    expect(routed.answerAr).toBe(COMPANY_SOURCE_UNAVAILABLE_AR);
    expect(routed.capabilities).toBeUndefined();
    expect(COMPANY_SOURCE_UNAVAILABLE_AR).toMatch(/لم يُحجز أي رصيد/);
    expect(/[a-z]/i.test(COMPANY_SOURCE_UNAVAILABLE_AR)).toBe(false);
  });

  it("routeCompanySearchRequest: the scope questions still come first when the request is incomplete", () => {
    const routed = routeCompanySearchRequest({ type: "suggest_alternative" }, { platforms: [], topics: ["شركات"], targetVolume: 100 }, [mislabelled], "أريد قائمة تضم ١٠٠ شركة للتواصل التجاري");
    expect(routed.type).toBe("ask_clarification");
  });

  it("buildAutoPlanProposal (the fallback of every stall path): icypeas, never the mislabelled endpoint; none live = honest answer", () => {
    const plan = buildAutoPlanProposal(brief, [mislabelled, icypeas], REQUEST);
    expect(plan.type).toBe("propose_plan");
    expect(plan.capabilities[0].capabilitySlug).toBe("icypeas-companies-search");
    const none: any = buildAutoPlanProposal(brief, [mislabelled], REQUEST);
    expect(none.type).toBe("answer_question");
    expect(none.answerAr).toBe(COMPANY_SOURCE_UNAVAILABLE_AR);
    expect(none.capabilities).toBeUndefined();
  });

  it("a «b2b» label does not route a company request either", () => {
    const b2b: Capability = { ...mislabelled, platform: "b2b" as any, category: "b2b" as any };
    const plan = buildAutoPlanProposal({ platforms: ["b2b"], topics: ["مقاولات"], targetVolume: 50 }, [b2b, icypeas], REQUEST);
    expect(plan.capabilities[0].capabilitySlug).toBe("icypeas-companies-search");
    expect((buildAutoPlanProposal({ platforms: ["b2b"], topics: ["مقاولات"], targetVolume: 50 }, [b2b], REQUEST) as any).type).toBe("answer_question");
  });

  it("buildDeterministicPlanFromIntent (the plan built without a model call): icypeas, or an honest answer when none is live", () => {
    const intent = extractRequestIntent(REQUEST);
    expect(intent.dataType).toBe("companies");
    const plan = buildDeterministicPlanFromIntent(intent, REQUEST, brief, [mislabelled, icypeas]);
    expect(plan?.type).toBe("propose_plan");
    expect(plan.capabilities[0].capabilitySlug).toBe("icypeas-companies-search");
    const none = buildDeterministicPlanFromIntent(intent, REQUEST, brief, [mislabelled]);
    expect(none).toMatchObject({ type: "answer_question", answerAr: COMPANY_SOURCE_UNAVAILABLE_AR });
  });

  it("the final plan check refuses a plan item the catalog labels «companies» that is not a company search; icypeas passes", () => {
    for (const request of [REQUEST, REQUEST_EN]) {
      const refused = validatePlanPlatformMatch(request, [{ capabilitySlug: "blitzapi-jobs-search", endpointId: "blitzapi.jobs.search" }], [mislabelled, icypeas]);
      expect(refused.valid).toBe(false);
      expect(refused.reasonCode).toBe("company_source_unavailable");
      expect(refused.errorAr).toBe(COMPANY_SOURCE_UNAVAILABLE_AR);
      expect(validatePlanPlatformMatch(request, [{ capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search" }], [mislabelled, icypeas]).valid).toBe(true);
    }
  });
});

describe("the whole chat flow, with the live catalog offering the mislabelled endpoint", () => {
  beforeEach(() => {
    live.icypeasLive = true;
    live.liveEndpoints = [liveBlitz];
  });

  it("«عايز ٥٠ شركة مقاولات في مصر» is planned and quoted on the company search, never on the job-postings endpoint", async () => {
    const { responses } = await runConversation([REQUEST]);
    const res = responses[0];
    expect(res.outputType).toBe("propose_plan");
    const items = res.planQuote?.items ?? res.plan?.capabilities ?? [];
    expect(JSON.stringify(res.planQuote ?? res.plan ?? {})).not.toMatch(/blitz/i);
    expect(JSON.stringify(res.planQuote ?? res.plan ?? {})).toMatch(/icypeas/);
    expect(items.length).toBeGreaterThan(0);
  });

  it("with the approved company search switched off, the answer is honest Arabic: no plan, no quote, no reserve", async () => {
    live.icypeasLive = false;
    const { responses } = await runConversation([REQUEST]);
    const res = responses[0];
    expect(res.outputType).toBe("answer_question");
    expect(res.contentAr).toContain(COMPANY_SOURCE_UNAVAILABLE_AR);
    expect(res.planQuote).toBeUndefined();
  });
});

describe("decision makers: the same rule", () => {
  const mislabelledPeople: Capability = { ...icypeas, id: "blitzapi-jobs-search", slug: "blitzapi-jobs-search", tregEndpointId: "blitzapi.jobs.search", platform: "people" as any, category: "people" as any };
  const PEOPLE_REQUEST = "ابحث عن ٢٠ من صناع القرار في شركات الطاقة في مصر مع الإيميلات";
  const peopleBrief: any = { platforms: ["people"], topics: ["طاقة"], targetVolume: 20 };

  it("the people service is the only people source: by endpoint or slug, the approved one first", () => {
    expect(isPeopleSearchCapabilityRef("professional-people-search", "treg.people.search")).toBe(true);
    expect(isPeopleSearchCapabilityRef("blitzapi-jobs-search", "blitzapi.jobs.search")).toBe(false);
    expect(isPeopleSearchCapabilityRef("blitzapi-people-email-find", "blitzapi.people.email.find")).toBe(false);
    expect(pickPeopleSearchCapability([mislabelledPeople, peopleSeed])?.slug).toBe("professional-people-search");
    expect(pickPeopleSearchCapability([mislabelledPeople])).toBeNull();
  });

  it("a people plan is never built on a source that only carries a people label", () => {
    const plan: any = buildAutoPlanProposal(peopleBrief, [mislabelledPeople, peopleSeed], PEOPLE_REQUEST);
    expect(plan.type).toBe("propose_plan");
    expect(plan.capabilities[0].capabilitySlug).toBe("professional-people-search");
    const none: any = buildAutoPlanProposal(peopleBrief, [mislabelledPeople], PEOPLE_REQUEST);
    expect(none).toMatchObject({ type: "answer_question", answerAr: PEOPLE_SOURCE_UNAVAILABLE_AR });
    const routed = routePeopleAlternative({ type: "suggest_alternative" }, peopleBrief, [mislabelledPeople, peopleSeed], PEOPLE_REQUEST);
    expect(routed.capabilities?.[0]?.capabilitySlug).toBe("professional-people-search");
  });

  it("the final plan check refuses a people-labelled item that is not a people search", () => {
    const refused = validatePlanPlatformMatch(PEOPLE_REQUEST, [{ capabilitySlug: "blitzapi-jobs-search", endpointId: "blitzapi.jobs.search" }], [mislabelledPeople, peopleSeed]);
    expect(refused.valid).toBe(false);
    expect(refused.reasonCode).toBe("people_source_unavailable");
    expect(validatePlanPlatformMatch(PEOPLE_REQUEST, [{ capabilitySlug: "professional-people-search", endpointId: "treg.people.search" }], [mislabelledPeople, peopleSeed]).valid).toBe(true);
  });
});
