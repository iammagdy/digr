import { isPersonalMailDomain, isPlausibleEmail, normalizePhone } from "../multiProvider/policy";
import { categoryOf } from "../treg/dataPolicy";
import { CONTACT_PARSER_IDS } from "./sources";

/**
 * CONTACT FIELDS, by code. A mission that promises work e-mails or phones delivers VERIFIED values only: a value that does not pass the check below is left EMPTY, and a row of a contact stage with no
 * verified value is not saved at all (so it is neither delivered nor charged). The check is the same one the multi-provider chain applies (src/lib/multiProvider/policy.ts): a plausible address on a
 * company domain (never a gmail / outlook box, never a placeholder), a phone with 7 to 15 digits that is not a repeated digit.
 */
export type ContactKind = "work_email" | "phone";
export const CONTACT_KINDS: readonly ContactKind[] = ["work_email", "phone"];

const EMAIL_WORDS = /(?:e-?mail|mail|بريد|ايميل|إيميل|اميل|إميل|ميل)/i;
const PHONE_WORDS = /(?:phone|mobile|tel\b|whats?app|هاتف|تليفون|تلفون|موبايل|جوال|محمول|واتس|رقم(?:\s+(?:تليفون|هاتف|موبايل|جوال))|أرقام|ارقام)/i;

/** What the customer's words ask for: work e-mails and/or phones. */
export function requestWantsContacts(text: unknown): { email: boolean; phone: boolean } {
  const t = String(text ?? "");
  return { email: EMAIL_WORDS.test(t), phone: PHONE_WORDS.test(t) };
}

/** The verified form of a contact value, or null when it does not pass (the caller leaves the field empty). */
export function verifyContactValue(kind: ContactKind, raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (kind === "work_email") {
    const email = value.replace(/^mailto:/i, "").split("?")[0].replace(/[),.;:]+$/, "").toLowerCase();
    if (!/^[^\s@]{1,64}@[^\s@]+\.[a-z]{2,24}$/.test(email) || !isPlausibleEmail(email)) return null;
    return isPersonalMailDomain(email.split("@")[1]) ? null : email;
  }
  return normalizePhone(value);
}

/** A source whose rows ARE contacts: a catalog endpoint of the b2b_contact category, or the Context.dev e-mail / phone parser of one page. */
export function isContactSource(endpointId: string): boolean {
  return CONTACT_PARSER_IDS.has(endpointId) || categoryOf(endpointId) === "b2b_contact";
}
