import { describe, expect, it } from "vitest";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { FALLBACK_FINDER_MAX_USD, finderRankKey, finderSourcesOf } from "../src/lib/agentMission/contactFinders";
import { NOT_ADMIN } from "./helpers/agentHarness";

/**
 * ITEM 4 (owner decision after #321), the chain itself. (a) The finders of a step are ranked by what a FOUND VALUE costs: price over the MEASURED hit rate (finderStats.ts), not over the HTTP success rate: quickenrich answers «ok» for every call but gave an address 0 times in 14, so it must not sit
 * second in a chain of three when anyapi (5 in 5) is the one that finds. (b) A fallback finder dearer than FALLBACK_FINDER_MAX_USD per call is not part of the chain (live catalog: enrichlayer 0.1 USD billed on EVERY call, tomba phone 0.0445): one job must never be able to spend a large share of the provider's daily cap on lookups.
 */
const catalog = loadTregCatalog();
const customer = (id: string) => isSellable(id, catalog) && !blockedEndpointReason(id) && policyVerdict(id, NOT_ADMIN).allowed;

describe("the finders are ranked by the cost of a found value", () => {
  it("rank key = price / measured hit rate: blitz < anyapi < quickenrich for e-mail", () => {
    const blitz = finderRankKey({ id: "blitzapi.people.email.find", usd: 0.000495 }, "email");
    const anyapi = finderRankKey({ id: "anyapi.linkedin.email.work.find", usd: 0.011 }, "email");
    const quick = finderRankKey({ id: "quickenrich.people.email.find", usd: 0.004834 }, "email");
    expect(blitz).toBeCloseTo(0.000495 / (9.5 / 43), 9);
    expect(blitz).toBeLessThan(anyapi);
    expect(anyapi).toBeLessThan(quick);
  });
  it("the real catalog for a customer: e-mail finders blitz, anyapi, then dropleads (1 hit in 1 call): quickenrich (0 in 14) is no longer in the chain of three", () => {
    expect(finderSourcesOf("email", catalog, customer).map((f) => f.id)).toEqual(["blitzapi.people.email.find", "anyapi.linkedin.email.work.find", "dropleads.people.email.find"]);
  });
});

describe("no finder of a chain costs more than FALLBACK_FINDER_MAX_USD a call", () => {
  it("the ceiling is 0.02 USD", () => expect(FALLBACK_FINDER_MAX_USD).toBe(0.02));
  it("the real catalog for a customer: no e-mail or phone finder of the chain is dearer; the dear ones (tomba phone 0.0445, enrichlayer 0.1) are left out", () => {
    for (const kind of ["email", "phone"] as const) {
      const chain = finderSourcesOf(kind, catalog, customer);
      expect(chain.length).toBeGreaterThan(0);
      for (const f of chain) expect(f.usd, f.id).toBeLessThanOrEqual(FALLBACK_FINDER_MAX_USD);
    }
    const ids = finderSourcesOf("phone", catalog, customer).map((f) => f.id);
    expect(ids).not.toContain("tomba.people.phone.find");
    expect(ids).not.toContain("enrichlayer.contacts.personal-phone");
    expect(ids[0]).toBe("blitzapi.people.phone.find");
  });
});
