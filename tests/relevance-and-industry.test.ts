import { describe, it, expect } from "vitest";
import { evaluateDeterministicRelevance } from "../src/lib/server/relevanceValidationLayer";
import { detectIndustryFromText } from "../src/lib/planParameters";
import { detectIndustryFromText as providerDetectIndustry, normalizeIcypeasCompanyParams } from "../src/lib/server/tregAdapter";

const row = (industry: string, extra: Record<string, unknown> = {}) => ({ company_name: "Acme", industry, location: "Cairo, Egypt", ...extra });

describe("contracting relevance does not drop real electromechanical contractors", () => {
  const review = (industry: string, extra: Record<string, unknown> = {}) =>
    evaluateDeterministicRelevance(row(industry, extra), "Egypt", "المقاولات والتشييد");

  it("keeps clearly unrelated sectors out", () => {
    expect(review("Furniture").decision).toBe("no_match");
    expect(review("Interior Design").decision).toBe("no_match");
    expect(review("Real Estate").decision).toBe("no_match");
  });

  it("sends energy, electronics and machinery labels to the review sheet instead of excluding them", () => {
    for (const label of ["Oil & Energy", "Electrical/Electronic Manufacturing", "Machinery", "Mechanical or Industrial Engineering"]) {
      const result = review(label);
      expect(result.decision).toBe("uncertain");
      expect(result.reasonAr).toMatch(/مراجعة/);
    }
  });

  it("matches the same labels when the row itself shows contracting activity", () => {
    expect(review("Electrical/Electronic Manufacturing", { description: "Electrical contracting and installation services" }).decision).toBe("match");
    expect(review("Oil & Energy", { company_name: "النيل للمقاولات" }).decision).toBe("match");
  });

  it("electromechanical requests also accept MEP wording", () => {
    const result = evaluateDeterministicRelevance(row("Mechanical or Industrial Engineering", { description: "MEP works for buildings" }), "Egypt", "المقاولات الكهروميكانيكية");
    expect(result.decision).toBe("match");
  });

  it("a row with no industry is reviewed, never delivered", () => {
    expect(review("").decision).toBe("uncertain");
  });

  it("never delivers a company from another country", () => {
    const result = evaluateDeterministicRelevance(row("Construction", { location: "Berlin, Germany" }), "Egypt", "المقاولات والتشييد");
    expect(result.decision).toBe("no_match");
  });
});

describe("other recognized sectors", () => {
  it("delivers a row whose own industry label names the requested sector (electricity)", () => {
    const result = evaluateDeterministicRelevance(row("Electrical/Electronic Manufacturing"), "Egypt", detectIndustryFromText("عايز خمس شركات في مجال الكهرباء").arabicLabel);
    expect(result.decision).toBe("match");
  });

  it("sends a row with another label to review instead of delivering it", () => {
    const result = evaluateDeterministicRelevance(row("Restaurants"), "Egypt", detectIndustryFromText("الكهرباء").arabicLabel);
    expect(result.decision).toBe("uncertain");
  });

  it("food sector rows with a matching label are delivered", () => {
    expect(evaluateDeterministicRelevance(row("Food & Beverages"), "Egypt", "الأغذية والمطاعم").decision).toBe("match");
  });

  it("does not treat a broad Utilities label as an electricity match without corroborating evidence", () => {
    expect(evaluateDeterministicRelevance(row("Utilities", { description: "Water treatment and chemical supplies" }), "Egypt", "الكهرباء والطاقة الكهربائية").decision).toBe("uncertain");
    expect(evaluateDeterministicRelevance(row("Utilities", { company_name: "Lucky Patcher", description: "Hack Android games and apps" }), "Egypt", "الكهرباء والطاقة الكهربائية").decision).toBe("uncertain");
    expect(evaluateDeterministicRelevance(row("Utilities", { description: "Electric power grid maintenance services" }), "Egypt", "الكهرباء والطاقة الكهربائية").decision).toBe("match");
  });
});

describe("one industry detector for planning and the provider request", () => {
  it("both entry points are the same function", () => {
    expect(providerDetectIndustry).toBe(detectIndustryFromText);
  });

  it("electricity and electromechanical requests are recognized with a structured taxonomy", () => {
    expect(detectIndustryFromText("خمس شركات في مجال الكهرباء").exactTaxonomy).toContain("Electrical/Electronic Manufacturing");
    const mep = detectIndustryFromText("٥ شركات كهروميكانيكية مع صناع القرار");
    expect(mep.arabicLabel).toBe("المقاولات الكهروميكانيكية");
    expect(mep.exactTaxonomy).toContain("Construction");
  });

  it("Latin 'it' inside other words no longer means information technology", () => {
    for (const text of ["construction companies in United Arab Emirates", "construction companies in Italy", "technical contracting"]) {
      expect(detectIndustryFromText(text).arabicLabel).not.toBe("تقنية المعلومات والبرمجيات");
    }
    expect(detectIndustryFromText("construction companies in United Arab Emirates").arabicLabel).toBe("المقاولات والتشييد");
    expect(detectIndustryFromText("IT companies in Saudi Arabia").arabicLabel).toBe("تقنية المعلومات والبرمجيات");
    expect(detectIndustryFromText("شركات تقنية مالية").arabicLabel).toBe("FinTech");
  });
});

describe("structured industry is primary, free keywords are only a fallback (provider combines them with AND)", () => {
  it("a recognized industry sends only the structured taxonomy filter", () => {
    const params = normalizeIcypeasCompanyParams({ query: "شركات مقاولات في السعودية", country: "Saudi Arabia" } as any, 10, null);
    expect(params.query.industry).toEqual({ include: ["Construction"] });
    expect(params.query.keyword).toBeUndefined();
    expect(params.query.location).toEqual({ include: ["Saudi Arabia"] });
  });

  it("an electricity request is no longer sent as an Arabic free keyword", () => {
    const params = normalizeIcypeasCompanyParams({ query: "خمس شركات في مجال الكهرباء في مصر", country: "Egypt" } as any, 5, null);
    expect(params.query.industry?.include).toContain("Electrical/Electronic Manufacturing");
    expect(params.query.keyword).toBeUndefined();
  });

  it("a custom sector with no taxonomy falls back to keywords so the search still runs", () => {
    const params = normalizeIcypeasCompanyParams({ query: "whale hunting companies in Norway", country: "Norway", industry: "صيد الحيتان" } as any, 5, null);
    expect(params.query.industry).toBeUndefined();
    expect(params.query.keyword?.include?.length).toBeGreaterThan(0);
  });

  it("no hidden country: an unstated country sends no location filter", () => {
    const params = normalizeIcypeasCompanyParams({ query: "شركات مقاولات" } as any, 5, null);
    expect(params.query.location).toBeUndefined();
  });
});
