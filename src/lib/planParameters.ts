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
    .replace(/[٠-٩0-9]/g, " ")
    .replace(/\b(عايز|عاوز|محتاج|اريد|أريد|شركات|شركة|مؤسسات|مؤسسة|مجال|نشاط|ملف|في|داخل|بـ|in|companies|company|need|want|find)\b/gi, "")
    .replace(/عايز|عاوز|محتاج|اريد|أريد|شركات|شركة|مؤسسات|مؤسسة|مجال|نشاط|خطة|استخراج|ملف|في|داخل|بـ/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 0) {
    return { englishKeywords: [cleaned], arabicLabel: cleaned };
  }

  return { englishKeywords: [], arabicLabel: "يلزم تحديد النشاط" };
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
 * When no country or industry is specified, marks it as required instead of
 * inserting a geographic or industry default into the customer-facing plan.
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
    : params?.industry || firstIncluded(query.keyword) || firstIncluded(query.industry);
  const explicitIndustry = (typeof params?.industry === "string" && params.industry.trim())
    ? detectIndustryFromText(params.industry)
    : null;
  const fullText = [
    params?.industry,
    params?.search,
    typeof params?.query === "string" ? params?.query : (params?.query ? JSON.stringify(params.query) : ""),
    params?.keyword,
    params?.topic,
    params?.location,
    params?.country,
    queryCountry,
    queryIndustry,
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
    : explicitIndustry || detectIndustryFromText(queryIndustry || fullText);

  if (explicitCountry) {
    return {
      countryAr: explicitCountry.arabicLabel,
      countryCanonical: explicitCountry.canonicalEnglish,
      industryAr: industry.arabicLabel,
      isDefaultCountry: false,
    };
  }

  return {
    countryAr: "يلزم تحديد الدولة",
    countryCanonical: "",
    industryAr: industry.arabicLabel,
    isDefaultCountry: true,
  };
}

/** Return the required company-search fields the user has not supplied. */
export type CompanyResearchRequirement = "country" | "industry" | "outreach_details";

export function getMissingCompanyResearchRequirements(text: string): CompanyResearchRequirement[] {
  const country = detectCountryFromText(text || "");
  let industryText = (text || "").toLowerCase();
  if (country) {
    industryText = industryText
      .replace(new RegExp(country.canonicalEnglish.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ")
      .replace(new RegExp(country.arabicLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  }
  industryText = industryText
    // Quantities often arrive in Arabic-Indic digits or Arabic words. Leaving
    // them in the residual text can make "١٠٠ شركة" look like an industry.
    .replace(/[0-9٠-٩۰-۹]+/g, " ")
    .replace(/(?<![\p{L}\p{N}])(?:واحد|واحدة|واحده|اتنين|اثنين|اثنان|تلاتة|تلاته|ثلاثة|ثلاثه|ثلاث|أربعة|اربعة|أربعه|اربعه|خمسة|خمسه|خمس|ستة|سته|سبعة|سبعه|ثمانية|تمانية|تسعة|تسعه|عشرة|عشر|حداشر|اتناشر|تلتاشر|اربعتاشر|خمستاشر|ستاشر|سبعتاشر|تمنتاشر|تسعتاشر|عشرين|عشرون|تلاتين|ثلاثين|أربعين|اربعين|خمسين|ستين|سبعين|تمانين|ثمانين|تسعين|مية|ميه|مائة|مئة|ميتين|ألفين|الفين|ألف|الف|مليون|مليونين)(?![\p{L}\p{N}])/giu, " ")
    .replace(/للتواصل التجاري|التواصل التجاري|تواصل تجاري|للتواصل|التواصل|تواصل|التجاري|تجاري|commercial outreach|business development|outreach|commercial/gi, " ")
    .replace(/عايز|اريد|أريد|قائمة|تضم|شركات|شركة|مؤسسات|مؤسسة|بيانات|سجلات|سجل|قطاع|نشاط|بحث|ابحث|عن|في|من|مطلوب|القطاع|الشركات/gi, " ")
    .replace(/\b(?:companies|company|business|find|need|want|search|for|in|of|the|up|to|records?|list)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const industry = detectIndustryFromText(industryText);
  const asksForGenericOutreach = /التواصل|تواصل|outreach|business development|commercial/i.test(text || "");
  const givesOutreachDetails = /إجابة هدف التواصل:\s*\S+|شركة محددة بهذا الاسم|اسم الشركة|اسم الشركات|موقع الشركة|الموقع الإلكتروني|website|بريد العمل|البريد المهني|work email|business email|الهاتف|رقم الهاتف|linkedin|لينكد.?إن|مورد|موردون|مشتري|شراكة|شركاء|توريد|مبيعات|بيع|شراء|عملاء محتملون|بحث سوقي|supplier|buyer|partnership|sales lead|market research/i.test(text || "");
  // Unknown residue (for example, an organization name plus a sales purpose)
  // is not an industry. Accept a custom industry only when it is supplied as
  // the answer to the industry field or explicitly introduced as a sector.
  const hasExplicitIndustryAnswer = /(?:^|\|\s*)المجال المطلوب:\s*\S+/i.test(text || "");
  const hasExplicitIndustryPhrase = /(?:في\s+(?:مجال|قطاع|نشاط)|\b(?:industry|sector)\s*:)\s*[\p{L}\p{N}]/iu.test(text || "");
  const hasRecognizedIndustry = Boolean(industry.exactTaxonomy?.length) || industry.arabicLabel === "صيد الحيتان";
  return [
    ...(!country ? ["country" as const] : []),
    ...(!hasExplicitIndustryAnswer && !hasExplicitIndustryPhrase && !hasRecognizedIndustry
      ? ["industry" as const]
      : []),
    ...(asksForGenericOutreach && !givesOutreachDetails ? ["outreach_details" as const] : []),
  ];
}

/** Ask for the unresolved company-search scope in one natural turn. */
export function getCompanyRequirementQuestions(missing: CompanyResearchRequirement[]): string[] {
  const questions: string[] = [];
  if (missing.includes("country")) questions.push("ما الدولة التي تريد البحث عن الشركات فيها؟");
  if (missing.includes("industry")) questions.push("ما القطاع أو المجال الذي تعمل فيه الشركات المطلوبة؟");
  if (missing.includes("outreach_details")) {
    questions.push("ما المقصود بالتواصل التجاري تحديداً، وما بيانات الشركات التي تحتاجها؟");
  }
  return questions;
}

/** Pull out a likely named organization when a request mixes a company name
 * with an unclear verb such as "include/add". This is a cue to ask what the
 * user means; it is never treated as a verified company or industry. */
export function getAmbiguousCompanyReference(text: string): string | null {
  const match = (text || "").match(
    /(?<![\p{L}\p{N}])(?:شركة|مؤسسة)(?![\p{L}\p{N}])\s+([\p{L}\p{N}][\p{L}\p{N}\s&'’.-]{1,48}?)(?=\s+(?:في|ضمن|للتواصل|وتضم|مع|أو|إلى|للقائمة)|[،.!؟]|$)/iu,
  );
  const candidate = match?.[1]?.replace(/\s+/g, " ").trim();
  if (!candidate) return null;
  if (/[0-9٠-٩]/u.test(candidate) || /(?:أريد|اريد|أضم|اضم|أضيف|اضيف|قائمة|تضم|شركة|شركات|مؤسسة|مؤسسات|ابحث|بحث|حتى|سجل)/iu.test(candidate)) return null;
  // The loose phrase matcher can otherwise backtrack and treat a location or
  // relative clause ("شركة في ألمانيا تعمل...") as the supposed company name.
  // Only ask the named-company disambiguation when the candidate starts like
  // an actual name, not a preposition or ordinary sentence continuation.
  if (/^(?:في|ضمن|من|إلى|الى|على|ب|تعمل|يعمل|تقدم|يقدم|تضم|يشمل|تعمل\s+في|تعمل\s+ضمن|in|within|from|to|for|that|which|operating|based)(?:\s|$)/iu.test(candidate)) return null;
  if (/^(?:للتواصل|للتعامل|للتسويق|للبيع|للشراء|للاستيراد|للتصدير)(?:\s|$)/iu.test(candidate)) return null;
  if (/^(?:تقنية|تكنولوجيا|أغذية|مطاعم|تصنيع|مقاولات|برمجيات|شركات|مؤسسات)$/iu.test(candidate)) return null;
  return candidate;
}

/** Compact, adaptive answer chips for the company-search details UI. The final
 * chip always opens the custom-answer field, so suggestions never constrain
 * what the customer can ask for. */
export function getCompanyRequirementItems(
  missing: CompanyResearchRequirement[],
  requestText = "",
): Array<{ id: string; text: string; question: string; type: "single"; options: string[]; allowOther: true }> {
  const items: Array<{ id: string; text: string; question: string; type: "single"; options: string[]; allowOther: true }> = [];
  const hasResolvedAsCompanyList = /قائمة\s+(?:من\s+)?شركات?\s+للتواصل\s+التجاري|قائمة\s+الشركات\s+للتواصل\s+التجاري|\b(?:company list|list of companies)\b/i.test(requestText);
  const ambiguousNamedEntity = hasResolvedAsCompanyList ? null : getAmbiguousCompanyReference(requestText);
  if (ambiguousNamedEntity && missing.includes("outreach_details")) {
    const text = `هل تقصد شركة محددة باسم «${ambiguousNamedEntity.slice(0, 36)}» أم قائمة شركات للتواصل التجاري؟`;
    items.push({
      id: "company_outreach_required",
      text,
      question: text,
      type: "single",
      options: ["شركة محددة بهذا الاسم", "قائمة شركات للتواصل التجاري", "أخرى"],
      allowOther: true,
    });
  }
  if (missing.includes("country")) {
    const text = "ما الدولة التي تريد البحث عن الشركات فيها؟";
    items.push({ id: "company_country_required", text, question: text, type: "single", options: ["مصر", "السعودية", "الإمارات", "أخرى"], allowOther: true });
  }
  if (missing.includes("industry")) {
    const text = ambiguousNamedEntity
      ? `ما القطاع أو مجال «${ambiguousNamedEntity.slice(0, 36)}»، أو ما المجال المطلوب للشركات التي تبحث عنها؟`
      : "ما القطاع أو المجال الذي تعمل فيه الشركات المطلوبة؟";
    const lower = requestText.toLowerCase();
    const options = /تواصل|outreach|تجاري|business/i.test(lower)
      ? ["تقنية وبرمجيات", "التقنية المالية", "أغذية ومطاعم", "أخرى"]
      : ["تقنية وبرمجيات", "تصنيع", "التقنية المالية", "أخرى"];
    items.push({ id: "company_industry_required", text, question: text, type: "single", options, allowOther: true });
  }
  if (missing.includes("outreach_details") && !ambiguousNamedEntity) {
    const text = "ما المقصود بالتواصل التجاري تحديداً، وما بيانات الشركات التي تحتاجها؟";
    const options = ["عملاء محتملون / مبيعات", "موردون أو شركاء", "بحث سوقي", "أخرى"];
    items.push({ id: "company_outreach_required", text, question: text, type: "single", options, allowOther: true });
  }
  return items;
}

export function isPeopleSearchRequest(text: string): boolean {
  const normalized = (text || "").toLowerCase();
  const explicitPeopleIntent = /decision[\s-]*makers?|executives?|people search|\bpeople\b|job titles?|contacts?\b|employees?|individuals?|صناع القرار|صانعي القرار|صناع الأعمال|المديرين التنفيذيين|مسؤولين تنفيذيين|المسمى الوظيفي|جهات الاتصال|بيانات الأشخاص|أشخاص|شخص|موظفين|موظف/.test(normalized);
  if (explicitPeopleIntent) return true;

  // A work email can be a company field. Do not reinterpret an explicit
  // company list as a people search solely because it asks for business email.
  const explicitCompanyIntent = /\bcompanies?\b|\bbusinesses\b|شركة|شركات|مؤسسة|مؤسسات|مصنع|مصانع/.test(normalized);
  if (explicitCompanyIntent) return false;

  return /work emails?|professional emails?|بريد العمل|البريد المهني/.test(normalized);
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
