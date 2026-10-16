import { describe, it, expect } from "vitest";
import {
  detectCountryFromText,
  detectIndustryFromText,
  isCompanyRowMatchingLocation,
  isCompanyRowMatchingConstraints,
  extractInterpretedParameters,
  getMissingCompanyResearchRequirements,
  getCompanyRequirementQuestions,
  getCompanyRequirementItems,
  getAmbiguousCompanyReference,
  extractParamDisplayString,
  industryDisplayLabelAr,
  isPeopleSearchRequest,
} from "../src/lib/planParameters";
import { normalizeIcypeasCompanyParams } from "../src/lib/server/tregAdapter";

describe("Country & Industry Detection and Matching", () => {
  it("keeps people-search quote display in Arabic and does not treat the prompt as industry", () => {
    const rawPrompt = "Find 20 decision makers Germany Germany with name title and verified work emails";
    const params = { query: { keyword: { include: [rawPrompt] }, location: { include: ["Germany"] } } };
    const interpreted = extractInterpretedParameters(params, "بحث صناع القرار", true);

    expect(interpreted.countryAr).toBe("ألمانيا");
    expect(interpreted.industryAr).toBe("صناع القرار والمهنيون");
    expect(extractParamDisplayString(params, "بحث صناع القرار", true)).toBe("صناع القرار والمهنيون");
    expect(extractParamDisplayString(params, "بحث صناع القرار", true)).not.toContain("Germany");
  });

  it("localizes the English FinTech taxonomy in customer-facing cards", () => {
    expect(industryDisplayLabelAr("FinTech")).toBe("التقنية المالية");
  });

  it("does not route a company list with work email to people search, but does route decision makers", () => {
    expect(isPeopleSearchRequest("٥٠ شركة تقنية مالية في ألمانيا مع بريد العمل والهاتف" )).toBe(false);
    expect(isPeopleSearchRequest("٢٠ من صناع القرار في شركات التقنية المالية مع الاسم والمسمى وبريد العمل")).toBe(true);
    expect(isPeopleSearchRequest("Find people in Germany with work emails")).toBe(true);
  });

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

    // 3. Unstated country remains absent; the chat flow asks instead of assuming Egypt
    const paramsNoCountry = normalizeIcypeasCompanyParams(
      { search: "عايز 5 شركات" },
      5
    );
    expect(paramsNoCountry.query.location).toBeUndefined();
    expect(paramsNoCountry.query.keyword).toBeUndefined();
  });

  it("extracts explicit parameters and marks unstated scope as required", () => {
    // Explicit country
    const interpLi = extractInterpretedParameters(
      { search: "عايز 5 شركات صناعة الصواريخ في ليختنشتاين" },
      "خطة استخراج شركات صواريخ في ليختنشتاين"
    );
    expect(interpLi.countryAr).toBe("ليختنشتاين");
    expect(interpLi.isDefaultCountry).toBe(false);

    // Unstated country and industry must remain visibly required.
    const interpDefault = extractInterpretedParameters(
      { search: "عايز 5 شركات" },
      "خطة استخراج شركات"
    );
    expect(interpDefault.countryAr).toBe("يلزم تحديد الدولة");
    expect(interpDefault.countryCanonical).toBe("");
    expect(interpDefault.industryAr).toBe("يلزم تحديد النشاط");
    expect(interpDefault.isDefaultCountry).toBe(true);
  });

  it("reads the saved Germany and FinTech values from the structured company query", () => {
    const interpreted = extractInterpretedParameters({
      query: {
        keyword: { include: ["FinTech"] },
        location: { include: ["Germany"] },
        industry: { include: ["Financial Services", "Banking"] },
      },
    }, "Old quote summary for Egypt IT companies");

    expect(interpreted.countryCanonical).toBe("Germany");
    expect(interpreted.countryAr).toBe("ألمانيا");
    expect(interpreted.industryAr).toBe("FinTech");
    expect(interpreted.isDefaultCountry).toBe(false);
  });

  it("requires both country and industry instead of interpreting unstated company-search defaults", () => {
    expect(getMissingCompanyResearchRequirements("Find 100 companies")).toEqual(["country", "industry"]);
    expect(getMissingCompanyResearchRequirements("أريد قائمة تضم ١٠٠ شركة")).toEqual(["country", "industry"]);
    expect(getMissingCompanyResearchRequirements("أريد قائمة تضم ١٠٠ شركة للتواصل التجاري.")).toEqual(["country", "industry", "outreach_details"]);
    expect(getMissingCompanyResearchRequirements("أريد قائمة تضم مية شركة للتواصل التجاري.")).toEqual(["country", "industry", "outreach_details"]);
    expect(getMissingCompanyResearchRequirements("أريد ٥٠ شركة تقنية مالية في ألمانيا مع الاسم والموقع الإلكتروني وبريد العمل والهاتف")).toEqual([]);
    expect(getCompanyRequirementQuestions(["country", "industry", "outreach_details"])).toEqual([
      "ما الدولة التي تريد البحث عن الشركات فيها؟",
      "ما القطاع أو المجال الذي تعمل فيه الشركات المطلوبة؟",
      "ما المقصود بالتواصل التجاري تحديداً، وما بيانات الشركات التي تحتاجها؟",
    ]);
    expect(getMissingCompanyResearchRequirements("Find 100 solar companies in Germany")).toEqual([]);
    expect(getMissingCompanyResearchRequirements("Find 100 solar companies")).toEqual(["country"]);
    expect(getMissingCompanyResearchRequirements("Find 100 companies in Germany")).toEqual(["industry"]);
  });

  it("asks what a possibly named company means instead of treating it as a generic outreach request", () => {
    const request = "أريدك تضم شركة تواصل التجاري، وأحتاج بيانات للتواصل معها";
    expect(getAmbiguousCompanyReference(request)).toBe("تواصل التجاري");
    const items = getCompanyRequirementItems(getMissingCompanyResearchRequirements(request), request);
    const outreach = items.find((item) => item.id === "company_outreach_required");
    expect(outreach?.text).toContain("تواصل التجاري");
    expect(outreach?.options).toContain("شركة محددة بهذا الاسم");
    expect(outreach?.options.at(-1)).toBe("أخرى");
    expect(getMissingCompanyResearchRequirements(`${request} إجابة هدف التواصل: شركة محددة بهذا الاسم`)).not.toContain("outreach_details");
  });

  it("does not infer Egypt or CEO for an unscoped people search", async () => {
    const { normalizeIcypeasPeopleParams } = await import("../src/lib/server/tregAdapter");
    const params = normalizeIcypeasPeopleParams({ query: { keyword: { include: ["decision makers"] } } }, 20);
    expect(params.query.location).toBeUndefined();
    expect(params.query.currentJobTitle).toBeUndefined();
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

  it("strictly separates contracting/construction from real estate developers, interior design, oil & gas and wood", async () => {
    const { evaluateDeterministicRelevance } = await import("../src/lib/server/relevanceValidationLayer");

    const realEstate = {
      company_name: "Palm Hills Developments",
      location: "Cairo, Egypt",
      industry: "Real Estate",
      description: "Leading real estate developer building luxury residential communities in Egypt",
    };

    const interiorDesign = {
      company_name: "Style Interior Design Studio",
      location: "Giza, Egypt",
      industry: "Interior Design",
      description: "Interior design and decoration office",
    };

    const oilGas = {
      company_name: "Petro Drilling Services",
      location: "Alexandria, Egypt",
      industry: "Oil & Energy",
      description: "Oil and gas exploration and drilling support services",
    };

    const woodTrading = {
      company_name: "Egyptian Wood Products",
      location: "Damietta, Egypt",
      industry: "Wood Products",
      description: "Import and manufacturing of lumber and wood supplies",
    };

    const emptyIndustry = {
      company_name: "Vague Services Co",
      location: "Cairo, Egypt",
      industry: "",
      description: "General trade and services",
    };

    const genuineContractor = {
      company_name: "The Arab Contractors (Osman Ahmed Osman)",
      location: "Cairo, Egypt",
      industry: "Construction",
      description: "General contracting, civil engineering, bridges, and infrastructure building",
    };

    // Contracting/construction evaluations
    expect(evaluateDeterministicRelevance(realEstate, "Egypt", "المقاولات والتشييد").decision).toBe("no_match");
    expect(evaluateDeterministicRelevance(interiorDesign, "Egypt", "المقاولات والتشييد").decision).toBe("no_match");
    expect(evaluateDeterministicRelevance(oilGas, "Egypt", "المقاولات والتشييد").decision).toBe("no_match");
    expect(evaluateDeterministicRelevance(woodTrading, "Egypt", "المقاولات والتشييد").decision).toBe("no_match");
    expect(evaluateDeterministicRelevance(emptyIndustry, "Egypt", "المقاولات والتشييد").decision).toBe("uncertain");
    expect(evaluateDeterministicRelevance(genuineContractor, "Egypt", "المقاولات والتشييد").decision).toBe("match");
  });
});
