import { describe, expect, it } from "vitest";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";

/**
 * Synthetic rows copied in substance from the nine rows a live «عايز شركتين كهرباء في مصر» job received when the provider
 * was asked for the label «Utilities» alone. None is an electricity company: the gate must deliver none of them.
 */
const context = {
  capabilitySlug: "icypeas-companies-search",
  endpointId: "icypeas.companies.search",
  params: {
    query: {
      location: { include: ["Egypt"] },
      industry: { include: ["Electrical/Electronic Manufacturing", "Utilities"] },
      keyword: { include: ["electrical", "electricity", "electrical engineering"] },
    },
    country: "Egypt",
    industry: "الكهرباء والطاقة الكهربائية",
  },
};

const rejectedByIndustry = [
  { company_name: "EJTCO", industry: "Utilities", description: "Water treatment plants, wastewater and desalination contracting.", location: "Cairo, Egypt" },
  { company_name: "تحميل برنامج لوكي باتشر تهكير ألعاب الأندرويد", industry: "Utilities", description: "تحميل برنامج تهكير ألعاب الأندرويد مجانا", location: "Egypt" },
  { company_name: "Clear Thru", industry: "Utilities", description: "Perimeter fencing, security barriers and gates.", location: "Giza, Egypt" },
  { company_name: "Fluid Egypt", industry: "Utilities", description: "Air compressor filters, separators and spare parts.", location: "Cairo, Egypt" },
  { company_name: "Water Engineering", industry: "Utilities", description: "Water equipment, pumps and pipes for buildings.", location: "Cairo, Egypt" },
  { company_name: "Water Express WATEX", industry: "Utilities", description: "Drinking water supply and bottled water distribution.", location: "Alexandria, Egypt" },
];

const sentToReview = [
  {
    company_name: "Universal Nexus Energy",
    industry: "Utilities",
    description: "Energy consultancy, sustainable power systems and equipment trading.",
    location: "Cairo, Egypt",
    website: "https://www.linkedin.com/company/universal-nexus-energy",
  },
  { company_name: "Royal Service", industry: "Utilities", description: "Home services, nursing, cleaning and maintenance.", location: "Cairo, Egypt" },
  { company_name: "Europe Egypt Travel", industry: "Utilities", description: "Travel agency, visas and tourism packages.", location: "Cairo, Egypt" },
];

describe("the relevance gate on the rows a label-only query returned for an electricity request", () => {
  for (const row of rejectedByIndustry) {
    it(`${row.company_name}: not delivered`, () => {
      const result = evaluateResearchRowRelevance(row, context);
      expect(result.decision).not.toBe("match");
    });
  }

  for (const row of sentToReview) {
    it(`${row.company_name}: not delivered (review or no_match)`, () => {
      const result = evaluateResearchRowRelevance(row, context);
      expect(["uncertain", "no_match"]).toContain(result.decision);
    });
  }

  it("none of the nine rows is a match, so nothing could be charged", () => {
    const decisions = [...rejectedByIndustry, ...sentToReview].map((row) => evaluateResearchRowRelevance(row, context).decision);
    expect(decisions.filter((decision) => decision === "match")).toHaveLength(0);
  });
});
