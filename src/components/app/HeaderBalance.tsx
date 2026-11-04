import { balanceText, type BalanceView } from "@/lib/honestDisplay";

export function HeaderBalance({ balance }: { balance: BalanceView }) {
  if (balance.status === "loading") {
    return <span role="status" aria-label="جارٍ تحميل الرصيد" data-testid="balance-skeleton" className="inline-block h-4 w-12 animate-pulse rounded bg-ln2 motion-reduce:animate-none" />;
  }
  return <span className="text-sm font-medium text-ink">{balanceText(balance)}</span>;
}
