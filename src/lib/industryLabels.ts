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
};

/** Arabic name for a source industry label; an already-Arabic value is kept, an unknown English one returns null. */
export function industryLabelAr(label: unknown): string | null {
  const value = String(label ?? "").trim();
  if (!value) return null;
  if (/[؀-ۿ]/u.test(value)) return value;
  return INDUSTRY_LABELS_AR[value.toLowerCase().replace(/\s+/g, " ")] ?? null;
}

/** For sentences: the Arabic name, or a neutral phrase when the label has no known translation. */
export function industryLabelForSentence(label: unknown): string {
  return industryLabelAr(label) ?? "نشاط آخر";
}
