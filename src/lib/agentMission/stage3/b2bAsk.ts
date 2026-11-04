import { normalizeDigits, toArabicDigits } from "../../arabicDigits";
import { NUMBER_WORDS_SRC, numberOfToken } from "../arabicNumberWords";
import { sectorWordsOf } from "../entities";
import { countryOfRequestText } from "../places";
import { budgetOfWords } from "../foundation/countChoice";

/**
 * STAGE 3, THE ASK OF A COMPANIES / DECISION-MAKERS REQUEST (docs/STAGE-3.md, FOUNDATION-PLAN PR 5). The same idea as the social Ask (F1, `foundation/ask.ts`), in a NEW type: built ONCE by
 * code from the customer's words, read by everything the B2B compiler does. A value code cannot read stays null; nothing here guesses and nothing here filters. A condition the request names
 * (a size, a founding year) is kept as a CONDITION: the compiler sends it to a tool that can carry it, or writes it as a mark column (never a filter, never a silent drop). Pure.
 */
export type B2BKind = "companies" | "companies_people" | "people";
export type B2BCondition =
  | { kind: "size_min"; value: number }
  | { kind: "size_max"; value: number }
  | { kind: "founded_after"; value: number }
  | { kind: "founded_before"; value: number };

export interface B2BAsk {
  kind: B2BKind;
  /** The number of companies, or null when the words give none. */
  companies: number | null;
  /** The number of people for each company («٣ مديرين من كل شركة»), or null. */
  peoplePerCompany: number | null;
  /** A people request with no companies named: the number of people. */
  people: number | null;
  /** The sector words, as the customer wrote them (entities.ts `sectorWordsOf`). */
  sector: string[];
  /** ISO code of the country named or implied by a nationality word («شركات مصرية» → EG). */
  country: string | null;
  /** The people asked: decision makers (the owner's default for «صناع القرار», «مدير», «المسؤول»). */
  roles: "decision_makers" | null;
  /** The contact columns: the company's general e-mail and HQ phone are always asked for a companies request (the owner's priority); a person's e-mail and mobile for people. */
  fields: { companyEmail: boolean; hqPhone: boolean; personEmail: boolean; personMobile: boolean };
  conditions: B2BCondition[];
  /** A budget in points said in the words (a hard ceiling on the hold, as for social). */
  budget: number | null;
}

const NUM = `(\\d+|${NUMBER_WORDS_SRC})`;
const num = (token: string | undefined): number | null => {
  if (token === undefined) return null;
  const n = /^\d+$/.test(token) ? Number(token) : numberOfToken(token);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
};
const COMPANY_WORD = /شرك/;
const COMPANIES_COUNT = new RegExp(`${NUM}\\s*(?:شركات|شركة|شركه)(?![ء-ي])`);
const COMPANIES_DUAL = /(?:^|\s)(?:شركتين|شركتان)(?:\s|$|[،,.])/;
const ROLE_WORDS = /صناع?\s*(?:ال)?قرار|صانع\s*(?:ال)?قرار|(?:^|\s|و)(?:ال)?(?:مدير|مديرين|مدراء|مديري)(?:\s|$|[،,.])|(?:ال)?مسؤول|الإدارة العليا|الادارة العليا|التنفيذيين/;
const PER_COMPANY = new RegExp(`${NUM}\\s*(?:[^\\s،,.]+\\s+){0,2}?(?:(?:من|في|على)\\s+كل|لكل)\\s+(?:شركة|شركه)`);
const PEOPLE_COUNT = new RegExp(`${NUM}\\s*(?:مديرين|مدراء|مدير|صناع\\s+قرار|صانع\\s+قرار|مسؤولين|مسؤول|أشخاص|اشخاص|شخص)(?![ء-ي])`);
const SIZE_MIN = /(?:(?:عدد\s+موظفيها|موظفيها)\s+(?:أكثر|اكثر|فوق)\s+(?:من\s+)?(\d+)|(?:أكثر|اكثر|فوق)\s+(?:من\s+)?(\d+)\s*(?:موظف|موظفين))/;
const SIZE_MAX = /(?:(?:عدد\s+موظفيها|موظفيها)\s+(?:أقل|اقل)\s+من\s+(\d+)|(?:أقل|اقل)\s+من\s+(\d+)\s*(?:موظف|موظفين))/;
const FOUNDED_AFTER = /و?(?:تأسست|تاسست|مؤسسة|تأسيسها)\s+(?:من\s+)?بعد\s+(?:سنة\s+|عام\s+)?(\d{4})/;
const FOUNDED_BEFORE = /و?(?:تأسست|تاسست|مؤسسة|تأسيسها)\s+قبل\s+(?:سنة\s+|عام\s+)?(\d{4})/;

/** The B2B Ask of a request, or null when the request is not about companies or decision makers. */
export function buildB2BAsk(request: unknown): B2BAsk | null {
  const text = normalizeDigits(String(request ?? "")).replace(/\s+/g, " ").trim();
  if (!text) return null;
  const hasCompanies = COMPANY_WORD.test(text);
  const hasRoles = ROLE_WORDS.test(text);
  if (!hasCompanies && !hasRoles) return null;
  // the conditions first; their numbers are then taken out so a «٢٠٠ موظف» is never read as a number of people
  const conditions: B2BCondition[] = [];
  let rest = text;
  const take = (rx: RegExp, kind: B2BCondition["kind"]): void => {
    const m = rx.exec(rest);
    if (!m) return;
    const v = Number(m[1] ?? m[2]);
    if (Number.isInteger(v) && v > 0) conditions.push({ kind, value: v } as B2BCondition);
    rest = rest.replace(m[0], " ");
  };
  take(SIZE_MIN, "size_min");
  take(SIZE_MAX, "size_max");
  take(FOUNDED_AFTER, "founded_after");
  take(FOUNDED_BEFORE, "founded_before");
  const kind: B2BKind = hasCompanies ? (hasRoles ? "companies_people" : "companies") : "people";
  const perCompany = kind === "companies_people" ? num(PER_COMPANY.exec(rest)?.[1]) : null;
  const restNoPer = perCompany !== null ? rest.replace(PER_COMPANY, " ") : rest;
  const companies = kind === "people" ? null : num(COMPANIES_COUNT.exec(restNoPer)?.[1]) ?? (COMPANIES_DUAL.test(restNoPer) ? 2 : null);
  const people = kind === "people" ? num(PEOPLE_COUNT.exec(rest)?.[1]) : null;
  const withPeople = kind !== "companies";
  return {
    kind,
    companies,
    peoplePerCompany: perCompany,
    people,
    sector: sectorWordsOf(text),
    country: countryOfRequestText(text),
    roles: hasRoles ? "decision_makers" : null,
    fields: { companyEmail: kind !== "people", hqPhone: kind !== "people", personEmail: withPeople, personMobile: withPeople },
    conditions,
    budget: budgetOfWords(String(request ?? "")),
  };
}

/** A condition's words for the card and the mark column («عدد الموظفين أكثر من ٥٠»). Years are written without a thousands mark. */
export function b2bConditionLabelAr(c: B2BCondition): string {
  switch (c.kind) {
    case "size_min": return `عدد الموظفين أكثر من ${toArabicDigits(c.value)}`;
    case "size_max": return `عدد الموظفين أقل من ${toArabicDigits(c.value)}`;
    case "founded_after": return `تأسست بعد ${toArabicDigits(c.value)}`;
    case "founded_before": return `تأسست قبل ${toArabicDigits(c.value)}`;
  }
}
