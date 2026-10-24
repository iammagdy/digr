"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import type { ConferenceSnapshot, JobListItem } from "@/lib/server/conferenceDashboard";
import { HIDE_TEST_ACCOUNTS_LABEL_AR } from "@/lib/server/adminTestAccounts";

const LEVEL_COLOR = { info: "var(--info)", warn: "var(--goldT)", bad: "var(--bad)" } as const;
const POLL_MS = 10_000;
const JITTER_MS = 2_000;

const SECTION = "rounded-[20px] border border-ln bg-sf p-[18px]";
const H2 = "m-0 text-base font-semibold text-ink";
const ROW = "m-0 text-[13px] leading-[1.9] text-ink2";
const usd = (value: number, digits = 2) => `${formatAr(value, digits)} دولار`;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className={SECTION} aria-labelledby={id}>
      <h2 id={id} className={H2}>{title}</h2>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

const Loading = () => <p className="m-0 text-[13px] text-mut">…</p>;
const Unavailable = () => <p className="m-0 text-[13px] text-mut">تعذّرت قراءة هذا القسم الآن.</p>;

/** Conference dashboard: signups, active chats, the queue, the provider, top spenders, model spend, pending top-ups. Read only. */
export default function AdminConferencePage() {
  const [data, setData] = useState<ConferenceSnapshot | null>(null);
  const [error, setError] = useState("");
  // «إخفاء حسابات الاختبار» is on by default. It only changes what is counted on this page; nothing stored changes.
  const [hideTest, setHideTest] = useState(true);

  const load = useCallback(() => {
    adminFetch<ConferenceSnapshot>(`/api/admin/conference?hideTest=${hideTest ? 1 : 0}`).then((r) => { setData(r); setError(""); }).catch((e) => setError(e.message));
  }, [hideTest]);

  // Polls every 10 s plus a random 0-2 s so several tabs do not land together; nothing runs while the tab is hidden.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      if (timer) clearTimeout(timer);
      if (document.hidden) return;
      load();
      timer = setTimeout(run, POLL_MS + Math.random() * JITTER_MS);
    };
    const onVisibility = () => {
      if (document.hidden) { if (timer) clearTimeout(timer); timer = undefined; } else run();
    };
    run();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [load]);

  const jobItem = (item: JobListItem, detail: string) => (
    <li key={item.id} className="flex flex-wrap items-center gap-2">
      <span dir="ltr" className="font-mono text-[11px] text-fnt">{item.id}</span>
      <span className="text-fnt">{detail} {formatAr(item.minutes)} د</span>
    </li>
  );
  const tiles: Array<{ k: string; v: number | null; c: string; list?: JobListItem[]; detail?: string }> = [
    { k: "تسجيلات آخر دقيقة", v: data ? data.signups?.lastMinute ?? null : null, c: data?.signups && data.signups.lastMinute > data.thresholds.signupsPerMinuteWarn ? "var(--goldT)" : "var(--ink)" },
    { k: "محادثون نشطون (١٠ دقائق)", v: data ? data.activeChats?.users ?? null : null, c: "var(--info)" },
    { k: "طلبات قيد التنفيذ", v: data ? data.jobs?.running ?? null : null, c: "var(--info)", list: data?.jobList?.running, detail: "بلا تقدم منذ" },
    { k: "طلبات في الانتظار", v: data ? data.jobs?.queued ?? null : null, c: "var(--ink)", list: data?.jobList?.queued, detail: "منتظر منذ" },
    { k: "عالقة في الانتظار", v: data?.jobList ? data.jobList.queuedStuck.length : null, c: data?.jobList?.queuedStuck.length ? "var(--goldT)" : "var(--ink)", list: data?.jobList?.queuedStuck, detail: "منتظر منذ" },
    { k: "طلبات متوقفة", v: data ? data.jobs?.stalled ?? null : null, c: data?.jobs?.stalled ? "var(--bad)" : "var(--ink)", list: data?.jobList?.stalled, detail: "بلا تقدم منذ" },
  ];
  const t = data?.thresholds;
  const maxBucket = Math.max(1, ...(data?.signups?.perMinute ?? [1]));
  const spend = data?.provider?.spend;
  const barColor = spend?.level === "reached" ? "var(--bad)" : spend?.level === "warn" ? "var(--gold)" : "var(--bar)";

  return (
    <div data-screen-label="Conference" className="flex flex-col gap-3.5">
      {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}
      <label className="flex min-h-11 cursor-pointer items-center gap-2 self-start text-[13px] text-ink2">
        <input type="checkbox" checked={hideTest} onChange={(e) => setHideTest(e.target.checked)} className="h-4 w-4" />
        <span>{HIDE_TEST_ACCOUNTS_LABEL_AR}</span>
      </label>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,160px),1fr))" }}>
        {tiles.map((tile) => (
          <div key={tile.k} data-testid="conf-tile" className="rounded-[18px] border border-ln bg-sf p-3.5">
            <p className="m-0 text-xs text-mut">{tile.k}</p>
            <p className="mb-0 mt-1.5 font-display text-[30px] leading-none" style={{ color: tile.c }}>{tile.v === null ? "…" : formatAr(tile.v)}</p>
            {tile.list && tile.list.length > 0 && tile.detail && (
              <details className="mt-2 text-[12px] text-ink2">
                <summary className="cursor-pointer">عرض الطلبات ({formatAr(tile.list.length)})</summary>
                <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">{tile.list.map((item) => jobItem(item, tile.detail!))}</ul>
              </details>
            )}
          </div>
        ))}
      </div>

      <Section id="conf-alerts" title="تنبيهات">
        {data && data.alerts.length === 0 && <p className="m-0 text-[13px] text-mut">لا يوجد ما يحتاج انتباهك الآن.</p>}
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="conf-alerts">
          {data?.alerts.map((a) => <li key={a.textAr} className="text-[13px] leading-[1.8]" style={{ color: LEVEL_COLOR[a.level] }}>{a.textAr}</li>)}
        </ul>
        {data && data.notes.length > 0 && (
          <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-[12px] text-mut" data-testid="conf-notes">
            {data.notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
        )}
      </Section>

      <Section id="conf-signups" title="التسجيل في آخر ١٠ دقائق">
        {!data ? <Loading /> : !data.signups ? <Unavailable /> : (
          <>
            <p className={ROW}>آخر دقيقة: {formatAr(data.signups.lastMinute)} · المتوسط في الدقيقة: {formatAr(data.signups.perMinuteAvg10, 1)} · خلال ٢٤ ساعة: {formatAr(data.signups.total24h)}</p>
            <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0 text-[12px] text-ink2" data-testid="conf-signup-minutes">
              {data.signups.perMinute.map((count, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="w-[88px] shrink-0 text-mut">{i === 0 ? "آخر دقيقة" : `قبل ${formatAr(i)} د`}</span>
                  <span className="h-2 rounded bg-sf2" style={{ width: "100%", maxWidth: 220 }}><span className="block h-full rounded" style={{ width: `${(count / maxBucket) * 100}%`, background: "var(--bar)" }} /></span>
                  <span className="w-10 shrink-0">{formatAr(count)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section id="conf-chats" title="المحادثات النشطة">
        {!data ? <Loading /> : !data.activeChats ? <Unavailable /> : (
          <p className={ROW}>{formatAr(data.activeChats.users)} مستخدم أرسل رسالة في آخر ١٠ دقائق · {formatAr(data.activeChats.messagesLastMinute)} رسالة في آخر دقيقة.</p>
        )}
      </Section>

      <Section id="conf-provider" title="المزود والحد اليومي">
        {!data ? <Loading /> : !data.provider ? <Unavailable /> : (
          <>
            {data.provider.real ? (
              <p className={ROW} data-testid="conf-real-balance">الرصيد الحقيقي: {usd(data.provider.real.usd)} ({data.provider.realLabelAr}، منذ {formatAr(data.provider.real.ageSeconds)} ثانية)</p>
            ) : (
              <>
                <p className={ROW} data-testid="conf-real-balance">{data.provider.realLabelAr}</p>
                {data.provider.estimate && <p className={ROW}>الرصيد المقدَّر: {usd(data.provider.estimate.usd)} — {data.provider.estimate.labelAr}</p>}
              </>
            )}
            {spend ? (
              <>
                <p className={`${ROW} mt-1`}>إنفاق اليوم: {usd(spend.todaySpendUsd, 4)} من {usd(spend.todayCapUsd)} · {formatAr(Math.round(spend.percentOfCap))}٪</p>
                <div className="mt-2 h-2 overflow-hidden rounded bg-sf2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(spend.percentOfCap)}>
                  <div className="h-full" style={{ width: `${spend.percentOfCap}%`, background: barColor }} />
                </div>
              </>
            ) : <p className={ROW}>تعذّرت قراءة إنفاق اليوم.</p>}
          </>
        )}
      </Section>

      <Section id="conf-topspenders" title="أكثر المستخدمين استهلاكًا للنقاط اليوم">
        {!data ? <Loading /> : !data.topSpenders ? <Unavailable /> : (
          <>
            {data.topSpenders.rows.length === 0 && <p className="m-0 text-[13px] text-mut">لا توجد خصومات اليوم بعد.</p>}
            <ol className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px] text-ink2" data-testid="conf-top-spenders">
              {data.topSpenders.rows.map((row, i) => (
                <li key={row.shortId + i}>{formatAr(i + 1)}. <span dir="ltr">{row.shortId}</span>{row.name || row.email ? <> — {row.name}{row.name && row.email ? " · " : ""}{row.email && <span dir="ltr">{row.email}</span>}</> : null} — {formatAr(row.points)} نقطة</li>
              ))}
            </ol>
            {data.topSpenders.truncated && <p className="mb-0 mt-2 text-[11px] text-fnt">القراءة بلغت حدها الأقصى؛ الأرقام قد تكون ناقصة قليلًا.</p>}
            <p className="mb-0 mt-2 text-[11px] text-fnt">النقاط المخصومة منذ منتصف الليل بتوقيت القاهرة.</p>
          </>
        )}
      </Section>

      <Section id="conf-model" title="إنفاق النموذج">
        {!data ? <Loading /> : !data.modelSpend ? <Unavailable /> : (
          <>
            <p className={ROW}>اليوم: {usd(data.modelSpend.todayUsd, 4)} · هذا الشهر: {usd(data.modelSpend.monthUsd, 4)}</p>
            <p className={ROW} data-testid="conf-model-budget">{data.modelSpend.budget.noteAr}{data.modelSpend.budget.percentUsed !== null ? ` المستهلك ${formatAr(Math.round(data.modelSpend.budget.percentUsed))}٪.` : ""}</p>
            {data.modelSpend.truncated && <p className="mb-0 mt-1 text-[11px] text-fnt">القراءة بلغت حدها الأقصى؛ رقم الشهر ناقص.</p>}
          </>
        )}
      </Section>

      <Section id="conf-topups" title="طلبات الشحن المعلقة">
        {!data ? <Loading /> : !data.pendingTopups ? <Unavailable /> : (
          <p className={ROW}>{formatAr(data.pendingTopups.count)} طلب بإجمالي {formatAr(data.pendingTopups.totalEgp, 2)} جنيه.</p>
        )}
      </Section>

      <Section id="conf-unserved" title="طلبات لا نبيعها (آخر ٢٤ ساعة)">
        {!data ? <Loading /> : !data.unserved ? <Unavailable /> : (
          <>
            {data.unserved.families.length === 0 && <p className="m-0 text-[13px] text-mut">لا توجد طلبات غير مخدومة.</p>}
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px] text-ink2" data-testid="conf-unserved">
              {data.unserved.families.map((f) => <li key={f.family}>{f.titleAr} — {formatAr(f.count)} طلب</li>)}
            </ul>
            <p className="mb-0 mt-2 text-[11px] text-fnt">الإجمالي: {formatAr(data.unserved.total)} طلب.</p>
          </>
        )}
      </Section>

      <Section id="conf-thresholds" title="حدود التنبيه">
        {t ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px] text-ink2" data-testid="conf-thresholds">
            <li>التسجيل: أكثر من {formatAr(t.signupsPerMinuteWarn)} في الدقيقة (تحذير)</li>
            <li>الطلبات المنتظرة: {formatAr(t.queuedJobsWarn)} فأكثر (تحذير)، وأي طلب متوقف (خطر)</li>
            <li>الحد اليومي للمزود: {formatAr(t.providerCapWarnPercent)}٪ فأكثر (تحذير)، وعند الوصول للحد (خطر)</li>
            <li>الرصيد الحقيقي: أقل من {usd(t.realBalanceWarnUsd)} (تحذير)، وأقل من {usd(t.realBalanceBadUsd)} (خطر)</li>
            <li>طلبات الشحن المعلقة: {formatAr(t.pendingTopupsWarn)} فأكثر (تحذير)</li>
            <li>ميزانية النموذج الشهرية: {formatAr(t.modelBudgetWarnPercent)}٪ (تحذير) و{formatAr(t.modelBudgetBadPercent)}٪ (خطر)، عند ضبط الميزانية فقط</li>
          </ul>
        ) : <Loading />}
      </Section>
      {data && <p className="m-0 text-[11px] text-fnt">يتحدث كل ١٠ ثوانٍ تقريبًا، ويتوقف أثناء إخفاء الصفحة.</p>}
    </div>
  );
}
