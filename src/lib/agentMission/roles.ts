import { countAr, knownItemNoun } from "./itemNoun";
import { normalizeText } from "./relevance";

/**
 * THE ROLE A CUSTOMER ASKED FOR AMONG THE PEOPLE OF A COMPANY («ومن كل شركة اتنين من المديرين»). A people source lists the employees of a company; it cannot pick the managers. When the source gives a job title, CODE ranks the people of each
 * company by it: a title that names the role first, a title it cannot read («موظف», empty, «consultant») next, a title of another role last, and the customer's count is taken from the top of that order. Nothing here invents a title or a person:
 * a company whose page holds fewer matching people delivers what the source has, and the card says so in one line. Pure: no I/O, no model (a title the table cannot read stays «unclear»; it is never guessed).
 */
export type RoleKey = "manager" | "engineer" | "sales" | "hr" | "accountant";
export type TitleVerdict = "match" | "unclear" | "other";

interface RoleDef {
  key: RoleKey;
  /** Stems of the noun the customer writes («مدير», «مديرين», «المديرين», «مسؤول»), compared after normalisation. */
  nounStems: string[];
  /** The plural as a subject, for the card's sentence. */
  pluralAr: string;
  /** Title words (Arabic and Latin, lower case) that name the role. */
  words: string[];
  /** Phrases (several words) that name the role. */
  phrases?: string[];
}

const ROLES: ReadonlyArray<RoleDef> = [
  // the DECISION MAKERS («صناع القرار») are this role: the owner, the founders, the chairman, the chiefs, the general manager, the directors, the managers and the heads
  { key: "manager", nounStems: ["مدير", "مدرا", "مسؤول", "مسئول", "رئيس", "قيادي", "صناع", "صانع", "manager", "director", "decision"], pluralAr: "مديرون", words: ["manager", "managers", "director", "directors", "head", "chief", "ceo", "coo", "cfo", "cto", "cmo", "cio", "president", "vp", "gm", "owner", "owners", "founder", "founders", "cofounder", "co-founder", "chairman", "chairwoman", "مدير", "مديرة", "مديرين", "رئيس", "رئيسة", "مسؤول", "مسئول", "مدير عام", "مالك", "مالكة", "صاحب", "صاحبة", "مؤسس", "مؤسسة"], phrases: ["vice president", "general manager", "managing director", "team lead", "head of", "chief executive", "chief operating", "chief financial"] },
  { key: "engineer", nounStems: ["مهندس", "engineer"], pluralAr: "مهندسون", words: ["engineer", "engineers", "engineering", "مهندس", "مهندسة", "مهندسين"] },
  { key: "sales", nounStems: ["مبيع", "مندوب", "sales"], pluralAr: "مسؤولو مبيعات", words: ["sales", "salesman", "salesperson", "مبيعات", "مندوب", "business development"] },
  { key: "hr", nounStems: ["موارد", "hr"], pluralAr: "مسؤولو موارد بشرية", words: ["hr", "recruiter", "recruitment", "talent", "موارد", "توظيف"], phrases: ["human resources"] },
  { key: "accountant", nounStems: ["محاسب", "accountant"], pluralAr: "محاسبون", words: ["accountant", "accounting", "finance", "financial", "محاسب", "محاسبة", "حسابات"] },
];

/** Titles that do not say what the person does (a person of such a title may or may not hold the role): unclear, never «other». */
const GENERIC_TITLES = new Set(["employee", "staff", "member", "team member", "consultant", "associate", "specialist", "executive", "partner", "founder", "co-founder", "cofounder", "owner", "co-owner", "موظف", "موظفة", "عضو", "مستشار", "شريك", "مؤسس", "مالك", "اخصائي", "أخصائي"]);

const wordsOf = (text: string): string[] => normalizeText(text).replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean);

/** The role a per-parent noun («المديرين», «مدير», «مهندسين») asks for, or null when the table does not know it (no ranking then: the people come as the source gives them). */
export function roleOfNoun(noun: string | null | undefined): RoleDef | null {
  const w = normalizeText(String(noun ?? "")).replace(/^(?:لل|ال)(?=.{2,})/, "");
  if (!w) return null;
  return ROLES.find((r) => r.nounStems.some((s) => w.startsWith(normalizeText(s)))) ?? null;
}

export const roleDefOf = (key: string | null | undefined): RoleDef | null => ROLES.find((r) => r.key === key) ?? null;

/** Does this job title name the role? `unclear` for an empty or generic title, `other` for a title that names something else. */
export function titleRoleVerdict(title: unknown, role: RoleKey): TitleVerdict {
  const def = roleDefOf(role);
  const text = typeof title === "string" ? title.trim() : "";
  if (!def || !text) return "unclear";
  const norm = normalizeText(text);
  const words = wordsOf(text);
  if (def.phrases?.some((p) => norm.includes(normalizeText(p)))) return "match";
  // a word is compared as written and without the Arabic definite article («المدير» is «مدير»)
  if (words.some((w) => def.words.some((d) => normalizeText(d) === w || normalizeText(d) === w.replace(/^ال(?=.{2,})/, "")))) return "match";
  if (GENERIC_TITLES.has(norm) || words.every((w) => GENERIC_TITLES.has(w))) return "unclear";
  return "other";
}

const TITLE_FIELD = /^(?:job_?title|jobtitle|title|position|role|designation|headline|job|occupation|المسمى(?:_الوظيفي)?|الوظيفة)$/i;

/** The field of a mapped person row that holds the job title: a known name, else a key that contains one. Null when the row has none (the people then come as the source gives them). */
export function titleFieldOf(row: Record<string, unknown>): string | null {
  const keys = Object.keys(row);
  return keys.find((k) => TITLE_FIELD.test(k)) ?? keys.find((k) => /title|position|role|مسمى|وظيف/i.test(k) && typeof row[k] === "string") ?? null;
}

/**
 * DECISION MAKERS ARE NEVER LEFT BEHIND BY THE LOWEST TITLES (live 2026-11-01: a «عامل» and a «محاسب» delivered when the page held nothing better in the ranking's eyes: «unclear» and «other» were one group in the page's order). For the decision makers' role the verdict gets a fourth
 * tier: 0 = a title that names the role (manager, director, head, chief, owner), 1 = a title the table cannot read, 2 = a title of another role, 3 = the lowest titles (worker, accountant, intern, trainee, junior, driver, receptionist...). A «junior» or an «intern» is tier 3 even
 * when the title says «manager». For every other role the tiers are the old three-way verdict (0, 1, 2).
 */
const LOW_WORDS: ReadonlySet<string> = new Set([
  "worker", "workers", "labor", "labour", "laborer", "labourer", "helper", "driver", "chauffeur", "receptionist", "cleaner", "clerk", "accountant", "accountants", "bookkeeper", "intern", "interns", "internship", "trainee", "trainees", "apprentice", "junior", "jr", "student", "graduate",
  "عامل", "عمال", "عاملة", "محاسب", "محاسبة", "محاسبين", "متدرب", "متدربة", "تدريب", "مبتدئ", "سائق", "سكرتير", "سكرتيرة", "ريسيبشن", "مساعد اداري", "طالب", "حديث التخرج",
].map((w) => normalizeText(w)));
const DISQUALIFIERS: ReadonlySet<string> = new Set(["junior", "jr", "intern", "interns", "internship", "trainee", "trainees", "apprentice", "student", "متدرب", "متدربة", "تدريب", "مبتدئ", "طالب"].map((w) => normalizeText(w)));
export type TitleTier = 0 | 1 | 2 | 3;

export function titleTierOf(title: unknown, role: RoleKey): TitleTier {
  const text = typeof title === "string" ? title.trim() : "";
  const verdict = titleRoleVerdict(title, role);
  if (role !== "manager" || !text) return verdict === "match" ? 0 : verdict === "unclear" ? 1 : 2;
  const words = wordsOf(text).map((w) => w.replace(/^ال(?=.{2,})/, ""));
  if (words.some((w) => DISQUALIFIERS.has(w))) return 3;
  if (verdict === "match") return 0;
  if (words.some((w) => LOW_WORDS.has(w)) || LOW_WORDS.has(normalizeText(text))) return 3;
  return verdict === "unclear" ? 1 : 2;
}

/** The rows of one page of a company's people, best match first (stable inside each tier: the source's order is kept). Rows are returned untouched; a page with no title field comes back as it is. */
export function rankPeopleByRole<T extends Record<string, unknown>>(rows: ReadonlyArray<T>, role: RoleKey): { rows: T[]; matching: number } {
  const field = rows.map(titleFieldOf).find((f) => f !== null) ?? null;
  if (field === null) return { rows: [...rows], matching: 0 };
  const scored = rows.map((row, i) => ({ row, i, t: titleTierOf(row[field], role) }));
  scored.sort((a, b) => a.t - b.t || a.i - b.i);
  return { rows: scored.map((s) => s.row), matching: scored.filter((s) => s.t === 0).length };
}

/**
 * THE LIMITS SENTENCE FOR DECISION MAKERS NOT FOUND: from the delivered people's job titles (a person with no title is not judged), how many are not decision makers and in how many companies, so a file that holds a «consultant» or an engineer where a manager was asked for says it.
 * Null when every person with a known title is a decision maker (or no title is known). Only for the decision makers' role; Arabic-Indic digits, no provider.
 */
export function decisionMakersLeftOutAr(people: ReadonlyArray<Record<string, unknown>>, role: RoleKey): string | null {
  if (role !== "manager") return null;
  let notDm = 0;
  const companies = new Set<string>();
  for (const p of people) {
    const field = titleFieldOf(p);
    const title = field ? String(p[field] ?? "").trim() : "";
    if (!title) continue;
    if (titleTierOf(title, role) > 0) { notDm += 1; companies.add(String(p.parent_id ?? "")); }
  }
  if (notDm === 0) return null;
  const person = knownItemNoun("شخص");
  const company = knownItemNoun("شركة");
  if (!person || !company) return null;
  return `لم يوجد في المصدر عدد كافٍ من صناع القرار في ${countAr(companies.size, company)}، فاكتمل العدد بـ${countAr(notDm, person)} من غيرهم بأقرب المسميات الوظيفية المتاحة`;
}

/** The one line the card shows for a people stage that prefers a role: what is preferred, and that when fewer match the count is completed from the company's other people, with the titles exactly as the source gives them. No number, no provider. */
export const roleLineAr = (role: RoleKey, parentNounSingularAr: string): string => {
  const def = roleDefOf(role);
  return `نفضّل في كل ${parentNounSingularAr} من تدل مسمياتهم الوظيفية على أنهم ${def ? def.pluralAr : "المطلوبون"}؛ وإن لم يذكر المصدر عددًا كافيًا منهم يكتمل العدد من بقية موظفي ${parentNounSingularAr === "شركة" ? "الشركة" : `ال${parentNounSingularAr}`} بمسمياتهم كما ذكرها المصدر، ولا نضيف أي مسمى لم يذكره.`;
};

/**
 * THE TITLE OF A PEOPLE STAGE DOES NOT PROMISE A ROLE THE STAGE DOES NOT FILTER. The customer's «اتنين من المديرين» only RANKS the people of each company by the job title the source gives (never excludes: when fewer match, the count is completed from
 * the company's other people), so a stage title such as «موظفو الإدارة في كل شركة» (the live sheet, which held an accountant and a water-plant operator) would promise what the file does not hold. A title that names the role (or «الإدارة») is replaced by the
 * plain one, «موظفو كل شركة»; the card's own line says the matching titles come first. A title that names no role is kept as it is.
 */
const ADMIN_STEM = ["ادار", "اداري"];
export function neutralPeopleTitleAr(title: string, role: RoleKey, parentNounSingularAr: string): string {
  const def = roleDefOf(role);
  const n = normalizeText(title);
  const claims = [...(def?.nounStems ?? []).filter((x) => /[\u0600-\u06ff]/.test(x)), ...(role === "manager" ? ADMIN_STEM : [])].map((x) => normalizeText(x));
  if (!claims.some((c) => n.includes(c))) return title;
  return `موظفو كل ${parentNounSingularAr || "عنصر"}`;
}
