"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import type { OperationsSnapshot } from "@/lib/server/adminOperations";

type Resp = OperationsSnapshot & { checkedAt: string };

const LEVEL_COLOR = { info: "var(--info)", warn: "var(--goldT)", bad: "var(--bad)" } as const;
const POLL_MS = 15_000;

/** Operations: running, stuck and failed jobs, the queue, the provider's daily allowance and what needs attention. Read only. */
export default function AdminOperationsPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    adminFetch<Resp>("/api/admin/operations").then((r) => { setData(r); setError(""); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const tiles: Array<{ k: string; v: number | null; c: string }> = [
    { k: "قيد التنفيذ", v: data?.counts.running ?? null, c: "var(--info)" },
    { k: "في الانتظار", v: data?.counts.queued ?? null, c: "var(--ink)" },
    { k: "متوقفة", v: data?.counts.stalled ?? null, c: data?.counts.stalled ? "var(--bad)" : "var(--ink)" },
    { k: "فشلت خلال ٢٤ ساعة", v: data?.counts.failedRecent ?? null, c: data?.counts.failedRecent ? "var(--goldT)" : "var(--ink)" },
  ];
  const barColor = data?.provider.level === "reached" ? "var(--bad)" : data?.provider.level === "warn" ? "var(--gold)" : "var(--bar)";

  return (
    <div data-screen-label="Operations" className="flex flex-col gap-3.5">
      {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,160px),1fr))" }}>
        {tiles.map((t) => (
          <div key={t.k} data-testid="ops-tile" className="rounded-[18px] border border-ln bg-sf p-3.5">
            <p className="m-0 text-xs text-mut">{t.k}</p>
            <p className="mb-0 mt-1.5 font-display text-[30px] leading-none" style={{ color: t.c }}>{t.v === null ? "…" : formatAr(t.v)}</p>
          </div>
        ))}
      </div>

      <section className="rounded-[20px] border border-ln bg-sf p-[18px]" aria-labelledby="ops-alerts">
        <h2 id="ops-alerts" className="m-0 text-base font-semibold text-ink">تنبيهات</h2>
        {data && data.alerts.length === 0 && <p className="mb-0 mt-2.5 text-[13px] text-mut">لا يوجد ما يحتاج انتباهك الآن.</p>}
        <ul className="m-0 mt-2.5 flex list-none flex-col gap-2 p-0" data-testid="ops-alerts">
          {data?.alerts.map((a) => <li key={a.textAr} className="text-[13px] leading-[1.8]" style={{ color: LEVEL_COLOR[a.level] }}>{a.textAr}</li>)}
        </ul>
      </section>

      <section className="rounded-[20px] border border-ln bg-sf p-[18px]" aria-labelledby="ops-provider">
        <h2 id="ops-provider" className="m-0 text-base font-semibold text-ink">المزود والحد اليومي</h2>
        {data ? (
          <>
            <p className="mb-0 mt-2.5 text-[13px] text-ink2" dir="ltr" style={{ textAlign: "right" }}>
              {data.provider.todaySpendUsd.toFixed(4)} / {data.provider.todayCapUsd.toFixed(2)} USD · {formatAr(Math.round(data.provider.percentOfCap))}%
            </p>
            <div className="mt-2 h-2 overflow-hidden rounded bg-sf2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(data.provider.percentOfCap)}>
              <div className="h-full" style={{ width: `${data.provider.percentOfCap}%`, background: barColor }} />
            </div>
            <p className="mb-0 mt-2.5 text-[13px] text-ink2" dir="ltr" style={{ textAlign: "right" }}>
              {data.provider.availableBalanceUsd.toFixed(2)} USD {data.provider.balanceIsLow ? "· low" : ""}
            </p>
            <p className="mb-0 mt-1 text-[11px] text-fnt">الرصيد المتاح تقدير: الرصيد المضبوط ناقص الإنفاق المسجَّل.</p>
          </>
        ) : <p className="mb-0 mt-2.5 text-[13px] text-mut">…</p>}
      </section>

      <section className="rounded-[20px] border border-ln bg-sf p-[18px]" aria-labelledby="ops-stalled">
        <h2 id="ops-stalled" className="m-0 text-base font-semibold text-ink">طلبات متوقفة</h2>
        {data && data.stalled.length === 0 && <p className="mb-0 mt-2.5 text-[13px] text-mut">لا توجد طلبات متوقفة.</p>}
        <ul className="m-0 mt-2.5 flex list-none flex-col gap-1.5 p-0 text-[13px] text-ink2" data-testid="ops-stalled">
          {data?.stalled.map((s) => (
            <li key={s.id}><span dir="ltr">{s.id}</span> — بلا تقدم منذ {formatAr(s.idleMinutes)} دقيقة، ويُرجَع حجزها تلقائيًا بعد حوالي {formatAr(s.refundInMinutes)} دقيقة</li>
          ))}
        </ul>
        {data?.oldestQueuedMinutes != null && <p className="mb-0 mt-2.5 text-[12px] text-mut">أقدم طلب منتظر: {formatAr(data.oldestQueuedMinutes)} دقيقة.</p>}
      </section>

      <section className="rounded-[20px] border border-ln bg-sf p-[18px]" aria-labelledby="ops-failed">
        <h2 id="ops-failed" className="m-0 text-base font-semibold text-ink">فشلت خلال ٢٤ ساعة</h2>
        {data && data.failed.length === 0 && <p className="mb-0 mt-2.5 text-[13px] text-mut">لا توجد طلبات فاشلة.</p>}
        <ul className="m-0 mt-2.5 flex list-none flex-col gap-1.5 p-0 text-[13px] text-ink2" data-testid="ops-failed">
          {data?.failed.map((f) => <li key={f.id}><span dir="ltr">{f.id}</span> — {f.reasonAr} (حجز {formatAr(f.reservedCredits)} نقطة)</li>)}
        </ul>
      </section>
      {data && <p className="m-0 text-[11px] text-fnt">يتحدث كل ١٥ ثانية.</p>}
    </div>
  );
}
