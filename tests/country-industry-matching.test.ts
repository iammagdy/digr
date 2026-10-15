import { describe, it, expect } from "vitest";
import {
  detectCountryFromText,
  detectIndustryFromText,
  isCompanyRowMatchingLocation,
  isCompanyRowMatchingConstraints,
  extractInterpretedParameters,
} from "../src/lib/planParameters";
import { normalizeIcypeasCompanyParams } from "../src/lib/server/tregAdapter";

describe("Country & Industry Detection and Matching", () => {
  it("accurately detects countries from Arabic and English requests", () => {
    expect(detectCountryFromText("عايز 5 شركات صناعة الصواريخ في ليختنشتاين")?.canonicalEnglish).toBe("Liechtenstein");
    expect(detectCountryFromText("شركات مقاولات في مصر")?.canonicalEnglish).toBe("Egypt");
    expect(detectCountryFromText("شركات تقنية معلومات في السعودية")?.canonicalEnglish).toBe("Saudi Arabia");
    expect(detectCountryFromText("شركات أغذية في الإمارات")?.canonicalEnglish).toBe("United Arab Emirates");
    expect(detectCountryFromText("I need 6 solar energy companies in Germany")?.canonicalEnglish).toBe("Germany");
    expect(detectCountryFromText("صيد الحيتان في النمسا")?.canonicalEnglish).toBe("Austria");
    expect(detectCountryFromText("شركات استيراد وتصدير")).toBeNull();
  });

  it("accurately detects industries from Arabic and English requests", () => {
    expect(detectIndustryFromText("عايز 5 شركات صناعة الصواريخ في ليختنشتاين").englishKeywords).toContain("aerospace");
    expect(detectIndustryFromText("شركات مقاولات في مصر").englishKeywords).toContain("construction");
    expect(detectIndustryFromText("شركات تقنية معلومات في السعودية").englishKeywords).toContain("information technology");
    expect(detectIndustryFromText("شركات أغذية في الإمارات").englishKeywords).toContain("food");
    expect(detectIndustryFromText("solar energy companies in Germany").englishKeywords).toContain("solar");
  });

  it("normalizes Icypeas company search parameters without hidden Egypt default", () => {
    // 1. Liechtenstein aerospace
    const paramsLi = normalizeIcypeasCompanyParams(
      { search: "عايز 5 شركات صناعة الصواريخ في ليختنشتاين" },
      5
    );
    expect(paramsLi.query.location.include).toEqual(["Liechtenstein"]);
    expect(paramsLi.query.keyword.include).toContain("aerospace");

    // 2. Germany solar
    const paramsDe = normalizeIcypeasCompanyParams(
      { search: "I need 6 solar energy companies in Germany" },
      6
    );
    expect(paramsDe.query.location.include).toEqual(["Germany"]);
    expect(paramsDe.query.keyword.include).toContain("solar");

    // 3. Unstated country defaults to Egypt
    const paramsNoCountry = normalizeIcypeasCompanyParams(
      { search: "عايز 5 شركات مقاولات" },
      5
    );
    expect(paramsNoCountry.query.location.include).toEqual(["Egypt"]);
  });

  it("extracts interpreted parameters with explicit country and default fallback", () => {
    // Explicit country
    const interpLi = extractInterpretedParameters(
      { search: "عايز 5 شركات صناعة الصواريخ في ليختنشتاين" },
      "خطة استخراج شركات صواريخ في ليختنشتاين"
    );
    expect(interpLi.countryAr).toBe("ليختنشتاين");
    expect(interpLi.isDefaultCountry).toBe(false);

    // Unstated country defaults to مصر (افتراضي)
    const interpDefault = extractInterpretedParameters(
      { search: "عايز 5 شركات مقاولات" },
      "خطة استخراج شركات مقاولات"
    );
    expect(interpDefault.countryAr).toBe("مصر (افتراضي)");
    expect(interpDefault.isDefaultCountry).toBe(true);
  });

  it("validates company rows strictly against target country and industry", () => {
    const oerlikon = {
      company_name: "Oerlikon Balzers",
      location: "Balzers, Liechtenstein",
      website: "https://www.oerlikon.com/balzers",
      industry: "Aviation & Aerospace Component Manufacturing",
      description: "Surface solutions, thin-film coatings for aerospace and precision components",
    };

    const cairoChemicals = {
      company_name: "Cairo Chemicals Co",
      location: "Cairo, Egypt",
      website: "https://cairochem.com.eg",
      industry: "Chemicals",
      description: "Trade in chemicals and industrial supplies in Egypt",
    };

    // Liechtenstein search
    expect(isCompanyRowMatchingLocation(oerlikon, "Liechtenstein")).toBe(true);
    expect(isCompanyRowMatchingLocation(cairoChemicals, "Liechtenstein")).toBe(false);

    expect(isCompanyRowMatchingConstraints(oerlikon, "Liechtenstein", "صناعة الصواريخ والفضاء")).toBe(true);
    expect(isCompanyRowMatchingConstraints(cairoChemicals, "Liechtenstein", "صناعة الصواريخ والفضاء")).toBe(false);
  });
});
