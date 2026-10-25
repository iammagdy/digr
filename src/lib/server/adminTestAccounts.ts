import { isTestAccount, isTestAccountEmail, TEST_ACCOUNT_DOMAIN, TEST_ACCOUNT_EMAILS } from "./testAccounts";

/**
 * The toggle «إخفاء حسابات الاختبار» of the admin Jobs and Conference pages (on unless switched off).
 * It changes only what the admin SEES: never a row, a balance, a ledger entry or a job. WHO is a test account is decided by ONE shared classifier
 * (testAccounts.ts), the same one the calls log uses. A real guest must never match, and customers never see this.
 */
export { TEST_ACCOUNT_DOMAIN, TEST_ACCOUNT_EMAILS, isTestAccountEmail };

export const HIDE_TEST_ACCOUNTS_LABEL_AR = "إخفاء حسابات الاختبار";

/** The ids of the test accounts among profile rows (`id`, `email`). Rows without a string id are skipped. */
export function testAccountIds(profiles: Array<{ id?: unknown; email?: unknown }>): Set<string> {
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (typeof profile.id !== "string") continue;
    if (isTestAccount({ id: profile.id, email: typeof profile.email === "string" ? profile.email : null })) ids.add(profile.id);
  }
  return ids;
}

/** Hidden unless the request asks for `hideTest=0`. A missing parameter means hidden. */
export function hidesTestAccounts(param: string | null | undefined): boolean {
  return param !== "0";
}
