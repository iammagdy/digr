import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock("../src/functions/shared/catalogClient", () => ({
  getEndpointDetails: vi.fn(async () => null),
}));
vi.mock("../src/lib/server/providerGate", () => ({
  getLiveProviderGateStatus: () => ({ isReady: true, reasonCode: "ready", messageAr: "" }),
}));
vi.mock("../src/functions/shared/tregClient", () => ({
  executeTregCall: mocks.call,
}));

import { defaultTregAdapter, hasRecognizedProviderResultShape, normalizeTregPeopleParams } from "../src/lib/server/tregAdapter";
import { requiredProfessionalContactFields } from "../src/lib/planParameters";

describe("TREG people search and enrichment", () => {
  it("distinguishes a valid empty result envelope from an invalid response object", () => {
    expect(hasRecognizedProviderResultShape({ data: { results: [] }, total: 0 })).toBe(true);
    expect(hasRecognizedProviderResultShape({ success: true, total: 0 })).toBe(true);
    expect(hasRecognizedProviderResultShape({ error: "unexpected response" })).toBe(false);
  });

  beforeEach(() => mocks.call.mockReset());

  it("converts legacy filters into TREG's routed search body", () => {
    expect(normalizeTregPeopleParams({
      query: {
        keyword: { include: ["solar energy"] },
        jobTitle: { include: ["CEO"] },
        location: { include: ["Germany"] },
      },
      country: "DE",
    }, 20)).toEqual({
      title: "CEO",
      country: "DE",
      location: "Germany",
      keywords: ["solar energy"],
      limit: 20,
    });
  });

  it("recognizes requested email and phone fields in Arabic and transliterated Arabic", () => {
    expect(requiredProfessionalContactFields("name, job title, email wl rkm w rkmo")).toEqual(["work_email", "phone"]);
    expect(requiredProfessionalContactFields("البريد المهني ورقم الهاتف")).toEqual(["work_email", "phone"]);
  });

  it("looks up missing professional email and phone and adds their actual TREG cost", async () => {
    mocks.call.mockImplementation(async (options: { endpointId: string } = { endpointId: "" }) => {
      const { endpointId } = options || { endpointId: "" };
      if (endpointId === "icypeas.people.search") return {
        ok: true, httpStatus: 200, tregCallId: "search_1", costMicro: 100, latencyMs: 1,
        data: { output: { people: [{
          first_name: "Mona", last_name: "Saleh", title: "Operations Director",
          company_name: "Example Ltd", company_domain: "example.com",
          linkedin_url: "https://www.linkedin.com/in/mona-saleh",
        }] } }, isRouteMaxCost: false, isPlatformBalanceLow: false,
      };
      if (endpointId === "treg.people.email.find") return {
        ok: true, httpStatus: 200, tregCallId: "email_1", costMicro: 20, latencyMs: 1,
        data: { output: { work_email: "mona@example.com" } }, isRouteMaxCost: false, isPlatformBalanceLow: false,
      };
      return {
        ok: true, httpStatus: 200, tregCallId: "phone_1", costMicro: 30, latencyMs: 1,
        data: { output: { phone_number: "+201000000000" } }, isRouteMaxCost: false, isPlatformBalanceLow: false,
      };
    });

    const result = await defaultTregAdapter({
      jobId: "job_people", userId: "user_people", step: 0,
      endpointId: "treg.people.search", capabilitySlug: "professional-people-search",
      method: "POST", params: { q: "operations directors in Egypt", country: "EG", limit: 1, requiredContactFields: ["work_email", "phone"] },
      paginationStrategy: "none", cursor: null, pageSize: 1, remainingNeeded: 1,
      targetVolumeMax: 1, deliveredSoFar: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.costMicro).toBe(150);
    expect(result.rows[0]).toMatchObject({
      contact_name: "Mona Saleh",
      job_title: "Operations Director",
      company_name: "Example Ltd",
      work_email: "mona@example.com",
      phone: "+201000000000",
      work_email_presence_status: "موجود",
      phone_presence_status: "موجود",
    });
    expect(mocks.call.mock.calls.map(([call]) => call.endpointId)).toEqual([
      "icypeas.people.search", "treg.people.email.find", "treg.people.phone.find",
    ]);
    expect(mocks.call.mock.calls.slice(1).every(([call]) => call.routeMaxCostUsd === "0.005")).toBe(true);
  });

  it("caps a three-person request at seven calls and disables retries for every people route", async () => {
    mocks.call.mockImplementation(async (options: { endpointId?: string } = {}) => {
      const endpointId = options?.endpointId || "";
      if (endpointId === "icypeas.people.search") return {
        ok: true, httpStatus: 200, tregCallId: "search_3", costMicro: 100,
        data: { output: { people: [1, 2, 3].map((n) => ({
          full_name: `Person ${n}`, title: "Director", company_name: `Company ${n}`,
          company_domain: `company${n}.test`, linkedin_url: `https://linkedin.test/${n}`,
        })) } }, isRouteMaxCost: false, isPlatformBalanceLow: false,
      };
      if (endpointId === "treg.people.email.find") return {
        ok: true, httpStatus: 200, tregCallId: `email_${mocks.call.mock.calls.length}`, costMicro: 20,
        data: { output: { work_email: "person@company.test" } }, isRouteMaxCost: false, isPlatformBalanceLow: false,
      };
      return {
        ok: true, httpStatus: 200, tregCallId: `phone_${mocks.call.mock.calls.length}`, costMicro: 30,
        data: { output: { phone_number: "+201000000000" } }, isRouteMaxCost: false, isPlatformBalanceLow: false,
      };
    });

    const result = await defaultTregAdapter({
      jobId: "job_people_three", userId: "user_people", step: 0,
      endpointId: "treg.people.search", capabilitySlug: "professional-people-search",
      method: "POST", params: { q: "directors in Egypt", limit: 3, requiredContactFields: ["work_email", "phone"] },
      paginationStrategy: "none", cursor: null, pageSize: 3, remainingNeeded: 3,
      targetVolumeMax: 3, deliveredSoFar: 0, decisionMakerSpendBudgetUsd: 0.04,
    });

    expect(result.ok).toBe(true);
    expect(result.providerCallCount).toBe(7);
    expect(result.costMicro).toBe(250);
    expect(mocks.call).toHaveBeenCalledTimes(7);
    expect(mocks.call.mock.calls.every(([call]) => call.routeMaxCostUsd === "0.005")).toBe(true);
    expect(result.costMicro / 1_000_000).toBeLessThanOrEqual(0.035);
  });

  it("stops enriching at the per-job spend ceiling and leaves unavailable fields reviewable", async () => {
    mocks.call.mockImplementation(async (options: { endpointId?: string } = {}) => {
      const endpointId = options?.endpointId || "";
      if (endpointId === "icypeas.people.search") return {
        ok: true, httpStatus: 200, tregCallId: "search_budget", costMicro: 5000,
        data: { output: { people: [1, 2, 3].map((n) => ({
          full_name: `Person ${n}`, title: "Director", company_name: `Company ${n}`,
          company_domain: `company${n}.test`, linkedin_url: `https://linkedin.test/${n}`,
        })) } }, isRouteMaxCost: false, isPlatformBalanceLow: false,
      };
      return {
        ok: true, httpStatus: 200, tregCallId: "email_budget", costMicro: 5000,
        data: { output: { work_email: "person@company.test" } }, isRouteMaxCost: false, isPlatformBalanceLow: false,
      };
    });

    const result = await defaultTregAdapter({
      jobId: "job_people_budget", userId: "user_people", step: 0,
      endpointId: "treg.people.search", capabilitySlug: "professional-people-search",
      method: "POST", params: { q: "directors in Egypt", limit: 3, requiredContactFields: ["work_email", "phone"] },
      paginationStrategy: "none", cursor: null, pageSize: 3, remainingNeeded: 3,
      targetVolumeMax: 3, deliveredSoFar: 0, decisionMakerSpendBudgetUsd: 0.01,
    });

    expect(mocks.call).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.providerCallCount).toBe(2);
    expect(result.nextCursor).toBeNull();
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({ work_email: "person@company.test", phone_presence_status: "غير موجود" });
    expect(result.rows.slice(1).every((row) => row.work_email_presence_status === "غير موجود")).toBe(true);
  });

  it("records a failed contact lookup and keeps the person for field-level settlement", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.call.mockImplementation(async (options: { endpointId?: string } = {}) => {
      const endpointId = options?.endpointId || "";
      if (endpointId === "icypeas.people.search") return {
        ok: true, httpStatus: 200, tregCallId: "search_failure_case", costMicro: 100,
        data: { output: { people: [{ full_name: "Person One", title: "Director", company_name: "Company One", company_domain: "company.test" }] } },
        isRouteMaxCost: false, isPlatformBalanceLow: false,
      };
      if (endpointId === "treg.people.email.find") return {
        ok: false, httpStatus: 503, tregCallId: "email_failed", costMicro: 200,
        data: null, error: "http_503", isRouteMaxCost: false, isPlatformBalanceLow: false,
      };
      return {
        ok: true, httpStatus: 200, tregCallId: "phone_success", costMicro: 30,
        data: { output: { phone_number: "+201000000000" } }, isRouteMaxCost: false, isPlatformBalanceLow: false,
      };
    });

    try {
      const result = await defaultTregAdapter({
        jobId: "job_people_failed_email", userId: "user_people", step: 0,
        endpointId: "treg.people.search", capabilitySlug: "professional-people-search",
        method: "POST", params: { q: "directors in Egypt", limit: 1, requiredContactFields: ["work_email", "phone"] },
        paginationStrategy: "none", cursor: null, pageSize: 1, remainingNeeded: 1,
        targetVolumeMax: 1, deliveredSoFar: 0,
      });

      expect(warning).toHaveBeenCalledWith("[decision_maker:contact_call_failed]", expect.objectContaining({
        endpointId: "treg.people.email.find", status: 503, callId: "email_failed",
      }));
      expect(result.ok).toBe(true);
      expect(result.providerCallCount).toBe(3);
      expect(result.rows[0]).toMatchObject({
        work_email_presence_status: "غير موجود",
        phone: "+201000000000",
      });
      expect(result.rows[0].contact_review_status).toContain("لم يتوفر");
    } finally {
      warning.mockRestore();
    }
  });

  it("does not retry a failed decision-maker search and returns its failure for worker release handling", async () => {
    mocks.call.mockResolvedValue({
      ok: false, httpStatus: 503, tregCallId: "search_failed", costMicro: 200,
      data: null, error: "http_503", isRouteMaxCost: false, isPlatformBalanceLow: false,
    });

    const result = await defaultTregAdapter({
      jobId: "job_people_failed_search", userId: "user_people", step: 0,
      endpointId: "treg.people.search", capabilitySlug: "professional-people-search",
      method: "POST", params: { q: "directors in Egypt", limit: 1 },
      paginationStrategy: "none", cursor: null, pageSize: 1, remainingNeeded: 1,
      targetVolumeMax: 1, deliveredSoFar: 0,
    });

    expect(mocks.call).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.providerCallCount).toBe(1);
    expect(result.costMicro).toBe(200);
  });
});
