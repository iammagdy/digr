"use client";

import Link from "next/link";
import { toArabicDigits } from "@/lib/arabicDigits";
import { useAdmin } from "./AdminShell";
import { tint } from "./format";

const usd = (n: number) => `${toArabicDigits(n.toFixed(n < 1 ? 2 : 2))} دولار`;

/** Admin home: a visible warning when the data provider balance is low or its real connection check fails. */
export function ProviderAlertBanner() {
  const { providers } = useAdmin();
  const t = providers?.treg;
  if (!t) return null;
  const items: string[] = [];
  if (t.health && !t.health.ok && t.tokenConfigured) {
    items.push(t.health.reason === "auth_rejected"
      ? "مزود البيانات رفض مفتاح الوصول، لذلك ستفشل المهام الجديدة. استبدل المفتاح من تبويب «مزودو الخدمة»."
      : "مزود البيانات لا يستجيب لفحص الاتصال الحقيقي الآن، وقد تفشل المهام الجديدة.");
  }
  if (!t.tokenConfigured) items.push("لا يوجد مفتاح مضبوط لمزود البيانات.");
  if (t.lowBalance && t.balance?.available && typeof t.balance.balanceUsd === "number") {
    items.push(`رصيدك لدى مزود البيانات منخفض: ${usd(t.balance.balanceUsd)} (حد التنبيه ${usd(t.thresholdUsd ?? 0.2)}). اشحن حسابك لدى المزود قبل أن تتوقف المهام.`);
  }
  if (items.length === 0) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[18px] px-4 py-3.5" style={{ background: tint("var(--bad)", 11), border: `1px solid ${tint("var(--bad)", 30)}` }}>
      <div className="flex flex-col gap-1">
        {items.map((m) => <p key={m} className="m-0 text-[13px] font-semibold leading-[1.8] text-bad">{m}</p>)}
      </div>
      <Link href="/admin/providers" className="flex min-h-11 items-center whitespace-nowrap rounded-full border border-ln2 bg-sf px-4 text-xs font-semibold text-ink">فتح مزودو الخدمة</Link>
    </div>
  );
}
