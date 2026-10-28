/**
 * Will this customer be e-mailed when a mission ends? A real address (not a guest) and the «done» e-mails not switched off in their preferences. The ONE rule: the e-mail sender (missionNotify.ts) and the
 * panel's «هنبعتلك إيميل» promise (customerActions.ts) both read it, so the panel never promises an e-mail that will not be sent.
 */
export function userWillBeEmailed(user: { email?: string | null; user_metadata?: Record<string, any> | null } | null | undefined): boolean {
  if (!user?.email || user.user_metadata?.is_guest) return false;
  const prefs = user.user_metadata?.prefs?.notif;
  return !(prefs && typeof prefs === "object" && prefs.done === false);
}
