import { findTestAccount } from "../../../../lib/agentMission/adminActions";
import { isTestAccount } from "../../../../lib/server/testAccounts";

/**
 * THE ACCOUNT OF AN ACCEPTANCE CAMPAIGN, checked twice: the agent console's test account (the only account it creates and approves missions for) AND a test account by the shared classifier. A console account the
 * classifier does not call a test account, or a lookup that fails, gives no account (and so no campaign). The id is returned trimmed and lower-cased, the form `scopedFlagOn` compares.
 * Admin-side only (the classifier may be imported by admin code only: tests/admin-calls-log.test.ts).
 */
export async function resolveAcceptanceAccount(client: any, find: (client: any) => Promise<{ id: string; email: string } | null> = findTestAccount): Promise<{ id: string } | null> {
  const account = await find(client).catch(() => null);
  if (!account || !isTestAccount(account)) return null;
  return { id: String(account.id).trim().toLowerCase() };
}
