import { isPeopleNoun } from "./childSources";
import { perParentQuantities } from "./quantity";
import { normalizeText } from "./relevance";

/**
 * VERIFICATION DECIDES A CELL, NEVER A PERSON. Live re-test 2026-10-31 (A1 «٥ شركات كهروميكانيكا + صناع القرار», msn_1d3c…): the customer had already asked for the people (name, title, e-mail, phone); the planner stopped to ask «the e-mails and phones
 * that were verified appear for a limited number of people, how do you want me to continue?», the customer chose «الشركات مع المديرين وما يتوفر من تواصلهم», and the plan promised the e-mail and phone «only if they appear complete and the system verified them».
 * The engine then removed every person without a verified contact. The owner's rule: no strict filters; deliver what exists. A person is delivered with a name, a job title and a professional page; the e-mail and phone CELLS are filled only with a value
 * code verified and are left empty otherwise.
 *
 * Two pure checks, by code (never the model): a QUESTION about contact verification is refused when the request already asks for people (the planner decides and says so in assumptions_ar), and a plan SENTENCE that makes the people conditional on a
 * verified contact is refused.
 */

const CONTACT_WORD = /(?:ايميل|اميل|بريد|تليفون|تلفون|هاتف|موبايل|جوال|محمول|رقم|ارقام|تواصل|اتصال)/;
const VERIFY_WORD = /(?:تحقق|موثق|مؤكد|مؤكده|صحيح|متوفر|يتوفر|تتوفر|توفر|متاح|تظهر|يظهر|ظاهر|محدود|ناقص|مخفي|مخفيه|مفقود|غير\s+موجود)/;
const PERSON_WORD = /(?:مدير|مديرين|مسؤول|مسئول|اشخاص|شخص|اسماء|صناع\s+القرار|موظف|قياديين)/;
/** «فقط إذا», «لمن يتوفر», «الذين ظهر لهم», «نستبعد», «بشرط»: a condition on WHO is delivered. */
const CONDITION = /(?:(?:فقط|الا)\s+(?:اذا|لو|لمن|الذين|الاشخاص|المديرين|المسؤولين|من\s+(?:ي|ت)?(?:توفر|ظهر|تحقق|لديه|له))|لمن\s+(?:ي|ت)?(?:توفر|ظهر|تحقق|لديه|له|عنده)|الذين\s+(?:ي|ت)?(?:توفر|ظهر|تحقق|لديهم|لهم|عندهم)|بشرط|نستبعد|تستبعد|يستبعد|استبعاد|نحذف|نسقط)/;
/** The person is the SUBJECT of the sentence's condition, not the contact («الإيميل يُضاف فقط إذا تحقق»): a person word, then a condition, then a contact word, in that order. */
const PERSON_THEN_CONDITION_THEN_CONTACT = new RegExp(`${PERSON_WORD.source}[^.؛\\n]{0,60}?${CONDITION.source}[^.؛\\n]{0,60}?${CONTACT_WORD.source}|${CONDITION.source}[^.؛\\n]{0,40}?${PERSON_WORD.source}[^.؛\\n]{0,60}?${CONTACT_WORD.source}`);

/** True when the request itself asks for the people of the items (a people noun per parent, with or without a number): «ومعاهم صناع القرار», «ومن كل شركة اتنين من المديرين». */
export function requestAsksForPeople(request: unknown): boolean {
  return perParentQuantities(request).some((q) => isPeopleNoun(q.noun ?? "") || isPeopleNoun(q.of ?? ""));
}

/**
 * Null when the question may be asked; otherwise the sentence the planner is told. Refused when the people are asked for and the QUESTION is about contacts being verified, available, limited or missing. The people are asked for when the
 * REQUEST says so (a people noun per parent, read by words) OR when the planner UNDERSTOOD them (`people`: its structure, whatever the wording; DT-20261118-09 F1: «ومسؤولي الإدارة فيهم بأرقامهم الشخصية» has no word this file reads).
 * `people.gaveRows`: a people source of the catalog already gave named people in this planning; `people.sourceIds`: the catalog's people-of-company sources this account may buy, cheapest first. With no person in hand the
 * planner is told to call those sources (item 3 of the order), never to put «companies only or any employees?» to the customer.
 */
export interface UnderstoodPeopleFacts { gaveRows: boolean; /** A people source was tried and ANSWERED, with no person: that is measured, and the honest question to the customer is allowed (FIX1, Gate 2 P1-3). */ answeredEmpty?: boolean; sourceIds: ReadonlyArray<string> }
export function contactVerificationQuestionIssue(request: unknown, question: string, options: ReadonlyArray<string> = [], people?: UnderstoodPeopleFacts): string | null {
  if (!people && !requestAsksForPeople(request)) return null;
  const q = normalizeText(question);
  const all = normalizeText([question, ...options].join(" "));
  if (!(CONTACT_WORD.test(all) && VERIFY_WORD.test(q))) return null;
  // a people source answered and gave nobody: the question is the honest way on, it is not refused (the refusal is for «no source tried» and «every try failed»)
  if (people && !people.gaveRows && people.answeredEmpty === true) return null;
  if (people && !people.gaveRows) return `do not ask this: the customer already asked for the people, and no people source has given a person yet, so «not found» is not known. ${people.sourceIds.length > 0 ? `Call a people source of the catalog with a company you found, cheapest first: ${people.sourceIds.slice(0, 4).join(", ")}. ` : ""}An empty answer for one company is not an answer for the source: try the next company of your sample, then the next people source. Plan the people stage on a source that gave named people. If every people source failed or answered with no rows, end with finish (cannot_serve): code tells the customer the truth. Never ask the customer to choose between the companies alone and other employees`;
  return "do not ask this: the customer already asked for the people. Deliver every person the source gives, with the name, the job title and the professional page; an e-mail or a phone is filled only when code verified it and the cell is left empty otherwise (verification never decides whether a person is delivered). Decide, say it in one line of assumptions_ar (no number), and go on with the plan";
}

/** The sentences (summary, assumptions, notes) that make a PERSON conditional on a verified contact; empty when none does. A sentence that conditions only the e-mail or phone CELL is fine. */
export function peopleConditionedOnContactIssues(sentences: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const s of sentences) {
    const t = normalizeText(s);
    if (VERIFY_WORD.test(t) && PERSON_THEN_CONDITION_THEN_CONTACT.test(t)) out.push(`«${String(s).slice(0, 80)}» makes a person conditional on a verified e-mail or phone. A person is delivered with the name, the job title and the professional page whether or not a contact was verified; only the e-mail or phone CELL depends on verification (filled when verified, empty otherwise). Rewrite the sentence about the cells only`);
  }
  return out;
}

/** What the planner is told after the customer answered «what is available» to the question about contacts: the plan follows it. Null for any other answer. */
export function availableContactAnswerNote(answer: unknown): string | null {
  const t = normalizeText(answer);
  if (!t || !CONTACT_WORD.test(t) && !PERSON_WORD.test(t)) return null;
  if (!/(?:ما\s+(?:ي|ت)توفر|المتاح|المتوفر|ما\s+هو\s+متاح|ما\s+يظهر|ما\s+ظهر)/.test(t)) return null;
  return "The customer chose to receive the people with whatever contact is available: deliver every person the source gives (name, job title, professional page); the e-mail and phone cells are left empty when code could not verify a value; do not drop the people, do not leave out a person for lacking a contact, and do not write any sentence that makes a person conditional on a verified contact.";
}
