import { checkCustomerText } from "@/lib/agentMission/text";
import { CUSTOMER_MESSAGE_LIMITS, customerGreetingName, type CustomerMessage } from "@/lib/customerMessage";

/**
 * THE TEXT RULES OF AN ADMIN MESSAGE TO CUSTOMERS (DT-20261118-06 phases 2A/2B). Pure; used by the server (the test send, later the campaign send) and by the composer (the same answer
 * on both sides). The customer-text guard (`checkCustomerText`, never edited here) runs on every field the customer reads: Arabic only, no Latin word, no provider name, no dollars,
 * no internal id, no «صف/سجل». The button's page path is a site path, not text, so it is not checked here (`validateCustomerMessage` checks it).
 */

/** The merge field «إدراج الاسم» puts in the text; the server replaces it with each customer's greeting name (never sent to the model). */
export const NAME_FIELD = "{الاسم}";

/** The message with the merge field replaced by this customer's greeting name («عزيزنا العميل» when there is none). */
export function withCustomerName(m: CustomerMessage, name: string | null | undefined): CustomerMessage {
  const greet = customerGreetingName(name);
  const put = (s: string | undefined): string | undefined => (s === undefined ? undefined : s.split(NAME_FIELD).join(greet));
  return { ...m, subject: put(m.subject)!, heading: put(m.heading)!, body: put(m.body)!, ...(m.badge !== undefined ? { badge: put(m.badge) } : {}), ...(m.ctaLabel !== undefined ? { ctaLabel: put(m.ctaLabel) } : {}) };
}

export type MessageField = "subject" | "badge" | "heading" | "body" | "ctaLabel";
const FIELDS: ReadonlyArray<MessageField> = ["subject", "badge", "heading", "body", "ctaLabel"];

/** The fields the customer-text guard refuses, with its reasons (empty: the text may go to a customer). The merge field is read as the fallback greeting. */
export function customerTextIssues(m: CustomerMessage): Array<{ field: MessageField; issues: string[] }> {
  const named = withCustomerName(m, null);
  const out: Array<{ field: MessageField; issues: string[] }> = [];
  for (const field of FIELDS) {
    const value = named[field];
    if (value === undefined || value.trim() === "") continue; // an empty optional field; the required ones are checked by validateCustomerMessage
    const check = checkCustomerText(value, { maxChars: CUSTOMER_MESSAGE_LIMITS[field].max });
    if (check.issues.length > 0) out.push({ field, issues: check.issues });
  }
  return out;
}

/** The sentence the admin reads when the guard refuses a text. */
export const CUSTOMER_TEXT_REFUSED_AR = "الرسالة تحتوي على ما لا يصلح للعميل (أحرف لاتينية أو أسماء مزودين أو أرقام داخلية). عدّلها ثم أعد المحاولة.";

/** A short stable fingerprint of exactly what the customer would read (FNV-1a, 32 bit, hex): a test send is valid only for this text; any edit changes it. Not a security hash. */
export function messageContentHash(m: CustomerMessage): string {
  const s = JSON.stringify([m.subject, m.badge ?? "", m.heading, m.body, m.ctaLabel ?? "", m.ctaPath ?? ""]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
