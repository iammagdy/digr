/**
 * The KNOWN TEST ACCOUNTS, for the admin calls log only (a badge «حساب تجريبي» and a test / real filter). A code-defined list: it is not stored
 * in any table, least of all a money table, and nothing customer-facing imports it. To add an account, add it here and open a PR.
 *
 * Where the entries come from (all in the repo docs):
 *  - iam.magdy+1@outlook.com            the tester account named by the owner for this work;
 *  - iam.magdy@outlook.com              the test account of docs/HANDOFF.md (UID 47693c59-89f1-405d-bec1-e72271517870);
 *  - iam.magdy+<tag>@outlook.com        any plus-alias of it (+2, +3 …) is the same mailbox, so it is a test account too;
 *  - 00000000-0000-0000-0000-00000000000{1,2}   the two verification-fixture users of docs/CUTOVER.md and docs/MEGA_REPORT.md.
 * The owner's own account (magdy.saber@outlook.com) is NOT a test account.
 */
export const TEST_ACCOUNT_EMAILS: readonly string[] = ["iam.magdy+1@outlook.com", "iam.magdy@outlook.com"];

export const TEST_ACCOUNT_IDS: readonly string[] = [
  "47693c59-89f1-405d-bec1-e72271517870",
  "00000000-0000-0000-0000-000000000001",
  "00000000-0000-0000-0000-000000000002",
];

const PLUS_ALIAS = /^iam\.magdy\+[a-z0-9._-]+@outlook\.com$/i;

export function isTestAccount(user: { id?: string | null; email?: string | null }): boolean {
  const id = String(user.id || "").trim().toLowerCase();
  const email = String(user.email || "").trim().toLowerCase();
  if (id && TEST_ACCOUNT_IDS.includes(id)) return true;
  if (!email) return false;
  return TEST_ACCOUNT_EMAILS.includes(email) || PLUS_ALIAS.test(email);
}
