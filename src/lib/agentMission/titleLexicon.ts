/**
 * JOB TITLES AND NAMES AS «العربية (English)» (audit 2026-11 reference A columns 7 and 8; owner decision 3). A people source gives titles in English («Chief Executive Officer») and names in Latin letters; the owner's sheet shows both: «الرئيس التنفيذي (Chief Executive Officer)», «محمد سعيد (Mohamed Saied)».
 *   - TITLES by a code lexicon (this file): a table of the common titles and of the words that build them («Operations Manager» is «مدير العمليات»). A title the table cannot read is NOT guessed: the cell keeps the English alone; a title already in Arabic is kept as it is.
 *   - NAMES by one small batched model call per mission (agent/src/namesAr.ts): the model only writes the Arabic spelling of names it is given; it never decides money, a count or a row, and its cost is added to the price by code.
 * Pure: no I/O, no model.
 */
const clean = (s: string): string => s.toLowerCase().replace(/[.,]/g, " ").replace(/[​-‏‪-‮﻿]/g, "").replace(/\s+/g, " ").trim();
const hasArabic = (s: string): boolean => /[؀-ۿ]/.test(s);
const hasLatin = (s: string): boolean => /[A-Za-z]/.test(s);

/** Whole titles (cleaned, lower case). */
const TITLES: Readonly<Record<string, string>> = {
  "chief executive officer": "الرئيس التنفيذي", ceo: "الرئيس التنفيذي", "chief executive": "الرئيس التنفيذي",
  "chief operating officer": "رئيس العمليات التنفيذي", coo: "رئيس العمليات التنفيذي",
  "chief financial officer": "الرئيس المالي التنفيذي", cfo: "الرئيس المالي التنفيذي",
  "chief technology officer": "رئيس التقنية التنفيذي", cto: "رئيس التقنية التنفيذي",
  "chief marketing officer": "رئيس التسويق التنفيذي", cmo: "رئيس التسويق التنفيذي",
  "chief information officer": "رئيس المعلومات التنفيذي", cio: "رئيس المعلومات التنفيذي",
  "managing director": "العضو المنتدب", "general manager": "المدير العام", "deputy general manager": "نائب المدير العام", "assistant general manager": "مساعد المدير العام",
  chairman: "رئيس مجلس الإدارة", chairwoman: "رئيسة مجلس الإدارة", "chairman of the board": "رئيس مجلس الإدارة", "vice chairman": "نائب رئيس مجلس الإدارة", "board member": "عضو مجلس الإدارة",
  owner: "المالك", "co owner": "المالك المشارك", founder: "المؤسس", "co founder": "المؤسس المشارك", cofounder: "المؤسس المشارك", partner: "شريك", "managing partner": "الشريك المدير",
  president: "الرئيس", "vice president": "نائب الرئيس", vp: "نائب الرئيس", director: "مدير", manager: "مدير", "team lead": "قائد فريق", "team leader": "قائد فريق", supervisor: "مشرف", coordinator: "منسق",
  engineer: "مهندس", accountant: "محاسب", consultant: "مستشار", technician: "فني", specialist: "أخصائي", officer: "مسؤول", assistant: "مساعد", secretary: "سكرتير", receptionist: "موظف استقبال",
  driver: "سائق", worker: "عامل", intern: "متدرب", trainee: "متدرب", employee: "موظف", "sales representative": "مندوب مبيعات", "sales rep": "مندوب مبيعات", "sales executive": "مسؤول مبيعات", "account manager": "مدير حسابات", "hr specialist": "أخصائي موارد بشرية", "admin assistant": "مساعد إداري", "administrative assistant": "مساعد إداري",
  "project manager": "مدير مشروع", "site manager": "مدير موقع", "plant manager": "مدير المصنع", "factory manager": "مدير المصنع", "branch manager": "مدير فرع", "site engineer": "مهندس موقع", "project engineer": "مهندس مشروع", "electrical engineer": "مهندس كهرباء", "mechanical engineer": "مهندس ميكانيكا", "civil engineer": "مهندس مدني", "quality engineer": "مهندس جودة", "quality inspector": "مفتش جودة", "technical office engineer": "مهندس مكتب فني", "site supervisor": "مشرف موقع", "procurement officer": "مسؤول مشتريات",
};

/** The departments and fields a title names («Head of Operations», «Finance Manager»). */
const FIELDS: Readonly<Record<string, string>> = {
  operations: "العمليات", operation: "العمليات", sales: "المبيعات", marketing: "التسويق", finance: "المالية", financial: "المالية", projects: "المشاريع", project: "المشاريع", procurement: "المشتريات", purchasing: "المشتريات", purchases: "المشتريات",
  hr: "الموارد البشرية", "human resources": "الموارد البشرية", it: "تقنية المعلومات", technical: "الفني", technology: "التقنية", engineering: "الهندسة", production: "الإنتاج", manufacturing: "التصنيع", quality: "الجودة", "supply chain": "سلاسل الإمداد", logistics: "اللوجستيات",
  "business development": "تطوير الأعمال", commercial: "التجارية", maintenance: "الصيانة", "customer service": "خدمة العملاء", administration: "الإدارة", administrative: "الإدارية", admin: "الإدارة", legal: "الشؤون القانونية", contracts: "العقود", planning: "التخطيط", construction: "الإنشاءات",
  electrical: "الكهرباء", mechanical: "الميكانيكا", "health and safety": "السلامة والصحة المهنية", safety: "السلامة", "research and development": "البحث والتطوير", "r&d": "البحث والتطوير", exports: "التصدير", export: "التصدير", "tenders": "العطاءات", "general": "العام", "regional": "الإقليمي",
};

const ROLES_OF_FIELD: ReadonlyArray<readonly [RegExp, (field: string) => string]> = [
  [/^(?:head of|head)\s+(.+)$/, (f) => `رئيس ${f.startsWith("ال") ? "قسم " : ""}${f}`],
  [/^director of\s+(.+)$/, (f) => `مدير ${f}`],
  [/^manager of\s+(.+)$/, (f) => `مدير ${f}`],
  [/^vice president of\s+(.+)$/, (f) => `نائب رئيس ${f}`],
  [/^vp of\s+(.+)$/, (f) => `نائب رئيس ${f}`],
  [/^(.+?)\s+director$/, (f) => `مدير ${f}`],
  [/^(.+?)\s+manager$/, (f) => `مدير ${f}`],
  [/^(.+?)\s+engineer$/, (f) => `مهندس ${f}`],
  [/^(.+?)\s+officer$/, (f) => `مسؤول ${f}`],
  [/^(.+?)\s+specialist$/, (f) => `أخصائي ${f}`],
  [/^(.+?)\s+supervisor$/, (f) => `مشرف ${f}`],
  [/^(.+?)\s+coordinator$/, (f) => `منسق ${f}`],
  [/^(.+?)\s+executive$/, (f) => `مسؤول ${f}`],
  [/^(.+?)\s+head$/, (f) => `رئيس ${f}`],
];
const PREFIX: ReadonlyArray<readonly [RegExp, string]> = [[/^senior\s+/, "كبير "], [/^assistant\s+(?!general)/, "مساعد "], [/^deputy\s+/, "نائب "], [/^junior\s+/, "مبتدئ "], [/^executive\s+/, ""], [/^regional\s+/, ""]];
/** A roman or Arabic numeral level at the end («Engineer II», «Engineer 2») does not change the translation. */
const LEVEL_SUFFIX = /\s+(?:i{1,3}|iv|v|\d)$/;

/** The Arabic of one title part (no «&», no «/»), or null when the table cannot read it. */
function translatePart(raw: string): string | null {
  let t = clean(raw).replace(LEVEL_SUFFIX, "");
  if (!t) return null;
  if (TITLES[t]) return TITLES[t];
  let lead = "";
  for (const [re, ar] of PREFIX) { if (re.test(t)) { lead = ar; t = t.replace(re, ""); break; } }
  if (TITLES[t]) return `${lead}${TITLES[t]}`.trim();
  for (const [re, make] of ROLES_OF_FIELD) {
    const m = re.exec(t);
    if (!m) continue;
    const field = FIELDS[m[1].trim()];
    if (field) return `${lead}${make(field)}`.trim();
  }
  return null;
}

/** The Arabic of a job title, or null: a title that is already Arabic, empty, or that the table cannot read has none. Several roles in one title («Founder & CEO», «CEO / Chairman», «Founder | Managing Director») are joined with «و». */
export function titleArabic(title: unknown): string | null {
  const raw = typeof title === "string" ? title.replace(/[​-‏‪-‮﻿]/g, "").trim() : "";
  if (!raw || hasArabic(raw) || !hasLatin(raw)) return null;
  const parts = raw.split(/\s*(?:&|\/|\||\band\b|,|;| - | – )\s*/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const out: string[] = [];
  for (const p of parts) { const ar = translatePart(p); if (ar === null) return null; if (!out.includes(ar)) out.push(ar); }
  return out.join(" و");
}

/** The cell of a job title: «العربية (English)» when the table reads it, else the title as the source gave it (an Arabic title is not touched; nothing is invented). */
export function bilingualTitle(title: unknown): string {
  const raw = typeof title === "string" ? title.trim() : title === null || title === undefined ? "" : String(title).trim();
  const ar = titleArabic(raw);
  return ar === null ? raw : `${ar} (${raw})`;
}

/** The cell of a person's name: «العربية (English)» when an Arabic spelling is known, else the name as the source gave it. A name already in Arabic is kept. */
export function bilingualName(name: unknown, arabic: unknown): string {
  const raw = typeof name === "string" ? name.trim() : name === null || name === undefined ? "" : String(name).trim();
  const ar = typeof arabic === "string" ? arabic.trim() : "";
  if (!raw || hasArabic(raw) || ar === "" || !hasArabic(ar)) return raw;
  return `${ar} (${raw})`;
}
