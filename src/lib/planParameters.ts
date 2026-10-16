const GREETING_WORDS = new Set([
  "ازيك",
  "ازيكوا",
  "ازيكم",
  "مرحبا",
  "مرحباً",
  "أهلاً",
  "أهلا",
  "اهلا",
  "صباح الخير",
  "مساء الخير",
  "سلام عليكم",
  "السلام عليكم",
  "هلا",
  "hello",
  "hi",
  "hey",
]);

function isGreeting(val?: string): boolean {
  if (!val) return true;
  const trimmed = val.trim().toLowerCase();
  return GREETING_WORDS.has(trimmed) || /^(ازيك|مرحبا|اهلا|أهلا|هاي|سلام|hello|hi)[\s!.؟?]*$/i.test(trimmed);
}

export interface CountryMapping {
  canonicalEnglish: string;
  arabicLabel: string;
  isDefault?: boolean;
}

export interface IndustryMapping {
  englishKeywords: string[];
  arabicLabel: string;
  exactTaxonomy?: string[];
}

export function detectCountryFromText(text: string): CountryMapping | null {
  if (!text || typeof text !== "string") return null;
  const t = text.toLowerCase().trim();

  if (t.includes("ليختنشتاين") || t.includes("liechtenstein")) {
    return { canonicalEnglish: "Liechtenstein", arabicLabel: "ليختنشتاين" };
  }
  if (t.includes("ألمانيا") || t.includes("المانيا") || t.includes("germany") || t.includes("deutschland") || t.includes("برلين") || t.includes("ميونخ")) {
    return { canonicalEnglish: "Germany", arabicLabel: "ألمانيا" };
  }
  if (t.includes("النمسا") || t.includes("austria") || t.includes("österreich") || t.includes("فيينا")) {
    return { canonicalEnglish: "Austria", arabicLabel: "النمسا" };
  }
  if (
    t.includes("السعودية") ||
    t.includes("المملكة العربية السعودية") ||
    t.includes("saudi") ||
    t.includes("ksa") ||
    t.includes("الرياض") ||
    t.includes("جدة") ||
    t.includes("الدمام")
  ) {
    return { canonicalEnglish: "Saudi Arabia", arabicLabel: "المملكة العربية السعودية" };
  }
  if (
    t.includes("الإمارات") ||
    t.includes("الامارات") ||
    t.includes("دبي") ||
    t.includes("أبوظبي") ||
    t.includes("ابوظبي") ||
    t.includes("uae") ||
    t.includes("emirates") ||
    t.includes("الشارقة")
  ) {
    return { canonicalEnglish: "United Arab Emirates", arabicLabel: "الإمارات العربية المتحدة" };
  }
  if (
    t.includes("مصر") ||
    t.includes("القاهرة") ||
    t.includes("الإسكندرية") ||
    t.includes("الاسكندرية") ||
    t.includes("الجيزة") ||
    t.includes("egypt") ||
    t.includes("cairo") ||
    t.includes("alexandria")
  ) {
    return { canonicalEnglish: "Egypt", arabicLabel: "مصر" };
  }
  if (t.includes("الكويت") || t.includes("kuwait")) {
    return { canonicalEnglish: "Kuwait", arabicLabel: "الكويت" };
  }
  if (t.includes("قطر") || t.includes("qatar") || t.includes("الدوحة")) {
    return { canonicalEnglish: "Qatar", arabicLabel: "قطر" };
  }
  if (t.includes("البحرين") || t.includes("bahrain") || t.includes("المنامة")) {
    return { canonicalEnglish: "Bahrain", arabicLabel: "البحرين" };
  }
  if (t.includes("عمان") || t.includes("سلطنة عمان") || t.includes("oman") || t.includes("مسقط")) {
    return { canonicalEnglish: "Oman", arabicLabel: "سلطنة عمان" };
  }
  if (t.includes("الأردن") || t.includes("الاردن") || t.includes("jordan")) {
    return { canonicalEnglish: "Jordan", arabicLabel: "الأردن" };
  }
  if (t.includes("المملكة المتحدة") || t.includes("بريطانيا") || t.includes("إنجلترا") || t.includes("uk") || t.includes("united kingdom") || t.includes("لندن")) {
    return { canonicalEnglish: "United Kingdom", arabicLabel: "المملكة المتحدة" };
  }
  if (t.includes("الولايات المتحدة") || t.includes("أمريكا") || t.includes("امريكا") || t.includes("usa") || t.includes("united states") || t.includes("نيويورك")) {
    return { canonicalEnglish: "United States", arabicLabel: "الولايات المتحدة" };
  }
  if (t.includes("فرنسا") || t.includes("france") || t.includes("باريس")) {
    return { canonicalEnglish: "France", arabicLabel: "فرنسا" };
  }
  if (t.includes("إيطاليا") || t.includes("ايطاليا") || t.includes("italy") || t.includes("روما")) {
    return { canonicalEnglish: "Italy", arabicLabel: "إيطاليا" };
  }
  if (t.includes("إسبانيا") || t.includes("اسبانيا") || t.includes("spain") || t.includes("مدريد")) {
    return { canonicalEnglish: "Spain", arabicLabel: "إسبانيا" };
  }
  if (t.includes("سويسرا") || t.includes("switzerland") || t.includes("جنيف") || t.includes("زيورخ")) {
    return { canonicalEnglish: "Switzerland", arabicLabel: "سويسرا" };
  }
  if (t.includes("هولندا") || t.includes("netherlands") || t.includes("holland") || t.includes("أمستردام")) {
    return { canonicalEnglish: "Netherlands", arabicLabel: "هولندا" };
  }
  if (t.includes("تركيا") || t.includes("turkey") || t.includes("türkiye") || t.includes("إسطنبول")) {
    return { canonicalEnglish: "Turkey", arabicLabel: "تركيا" };
  }

  return null;
}

export function detectIndustryFromText(text: string): IndustryMapping {
  const t = (text || "").toLowerCase().trim();

  if (t.includes("fintech") || t.includes("financial technology") || t.includes("التقنية المالية") || t.includes("التكنولوجيا المالية")) {
    return {
      englishKeywords: ["fintech", "financial technology"],
      arabicLabel: "FinTech",
      exactTaxonomy: ["Financial Services", "Banking", "Information Technology & Services"],
    };
  }

  if (t.includes("صواريخ") || t.includes("صاروخ") || t.includes("rocket") || t.includes("aerospace") || t.includes("فضاء")) {
    return {
      englishKeywords: ["aerospace", "rocket"],
      arabicLabel: "صناعة الصواريخ والفضاء",
      exactTaxonomy: ["Aviation & Aerospace", "Defense & Space"],
    };
  }
  if (t.includes("طاقة شمسية") || t.includes("شمسية") || t.includes("solar") || t.includes("طاقة متجددة") || t.includes("renewable")) {
    return {
      englishKeywords: ["solar", "solar energy", "renewable energy"],
      arabicLabel: "الطاقة الشمسية والمتجددة",
      exactTaxonomy: ["Renewables & Environment", "Oil & Energy"],
    };
  }
  if (t.includes("كهرباء") || t.includes("كهربائية") || t.includes("electrical") || t.includes("electricity")) {
    return {
      englishKeywords: ["electrical", "electricity", "electrical engineering"],
      arabicLabel: "الكهرباء والطاقة الكهربائية",
      exactTaxonomy: ["Electrical/Electronic Manufacturing", "Utilities"],
    };
  }
  if (t.includes("أغذية") || t.includes("اغذية") || t.includes("طعام") || t.includes("مطاعم") || t.includes("أطعمة") || t.includes("food") || t.includes("beverage")) {
    return {
      englishKeywords: ["food", "beverages", "restaurants"],
      arabicLabel: "الأغذية والمطاعم",
      exactTaxonomy: ["Food & Beverages", "Food Production", "Restaurants"],
    };
  }
  if (
    t.includes("تقنية") ||
    t.includes("تكنولوجيا") ||
    t.includes("معلومات") ||
    t.includes("برمجيات") ||
    t.includes("برمجة") ||
    t.includes("software") ||
    t.includes("tech") ||
    t.includes("it")
  ) {
    return {
      englishKeywords: ["information technology", "software", "technology"],
      arabicLabel: "تقنية المعلومات والبرمجيات",
      exactTaxonomy: ["Information Technology & Services", "Computer Software", "Internet"],
    };
  }
  if (
    t.includes("مقاولات") ||
    t.includes("تشييد") ||
    t.includes("بناء") ||
    t.includes("construction") ||
    t.includes("contracting")
  ) {
    return {
      englishKeywords: ["construction", "contracting"],
      arabicLabel: "المقاولات والتشييد",
      exactTaxonomy: ["Construction", "Civil Engineering", "Building Materials"],
    };
  }
  if (t.includes("أثاث") || t.includes("اثاث") || t.includes("موبيليا") || t.includes("furniture") || t.includes("woodworking")) {
    return {
      englishKeywords: ["furniture", "woodworking"],
      arabicLabel: "صناعة الأثاث",
      exactTaxonomy: ["Furniture"],
    };
  }
  if (t.includes("عقارات") || t.includes("تطوير عقاري") || t.includes("real estate")) {
    return {
      englishKeywords: ["real estate"],
      arabicLabel: "التطوير العقاري",
      exactTaxonomy: ["Real Estate"],
    };
  }
  if (t.includes("أدوية") || t.includes("ادوية") || t.includes("صيدلة") || t.includes("pharma")) {
    return {
      englishKeywords: ["pharmaceuticals", "healthcare"],
      arabicLabel: "الأدوية والرعاية الصحية",
      exactTaxonomy: ["Pharmaceuticals", "Hospital & Health Care"],
    };
  }
  if (t.includes("سيارات") || t.includes("automotive") || t.includes("vehicles")) {
    return {
      englishKeywords: ["automotive", "vehicles"],
      arabicLabel: "السيارات والمركبات",
      exactTaxonomy: ["Automotive"],
    };
  }
  if (t.includes("تعليم") || t.includes("مدارس") || t.includes("education")) {
    return {
      englishKeywords: ["education"],
      arabicLabel: "التعليم",
      exactTaxonomy: ["Education Management"],
    };
  }
  if (t.includes("سياحة") || t.includes("فنادق") || t.includes("tourism") || t.includes("hospitality")) {
    return {
      englishKeywords: ["tourism", "hospitality"],
      arabicLabel: "السياحة والضيافة",
      exactTaxonomy: ["Hospitality", "Leisure, Travel & Tourism"],
    };
  }
  if (t.includes("شحن") || t.includes("لوجستيات") || t.includes("logistics") || t.includes("freight")) {
    return {
      englishKeywords: ["logistics", "freight"],
      arabicLabel: "الشحن والخدمات اللوجستية",
      exactTaxonomy: ["Transportation/Trucking/Railroad", "Logistics & Supply Chain"],
    };
  }
  if (t.includes("صيد الحيتان") || t.includes("حيتان") || t.includes("whale hunting") || t.includes("whaling")) {
    return {
      englishKeywords: ["whale hunting", "whaling"],
      arabicLabel: "صيد الحيتان",
    };
  }
  if (t.includes("مصانع") || t.includes("تصنيع") || t.includes("صناعة") || t.includes("manufacturing") || t.includes("factory")) {
    return {
      englishKeywords: ["manufacturing", "factory"],
      arabicLabel: "التصنيع والإنتاج الصناعي",
      exactTaxonomy: ["Electrical/Electronic Manufacturing", "Machinery", "Mechanical or Industrial Engineering"],
    };
  }

  const cleaned = t
    .replace(/[^\w\s\u0600-\u06FF]/g, " ")
    .replace(/\b(عايز|اريد|أريد|شركات|شركة|مؤسسات|مؤسسة|ملف|في|داخل|بـ|in|companies|company|need|want|find)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    return { englishKeywords: [cleaned], arabicLabel: cleaned };
  }

  return { englishKeywords: ["contracting"], arabicLabel: "قواعد بيانات الشركات" };
}

/** Customer-facing industry label for recognized English taxonomy names. */
export function industryDisplayLabelAr(label: string): string {
  if (label.trim().toLowerCase() === "fintech") return "التقنية المالية";
  return label;
}

export function isCompanyRowMatchingLocation(row: Record<string, any>, expectedCountryCanonical?: string | null): boolean {
  if (!expectedCountryCanonical) return true;
  const targetLower = expectedCountryCanonical.toLowerCase().trim();
  const rowLoc = String(row.location || row.address || row.country || row.city || "").toLowerCase();
  const rowWeb = String(row.website || row.linkedin_url || "").toLowerCase();
  const rowDesc = String(row.description || "").toLowerCase();

  if (targetLower.includes("liechtenstein")) {
    return (
      rowLoc.includes("liechtenstein") ||
      rowLoc.includes("balzers") ||
      rowLoc.includes("vaduz") ||
      rowLoc.includes("schaan") ||
      rowWeb.includes(".li") ||
      rowDesc.includes("liechtenstein")
    );
  }
  if (targetLower.includes("saudi")) {
    return (
      rowLoc.includes("saudi") ||
      rowLoc.includes("riyadh") ||
      rowLoc.includes("jeddah") ||
      rowLoc.includes("dammam") ||
      rowLoc.includes("khobar") ||
      rowWeb.includes(".sa") ||
      rowLoc.includes("السعودية") ||
      rowLoc.includes("المملكة العربية السعودية")
    );
  }
  if (targetLower.includes("emirates") || targetLower.includes("uae")) {
    return (
      rowLoc.includes("emirates") ||
      rowLoc.includes("uae") ||
      rowLoc.includes("dubai") ||
      rowLoc.includes("abu dhabi") ||
      rowLoc.includes("sharjah") ||
      rowWeb.includes(".ae") ||
      rowLoc.includes("الإمارات") ||
      rowLoc.includes("الامارات") ||
      rowLoc.includes("دبي")
    );
  }
  if (targetLower.includes("germany")) {
    return (
      rowLoc.includes("germany") ||
      rowLoc.includes("deutschland") ||
      rowLoc.includes("berlin") ||
      rowLoc.includes("munich") ||
      rowLoc.includes("münchen") ||
      rowLoc.includes("essen") ||
      rowLoc.includes("frankfurt") ||
      rowLoc.includes("hamburg") ||
      rowWeb.includes(".de") ||
      rowLoc.includes("ألمانيا")
    );
  }
  if (targetLower.includes("egypt")) {
    return (
      rowLoc.includes("egypt") ||
      rowLoc.includes("cairo") ||
      rowLoc.includes("giza") ||
      rowLoc.includes("alexandria") ||
      rowWeb.includes(".eg") ||
      rowLoc.includes("مصر") ||
      rowLoc.includes("القاهرة") ||
      rowLoc.includes("الجيزة")
    );
  }
  if (targetLower.includes("austria")) {
    return (
      rowLoc.includes("austria") ||
      rowLoc.includes("österreich") ||
      rowLoc.includes("vienna") ||
      rowLoc.includes("wien") ||
      rowWeb.includes(".at") ||
      rowLoc.includes("النمسا")
    );
  }

  return rowLoc.includes(targetLower) || rowDesc.includes(targetLower);
}

export function isCompanyRowMatchingConstraints(
  row: Record<string, any>,
  expectedCountry?: string | null,
  expectedIndustryAr?: string | null
): boolean {
  if (expectedCountry && !isCompanyRowMatchingLocation(row, expectedCountry)) {
    return false;
  }

  if (expectedIndustryAr) {
    const rowInd = String(row.industry || "").toLowerCase();
    const rowDesc = String(row.description || "").toLowerCase();
    const rowName = String(row.company_name || row.name || "").toLowerCase();
    const rowText = `${rowInd} ${rowDesc} ${rowName}`;

    if (expectedIndustryAr.includes("صواريخ") || expectedIndustryAr.includes("فضاء")) {
      const match =
        rowText.includes("aerospace") ||
        rowText.includes("rocket") ||
        rowText.includes("space") ||
        rowText.includes("defense") ||
        rowText.includes("aviation") ||
        rowText.includes("machinery") ||
        rowText.includes("precision") ||
        rowText.includes("coating");
      if (!match) return false;
    } else if (expectedIndustryAr.includes("مقاولات") || expectedIndustryAr.includes("تشييد") || expectedIndustryAr.includes("بناء")) {
      const match =
        rowText.includes("construction") ||
        rowText.includes("contract") ||
        rowText.includes("contracting") ||
        rowText.includes("building") ||
        rowText.includes("civil engineering") ||
        rowText.includes("infrastructure") ||
        rowText.includes("architecture") ||
        rowText.includes("مقاولات") ||
        rowText.includes("بناء") ||
        rowText.includes("تشييد") ||
        rowText.includes("خرسانة");
      const isPureUnrelated =
        rowInd.includes("real estate") && !rowText.includes("contract") && !rowText.includes("construction");
      if (!match || isPureUnrelated) return false;
    } else if (expectedIndustryAr.includes("طاقة شمسية") || expectedIndustryAr.includes("شمسية")) {
      const match =
        rowText.includes("solar") ||
        rowText.includes("renewable") ||
        rowText.includes("photovoltaic") ||
        rowText.includes("energy") ||
        rowText.includes("طاقة شمسية");
      if (!match) return false;
    } else if (expectedIndustryAr.includes("أغذية") || expectedIndustryAr.includes("طعام")) {
      const match =
        rowText.includes("food") ||
        rowText.includes("beverage") ||
        rowText.includes("restaurant") ||
        rowText.includes("catering") ||
        rowText.includes("nutrition") ||
        rowText.includes("أغذية") ||
        rowText.includes("طعام");
      if (!match) return false;
    } else if (expectedIndustryAr.includes("تقنية") || expectedIndustryAr.includes("برمجيات")) {
      const match =
        rowText.includes("software") ||
        rowText.includes("technology") ||
        rowText.includes("it services") ||
        rowText.includes("information") ||
        rowText.includes("media") ||
        rowText.includes("tech") ||
        rowText.includes("برمجيات") ||
        rowText.includes("تقنية");
      if (!match) return false;
    }
  }

  return true;
}

/**
 * Extracts interpreted parameters (country, industry, volume) for customer display.
 * When no country is specified, returns "مصر (افتراضي)".
 */
export function extractInterpretedParameters(
  params: Record<string, any> | undefined | null,
  summaryAr?: string,
  isPeopleSearch = false
): { countryAr: string; countryCanonical: string; industryAr: string; isDefaultCountry: boolean } {
  const query = params?.query && typeof params.query === "object" ? params.query : {};
  const firstIncluded = (value: any): string | undefined =>
    typeof value === "string"
      ? value
      : Array.isArray(value?.include) && typeof value.include[0] === "string"
        ? value.include[0]
        : undefined;
  const queryCountry = firstIncluded(query.location) || firstIncluded(query.country);
  // Explicit industry fields must win over free-text keywords left over from
  // the original plan after an edit.
  const queryIndustry = isPeopleSearch
    ? ""
    : params?.industry || firstIncluded(query.industry) || firstIncluded(query.keyword);
  const fullText = [
    params?.search,
    params?.query,
    params?.keyword,
    params?.topic,
    params?.location,
    params?.country,
    queryCountry,
    queryIndustry,
    summaryAr,
  ]
    .filter((v) => typeof v === "string" && v.trim().length > 0)
    .join(" ");

  const explicitCountry =
    detectCountryFromText(queryCountry || "") ||
    detectCountryFromText(params?.country || "") ||
    detectCountryFromText(params?.location || "") ||
    detectCountryFromText(fullText);

  const industry = isPeopleSearch
    ? { arabicLabel: "صناع القرار والمهنيون", canonicalEnglish: "", englishKeywords: [] }
    : detectIndustryFromText(queryIndustry || params?.industry || fullText);

  if (explicitCountry) {
    return {
      countryAr: explicitCountry.arabicLabel,
      countryCanonical: explicitCountry.canonicalEnglish,
      industryAr: industry.arabicLabel,
      isDefaultCountry: false,
    };
  }

  return {
    countryAr: "مصر (افتراضي)",
    countryCanonical: "Egypt",
    industryAr: industry.arabicLabel,
    isDefaultCountry: true,
  };
}

/** Return the required company-search fields the user has not supplied. */
export function getMissingCompanyResearchRequirements(text: string): Array<"country" | "industry"> {
  const country = detectCountryFromText(text || "");
  let industryText = (text || "").toLowerCase();
  if (country) {
    industryText = industryText
      .replace(new RegExp(country.canonicalEnglish.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ")
      .replace(new RegExp(country.arabicLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  }
  industryText = industryText
    .replace(/\b\d+\b/g, " ")
    .replace(/عايز|اريد|أريد|شركات|شركة|مؤسسات|مؤسسة|بيانات|سجلات|سجل|قطاع|نشاط|بحث|ابحث|عن|في|من|مطلوب|القطاع|الشركات/gi, " ")
    .replace(/\b(?:companies|company|business|find|need|want|search|for|in|of|the)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const industry = detectIndustryFromText(industryText);
  const industryMissing = !industryText || industry.arabicLabel === "قواعد بيانات الشركات" ||
    industry.englishKeywords.length === 0 ||
    industry.englishKeywords.every((keyword) => keyword === "contracting");
  return [
    ...(!country ? ["country" as const] : []),
    ...(industryMissing ? ["industry" as const] : []),
  ];
}

export function isPeopleSearchRequest(text: string): boolean {
  const normalized = (text || "").toLowerCase();
  return /decision[\s-]*makers?|executives?|people search|work emails?|professional emails?|job titles?|contacts?\b|صناع القرار|صانعي القرار|صناع الأعمال|المديرين التنفيذيين|مسؤولين تنفيذيين|بريد العمل|البريد المهني|المسمى الوظيفي|جهات الاتصال|بيانات الأشخاص/.test(normalized);
}

/**
 * Extracts a human-readable display string from capability/plan parameters.
 */
export function extractParamDisplayString(
  params: Record<string, any> | undefined | null,
  summaryAr?: string,
  isPeopleSearch = false
): string {
  if (!params || typeof params !== "object") return "";
  // Provider query keywords may contain the customer's full natural-language prompt.
  // Never echo that raw English prompt into a customer-facing people-search card.
  if (isPeopleSearch) return "صناع القرار والمهنيون";

  const candidates: string[] = [];

  if (typeof params.search === "string" && params.search.trim()) candidates.push(params.search.trim());
  if (typeof params.username === "string" && params.username.trim()) candidates.push(params.username.trim());
  if (typeof params.keyword === "string" && params.keyword.trim()) candidates.push(params.keyword.trim());
  if (typeof params.topic === "string" && params.topic.trim()) candidates.push(params.topic.trim());
  if (typeof params.url === "string" && params.url.trim()) candidates.push(params.url.trim());
  if (typeof params.postUrl === "string" && params.postUrl.trim()) candidates.push(params.postUrl.trim());

  if (typeof params.query === "string" && params.query.trim()) candidates.push(params.query.trim());
  if (params.query && typeof params.query === "object") {
    if (
      Array.isArray(params.query.keyword?.include) &&
      typeof params.query.keyword.include[0] === "string" &&
      params.query.keyword.include[0].trim()
    ) {
      candidates.push(params.query.keyword.include[0].trim());
    }
    if (typeof params.query.keyword === "string" && params.query.keyword.trim()) {
      candidates.push(params.query.keyword.trim());
    }
    if (typeof params.query.search === "string" && params.query.search.trim()) {
      candidates.push(params.query.search.trim());
    }
  }

  if (params.topic && typeof params.topic === "object") {
    if (typeof params.topic.topic === "string" && params.topic.topic.trim()) {
      candidates.push(params.topic.topic.trim());
    }
    if (typeof params.topic.name === "string" && params.topic.name.trim()) {
      candidates.push(params.topic.name.trim());
    }
  }

  for (const [key, val] of Object.entries(params)) {
    if (typeof val === "string" && val.trim() && key !== "dateFrom" && key !== "dateTo" && key !== "pagination") {
      candidates.push(val.trim());
    }
  }

  for (const cand of candidates) {
    if (!isGreeting(cand)) {
      return cand;
    }
  }

  if (summaryAr && typeof summaryAr === "string") {
    const match = summaryAr.match(/(?:عن|لـ|في|حول|بشأن)\s+([^\n.]+)/);
    if (match?.[1] && match[1].trim() && !isGreeting(match[1])) {
      return match[1].trim();
    }
  }

  return candidates.find((c) => Boolean(c.trim())) || "";
}
