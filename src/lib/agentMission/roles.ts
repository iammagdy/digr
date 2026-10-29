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
  { key: "manager", nounStems: ["مدير", "مسؤول", "مسئول", "رئيس", "قيادي", "manager", "director"], pluralAr: "مديرون", words: ["manager", "managers", "director", "directors", "head", "chief", "ceo", "coo", "cfo", "cto", "cmo", "cio", "president", "vp", "gm", "مدير", "مديرة", "مديرين", "رئيس", "رئيسة", "مسؤول", "مسئول", "مدير عام"], phrases: ["vice president", "general manager", "managing director", "team lead", "head of", "chief executive", "chief operating", "chief financial"] },
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
  if (words.some((w) => def.words.some((d) => normalizeText(d) === w))) return "match";
  if (GENERIC_TITLES.has(norm) || words.every((w) => GENERIC_TITLES.has(w))) return "unclear";
  return "other";
}

const TITLE_FIELD = /^(?:job_?title|jobtitle|title|position|role|designation|headline|job|occupation|المسمى(?:_الوظيفي)?|الوظيفة)$/i;

/** The field of a mapped person row that holds the job title: a known name, else a key that contains one. Null when the row has none (the people then come as the source gives them). */
export function titleFieldOf(row: Record<string, unknown>): string | null {
  const keys = Object.keys(row);
  return keys.find((k) => TITLE_FIELD.test(k)) ?? keys.find((k) => /title|position|role|مسمى|وظيف/i.test(k) && typeof row[k] === "string") ?? null;
}

/** The rows of one page of a company's people, best match first (stable inside each group: the source's order is kept). Rows are returned untouched; a page with no title field comes back as it is. */
export function rankPeopleByRole<T extends Record<string, unknown>>(rows: ReadonlyArray<T>, role: RoleKey): { rows: T[]; matching: number } {
  const field = rows.map(titleFieldOf).find((f) => f !== null) ?? null;
  if (field === null) return { rows: [...rows], matching: 0 };
  const order: Record<TitleVerdict, number> = { match: 0, unclear: 1, other: 2 };
  const scored = rows.map((row, i) => ({ row, i, v: titleRoleVerdict(row[field], role) }));
  scored.sort((a, b) => order[a.v] - order[b.v] || a.i - b.i);
  return { rows: scored.map((s) => s.row), matching: scored.filter((s) => s.v === "match").length };
}

/** The one line the card shows for a people stage that prefers a role: what is preferred, and that when fewer match the count is completed from the company's other people, with the titles exactly as the source gives them. No number, no provider. */
export const roleLineAr = (role: RoleKey, parentNounSingularAr: string): string => {
  const def = roleDefOf(role);
  return `نفضّل في كل ${parentNounSingularAr} من تدل مسمياتهم الوظيفية على أنهم ${def ? def.pluralAr : "المطلوبون"}؛ وإن لم يذكر المصدر عددًا كافيًا منهم يكتمل العدد من بقية موظفي ${parentNounSingularAr === "شركة" ? "الشركة" : `ال${parentNounSingularAr}`} بمسمياتهم كما ذكرها المصدر، ولا نضيف أي مسمى لم يذكره.`;
};
