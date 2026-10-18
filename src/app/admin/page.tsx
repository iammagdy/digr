"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { adminFetch } from "@/lib/adminApi";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import { useUser } from "@/hooks/useUser";
import { useAdmin } from "@/components/admin/AdminShell";
import { UserSheet } from "@/components/admin/UserSheet";
import { ProviderAlertBanner } from "@/components/admin/ProviderAlertBanner";
import { ADMIN_IC, AIcon } from "@/components/admin/icons";
import { EGP, initials, tint } from "@/components/admin/format";

interface Stats {
  range: number;
  totals: {
    users: number; newUsers: number; newUsersPrev: number; active: number; rev: number; cost: number; profit: number; margin: number | null; jobs: number;
    change: { users: number; newUsers: number; active: number; rev: number; profit: number; jobs: number };
  };
  series: { rev: number[]; cost: number[]; newUsers: number[]; active: number[]; jobs: number[] };
  funnel: { signed: number; asked: number; paid: number };
  activity: Array<{ type: "signup" | "pay" | "jobs" | "check"; who: string; what: string; when: string; value: string; tone: "info" | "gold" | "ink" | "ok" }>;
  topPayers: Array<{ id: string; name: string; email: string; total: number; last: string }>;
  pendingCount: number;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const TONE: Record<string, string> = { info: "var(--info)", gold: "var(--goldT)", ink: "var(--ink2)", ok: "var(--ok)" };
const CARD = "min-w-0 rounded-[22px] border border-ln bg-sf p-[18px]";

function spark(series: number[], n = 14) {
  const step = Math.max(1, Math.floor(series.length / n));
  const pts: number[] = [];
  for (let i = 0; i < n; i += 1) pts.push(sum(series.slice(i * step, i * step + step)));
  const mx = Math.max(...pts, 1);
  return pts.map((v, i) => ({ h: Math.max(8, (v / mx) * 100), op: 0.35 + (i / n) * 0.65 }));
}

function delta(pct: number) {
  const good = pct >= 0;
  return { text: `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}%`, bg: tint(good ? "var(--ok)" : "var(--bad)", 13), fg: good ? "var(--ok)" : "var(--bad)" };
}

export default function AdminOverview() {
  const router = useRouter();
  const { user } = useUser();
  const { range, isMobile } = useAdmin();
  const [s, setS] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const [hover, setHover] = useState<number | null>(null);
  const [openUser, setOpenUser] = useState<string | null>(null);

  useEffect(() => {
    setS(null); setError("");
    adminFetch<Stats>(`/api/admin/stats?range=${range}`).then(setS).catch((e) => setError(e.message));
  }, [range]);

  const buckets = useMemo(() => {
    if (!s) return [];
    const { rev, cost } = s.series;
    if (range === 90) {
      return Array.from({ length: 13 }, (_, w) => ({ rev: sum(rev.slice(w * 7, w * 7 + 7)), cost: sum(cost.slice(w * 7, w * 7 + 7)), label: `أ${toArabicDigits(w + 1)}`, full: `الأسبوع ${toArabicDigits(w + 1)}` }));
    }
    return rev.map((r, i) => {
      const back = range - 1 - i;
      const d = new Date(Date.now() - back * 86400000);
      const lbl = `${toArabicDigits(d.getDate())}/${toArabicDigits(d.getMonth() + 1)}`;
      return { rev: r, cost: cost[i], label: range === 7 || i % 5 === 4 || back === 0 ? lbl : "", full: lbl };
    });
  }, [s, range]);

  const hour = new Date().getHours();
  const greeting = `${hour >= 5 && hour < 12 ? "صباح الخير" : "مساء الخير"}، ${(user?.name || "").split(" ")[0]}`;

  if (error) return <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>;
  if (!s) return <div className="flex flex-col gap-4">{[0, 1, 2].map((i) => <div key={i} className="h-40 rounded-[22px] bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />)}</div>;

  const t = s.totals;
  const kpis = [
    { label: "إجمالي المستخدمين", value: formatAr(t.users), unit: "", d: delta(t.change.users), sub: `+${formatAr(t.newUsers)} خلال الفترة`, spark: spark(s.series.newUsers), color: "var(--bar)", go: "/admin/users" },
    { label: "مستخدمون جدد", value: formatAr(t.newUsers), unit: "", d: delta(t.change.newUsers), sub: `مقابل ${formatAr(t.newUsersPrev)} في الفترة السابقة`, spark: spark(s.series.newUsers), color: "var(--info)", go: "/admin/users" },
    { label: "المستخدمون النشطون", value: formatAr(t.active), unit: "", d: delta(t.change.active), sub: "سجّلوا دخولًا مرة على الأقل", spark: spark(s.series.active), color: "var(--bar)", go: "/admin/users" },
    { label: "إيرادات الشحن", value: formatAr(Math.round(t.rev)), unit: "ج.م", d: delta(t.change.rev), sub: "شحنات معتمدة عبر إنستاباي", spark: spark(s.series.rev), color: "var(--bar2)", go: "/admin/finance" },
    { label: "صافي الربح", value: formatAr(Math.round(t.profit)), unit: "ج.م", d: delta(t.change.profit), sub: t.margin === null ? "لا إيرادات بعد" : `هامش ${toArabicDigits(t.margin.toFixed(1)).replace(".", "٫")}٪`, spark: spark(s.series.rev.map((r, i) => Math.max(0, r - s.series.cost[i]))), color: "var(--ok)", go: "/admin/finance" },
    { label: "عمليات البحث", value: formatAr(t.jobs), unit: "", d: delta(t.change.jobs), sub: "مهمة جمع بيانات منفذة", spark: spark(s.series.jobs), color: "var(--bar)", go: "/admin/jobs" },
  ];

  const maxBar = Math.max(...buckets.map((b) => b.rev), 1) * 1.08;
  const nB = buckets.length;
  const profitPath = buckets.map((b, i) => `${i ? "L" : "M"}${(((i + 0.5) / nB) * 100).toFixed(2)} ${(100 - (Math.max(0, b.rev - b.cost) / maxBar) * 100).toFixed(2)}`).join(" ");
  const hv = hover != null ? buckets[hover] : null;
  const gap = range === 7 ? 12 : range === 30 ? (isMobile ? 1 : 3) : 6;

  const nUsers = Math.min(range === 90 ? 26 : range, 30);
  const stepU = Math.max(1, Math.floor(range / nUsers));
  const userBars = Array.from({ length: nUsers }, (_, i) => sum(s.series.newUsers.slice(i * stepU, i * stepU + stepU)));
  const mxU = Math.max(...userBars, 1);
  const pct = (v: number) => (s.funnel.signed ? (v / s.funnel.signed) * 100 : 0);

  return (
    <div data-screen-label="Overview" className="flex flex-col gap-4">
      <ProviderAlertBanner />
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="m-0 font-display text-[32px] leading-[1.1] text-ink">{greeting}</p>
          <p className="mb-0 mt-1 text-[13px] text-mut">ملخص آخر {formatAr(range)} يومًا مقارنةً بالفترة السابقة</p>
        </div>
        {s.pendingCount > 0 && (
          <button type="button" onClick={() => router.push("/admin/topups")} className="flex min-h-11 cursor-pointer items-center gap-2 whitespace-nowrap rounded-full px-4 text-[13px] font-semibold text-goldT" style={{ border: "1px solid var(--gold)", background: tint("var(--gold)", 10) }}>
            <span className="h-[7px] w-[7px] rounded-full bg-gold" style={{ animation: "pulse 1.6s infinite" }} />{formatAr(s.pendingCount)} طلبات شحن بانتظار مراجعتك
          </button>
        )}
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fill,minmax(min(100%,${isMobile ? 150 : 200}px),1fr))` }}>
        {kpis.map((k) => (
          <button key={k.label} type="button" onClick={() => router.push(k.go)} className="flex cursor-pointer flex-col gap-2.5 rounded-[20px] border border-ln bg-sf p-4 text-right text-ink transition-[border-color,box-shadow] hover:border-ln2 hover:shadow-[var(--admin-shadow)]" style={{ animation: "up .4s both" }}>
            <span className="flex items-center justify-between gap-2"><span className="text-xs text-mut">{k.label}</span><span dir="ltr" className="whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: k.d.bg, color: k.d.fg }}>{k.d.text}</span></span>
            <span className="whitespace-nowrap font-display leading-none text-ink" style={{ fontSize: isMobile ? 30 : 38 }}>{k.value}<span className="text-xs text-fnt" style={{ fontFamily: "var(--font-sans)", marginInlineStart: 6 }}>{k.unit}</span></span>
            <span className="flex h-[26px] items-end gap-0.5">
              {k.spark.map((p, i) => <span key={i} className="flex-1 rounded-sm" style={{ height: `${p.h}%`, background: k.color, opacity: p.op, transformOrigin: "bottom", animation: "grow .6s both" }} />)}
            </span>
            <span className="text-[11px] text-fnt">{k.sub}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: isMobile ? "1fr" : "minmax(0,2fr) minmax(0,1fr)" }}>
        <section className={CARD}>
          <div className="flex flex-wrap items-start justify-between gap-2.5">
            <div><h2 className="m-0 text-[15px] font-semibold text-ink">الإيرادات والتكاليف</h2><p className="mb-0 mt-1 text-xs text-fnt">شحن معتمد مقابل تكلفة المزودين (TREG + النماذج)</p></div>
            <div className="flex flex-wrap gap-3 text-[11px] text-mut">
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: "var(--bar)" }} />الشحن</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: "var(--bar2)" }} />التكلفة</span>
              <span className="flex items-center gap-1.5"><span className="h-0.5 w-3.5 rounded-sm" style={{ background: "var(--ok)" }} />صافي الربح</span>
            </div>
          </div>
          <div className="mt-3.5 grid grid-cols-3 gap-2">
            {[["الشحن", EGP(t.rev), "var(--ink)"], ["التكلفة", EGP(t.cost), "var(--goldT)"], ["الربح", EGP(t.profit), "var(--ok)"]].map(([k, v, c]) => (
              <div key={k} className="rounded-[14px] bg-sf2 px-3 py-2.5"><p className="m-0 text-[11px] text-mut">{k}</p><p className="mb-0 mt-1 whitespace-nowrap font-semibold" style={{ fontSize: isMobile ? 13 : 16, color: c }}>{v}</p></div>
            ))}
          </div>
          <div className="relative mt-4 h-[210px]" onMouseLeave={() => setHover(null)}>
            <div className="pointer-events-none absolute flex flex-col justify-between" style={{ inset: "0 0 22px 0" }}>{[0, 1, 2, 3].map((i) => <span key={i} className="h-px bg-ln" />)}</div>
            <div dir="ltr" className="absolute flex items-end" style={{ inset: "0 0 22px 0", gap }}>
              {buckets.map((b, i) => (
                <div key={i} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)} className="flex h-full flex-1 cursor-pointer items-end justify-center gap-px rounded" style={{ background: hover === i ? "var(--sf2)" : "transparent" }}>
                  <span style={{ width: "46%", height: `${(b.rev / maxBar) * 100}%`, borderRadius: "3px 3px 0 0", background: "var(--bar)", transformOrigin: "bottom", animation: "grow .7s cubic-bezier(.2,.7,.2,1) both" }} />
                  <span style={{ width: "34%", height: `${(b.cost / maxBar) * 100}%`, borderRadius: "3px 3px 0 0", background: "var(--bar2)", transformOrigin: "bottom", animation: "grow .7s .08s cubic-bezier(.2,.7,.2,1) both" }} />
                </div>
              ))}
            </div>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute w-full overflow-visible" style={{ inset: "0 0 22px 0", height: "calc(100% - 22px)" }} aria-hidden="true">
              <path d={profitPath} fill="none" stroke="var(--ok)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
            <div dir="ltr" className="absolute inset-x-0 bottom-0 flex h-[18px]" style={{ gap }}>
              {buckets.map((b, i) => <span key={i} className="flex-1 overflow-visible whitespace-nowrap text-center text-[10px] text-fnt">{isMobile && range === 30 ? (i % 10 === 9 ? b.label : "") : b.label}</span>)}
            </div>
            {hv && (
              <div className="pointer-events-none absolute z-[3] min-w-[150px] -translate-x-1/2 rounded-xl bg-ink px-3 py-2 text-[11px] leading-[1.8] text-bg" style={{ top: -6, left: `${Math.min(85, Math.max(15, ((hover! + 0.5) / nB) * 100))}%`, boxShadow: "var(--admin-shadow)", animation: "fade .15s both" }}>
                <p className="m-0 font-bold">{hv.full}</p><p className="m-0">الشحن: {EGP(hv.rev)}</p><p className="m-0">التكلفة: {EGP(hv.cost)}</p><p className="m-0">الربح: {EGP(hv.rev - hv.cost)}</p>
              </div>
            )}
          </div>
        </section>

        <section className={`${CARD} flex flex-col gap-3.5`}>
          <div className="flex items-center justify-between"><h2 className="m-0 text-[15px] font-semibold text-ink">نمو المستخدمين</h2><span className="text-[11px] text-fnt">آخر {formatAr(range)} يومًا</span></div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-[14px] bg-sf2 p-3"><p className="m-0 text-[11px] text-mut">مستخدمون جدد</p><p className="mb-0 mt-1 font-display text-[32px] leading-none text-ink">{formatAr(t.newUsers)}</p></div>
            <div className="rounded-[14px] bg-sf2 p-3"><p className="m-0 text-[11px] text-mut">نشطون</p><p className="mb-0 mt-1 font-display text-[32px] leading-none text-ink">{formatAr(t.active)}</p></div>
          </div>
          <div dir="ltr" className="flex h-24 items-end gap-[3px]">
            {userBars.map((v, i) => <span key={i} className="flex-1" style={{ height: `${Math.max(6, (v / mxU) * 100)}%`, borderRadius: "3px 3px 0 0", background: i === userBars.length - 1 ? "var(--gold)" : "var(--info)", transformOrigin: "bottom", animation: "grow .7s both" }} />)}
          </div>
          <div className="flex flex-col gap-2.5 border-t border-ln pt-3">
            {[["سجّلوا", s.funnel.signed, 100, "var(--info)"], ["أرسلوا أول سؤال", s.funnel.asked, pct(s.funnel.asked), "var(--bar)"], ["شحنوا رصيدًا", s.funnel.paid, pct(s.funnel.paid), "var(--bar2)"]].map(([k, v, w, c]) => (
              <div key={k as string}>
                <div className="flex justify-between text-xs"><span className="text-mut">{k}</span><span className="font-semibold text-ink">{formatAr(v as number)}</span></div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-md bg-sf2"><div className="h-full rounded-md" style={{ width: `${w}%`, background: c as string }} /></div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: isMobile ? "1fr" : "minmax(0,1.2fr) minmax(0,1fr)" }}>
        <section className={CARD}>
          <div className="mb-1.5 flex items-center justify-between"><h2 className="m-0 text-[15px] font-semibold text-ink">أحدث النشاطات</h2><span className="flex items-center gap-1.5 text-[11px] text-ok"><span className="h-1.5 w-1.5 rounded-full bg-ok" style={{ animation: "pulse 1.6s infinite" }} />مباشر</span></div>
          {s.activity.map((a, i) => {
            const c = TONE[a.tone];
            return (
              <div key={i} className="flex items-start gap-3 border-b border-ln py-[11px]">
                <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[11px]" style={{ background: tint(a.tone === "gold" ? "var(--gold)" : c, 14), color: c }}><AIcon d={ADMIN_IC[a.type === "jobs" ? "jobs" : a.type]} size={16} stroke={1.8} /></span>
                <div className="min-w-0 flex-1"><p className="m-0 text-[13px] leading-[1.6] text-ink"><strong className="font-semibold">{a.who}</strong> {a.what}</p><p className="mb-0 mt-0.5 text-[11px] text-fnt">{a.when}</p></div>
                <span dir="ltr" className="whitespace-nowrap text-xs font-semibold" style={{ color: a.tone === "ink" ? "var(--mut)" : c }}>{a.value}</span>
              </div>
            );
          })}
          {s.activity.length === 0 && <p className="m-0 py-6 text-center text-[13px] text-fnt">لا نشاط بعد.</p>}
        </section>
        <section className={CARD}>
          <div className="mb-1.5 flex items-center justify-between"><h2 className="m-0 text-[15px] font-semibold text-ink">الأعلى شحنًا</h2><button type="button" onClick={() => router.push("/admin/users")} className="min-h-11 cursor-pointer border-0 bg-transparent text-xs font-semibold text-goldT">كل المستخدمين ←</button></div>
          {s.topPayers.map((p, i) => (
            <button key={p.id} type="button" onClick={() => setOpenUser(p.id)} className="flex min-h-14 w-full cursor-pointer items-center gap-3 border-0 border-b border-ln bg-transparent py-2.5 text-right">
              <span className="w-[22px] text-xs text-fnt">{formatAr(i + 1)}</span>
              <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-sf2 text-xs font-semibold text-ink2">{initials(p.name)}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold text-ink">{p.name || "—"}</span><span dir="ltr" className="block truncate text-right text-[11px] text-fnt">{p.email}</span></span>
              <span className="text-left"><span className="block whitespace-nowrap text-[13px] font-semibold text-ink">{EGP(p.total)}</span><span className="block whitespace-nowrap text-[11px] text-fnt">آخر شحن {p.last}</span></span>
            </button>
          ))}
          {s.topPayers.length === 0 && <p className="m-0 py-6 text-center text-[13px] text-fnt">لا شحنات معتمدة بعد.</p>}
        </section>
      </div>

      {openUser && <UserSheet userId={openUser} onClose={() => setOpenUser(null)} />}
    </div>
  );
}
