/**
 * Arabic names for the industry labels sources commonly return (the LinkedIn-style taxonomy).
 * Used wherever our own sentence mentions an industry: reasons shown in the activity feed and the
 * review sheet, and the industry column of delivered workbooks.
 */
const INDUSTRY_LABELS_AR: Record<string, string> = {
  "construction": "المقاولات والتشييد",
  "civil engineering": "الهندسة المدنية",
  "building materials": "مواد البناء",
  "architecture & planning": "العمارة والتخطيط",
  "real estate": "العقارات",
  "commercial real estate": "العقارات التجارية",
  "interior design": "التصميم الداخلي",
  "furniture": "الأثاث",
  "wood": "منتجات الخشب",
  "wood products": "منتجات الخشب",
  "oil & energy": "النفط والطاقة",
  "oil and gas": "النفط والغاز",
  "utilities": "المرافق",
  "renewables & environment": "الطاقة المتجددة والبيئة",
  "electrical/electronic manufacturing": "تصنيع المعدات الكهربائية والإلكترونية",
  "machinery": "الآلات والمعدات",
  "mechanical or industrial engineering": "الهندسة الميكانيكية والصناعية",
  "industrial automation": "الأتمتة الصناعية",
  "information technology & services": "تقنية المعلومات والخدمات التقنية",
  "information technology and services": "تقنية المعلومات والخدمات التقنية",
  "computer software": "البرمجيات",
  "internet": "الإنترنت",
  "computer & network security": "أمن الحاسوب والشبكات",
  "computer hardware": "أجهزة الحاسوب",
  "telecommunications": "الاتصالات",
  "financial services": "الخدمات المالية",
  "banking": "الخدمات المصرفية",
  "insurance": "التأمين",
  "investment banking": "الاستثمار المصرفي",
  "accounting": "المحاسبة",
  "management consulting": "الاستشارات الإدارية",
  "marketing & advertising": "التسويق والإعلان",
  "food & beverages": "الأغذية والمشروبات",
  "food production": "إنتاج الأغذية",
  "restaurants": "المطاعم",
  "retail": "التجزئة",
  "wholesale": "الجملة",
  "consumer goods": "السلع الاستهلاكية",
  "pharmaceuticals": "الأدوية",
  "hospital & health care": "المستشفيات والرعاية الصحية",
  "medical devices": "الأجهزة الطبية",
  "automotive": "السيارات",
  "aviation & aerospace": "الطيران والفضاء",
  "defense & space": "الدفاع والفضاء",
  "transportation/trucking/railroad": "النقل والشحن",
  "logistics & supply chain": "الخدمات اللوجستية وسلاسل الإمداد",
  "maritime": "الملاحة البحرية",
  "hospitality": "الضيافة",
  "leisure, travel & tourism": "السياحة والسفر",
  "education management": "إدارة التعليم",
  "primary/secondary education": "التعليم الأساسي والثانوي",
  "higher education": "التعليم العالي",
  "chemicals": "الكيماويات",
  "plastics": "البلاستيك",
  "mining & metals": "التعدين والمعادن",
  "paper & forest products": "الورق ومنتجات الغابات",
  "textiles": "المنسوجات",
  "apparel & fashion": "الأزياء والملابس",
  "agriculture": "الزراعة",
  "farming": "الزراعة",
  "fishery": "الصيد البحري",
  "environmental services": "الخدمات البيئية",
  "facilities services": "خدمات المرافق",
  "security & investigations": "الأمن والتحقيقات",
  "staffing & recruiting": "التوظيف والاستقطاب",
  "legal services": "الخدمات القانونية",
  "nonprofit organization management": "إدارة المؤسسات غير الربحية",
  "government administration": "الإدارة الحكومية",
  "media production": "الإنتاج الإعلامي",
  "entertainment": "الترفيه",
  "sports": "الرياضة",
  "information technology": "تقنية المعلومات والخدمات التقنية",
  "it services": "تقنية المعلومات والخدمات التقنية",
  "it services and it consulting": "تقنية المعلومات والخدمات التقنية",
  "software development": "تطوير البرمجيات",
  "software": "البرمجيات",
  "technology": "التقنية",
  "technology, information and internet": "التقنية والمعلومات والإنترنت",
  "technology, information and media": "التقنية والمعلومات والإعلام",
  "telecommunications carriers": "مشغّلو الاتصالات",
  "wireless": "الاتصالات اللاسلكية",
  "fintech": "التقنية المالية",
  "financial technology": "التقنية المالية",
  "capital markets": "أسواق المال",
  "venture capital & private equity": "رأس المال الجريء والأسهم الخاصة",
  "investment management": "إدارة الاستثمار",
  "banks": "الخدمات المصرفية",
  "insurance carriers": "التأمين",
  "health, wellness & fitness": "الصحة واللياقة",
  "health care": "الرعاية الصحية",
  "healthcare": "الرعاية الصحية",
  "medical practice": "الممارسة الطبية",
  "mental health care": "الصحة النفسية",
  "biotechnology": "التقنية الحيوية",
  "veterinary": "الطب البيطري",
  "retail apparel and fashion": "تجزئة الأزياء",
  "retail groceries": "تجزئة البقالة",
  "supermarkets": "المتاجر الكبرى",
  "e-commerce": "التجارة الإلكترونية",
  "import & export": "الاستيراد والتصدير",
  "import and export": "الاستيراد والتصدير",
  "wholesale building materials": "تجارة مواد البناء بالجملة",
  "luxury goods & jewelry": "السلع الفاخرة والمجوهرات",
  "cosmetics": "مستحضرات التجميل",
  "sporting goods": "السلع الرياضية",
  "consumer electronics": "الإلكترونيات الاستهلاكية",
  "consumer services": "الخدمات الاستهلاكية",
  "electrical equipment manufacturing": "تصنيع المعدات الكهربائية",
  "industrial machinery manufacturing": "تصنيع الآلات الصناعية",
  "manufacturing": "التصنيع",
  "packaging & containers": "التعبئة والتغليف",
  "printing": "الطباعة",
  "glass, ceramics & concrete": "الزجاج والسيراميك والخرسانة",
  "semiconductors": "أشباه الموصلات",
  "automation machinery manufacturing": "تصنيع آلات الأتمتة",
  "motor vehicle manufacturing": "تصنيع المركبات",
  "airlines/aviation": "الطيران",
  "airlines and aviation": "الطيران",
  "shipbuilding": "بناء السفن",
  "railroad manufacture": "تصنيع السكك الحديدية",
  "warehousing": "التخزين",
  "package/freight delivery": "توصيل الطرود والشحن",
  "truck transportation": "النقل بالشاحنات",
  "civil engineering and infrastructure": "الهندسة المدنية والبنية التحتية",
  "building construction": "تشييد المباني",
  "construction and engineering": "المقاولات والهندسة",
  "engineering services": "الخدمات الهندسية",
  "architecture and planning": "العمارة والتخطيط",
  "design": "التصميم",
  "graphic design": "التصميم الجرافيكي",
  "public relations & communications": "العلاقات العامة والاتصال",
  "market research": "أبحاث السوق",
  "human resources": "الموارد البشرية",
  "outsourcing/offshoring": "الاستعانة بمصادر خارجية",
  "professional training & coaching": "التدريب والتأهيل المهني",
  "e-learning": "التعليم الإلكتروني",
  "education": "التعليم",
  "research": "الأبحاث",
  "law practice": "المحاماة",
  "law firms": "مكاتب المحاماة",
  "broadcast media": "البث الإعلامي",
  "publishing": "النشر",
  "newspapers": "الصحافة",
  "online media": "الإعلام الإلكتروني",
  "motion pictures & film": "الأفلام والسينما",
  "music": "الموسيقى",
  "gaming": "الألعاب",
  "computer games": "ألعاب الحاسوب",
  "events services": "تنظيم الفعاليات",
  "travel arrangements": "ترتيبات السفر",
  "hotels and motels": "الفنادق",
  "food and beverage services": "خدمات الأغذية والمشروبات",
  "food and beverage manufacturing": "تصنيع الأغذية والمشروبات",
  "dairy": "الألبان",
  "beverages": "المشروبات",
  "tobacco": "التبغ",
  "farming, ranching, forestry": "الزراعة والثروة الحيوانية والغابات",
  "ranching": "تربية المواشي",
  "oil, gas, and mining": "النفط والغاز والتعدين",
  "mining": "التعدين",
  "metals": "المعادن",
  "renewable energy semiconductor manufacturing": "الطاقة المتجددة",
  "renewable energy power generation": "توليد الطاقة المتجددة",
  "electric power generation": "توليد الكهرباء",
  "utilities administration": "إدارة المرافق",
  "water supply and irrigation systems": "إمدادات المياه والري",
  "waste treatment and disposal": "معالجة النفايات",
  "individual & family services": "الخدمات الفردية والأسرية",
  "non-profit organizations": "المنظمات غير الربحية",
  "religious institutions": "المؤسسات الدينية",
  "government relations": "العلاقات الحكومية",
  "public safety": "السلامة العامة",
  "military": "الدفاع",
  "international trade and development": "التجارة والتنمية الدولية",
  "think tanks": "مراكز الفكر",
  "executive office": "المكاتب التنفيذية",
  "real estate agents and brokers": "الوساطة العقارية",
  "leasing non-residential real estate": "تأجير العقارات غير السكنية",
  "business consulting and services": "الاستشارات والخدمات التجارية",
  "business supplies & equipment": "مستلزمات ومعدات الأعمال",
  "translation and localization": "الترجمة والتوطين",
  "writing and editing": "الكتابة والتحرير",
  "photography": "التصوير",
  "fine art": "الفنون الجميلة",
  "libraries": "المكتبات",
  "museums and institutions": "المتاحف والمؤسسات",
  "recreational facilities and services": "المرافق والخدمات الترفيهية",
  "sports and recreation": "الرياضة والترفيه",
  "pet services": "خدمات الحيوانات الأليفة",
  "personal care": "العناية الشخصية",
  "wellness and fitness services": "خدمات الصحة واللياقة",
  "alternative medicine": "الطب البديل",
  "pharmaceutical manufacturing": "تصنيع الأدوية",
  "medical equipment manufacturing": "تصنيع المعدات الطبية",
  "hospitals and health care": "المستشفيات والرعاية الصحية",
  "oil and energy": "النفط والطاقة",
  "other": "نشاط آخر",
};

/** The label as a key: case, spacing, «&» / «and» and a trailing «services» do not make a different industry. */
const labelKey = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();
const loose = (value: string): string => labelKey(value).replace(/\s*&\s*/g, " and ").replace(/[^a-z0-9, /\-]+/g, "").replace(/\s+/g, " ").trim();
const LOOSE_LABELS = new Map<string, string>(Object.entries(INDUSTRY_LABELS_AR).map(([key, label]) => [loose(key), label]));

/** One English label, or null when it is not known. */
function singleLabelAr(value: string): string | null {
  const exact = INDUSTRY_LABELS_AR[labelKey(value)];
  if (exact) return exact;
  const normalized = loose(value);
  return LOOSE_LABELS.get(normalized) ?? LOOSE_LABELS.get(normalized.replace(/ services$/, "")) ?? LOOSE_LABELS.get(`${normalized} services`) ?? null;
}

/**
 * Arabic name for a source industry label. An already-Arabic value is kept. A list («Construction; Real Estate», «A, B», «A / B») is
 * translated item by item and joined with «، » when EVERY item is known. An unknown English label returns null.
 */
export function industryLabelAr(label: unknown): string | null {
  const value = String(label ?? "").trim();
  if (!value) return null;
  if (/[؀-ۿ]/u.test(value)) return value;
  const whole = singleLabelAr(value);
  if (whole) return whole;
  const parts = value.split(/\s*[;|\n]\s*|\s*,\s*(?=[A-Za-z])|\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    const translated = parts.map(singleLabelAr);
    if (translated.every((item): item is string => Boolean(item))) return [...new Set(translated)].join("، ");
  }
  return null;
}

/** For sentences: the Arabic name, or a neutral phrase when the label has no known translation. */
export function industryLabelForSentence(label: unknown): string {
  return industryLabelAr(label) ?? "نشاط آخر";
}

/** Shown in a spreadsheet cell for a source label with no Arabic name: Arabic only (the English label is never copied into a delivered file). */
export const INDUSTRY_NOT_TRANSLATED_AR = "نشاط آخر (تصنيف المصدر غير مترجم)";

/** For a spreadsheet cell: the Arabic industry, or a plain Arabic marker when the label has no known translation. */
export function industryLabelForCell(label: unknown): string {
  const value = String(label ?? "").trim();
  if (!value || value === "غير متاح") return "غير متاح";
  return industryLabelAr(value) ?? INDUSTRY_NOT_TRANSLATED_AR;
}

/** English sector names in the customer's text («Construction», «Information Technology & Services») and a bare «FinTech», as Arabic. */
const SECTOR_PHRASES = Object.keys(INDUSTRY_LABELS_AR)
  .filter((key) => /[a-z]/.test(key) && key.length >= 5 && key !== "other")
  .sort((a, b) => b.length - a.length);
const SECTOR_PHRASE_RE = new RegExp(`(?<![A-Za-z0-9])(?:${SECTOR_PHRASES.map((key) => key.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/ and /g, " (?:and|&) ").replace(/ /g, "\\s+")).join("|")})(?![A-Za-z0-9])`, "giu");

/** Last guard before text reaches the customer: a known English sector name inside a sentence is replaced by its Arabic name. */
export function localizeSectorNamesInText(text: string): string {
  const raw = String(text ?? "");
  if (!raw || !/[A-Za-z]/.test(raw)) return raw;
  return raw.replace(SECTOR_PHRASE_RE, (match) => industryLabelAr(match) ?? match);
}
