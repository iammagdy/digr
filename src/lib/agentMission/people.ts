import { isPeopleNoun } from "./childSources";
import { normalizeText } from "./relevance";

/**
 * A PERSON ROW MUST BE A PERSON. Live retest 2026-10-31 (A1 «٥ شركات كهروميكانيكا + صناع القرار»): the people sheet held 9 rows, 8 with no name and all 9 with no job title, most of them role mailboxes (info@, customer_care@, totaline@, webmaster@, cs@,
 * em.sales@); they were counted as delivered decision makers and charged (A2: «Petro Consultants», petro.consultants@..., counted as a person). A people source answers with what it has; a mailbox lister answers with mailboxes.
 *
 * By CODE, from the row itself (never the model): a row of a people stage is a person when it carries a person's NAME and its e-mail, if it has one, is not a role or generic mailbox. Anything else is a company e-mail: it is kept (with its address)
 * for the company's own sheet, it is not a decision maker, it is not counted and it is not charged. No title is required (a source may not give one; the card says titles come as the source gives them), no provider is named, nothing is invented.
 */
export type PersonVerdict = { person: true } | { person: false; reason: "no_name" | "role_mailbox" | "organisation_name" };

/** The mailbox names that name a ROLE or a department, not a person. */
const ROLE_WORDS: ReadonlySet<string> = new Set([
  "info", "information", "sales", "cs", "support", "help", "helpdesk", "webmaster", "postmaster", "hostmaster", "customercare", "customerservice", "customersupport", "care", "service", "services", "hr", "humanresources", "recruitment", "recruiting",
  "careers", "career", "jobs", "job", "hiring", "contact", "contactus", "admin", "administrator", "administration", "office", "hello", "hi", "enquiries", "enquiry", "inquiries", "inquiry", "marketing", "press", "media", "pr", "mail", "email", "noreply",
  "donotreply", "billing", "accounts", "accounting", "finance", "procurement", "purchasing", "purchase", "orders", "order", "reception", "general", "team", "feedback", "tender", "tenders", "export", "exports", "commercial", "complaints", "secretary",
  "ceo", "md", "gm", "chairman", "director", "manager", "management", "booking", "reservations", "security", "legal", "compliance", "newsletter", "abuse", "privacy", "ops", "operations", "logistics", "dispatch", "projects", "shop", "store",
]);
/** Words that may stand beside a role word in a mailbox («sales.egypt») without making it a person's. */
const PLACE_WORDS: ReadonlySet<string> = new Set(["egypt", "eg", "cairo", "alex", "alexandria", "giza", "ksa", "uae", "gulf", "global", "main", "head", "local", "group", "int", "international", "new", "the"]);
/** Words that, anywhere in a mailbox, name an ORGANISATION and not a person («petro.consultants»). */
const ORGANISATION_TOKENS: ReadonlySet<string> = new Set(["team", "group", "consultants", "consultancy", "company", "department", "dept", "helpdesk", "desk", "enquiries", "inquiries"]);

/** The tokens of a mailbox's local part: lower case, split on dots, dashes, underscores and plus, digits dropped («info2» is «info»). */
function localTokensOf(email: string): string[] {
  const local = email.trim().toLowerCase().split("@")[0] ?? "";
  return local.split(/[._\-+]+/).map((t) => t.replace(/\d+/g, "")).filter(Boolean);
}

/** True when the address names a role, a department or an organisation (info@, sales@, customer_care@, noreply@, petro.consultants@), not a person. */
export function isRoleMailbox(email: unknown): boolean {
  const text = String(email ?? "").trim();
  if (!text.includes("@")) return false;
  const tokens = localTokensOf(text);
  if (tokens.length === 0) return false;
  if (ROLE_WORDS.has(tokens.join(""))) return true;
  if (tokens.some((t) => ORGANISATION_TOKENS.has(t))) return true;
  return tokens.every((t) => ROLE_WORDS.has(t) || PLACE_WORDS.has(t)) && tokens.some((t) => ROLE_WORDS.has(t));
}

/** Words that name a department or an organisation when they appear in what is written in a NAME cell («Sales Team», «Customer Care», «قسم المبيعات»), compared after normalisation. */
const ORGANISATION_NAME_WORDS: ReadonlySet<string> = new Set([
  "team", "department", "dept", "support", "service", "services", "office", "group", "ltd", "llc", "inc", "co", "corp", "corporation", "company", "consultants", "consultancy", "solutions", "systems", "industries", "trading", "enterprises", "holding",
  "helpdesk", "desk", "sales", "marketing", "hr", "info", "admin", "administrator", "webmaster", "contact", "customer", "care", "reception", "accounts", "procurement", "enquiries", "inquiries",
  ...["قسم", "فريق", "شركة", "مجموعة", "إدارة", "خدمة", "العملاء", "المبيعات", "الدعم", "مكتب", "الموارد", "البشرية", "المشتريات", "الحسابات", "التسويق", "الاستقبال"].map((w) => normalizeText(w)),
]);
const isOrganisationName = (name: string): boolean => normalizeText(name).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).some((w) => ORGANISATION_NAME_WORDS.has(w));
const hasLetters = (text: string): boolean => /\p{L}/u.test(text);

export interface PersonColumn { key: string; title_ar?: string; kind?: string }

const NAME_KEY = /^(?:name|full_?name|person_?name|contact_?name|employee_?name|first_?name|last_?name|given_?name|family_?name|fname|lname|الاسم|اسم)$/i;
const EMAIL_KEY = /(?:e-?mail|mail|بريد|ايميل|إيميل)/i;
const NAME_TITLE = /^(?:ال)?اسم(?:\s|$)|^الاسم/;
/** The columns that hold a person's NAME (not the company's), from their keys and titles. */
export const nameKeysOf = (columns: ReadonlyArray<PersonColumn>): string[] => columns.filter((c) => !/company|org|account|channel|page/i.test(c.key) && (NAME_KEY.test(c.key) || NAME_TITLE.test(String(c.title_ar ?? "").trim()) && !/شرك/.test(String(c.title_ar ?? "")))).map((c) => c.key);
const emailKeysOf = (columns: ReadonlyArray<PersonColumn>): string[] => columns.filter((c) => c.kind === "work_email" || EMAIL_KEY.test(c.key)).map((c) => c.key);

const textOf = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").replace(/[​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();

/** The e-mail addresses a row carries (in the columns that hold one), as written, lower case. */
export function mailboxesOf(row: Record<string, unknown>, columns: ReadonlyArray<PersonColumn>): string[] {
  return emailKeysOf(columns).map((k) => textOf(row[k]).toLowerCase()).filter((e) => e.includes("@"));
}

/**
 * Is this row (as the stage's mapping gave it) a person? A row with no name column is judged by its e-mail only (a role mailbox is not a person, any other address passes: the stage may be one whose rows carry no name by design).
 */
export function personVerdict(row: Record<string, unknown>, columns: ReadonlyArray<PersonColumn>): PersonVerdict {
  const nameKeys = nameKeysOf(columns);
  const name = nameKeys.map((k) => textOf(row[k])).filter(Boolean).join(" ").trim();
  if (nameKeys.length > 0 && !hasLetters(name)) return { person: false, reason: "no_name" };
  if (mailboxesOf(row, columns).some((e) => isRoleMailbox(e))) return { person: false, reason: "role_mailbox" };
  if (nameKeys.length > 0 && isOrganisationName(name)) return { person: false, reason: "organisation_name" };
  return { person: true };
}

/**
 * A REAL PERSON, WHATEVER CONTACT CELLS ARE FILLED: the row carries a person's NAME (a name column with letters, not an organisation's or a department's) and is not a role mailbox. Live re-test 2026-10-31 (A1, A2): the people source gave names, job
 * titles and professional pages but no e-mail and no phone, and every one of the 31 (A1) and 32 (A2) people was thrown away as «no verified contact» (ingest.ts). The owner's rule: verification decides whether an e-mail or phone CELL is filled, never
 * whether the PERSON row is delivered. A row with no name column at all is not judged a named person here (an e-mail finder's row is its address: with no verified address there is nothing to deliver).
 */
export function isNamedPerson(row: Record<string, unknown>, columns: ReadonlyArray<PersonColumn>): boolean {
  const keys = nameKeysOf(columns);
  if (keys.length === 0) return false;
  const name = keys.map((k) => textOf(row[k])).filter(Boolean).join(" ").trim();
  return hasLetters(name) && personVerdict(row, columns).person;
}

/** A stage whose items are the PEOPLE of the items of another stage: a stage with a parent whose title names people («مسؤولو الشركات», «موظفو كل شركة», «صناع القرار») or that prefers a role among them. */
export function isPeopleStage(stage: { parent_key: string | null; title_ar: string; role_preference?: unknown }): boolean {
  if (stage.parent_key === null) return false;
  if (stage.role_preference) return true;
  return String(stage.title_ar ?? "").replace(/[«»"،,.:؛]/g, " ").split(/\s+/).filter(Boolean).slice(0, 3).some((w) => isPeopleNoun(w));
}
