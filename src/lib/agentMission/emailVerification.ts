import { registrableDomain } from "./companyIdentity";

/**
 * E-MAIL STATUS, BACKED BY A REAL VERIFIER (live test A1, 2026-11-01: 4 e-mails marked «موثّق» and none of them had been through a verifier; one person had an address on ANOTHER company's domain, saudisicli.com.sa, and it too was «موثّق»). Owner direction:
 *   «موثّق»                       only when a verifier answered deliverable (safe / valid) and the address is not a catch-all one;
 *   «غير موثّق»                   a value that was found but not verified (no verifier answered, the budget had no room) or that the verifier called catch-all, undeliverable or unknown;
 *   «غير موثّق لهذه الشركة»       the address's domain is not the company's domain (no verifier is paid for it).
 * A found value is never dropped: the status says how far it can be trusted. Pure: an answer in, a verdict out.
 */
export const EMAIL_STATUS_VERIFIED_AR = "موثّق";
export const EMAIL_STATUS_UNVERIFIED_AR = "غير موثّق";
export const EMAIL_STATUS_OTHER_COMPANY_AR = "غير موثّق لهذه الشركة";

export type EmailVerdict = "deliverable" | "catch_all" | "undeliverable" | "unknown";

const GOOD = /^(safe|valid|deliverable|ok|good|verified|accepted|success)$/i;
const BAD = /^(invalid|undeliverable|bad|bounce|bounced|disposable|spam_?trap|spamtrap|do_?not_?mail|abuse|reject|rejected|failed|not_?deliverable|nonexistent|no_?mailbox)$/i;
const CATCH_ALL = /catch.?all|accept.?all/i;
/** The fields that carry the verdict: a status text, or a flag. */
const STATUS_KEYS = /^(status|result|state|verdict|verification|verification_?status|email_?status|deliverability|validity|quality|reason)$/i;
const DELIVERABLE_FLAG = /^(deliverable|is_?deliverable|valid|is_?valid|verified|is_?verified|valid_?email|can_?receive)$/i;
const CATCH_ALL_FLAG = /^(catch_?all|is_?catch_?all|accept_?all|is_?accept_?all|acceptall)$/i;

const truthy = (v: unknown): boolean => v === true || (typeof v === "string" && /^(true|yes|1)$/i.test(v.trim()));
const falsy = (v: unknown): boolean => v === false || (typeof v === "string" && /^(false|no|0)$/i.test(v.trim()));

/**
 * What a verifier's answer says about the address, found by walking the answer (an object, a list, nested `data` / `result`), whatever the provider calls its fields: a status word (safe, valid, deliverable | invalid, undeliverable, disposable | catch-all), a flag
 * (deliverable, valid, catch_all). A catch-all flag or word always wins over «deliverable» (a catch-all domain accepts any local part, so it proves nothing); any bad word or a false deliverable flag makes the address undeliverable; no word and no flag is unknown.
 */
export function emailVerdictIn(page: unknown): EmailVerdict {
  let good = false;
  let bad = false;
  let catchAll = false;
  const walk = (node: unknown, depth: number): void => {
    if (depth > 5 || node === null || node === undefined) return;
    if (Array.isArray(node)) { for (const x of node.slice(0, 5)) walk(x, depth + 1); return; }
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (CATCH_ALL_FLAG.test(k)) { if (truthy(v)) catchAll = true; continue; }
      if (DELIVERABLE_FLAG.test(k)) { if (truthy(v)) good = true; else if (falsy(v)) bad = true; else if (typeof v === "string") { if (GOOD.test(v.trim())) good = true; else if (BAD.test(v.trim())) bad = true; else if (CATCH_ALL.test(v)) catchAll = true; } continue; }
      if (STATUS_KEYS.test(k) && typeof v === "string") {
        const s = v.trim();
        if (CATCH_ALL.test(s)) catchAll = true; else if (GOOD.test(s)) good = true; else if (BAD.test(s)) bad = true;
        continue;
      }
      if (typeof v === "object") walk(v, depth + 1);
    }
  };
  walk(page, 0);
  if (catchAll) return "catch_all";
  if (bad) return "undeliverable";
  return good ? "deliverable" : "unknown";
}

/** True when an address is on a domain other than the company's (both known). Subdomains of the company's domain are the company's. */
export function emailOnOtherDomain(email: string, companyDomain: string | null): boolean {
  if (!companyDomain) return false;
  const mine = registrableDomain(email);
  return mine !== null && mine !== registrableDomain(companyDomain);
}

/** The status cell of an e-mail value. */
export function emailStatusAr(status: "verified" | "unverified" | "other_company"): string {
  return status === "verified" ? EMAIL_STATUS_VERIFIED_AR : status === "other_company" ? EMAIL_STATUS_OTHER_COMPANY_AR : EMAIL_STATUS_UNVERIFIED_AR;
}
