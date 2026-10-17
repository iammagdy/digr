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

import { defaultTregAdapter, normalizeTregPeopleParams } from "../src/lib/server/tregAdapter";
import { requiredProfessionalContactFields } from "../src/lib/planParameters";

describe("TREG people search and enrichment", () => {
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
      if (endpointId === "treg.people.search") return {
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
      "treg.people.search", "treg.people.email.find", "treg.people.phone.find",
    ]);
    expect(mocks.call.mock.calls.slice(1).every(([call]) => call.routeMaxCostUsd === "0.005")).toBe(true);
  });
});
