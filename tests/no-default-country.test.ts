import { describe, it, expect } from "vitest";
import { normalizeCatalogEndpoint } from "../src/functions/shared/catalogClient";
import { validatePlanAgainstLiveCatalog, type PlanItem } from "../src/functions/shared/planManager";
import { extractResearchIntent } from "../src/lib/server/researchIntent";
import { buildSystemPrompt } from "../src/functions/shared/systemPrompt";
import { normalizeIcypeasCompanyParams } from "../src/lib/server/tregAdapter";
import { getMissingCompanyResearchRequirements, detectCountryFromText } from "../src/lib/planParameters";

// Owner decision D1: Diger works for any country. The country comes from the request; nothing defaults to Egypt.
describe("no default country", () => {
  const companiesEndpoint = normalizeCatalogEndpoint({
    id: "icypeas.companies.search",
    name: "Companies",
    summary: "Company search",
    platform: "companies",
    method: "POST",
    path: "/v1/companies",
    cost: { usd: 0.00038, unit: "record" },
    input: { body: { query: { type: "object", required: true }, limit: { type: "integer", maximum: 100 } } },
    observed: { ok_rate: 0.95, samples: 50 },
    scope: "any_account",
  });

  it("plan validation does not fill an empty company query with Egypt", () => {
    const item: PlanItem = {
      capabilitySlug: companiesEndpoint.slug,
      endpointId: companiesEndpoint.id,
      params: {},
      targetVolumeMin: 1,
      targetVolumeMax: 5,
      paginationStrategy: "none",
    };
    const result = validatePlanAgainstLiveCatalog([item], [companiesEndpoint]);
    expect(JSON.stringify(item.params)).not.toMatch(/Egypt|مصر/);
    expect(item.params.query).toBeUndefined();
    expect(result.valid).toBe(false);
  });

  it("an unstated geographic scope stays unstated instead of defaulting to Egypt and the Middle East", () => {
    const intent = extractResearchIntent("عايز خمس شركات في مجال الكهرباء");
    expect(intent.geographicScope.provenance).toBe("DEFAULT");
    expect(intent.geographicScope.value).toBe("غير محدد");
    expect(intent.geographicScope.value).not.toMatch(/مصر|الشرق الأوسط/);
  });

  it("the model prompt never tells the model to assume Egypt or the Arab region", () => {
    const prompt = buildSystemPrompt({ sanitizedCapabilities: [] });
    expect(prompt).not.toMatch(/Egypt \/ Arab region may be offered/);
    expect(prompt).toContain("do not assume one (never Egypt or the Arab region)");
  });

  it("a company request without a country asks for the country instead of assuming one", () => {
    expect(getMissingCompanyResearchRequirements("عايز خمس شركات في مجال الكهرباء")).toContain("country");
    expect(detectCountryFromText("عايز خمس شركات في مجال الكهرباء")).toBeNull();
  });

  it("provider parameters carry only the country the request named", () => {
    const germany = normalizeIcypeasCompanyParams({ query: "software companies in Germany", country: "Germany" } as any, 5, null);
    expect(JSON.stringify(germany)).toMatch(/Germany/);
    expect(JSON.stringify(germany)).not.toMatch(/Egypt/);

    const none = normalizeIcypeasCompanyParams({ query: "software companies" } as any, 5, null);
    expect(JSON.stringify(none)).not.toMatch(/Egypt/);
  });
});
