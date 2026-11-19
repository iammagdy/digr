import { vi } from "vitest";

/**
 * DT-20261118-06 fix push (QA FAIL at 6af74613): a customer action that changes something now FAILS CLOSED when the sign-in service cannot say whether the account is banned (503, nothing charged).
 * The route tests written before that give the routes a fake admin client with no account lookup at all (no `auth.admin.getUserById`): such a fake has no ban to report, so for them the guard
 * stands aside. A fake that CAN look an account up (every test of the suspension itself, and any test that adds the lookup) meets the real guard, with its fresh lookup and its closed failure.
 * Production code is untouched: a real client always has the lookup.
 */
vi.mock("../../src/lib/server/accountSuspension", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/server/accountSuspension")>();
  return {
    ...actual,
    suspensionBlock: async (admin: Parameters<typeof actual.suspensionBlock>[0], user: Parameters<typeof actual.suspensionBlock>[1], extra?: Record<string, unknown>) => {
      let client: ReturnType<typeof admin> | undefined;
      const once = () => (client ??= admin());
      let canLook = false;
      try { canLook = typeof (once() as unknown as { auth?: { admin?: { getUserById?: unknown } } })?.auth?.admin?.getUserById === "function"; } catch { canLook = false; }
      return canLook ? actual.suspensionBlock(once, user, extra) : null;
    },
  };
});
