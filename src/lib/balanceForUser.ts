import { balanceLoading, type BalanceView } from "./honestDisplay";

/** Never display a balance fetched for a different signed-in account. */
export function balanceForUser(cached: { ownerId: string | null; balance: BalanceView }, userId: string | null): BalanceView {
  return userId && cached.ownerId === userId ? cached.balance : balanceLoading();
}
