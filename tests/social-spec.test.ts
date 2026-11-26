import { describe, it, expect, vi } from "vitest";

vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => { throw new Error("a social job must never look its service up in the live catalog"); }),
  searchCatalog: vi.fn(async () => { throw new Error("a social job must never search the live catalog"); }),
}));

import { createHash } from "crypto";
import { resolveJobExecutionSpec } from "../src/lib/server/jobExecutionSpec";
import { SOCIAL_CAPABILITIES, SOCIAL_ROWS_PER_CHUNK, estimateSocialChunkCostUsd, getSocialCapability } from "../src/lib/socialSources";

const jobIdFor = (quoteId: string) => `job_quote_${createHash("md5").update(quoteId).digest("hex")}`;

function adminClientWith(quote: any) {
  const api: any = {
    select: () => api,
    eq: () => api,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: any) => Promise.resolve({ data: [quote], error: null }).then(resolve),
  };
  return { from: (table: string) => (table === "plans_quotes" ? api : { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
}

describe("a social job resolves from its quote alone", () => {
  it("uses only the selected output formats and defaults legacy or missing formats to Excel", async () => {
    const xlsxQuote = {
      id: "xlsx_only_quote",
      user_id: "u1",
      output_formats: ["xlsx"],
      items: [{ capabilitySlug: "social-tiktok-videos", endpointId: "tikhub.tiktok.search.videos", params: { query: "كرة السلة" }, targetVolumeMax: 3, paginationStrategy: "cursor", unitCostUsd: 0.001, pricingUnit: "item" }],
    };
    const selected = await resolveJobExecutionSpec(
      adminClientWith(xlsxQuote), jobIdFor(xlsxQuote.id), "u1", "social-tiktok-videos", 6,
    );
    expect(selected.outputFormats).toEqual(["xlsx"]);

    const legacyQuote = { ...xlsxQuote, id: "legacy_quote", output_formats: [] };
    const legacy = await resolveJobExecutionSpec(
      adminClientWith(legacyQuote), jobIdFor(legacyQuote.id), "u1", "social-tiktok-videos", 6,
    );
    expect(legacy.outputFormats).toEqual(["xlsx"]);
  });

  for (const cap of SOCIAL_CAPABILITIES) {
    it(`${cap.slug}: one call per chunk estimated at the worst case, paged by the adapter's own cursor`, async () => {
      const quote = {
        id: "q1",
        user_id: "u1",
        output_formats: ["csv", "xlsx"],
        items: [{ capabilitySlug: cap.slug, endpointId: cap.slug, params: { query: "قهوة", retryOfJobId: "job_prev" }, targetVolumeMax: 40, paginationStrategy: "cursor", unitCostUsd: cap.rowCostUsd, pricingUnit: "item" }],
      };
      const spec = await resolveJobExecutionSpec(adminClientWith(quote), jobIdFor("q1"), "u1", cap.slug, 6);

      expect(spec.capabilitySlug).toBe(cap.slug);
      expect(spec.paginationStrategy).toBe("cursor");
      expect(spec.pricingUnit).toBe("call");
      expect(spec.unitCostUsd).toBeCloseTo(estimateSocialChunkCostUsd(getSocialCapability(cap.slug)!), 6);
      expect(spec.pageSize).toBe(SOCIAL_ROWS_PER_CHUNK);
      // The retry marker is an instruction to this platform, never a provider parameter.
      expect(spec.params).toEqual({ query: "قهوة" });
      expect(spec.retryOfJobId).toBe("job_prev");
      expect(spec.outputFormats).toEqual(["csv", "xlsx"]);
    });
  }
});
