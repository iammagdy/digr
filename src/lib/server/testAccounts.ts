/**
 * THE ONE CLASSIFIER of test accounts for the admin screens. The toggle «إخفاء حسابات الاختبار» (admin Jobs and Conference pages, through
 * adminTestAccounts.ts) and the calls log's badge and test / real filter (adminCallsLog.ts) both ask this file, so they can never disagree.
 * A code-defined rule: it is not stored in any table, least of all a money table, and nothing customer-facing imports it. It only decides what the
 * admin SEES; no row, balance, ledger entry or job is changed by it.
 *
 * An account is a test account when its e-mail (trimmed, lower-cased) is
 *  - on the domain @digr.local (the accounts the verification scripts create), or
 *  - exactly iam.magdy@outlook.com (the test account of docs/HANDOFF.md), or
 *  - iam.magdy+<anything>@outlook.com (a plus-alias is the same mailbox: +1, +2 ...),
 * or when its id is one of the known test users: the HANDOFF account and the two verification-fixture users of docs/CUTOVER.md.
 * The owner's own account (magdy.saber@outlook.com) is NOT a test account, and no real customer matches any of these.
 */
export const TEST_ACCOUNT_DOMAIN = "@digr.local";
export const TEST_ACCOUNT_EMAILS: readonly string[] = ["iam.magdy+1@outlook.com", "iam.magdy@outlook.com"];

export const TEST_ACCOUNT_IDS: readonly string[] = [
  "47693c59-89f1-405d-bec1-e72271517870",
  "00000000-0000-0000-0000-000000000001",
  "00000000-0000-0000-0000-000000000002",
];

/** iam.magdy+<anything without @ or spaces>@outlook.com, the whole address (so iam.magdy+1@outlook.com.evil.com does not match). */
const PLUS_ALIAS = /^iam\.magdy\+[^@\s]+@outlook\.com$/i;

export function isTestAccountEmail(email: string | null | undefined): boolean {
  const normalised = String(email || "").trim().toLowerCase();
  if (!normalised) return false;
  return normalised.endsWith(TEST_ACCOUNT_DOMAIN) || TEST_ACCOUNT_EMAILS.includes(normalised) || PLUS_ALIAS.test(normalised);
}

export function isTestAccount(user: { id?: string | null; email?: string | null }): boolean {
  const id = String(user.id || "").trim().toLowerCase();
  if (id && TEST_ACCOUNT_IDS.includes(id)) return true;
  return isTestAccountEmail(user.email);
}
