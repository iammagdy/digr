"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import type { MissionOverview, RecentMission } from "@/lib/server/adminOverview";
import type { CreditSummary } from "@/lib/server/financeSummary";
import type { AdminAlerts, ProviderStatus, Range } from "./AdminShell";
import { AttentionCard, attentionItems, tregBalanceState, usd } from "./AttentionCard";
import { ADMIN_IC, AIcon } from "./icons";
import { EGP, agoAr, initials, tint } from "./format";
import { Card, CardSkeleton, EmptyState, ErrorState, Meter, StatTile, StatusBadge, TrendBars, deltaAr, type MeterLevel } from "./ui";
import type { VisitorsResponse } from "./visitorFormat";
import { UserSheet } from "./UserSheet";
import { BRAND_TREG } from "@/lib/multiProvider/types";

/**
 * THE OVERVIEW (DT-20261118-06 §3.2), phone first. Each card reads its own source and has its own skeleton, empty sentence and error with «أعد المحاولة»:
 * a failing card never blanks the page. The money, user-growth, activity and top-payers cards are the old page's, moved down; their values and /api/admin/stats are unchanged.
 * Logical properties only, no emoji, Arabic-Indic digits (Latin digits only inside dir="ltr" e-mails and the stats feed's amount pills).
 */

export type Slot<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

export interface StatsData {
  range: number;
  totals: {
    users: number; newUsers: number; newUsersPrev: number; active: number; rev: number; cost: number; profit: number; margin: number | null; jobs: number;
    change: { users: number; newUsers: number; active: number; rev: number; profit: number; jobs: number };
  };
  series: { rev: number[]; cost: number[]; newUsers: number[]; active: number[]; jobs: number[] };
  funnel: { signed: number; asked: number; paid: number };
  activity: ActivityEvent[];
  topPayers: Array<{ id: string; name: string; email: string; total: number; last: string }>;
  pendingCount: number;
}
interface ActivityEvent { type: "signup" | "pay" | "jobs" | "check"; who: string; what: string; at: string; when: string; value: string; tone: "info" | "gold" | "ink" | "ok"; userId?: string | null }
export type OverviewData = MissionOverview & { recentMissions: RecentMission[] };
export interface FinanceData { credit: Pick<CreditSummary, "realIncome" | "consumedPoints" | "refundedPoints" | "outstandingPoints"> | null }
export interface LiveData { live: MissionOverview["live"] }

export interface OverviewSlots {
  stats: Slot<StatsData>;
  overview: Slot<OverviewData>;
  finance: Slot<FinanceData>;
  /** the visits of the last 14 Cairo days (the chart) */
  visits: Slot<VisitorsResponse>;
  /** today's visits and new accounts (live tiles) */
  today: Slot<VisitorsResponse>;
  /** the running missions (live tiles, attention card) */
  live: Slot<LiveData>;
}
export type SlotKey = keyof OverviewSlots;
/** Read on a range change and on «أعد المحاولة». */
export const HEAVY_SLOTS: SlotKey[] = ["stats", "overview", "finance", "visits"];
/** Read every 60 s while the tab is visible (startVisiblePolling) and on «تحديث». */
export const LIVE_SLOTS: SlotKey[] = ["today", "live"];
const LOADING = { status: "loading" } as const;
export const LOADING_SLOTS: OverviewSlots = { stats: LOADING, overview: LOADING, finance: LOADING, visits: LOADING, today: LOADING, live: LOADING };

export function slotPath(key: SlotKey, range: Range): string {
  switch (key) {
    case "stats": return `/api/admin/stats?range=${range}`;
    case "overview": return `/api/admin/overview?range=${range}`;
    case "finance": return `/api/admin/finance?range=${range}`;
    case "visits": return "/api/admin/visitors?range=14d";
    case "today": return "/api/admin/visitors?range=today";
    case "live": return "/api/admin/overview?part=live";
  }
}

/** One card's read: never throws, a failure is the card's own error. */
export async function loadSlot<K extends SlotKey>(key: K, range: Range, fetcher: (path: string) => Promise<unknown>): Promise<OverviewSlots[K]> {
  try {
    return { status: "ready", data: await fetcher(slotPath(key, range)) } as OverviewSlots[K];
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : "" } as OverviewSlots[K];
  }
}

/** Every card's read, in parallel (the page starts the same reads from its effects). */
export async function loadOverviewSlots(range: Range, fetcher: (path: string) => Promise<unknown>): Promise<OverviewSlots> {
  const keys = Object.keys(LOADING_SLOTS) as SlotKey[];
  const loaded = await Promise.all(keys.map((key) => loadSlot(key, range, fetcher)));
  return Object.fromEntries(keys.map((key, i) => [key, loaded[i]])) as unknown as OverviewSlots;
}

const rangeAr = (range: number) => `${formatAr(range)} ${range === 7 ? "أيام" : "يومًا"}`;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const TONE: Record<string, string> = { info: "var(--info)", gold: "var(--goldT)", ink: "var(--ink2)", ok: "var(--ok)" };
const LINK = "flex min-h-11 items-center whitespace-nowrap text-xs font-semibold text-goldT";

function Section({ id, span, children }: { id: string; span: string; children: ReactNode }) {
  return <div data-card={id} className={`min-w-0 ${span}`}>{children}</div>;
}

/** A card fed by one slot: skeleton while it loads, its error with «أعد المحاولة», or its content. */
function SlotCard<T>({ slot, title, sub, action, testId, height, onRetry, children }: { slot: Slot<T>; title: string; sub?: ReactNode; action?: ReactNode; testId: string; height: number; onRetry: () => void; children: (data: T) => ReactNode }) {
  if (slot.status === "loading") return <CardSkeleton height={height} />;
  if (slot.status === "error") return <Card title={title} testId={testId}><ErrorState onRetry={onRetry} /></Card>;
  return <Card title={title} sub={sub} action={action} testId={testId}>{children(slot.data)}</Card>;
}

export interface OverviewViewProps {
  range: Range;
  isMobile: boolean;
  alerts: AdminAlerts | null;
  providers: ProviderStatus | null;
  slots: OverviewSlots;
  /** when the live tiles last loaded; null before the first answer */
  liveAt: string | null;
  /** the last 60 s refresh failed and the tiles show the numbers before it */
  liveStale: boolean;
  now: number;
  onRetry: (key: SlotKey) => void;
  onRefreshLive: () => void;
}

export function OverviewView(props: OverviewViewProps) {
  const { range, isMobile, alerts, providers, slots, now, onRetry } = props;
  const [openUser, setOpenUser] = useState<string | null>(null);
  const live = slots.live.status === "ready" ? slots.live.data : null;
  const attention = !alerts && !providers && slots.live.status === "error"
    ? <Card title="يحتاج انتباهك" testId="attention-card"><ErrorState onRetry={() => onRetry("live")} /></Card>
    : <AttentionCard items={attentionItems({ alerts, providers, overview: live })} loading={!alerts && !providers && slots.live.status === "loading"} />;
  return (
    <div data-screen-label="Overview" className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-12">
      <Section id="attention" span="min-[900px]:col-span-12">{attention}</Section>
      <Section id="today" span="min-[900px]:col-span-12"><TodayCard {...props} /></Section>
      <Section id="missions" span="min-[900px]:col-span-4">
        <SlotCard slot={slots.overview} title={`المهام · ${rangeAr(range)}`} testId="missions-card" height={190} onRetry={() => onRetry("overview")} action={<Link href="/admin/jobs" className={LINK}>عمليات البحث</Link>}>
          {(o) => <MissionsBody o={o} />}
        </SlotCard>
      </Section>
      <Section id="points" span="min-[900px]:col-span-4">
        <SlotCard slot={slots.finance} title={`النقاط · ${rangeAr(range)}`} testId="points-card" height={190} onRetry={() => onRetry("finance")}>
          {(f) => <PointsBody credit={f.credit} onRetry={() => onRetry("finance")} />}
        </SlotCard>
      </Section>
      <Section id="providers" span="min-[900px]:col-span-4"><ProvidersCard providers={providers} /></Section>
      <Section id="visits" span="min-[900px]:col-span-12">
        <SlotCard slot={slots.visits} title="الزيارات · آخر ١٤ يومًا" testId="visits-card" height={210} onRetry={() => onRetry("visits")} action={<Link href="/admin/visitors" className={LINK}>الزوّار</Link>}>
          {(v) => <VisitsBody v={v} />}
        </SlotCard>
      </Section>
      <Section id="money" span="min-[900px]:col-span-8">
        <SlotCard slot={slots.stats} title="الإيرادات والتكاليف" sub={`شحن معتمد مقابل تكلفة المزودين (${BRAND_TREG} + النماذج)`} testId="money-card" height={330} onRetry={() => onRetry("stats")}>
          {(s) => <MoneyBody s={s} range={range} isMobile={isMobile} now={now} />}
        </SlotCard>
      </Section>
      <Section id="growth" span="min-[900px]:col-span-4">
        <SlotCard slot={slots.stats} title="نمو المستخدمين" sub={`آخر ${rangeAr(range)}`} testId="growth-card" height={330} onRetry={() => onRetry("stats")}>
          {(s) => <GrowthBody s={s} range={range} />}
        </SlotCard>
      </Section>
      <Section id="activity" span="min-[900px]:col-span-7"><ActivityCard slots={slots} now={now} onRetry={onRetry} onOpenUser={setOpenUser} /></Section>
      <Section id="payers" span="min-[900px]:col-span-5">
        <SlotCard slot={slots.stats} title="الأعلى شحنًا" testId="payers-card" height={260} onRetry={() => onRetry("stats")} action={<Link href="/admin/users" className={LINK}>كل المستخدمين</Link>}>
          {(s) => <PayersBody s={s} onOpenUser={setOpenUser} />}
        </SlotCard>
      </Section>
      {openUser && <UserSheet userId={openUser} onClose={() => setOpenUser(null)} />}
    </div>
  );
}

function TodayCard({ slots, alerts, liveAt, liveStale, now, onRetry, onRefreshLive }: OverviewViewProps) {
  const { today, live } = slots;
  const off = today.status === "ready" && !today.data.available;
  const tiles: Array<{ label: string; value: string | null; loading: boolean; href: string; sub?: string }> = [
    { label: "زيارات اليوم", value: today.status === "ready" && today.data.available && today.data.summary ? formatAr(today.data.summary.visits) : null, loading: today.status === "loading", href: "/admin/visitors", sub: off ? "غير مُفعَّل" : undefined },
    { label: "حسابات جديدة", value: today.status === "ready" && today.data.newAccounts != null ? formatAr(today.data.newAccounts) : null, loading: today.status === "loading", href: "/admin/users" },
    { label: "مهام تعمل الآن", value: live.status === "ready" ? formatAr(live.data.live.running) : null, loading: live.status === "loading", href: "/admin/operations" },
    { label: "طلبات شحن معلّقة", value: alerts ? formatAr(alerts.pendingTotal) : null, loading: !alerts, href: "/admin/topups" },
  ];
  const action = (
    <div className="flex items-center gap-2">
      {liveAt && <span className="text-xs text-mut">آخر تحديث {agoAr(liveAt, now)}</span>}
      <button type="button" onClick={onRefreshLive} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-sf px-4 text-[13px] font-semibold text-ink">تحديث</button>
    </div>
  );
  return (
    <Card title="اليوم" action={action} testId="today-card">
      <div className="grid grid-cols-2 gap-3 min-[900px]:grid-cols-4">
        {tiles.map((t) => (t.loading ? <CardSkeleton key={t.label} height={92} /> : <StatTile key={t.label} label={t.label} value={t.value} href={t.href} sub={t.sub} />))}
      </div>
      {liveStale && <p className="m-0 text-xs text-mut">تعذّر التحديث</p>}
      {today.status === "error" && <ErrorState onRetry={() => onRetry("today")} />}
      {live.status === "error" && <ErrorState onRetry={() => onRetry("live")} />}
    </Card>
  );
}

function MissionsBody({ o }: { o: OverviewData }) {
  const m = o.missions;
  if (m.total === 0) return <EmptyState title="لا مهام في هذه الفترة." />;
  const pct = m.successPct;
  const level: MeterLevel = pct === null ? "ok" : pct >= 80 ? "ok" : pct >= 50 ? "warn" : "bad";
  const delta = pct !== null && m.successPctPrev !== null ? ` ${deltaAr(Math.round((pct - m.successPctPrev) * 10) / 10)}` : "";
  return (
    <>
      <Meter value={pct ?? 0} max={100} level={level} label="نسبة النجاح" valueText={pct === null ? "—" : `${formatAr(pct)}٪${delta}`} />
      {m.requested > 0 && <p className="m-0 text-[13px] text-ink">سُلِّم {formatAr(m.delivered)} من {formatAr(m.requested)} نتيجة مطلوبة</p>}
      <p className="m-0 text-[13px] text-mut">نجحت {formatAr(m.succeeded)} · فشلت {formatAr(m.failed)} · حجز مُحرَّر {formatAr(m.released)}</p>
      {o.truncated && <p className="m-0 text-xs text-mut">الأرقام حد أدنى: قُرئت أحدث {formatAr(5000)} مهمة فقط.</p>}
    </>
  );
}

function PointsBody({ credit, onRetry }: { credit: FinanceData["credit"]; onRetry: () => void }) {
  // the finance route answers credit: null when the ledger could not be read
  if (!credit) return <ErrorState onRetry={onRetry} />;
  const rows: Array<[string, number]> = [["بيعت", credit.realIncome.points], ["استُهلكت", credit.consumedPoints], ["حجز مُحرَّر", credit.refundedPoints], ["رصيد العملاء الحالي", credit.outstandingPoints]];
  if (rows.every(([, v]) => !v)) return <EmptyState title="لا حركة نقاط في هذه الفترة." />;
  return <div className="grid grid-cols-2 gap-2">{rows.map(([label, v]) => <StatTile key={label} label={label} value={formatAr(Math.round(v))} unit="نقطة" />)}</div>;
}

function ProvidersCard({ providers }: { providers: ProviderStatus | null }) {
  // the shell reads the providers every 60 s; until its first answer the card waits
  if (!providers) return <CardSkeleton height={190} />;
  const { balance, threshold, low } = tregBalanceState(providers.treg);
  const limits = providers.limits;
  const spendLevel: MeterLevel = limits?.level === "reached" ? "bad" : limits?.level === "warn" ? "warn" : "ok";
  return (
    <Card title="المزودون" testId="providers-card" action={<Link href="/admin/providers" className={LINK}>مزودو الخدمة</Link>}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink">رصيد TREG</span>
        {low && <StatusBadge tone="warn">منخفض</StatusBadge>}
      </div>
      {balance === null ? (
        <p className="m-0 text-[13px] text-mut">تعذّر قراءة الرصيد الآن.</p>
      ) : (
        <Meter value={balance} max={threshold ? threshold * 4 : balance} level={low ? "warn" : "ok"} label="الرصيد المتبقي" valueText={`${usd(balance)} دولار`} />
      )}
      {threshold !== null && <p className="m-0 text-xs text-mut">الحد المنبّه {usd(threshold)} دولار</p>}
      {limits && <Meter value={limits.percent} max={100} level={spendLevel} label="الإنفاق اليومي" valueText={`${formatAr(Math.round(limits.percent))}٪ من الحد`} />}
    </Card>
  );
}

function dayLabel(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${toArabicDigits(d)}/${toArabicDigits(m)}`;
}

function VisitsBody({ v }: { v: VisitorsResponse }) {
  const [selected, setSelected] = useState<number | null>(null);
  if (!v.available) return <EmptyState title="تتبّع الزوّار لم يُفعَّل بعد. تفعيله خطوة يقوم بها مالك المنصة." />;
  const daily = v.summary?.daily ?? [];
  const total = sum(daily.map((d) => d.visits));
  if (total === 0) return <EmptyState title="لا زيارات مسجّلة في هذه الفترة." />;
  const series = daily.map((d) => ({ label: dayLabel(d.day), value: d.visits, detail: `${dayLabel(d.day)}: ${formatAr(d.visits)} زيارة · ${formatAr(d.uniqueVisitors)} زائر فريد` }));
  const yesterday = daily.length >= 2 ? daily[daily.length - 2].visits : 0;
  return (
    <>
      <TrendBars label="الزيارات في آخر ١٤ يومًا" series={series} selected={selected} onSelect={setSelected} labelEvery={2} />
      <p className="m-0 text-[13px] text-mut">أمس {formatAr(yesterday)} · مجموع ١٤ يومًا {formatAr(total)}</p>
    </>
  );
}

function MoneyBody({ s, range, isMobile, now }: { s: StatsData; range: Range; isMobile: boolean; now: number }) {
  const [selected, setSelected] = useState<number | null>(null);
  const buckets = useMemo(() => {
    const { rev, cost } = s.series;
    if (range === 90) {
      return Array.from({ length: 13 }, (_, w) => ({ rev: sum(rev.slice(w * 7, w * 7 + 7)), cost: sum(cost.slice(w * 7, w * 7 + 7)), label: `أ${toArabicDigits(w + 1)}`, full: `الأسبوع ${toArabicDigits(w + 1)}` }));
    }
    return rev.map((r, i) => {
      const d = new Date(now - (range - 1 - i) * 86400000);
      const lbl = `${toArabicDigits(d.getDate())}/${toArabicDigits(d.getMonth() + 1)}`;
      return { rev: r, cost: cost[i], label: lbl, full: lbl };
    });
  }, [s, range, now]);
  const t = s.totals;
  const series = buckets.map((b) => ({ label: b.label, value: b.rev, value2: b.cost, detail: `${b.full}: الشحن ${EGP(b.rev)} · التكلفة ${EGP(b.cost)} · الربح ${EGP(b.rev - b.cost)}` }));
  return (
    <>
      <div className="grid grid-cols-1 gap-2 min-[600px]:grid-cols-3">
        <StatTile label="إيرادات الشحن" value={formatAr(Math.round(t.rev))} unit="ج.م" delta={t.change.rev} sub="شحنات معتمدة عبر إنستاباي" href="/admin/finance" />
        <StatTile label="التكلفة" value={formatAr(Math.round(t.cost))} unit="ج.م" tone="warn" />
        <StatTile label="صافي الربح" value={formatAr(Math.round(t.profit))} unit="ج.م" delta={t.change.profit} sub={t.margin === null ? "لا إيرادات بعد" : `هامش ${toArabicDigits(t.margin.toFixed(1)).replace(".", "٫")}٪`} href="/admin/finance" />
      </div>
      <div className="flex flex-wrap gap-3 text-[12px] text-mut">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: "var(--bar)" }} />الشحن</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: "var(--bar2)" }} />التكلفة</span>
      </div>
      <TrendBars label="الشحن والتكلفة" series={series} selected={selected} onSelect={setSelected} height={180} labelEvery={range === 7 ? 1 : range === 30 ? (isMobile ? 10 : 5) : 2} />
    </>
  );
}

function GrowthBody({ s, range }: { s: StatsData; range: Range }) {
  const t = s.totals;
  const nUsers = Math.min(range === 90 ? 26 : range, 30);
  const stepU = Math.max(1, Math.floor(range / nUsers));
  const userBars = Array.from({ length: nUsers }, (_, i) => sum(s.series.newUsers.slice(i * stepU, i * stepU + stepU)));
  const mxU = Math.max(...userBars, 1);
  const pct = (v: number) => (s.funnel.signed ? (v / s.funnel.signed) * 100 : 0);
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <StatTile label="مستخدمون جدد" value={formatAr(t.newUsers)} delta={t.change.newUsers} sub={`مقابل ${formatAr(t.newUsersPrev)} في الفترة السابقة`} />
        <StatTile label="نشطون" value={formatAr(t.active)} delta={t.change.active} />
      </div>
      <p className="m-0 text-[13px] text-mut">إجمالي المستخدمين {formatAr(t.users)}</p>
      <div aria-hidden="true" className="flex h-24 items-end gap-[3px]">
        {userBars.map((v, i) => <span key={i} className="flex-1 rounded-t-[3px]" style={{ height: `${Math.max(6, (v / mxU) * 100)}%`, background: i === userBars.length - 1 ? "var(--gold)" : "var(--info)" }} />)}
      </div>
      <div className="flex flex-col gap-2.5 border-t border-ln pt-3">
        {([["سجّلوا", s.funnel.signed, 100, "var(--info)"], ["أرسلوا أول سؤال", s.funnel.asked, pct(s.funnel.asked), "var(--bar)"], ["شحنوا رصيدًا", s.funnel.paid, pct(s.funnel.paid), "var(--bar2)"]] as const).map(([k, v, w, c]) => (
          <div key={k}>
            <div className="flex justify-between text-xs"><span className="text-mut">{k}</span><span className="font-semibold text-ink">{formatAr(v)}</span></div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-md bg-sf2"><div className="h-full rounded-md" style={{ width: `${w}%`, background: c }} /></div>
          </div>
        ))}
      </div>
    </>
  );
}

/** A request line of the feed, from overview.recentMissions (the `missions` table). The account's name is in its sheet (one tap). */
function missionEvent(m: RecentMission, now: number): ActivityEvent {
  const what = m.status === "completed" ? "اكتمل طلبه" : m.status === "failed" ? "تعذّر تنفيذ طلبه" : m.status === "cancelled" ? "أُلغي طلبه" : "أرسل طلبًا جديدًا";
  const value = m.status === "completed" && m.delivered_units ? `${formatAr(m.delivered_units)} نتيجة` : "";
  return { type: "jobs", who: "عميل", what, at: m.created_at, when: agoAr(m.created_at, now), value, tone: "ink", userId: m.user_id };
}

function ActivityCard({ slots, now, onRetry, onOpenUser }: { slots: OverviewSlots; now: number; onRetry: (key: SlotKey) => void; onOpenUser: (id: string) => void }) {
  const { stats, overview } = slots;
  if (stats.status === "loading" && overview.status === "loading") return <CardSkeleton height={260} />;
  if (stats.status === "error" && overview.status === "error") {
    return <Card title="أحدث النشاطات" testId="activity-card"><ErrorState onRetry={() => { onRetry("stats"); onRetry("overview"); }} /></Card>;
  }
  // the stats feed's request lines read the stale `jobs` table: the overview's missions replace them
  const events = [
    ...(stats.status === "ready" ? stats.data.activity.filter((a) => a.type !== "jobs") : []),
    ...(overview.status === "ready" ? overview.data.recentMissions.map((m) => missionEvent(m, now)) : []),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  return (
    <Card title="أحدث النشاطات" testId="activity-card" action={<span className="flex items-center gap-1.5 text-xs text-ok"><span className="h-1.5 w-1.5 rounded-full bg-ok" />مباشر</span>}>
      {events.length === 0 ? <EmptyState title="لا نشاط بعد." /> : (
        <ul className="m-0 flex list-none flex-col p-0">
          {events.map((a, i) => {
            const c = TONE[a.tone];
            const body = (
              <>
                <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[11px]" style={{ background: tint(a.tone === "gold" ? "var(--gold)" : c, 14), color: c }}><AIcon d={ADMIN_IC[a.type]} size={16} stroke={1.8} /></span>
                <span className="min-w-0 flex-1"><span className="block text-[13px] leading-[1.6] text-ink"><strong className="font-semibold">{a.who}</strong> {a.what}</span><span className="mt-0.5 block text-[12px] text-mut">{a.when}</span></span>
                {a.value && <span dir={a.userId !== undefined ? undefined : "ltr"} className="whitespace-nowrap text-xs font-semibold" style={{ color: a.tone === "ink" ? "var(--mut)" : c }}>{a.value}</span>}
              </>
            );
            return (
              <li key={`${a.at}-${i}`} className="border-b border-ln last:border-b-0">
                {a.userId ? (
                  <button type="button" onClick={() => onOpenUser(a.userId!)} className="flex min-h-11 w-full cursor-pointer items-start gap-3 border-0 bg-transparent py-[11px] text-start">{body}</button>
                ) : (
                  <div className="flex items-start gap-3 py-[11px]">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {stats.status === "error" && <ErrorState onRetry={() => onRetry("stats")} />}
      {overview.status === "error" && <ErrorState onRetry={() => onRetry("overview")} />}
    </Card>
  );
}

function PayersBody({ s, onOpenUser }: { s: StatsData; onOpenUser: (id: string) => void }) {
  if (s.topPayers.length === 0) return <EmptyState title="لا شحنات معتمدة بعد." />;
  return (
    <div className="flex flex-col">
      {s.topPayers.map((p, i) => (
        <button key={p.id} type="button" onClick={() => onOpenUser(p.id)} className="flex min-h-14 w-full cursor-pointer items-center gap-3 border-0 border-b border-ln bg-transparent py-2.5 text-start">
          <span className="w-[22px] text-xs text-mut">{formatAr(i + 1)}</span>
          <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-sf2 text-xs font-semibold text-ink2">{initials(p.name)}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold text-ink">{p.name || "—"}</span><span dir="ltr" className="block truncate text-end text-[12px] text-mut">{p.email}</span></span>
          <span className="text-end"><span className="block whitespace-nowrap text-[13px] font-semibold text-ink">{EGP(p.total)}</span><span className="block whitespace-nowrap text-[12px] text-mut">آخر شحن {p.last}</span></span>
        </button>
      ))}
    </div>
  );
}
