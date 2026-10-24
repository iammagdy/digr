/**
 * Test accounts that the admin dashboards hide by default («إخفاء حسابات الاختبار», on unless switched off).
 * The toggle only changes what the admin SEES: it never changes a row, a balance, a ledger entry or a job. A real guest must never
 * be listed here, and customers never see this list.
 */
export const TEST_ACCOUNT_EMAILS: readonly string[] = ["iam.magdy+1@outlook.com", "magdy.saber@outlook.com"];
export const TEST_ACCOUNT_DOMAIN = "@digr.local";

export const HIDE_TEST_ACCOUNTS_LABEL_AR = "إخفاء حسابات الاختبار";

export function isTestAccountEmail(email: string | null | undefined): boolean {
  const normalised = String(email || "").trim().toLowerCase();
  if (!normalised) return false;
  return TEST_ACCOUNT_EMAILS.includes(normalised) || normalised.endsWith(TEST_ACCOUNT_DOMAIN);
}

/** The ids of the test accounts among profile rows (`id`, `email`). Rows without a string id are skipped. */
export function testAccountIds(profiles: Array<{ id?: unknown; email?: unknown }>): Set<string> {
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (typeof profile.id !== "string") continue;
    if (isTestAccountEmail(typeof profile.email === "string" ? profile.email : null)) ids.add(profile.id);
  }
  return ids;
}

/** Hidden unless the request asks for `hideTest=0`. A missing parameter means hidden. */
export function hidesTestAccounts(param: string | null | undefined): boolean {
  return param !== "0";
}
