import Link from "next/link";
import { formatAr } from "@/lib/arabicDigits";
import type { AdminAlerts, ProviderStatus } from "./AdminShell";
import { Card, CardSkeleton } from "./ui";
import { PROVIDER_TREG } from "@/lib/multiProvider/types";

/** DT-20261118-06 §3.2: «يحتاج انتباهك», the first card of the overview. Admin only, so dollars may be named here. Logical properties only, no emoji. */
export interface AttentionItem { level: "warn" | "bad"; text: string; actionLabel: string; href: string }

/** «١٢٫٤٠» for a fraction, «٢٥» for a whole number of dollars. */
export const usd = (n: number) => (Number.isInteger(n) ? formatAr(n) : formatAr(n, 2));

/** The data provider's balance as the attention card and the providers card both read it. A balance that could not be read is never called low. */
export function tregBalanceState(treg: ProviderStatus[typeof PROVIDER_TREG] | null | undefined): { balance: number | null; threshold: number | null; low: boolean } {
  const balance = treg?.balance?.available && typeof treg.balance.balanceUsd === "number" ? treg.balance.balanceUsd : null;
  const threshold = typeof treg?.thresholdUsd === "number" ? treg.thresholdUsd : null;
  return { balance, threshold, low: balance !== null && threshold !== null && (treg?.lowBalance === true || balance < threshold) };
}
const OPEN = "فتح";
const PROVIDERS = "/admin/providers";

/**
 * The items of the card, red first then gold, from what the shell already reads every 60 s (alerts, providers) and the overview's live numbers.
 * The provider warnings of the old banner (key rejected, no answer, no key, the model's daily limit) are kept, in its own words, so moving them here loses none.
 */
export function attentionItems({ alerts, providers, overview }: {
  alerts: Pick<AdminAlerts, "pendingTotal"> | null;
  providers: ProviderStatus | null;
  overview: { live: { stalled: number; stalledMinMinutes: number | null } } | null;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  const add = (level: AttentionItem["level"], text: string, href: string) => items.push({ level, text, actionLabel: OPEN, href });
  const t = providers?.treg;
  if (t) {
    if (!t.tokenConfigured) add("bad", "لا يوجد مفتاح مضبوط لمزود البيانات.", PROVIDERS);
    else if (t.health && !t.health.ok) {
      add("bad", t.health.reason === "auth_rejected"
        ? "مزود البيانات رفض مفتاح الوصول، لذلك ستفشل المهام الجديدة. استبدل المفتاح من تبويب «مزودو الخدمة»."
        : "مزود البيانات لا يستجيب لفحص الاتصال الحقيقي الآن، وقد تفشل المهام الجديدة.", PROVIDERS);
    }
    const { balance, threshold, low } = tregBalanceState(t);
    if (low && balance !== null && threshold !== null) {
      add("warn", `رصيد مزود البيانات منخفض: متبقٍ ${usd(balance)} دولار والحد المنبّه ${usd(threshold)} دولار.`, PROVIDERS);
    }
  }
  const limits = providers?.limits;
  if (limits && (limits.level === "warn" || limits.level === "reached")) {
    add(limits.level === "reached" ? "bad" : "warn", `بلغ الإنفاق اليومي ${formatAr(Math.round(limits.percent))}٪ من الحد المسموح.`, PROVIDERS);
  }
  if (limits?.llmLevel === "reached") add("bad", "وصل إنفاق النموذج الذكي اليوم إلى حده اليومي، وسيتوقف المساعد حتى يُرفع الحد أو يبدأ يوم جديد.", PROVIDERS);
  else if (limits?.llmLevel === "warn") add("warn", `وصل إنفاق النموذج الذكي اليوم إلى ${formatAr(Math.round(limits.llmPercent))}٪ من حده اليومي.`, PROVIDERS);
  if (alerts && alerts.pendingTotal > 0) add("warn", `${formatAr(alerts.pendingTotal)} طلبات شحن بانتظار مراجعتك`, "/admin/topups");
  const live = overview?.live;
  if (live && live.stalled > 0 && live.stalledMinMinutes !== null) {
    add("bad", `${formatAr(live.stalled)} مهام متوقفة منذ أكثر من ${formatAr(live.stalledMinMinutes)} دقيقة.`, "/admin/operations");
  }
  // stable: red first, each group in the order above
  return [...items.filter((i) => i.level === "bad"), ...items.filter((i) => i.level === "warn")];
}

const DOT: Record<AttentionItem["level"], string> = { warn: "var(--gold)", bad: "var(--bad)" };
const TEXT: Record<AttentionItem["level"], string> = { warn: "text-goldT", bad: "text-bad" };

export function AttentionCard({ items, loading = false }: { items: AttentionItem[]; loading?: boolean }) {
  if (loading) return <CardSkeleton height={120} />;
  const tone = items.some((i) => i.level === "bad") ? "bad" : items.length ? "warn" : "default";
  return (
    <Card title="يحتاج انتباهك" tone={tone} testId="attention-card">
      {items.length === 0 ? (
        <p className="m-0 text-[13px] text-mut">لا شيء يحتاج انتباهك الآن.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {items.map((item) => (
            <li key={item.text} data-level={item.level} className="flex items-center gap-2.5 border-b border-ln py-1 last:border-b-0">
              <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: DOT[item.level] }} />
              <p className={`m-0 min-w-0 flex-1 text-[13px] font-semibold leading-[1.8] ${TEXT[item.level]}`}>{item.text}</p>
              <Link href={item.href} className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border border-ln2 bg-sf px-3 text-xs font-semibold text-ink">{item.actionLabel}</Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
