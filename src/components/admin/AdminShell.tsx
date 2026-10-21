"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Logo } from "@/components/Brand";
import { useUser } from "@/hooks/useUser";
import { useTheme } from "@/lib/theme";
import { adminFetch } from "@/lib/adminApi";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import { ADMIN_IC, ADMIN_PAGES, AIcon, adminHref, type AdminPageId } from "./icons";
import { EGP, agoAr, initials, tint } from "./format";

export type Range = 7 | 30 | 90;

export interface AdminAlerts {
  pendingTopups: Array<{ id: string; senderName: string; reference: string; amountEgp: number; createdAt: string }>;
  pendingTotal: number;
  newUsers: { total: number; latest: { name: string; at: string } | null };
  failedJobs: Array<{ id: string; reservedCredits: number; createdAt: string }>;
  failedTotal: number;
}
/** Result of a real authenticated provider call (never a flag). */
export interface ProviderHealth { ok: boolean; reason: string; httpStatus: number | null; statusClass: string; latencyMs: number | null; checkedAt: string }
export interface ProviderStatus {
  llm: { enabled: boolean; provider: string; model: string; keyEnv: string; modelEnv: string; keyConfigured: boolean; keyLast4: string | null; keySource?: string; health?: ProviderHealth; lastUsage: string | null; fallbackReason: string | null; callsToday: number; costTodayEgp: number };
  treg: {
    live: boolean; tokenConfigured: boolean; tokenLast4: string | null; keySource?: string; health?: ProviderHealth;
    balance?: { available: boolean; balanceUsd?: number; unavailableReason?: string; checkedAt: string };
    thresholdUsd?: number; lowBalance?: boolean; baseUrl: string; lastCall: string | null; callsToday: number;
  };
  /** Today's recorded spend against the admin-set limits (drives the warning banner on the home page). */
  limits?: { level: "ok" | "warn" | "reached"; percent: number; llmLevel: "ok" | "warn" | "reached"; llmPercent: number };
}

interface AdminCtx {
  range: Range;
  setRange: (r: Range) => void;
  alerts: AdminAlerts | null;
  providers: ProviderStatus | null;
  refresh: () => void;
  isMobile: boolean;
  /** Opens a top-up sheet from anywhere (bell, user sheet). */
  pendingOpenTopup: string | null;
  setPendingOpenTopup: (id: string | null) => void;
  toast: (msg: string) => void;
}
const Ctx = createContext<AdminCtx | null>(null);
export const useAdmin = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAdmin outside AdminShell");
  return c;
};

const RANGE_KEY = "diger:admin:range";
const SEEN_KEY = "diger:admin:alertsSeen";

function useIsMobile(bp = 900) {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp - 1}px)`);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [bp]);
  return m;
}

export function AdminShell({ children }: { children: ReactNode }) {
  const { user, logout } = useUser();
  const { theme, toggleTheme } = useTheme();
  const pathname = usePathname();
  const router = useRouter();
  const mobile = useIsMobile();
  const [wide, setWide] = useState(false);

  const [range, setRangeState] = useState<Range>(30);
  const [alerts, setAlerts] = useState<AdminAlerts | null>(null);
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [bell, setBell] = useState(false);
  const [seen, setSeen] = useState("");
  const [q, setQ] = useState("");
  const [toastMsg, setToastMsg] = useState("");
  const [pendingOpenTopup, setPendingOpenTopup] = useState<string | null>(null);

  const page: AdminPageId = (ADMIN_PAGES.find(([id]) => id !== "overview" && pathname.startsWith(adminHref(id)))?.[0] ?? "overview") as AdminPageId;
  const title = ADMIN_PAGES.find(([id]) => id === page)![1];

  useEffect(() => {
    try {
      const r = Number(localStorage.getItem(RANGE_KEY));
      if (r === 7 || r === 30 || r === 90) setRangeState(r);
      setSeen(localStorage.getItem(SEEN_KEY) || "");
    } catch { /* storage blocked */ }
    const mq = window.matchMedia("(min-width: 1280px)");
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const setRange = useCallback((r: Range) => { setRangeState(r); try { localStorage.setItem(RANGE_KEY, String(r)); } catch { /* ignore */ } }, []);

  const refresh = useCallback(() => {
    adminFetch<AdminAlerts>("/api/admin/alerts").then(setAlerts).catch(() => {});
    adminFetch<ProviderStatus>("/api/admin/providers").then(setProviders).catch(() => {});
  }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 60000); return () => clearInterval(t); }, [refresh]);

  // One «تسجيل دخول» audit entry per browser session.
  useEffect(() => {
    try {
      if (sessionStorage.getItem("diger:admin:logged")) return;
      sessionStorage.setItem("diger:admin:logged", "1");
    } catch { /* ignore */ }
    adminFetch("/api/admin/audit", { method: "POST" }).catch(() => {});
  }, []);

  useEffect(() => { setDrawer(false); setBell(false); }, [pathname]);

  const toast = useCallback((m: string) => { setToastMsg(m); setTimeout(() => setToastMsg(""), 2600); }, []);

  const pendingCount = alerts?.pendingTotal ?? 0;
  const bellItems = useMemo(() => {
    if (!alerts) return [];
    const items: Array<{ key: string; icon: string; color: string; title: string; body: string; when: string; go: () => void; fresh: boolean }> = [];
    for (const t of alerts.pendingTopups) {
      items.push({
        key: `t${t.id}`, icon: ADMIN_IC.pay, color: "var(--goldT)", title: `طلب شحن جديد · ${EGP(t.amountEgp)}`,
        body: `${t.senderName || "—"} · ${t.reference}`, when: agoAr(t.createdAt), fresh: true,
        go: () => { setPendingOpenTopup(t.id); router.push("/admin/topups"); },
      });
    }
    if (alerts.newUsers.total > 0) {
      items.push({
        key: "nu", icon: ADMIN_IC.signup, color: "var(--info)", fresh: false,
        title: `${formatAr(alerts.newUsers.total)} ${alerts.newUsers.total === 1 ? "مستخدم جديد" : alerts.newUsers.total <= 10 ? "مستخدمين جدد" : "مستخدمًا جديدًا"} اليوم`,
        body: alerts.newUsers.latest ? `آخرهم ${alerts.newUsers.latest.name || "—"} ${agoAr(alerts.newUsers.latest.at)}` : "", when: "اليوم", go: () => router.push("/admin/users"),
      });
    }
    if (alerts.failedTotal > 0) {
      items.push({
        key: "fj", icon: ADMIN_IC.alert, color: "var(--bad)", fresh: false, title: "فشل بحث واسترداد",
        body: `رجعت ${formatAr(alerts.failedJobs[0]?.reservedCredits ?? 0)} نقطة للمستخدم`, when: agoAr(alerts.failedJobs[0]?.createdAt), go: () => router.push("/admin/jobs"),
      });
    }
    return items;
  }, [alerts, router]);
  const signature = bellItems.map((i) => i.key).join("|");
  const unread = bellItems.length > 0 && seen !== signature ? bellItems.length : 0;
  const openBell = () => {
    setBell((v) => !v);
    try { localStorage.setItem(SEEN_KEY, signature); } catch { /* ignore */ }
    setSeen(signature);
  };

  const hasRange = page === "overview" || page === "finance";
  const rangeSwitch = (
                  <div className="flex gap-0.5 rounded-xl bg-sf2 p-[3px]" role="group" aria-label="الفترة">
      {([7, 30, 90] as Range[]).map((r) => (
        <button
          key={r} type="button" onClick={() => setRange(r)} aria-pressed={range === r}
          className="min-h-11 min-w-11 cursor-pointer whitespace-nowrap rounded-[9px] border-0 px-2.5 text-xs font-semibold"
          style={{ background: range === r ? "var(--sf)" : "transparent", color: range === r ? "var(--ink)" : "var(--mut)", boxShadow: range === r ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}
        >
          {mobile ? `${toArabicDigits(r)}ي` : `${toArabicDigits(r)} ${r === 7 ? "أيام" : "يومًا"}`}
        </button>
      ))}
    </div>
  );
  const ctx = useMemo<AdminCtx>(() => ({ range, setRange, alerts, providers, refresh, isMobile: mobile, pendingOpenTopup, setPendingOpenTopup, toast }), [range, setRange, alerts, providers, refresh, mobile, pendingOpenTopup, toast]);

  // The dots come from a real authenticated call to each provider (cached 60 s on the server), not from a flag.
  const llmDot = !providers ? "var(--ln2)" : !providers.llm.enabled ? "var(--bad)" : providers.llm.provider === "fake" ? "var(--gold)" : providers.llm.health ? (providers.llm.health.ok ? "var(--ok)" : "var(--bad)") : "var(--ln2)";
  const tregDot = !providers ? "var(--ln2)" : providers.treg.health ? (providers.treg.health.ok ? (providers.treg.lowBalance ? "var(--gold)" : "var(--ok)") : "var(--bad)") : "var(--ln2)";
  const llmShort = !providers ? "…" : !providers.llm.enabled ? "متوقف" : providers.llm.provider === "fake" ? "وضع تجريبي" : providers.llm.health ? (providers.llm.health.ok ? "متصل فعليًا" : "لا يستجيب") : "…";
  const tregShort = !providers ? "…" : providers.treg.health ? (providers.treg.health.ok ? (providers.treg.lowBalance ? "رصيد منخفض" : "متصل فعليًا") : "لا يستجيب") : "…";

  const navItems = ADMIN_PAGES.map(([id, label]) => ({ id, label, icon: ADMIN_IC[id], on: page === id, badge: id === "topups" ? pendingCount : 0 }));
  const bottom: Array<{ id: string; label: string; icon: string; on: boolean; badge: number; go: () => void }> = [
    ["overview", "الرئيسية"], ["users", "المستخدمون"], ["topups", "الشحن"], ["providers", "المزودون"], ["more", "المزيد"],
  ].map(([id, label]) => ({
    id, label, icon: ADMIN_IC[id as keyof typeof ADMIN_IC],
    on: page === id || (id === "more" && ["jobs", "operations", "finance", "audit", "requests", "settings"].includes(page)),
    badge: id === "topups" ? pendingCount : 0,
    go: id === "more" ? () => setDrawer(true) : () => router.push(adminHref(id as AdminPageId)),
  }));

  const exit = () => router.push("/dashboard/chat");
  const NavButton = ({ n, big }: { n: (typeof navItems)[number]; big?: boolean }) => (
    <Link
      href={adminHref(n.id)} aria-current={n.on ? "page" : undefined}
      className={`relative flex shrink-0 items-center gap-3 rounded-xl px-3 text-right text-sm transition-colors hover:bg-sf2 ${big ? "min-h-12" : "min-h-11"} ${n.on ? "bg-sf2 font-semibold text-ink" : "bg-transparent font-medium text-mut"}`}
    >
      <AIcon d={n.icon} />
      <span className="flex-1">{n.label}</span>
      {n.badge > 0 && <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-gold px-[7px] text-[11px] font-bold text-white">{formatAr(n.badge)}</span>}
      {!big && <span className="absolute bottom-2.5 top-2.5 w-[3px] rounded-[3px] bg-gold" style={{ right: -14, opacity: n.on ? 1 : 0 }} />}
    </Link>
  );

  return (
    <Ctx.Provider value={ctx}>
      <div data-area="admin" className="bg-bg text-ink2" style={{ minHeight: "100dvh", height: mobile ? undefined : "100dvh", overflow: mobile ? undefined : "hidden", containerType: "inline-size" }}>
        <div className="flex items-stretch" style={{ minHeight: mobile ? "100dvh" : undefined, height: mobile ? "auto" : "100%", overflow: mobile ? "visible" : "hidden" }}>
          {!mobile && (
            <aside className="flex h-full min-h-0 w-[252px] shrink-0 flex-col gap-0.5 overflow-hidden border-ln bg-sf px-3.5 py-5" style={{ borderInlineEnd: "1px solid var(--ln)" }}>
              <div className="flex items-center gap-2.5 px-2 pb-[22px]">
                <Logo height={28} />
                <span className="rounded-full px-[9px] py-0.5 text-[11px] font-semibold text-goldT" style={{ background: tint("var(--gold)", 16) }}>إدارة</span>
              </div>
              <nav aria-label="الإدارة" className="-mx-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5">
                {navItems.map((n) => <NavButton key={n.id} n={n} />)}
              </nav>
              <div className="mt-3 flex shrink-0 flex-col gap-2.5 rounded-2xl bg-sf2 p-3.5">
                <p className="m-0 text-[11px] font-semibold text-mut">حالة المزودين</p>
                <div className="flex items-center justify-between text-xs"><span className="flex items-center gap-[7px] text-ink"><span className="h-[7px] w-[7px] rounded-full" style={{ background: llmDot }} />المساعد الذكي</span><span className="text-mut">{llmShort}</span></div>
                <div className="flex items-center justify-between text-xs"><span className="flex items-center gap-[7px] text-ink"><span className="h-[7px] w-[7px] rounded-full" style={{ background: tregDot }} />مزود البيانات TREG</span><span className="text-mut">{tregShort}</span></div>
              </div>
              <div className="flex shrink-0 items-center gap-2.5 px-2 pt-3.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ac text-[13px] font-semibold text-onac">{initials(user?.name || "")}</span>
                <div className="min-w-0 flex-1"><p className="m-0 truncate text-[13px] font-semibold text-ink">{user?.name}</p><p className="m-0 text-[11px] text-fnt">مسؤول · admin</p></div>
                <button type="button" onClick={exit} className="min-h-11 cursor-pointer whitespace-nowrap border-0 bg-transparent py-1.5 text-[11px] text-mut">لوحة المستخدم</button>
              </div>
            </aside>
          )}

          <div className="flex min-w-0 flex-1 flex-col overflow-x-hidden" style={{ minHeight: mobile ? "100dvh" : 0, height: mobile ? "auto" : "100%", overflowY: mobile ? "visible" : "auto" }} data-admin-scroll>
            <header className="sticky top-0 z-30 border-b border-ln" style={{ background: "color-mix(in oklab, var(--bg) 88%, transparent)", WebkitBackdropFilter: "blur(12px)", backdropFilter: "blur(12px)" }}>
              <div className="flex min-h-16 items-center gap-2.5 py-2.5" style={{ paddingInline: mobile ? 14 : 24 }}>
                {mobile && (
                  <button type="button" onClick={() => setDrawer(true)} aria-label="القائمة" className="flex h-11 w-11 shrink-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-ln bg-sf text-ink">
                    <span className="h-[1.6px] w-4 bg-current" /><span className="h-[1.6px] w-4 bg-current" />
                  </button>
                )}
                <div className={`flex-1 ${mobile ? "min-w-0" : "min-w-[140px]"}`}>
                  <p className="m-0 whitespace-nowrap text-[11px] text-fnt">لوحة الإدارة</p>
                  <h1 className="mb-0 mt-0.5 truncate font-semibold text-ink" style={{ fontSize: mobile ? 18 : 20 }}>{title}</h1>
                </div>
                {!mobile && wide && (
                  <form
                    className="flex min-h-[42px] min-w-[120px] flex-[0_1_260px] items-center gap-2 rounded-xl border border-ln bg-sf px-3 text-fnt"
                    onSubmit={(e) => { e.preventDefault(); if (q.trim()) router.push(`/admin/users?q=${encodeURIComponent(q.trim())}`); }}
                  >
                    <AIcon d={ADMIN_IC.search} size={16} stroke={1.8} />
                    <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ابحث عن مستخدم أو بريد أو رقم مرجعي" aria-label="بحث" className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink outline-none" />
                  </form>
                )}
                {hasRange && !mobile && rangeSwitch}
                <button
                  type="button" onClick={openBell} aria-label="تنبيهات الإدارة" aria-expanded={bell}
                  className="relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-ln text-ink"
                  style={{ background: bell ? "var(--sf2)" : "var(--sf)" }}
                >
                  <AIcon d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0" size={17} />
                  {unread > 0 && <span className="absolute -left-[5px] -top-[5px] flex h-[19px] min-w-[19px] items-center justify-center rounded-full border-2 border-bg bg-gold px-[5px] text-[10px] font-bold text-white">{formatAr(unread)}</span>}
                </button>
                <button type="button" onClick={toggleTheme} aria-label="تبديل المظهر" className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-ln bg-sf text-mut">
                  <AIcon d={theme === "dark" ? ADMIN_IC.sun : ADMIN_IC.moon} size={16} />
                </button>
              </div>
              {bell && (
                <>
                  <div onClick={() => setBell(false)} className="fixed inset-0 z-[44]" />
                  <div role="dialog" aria-label="تنبيهات الإدارة" className="absolute z-[45] overflow-hidden rounded-[20px] border border-ln bg-sf" style={{ top: "calc(100% + 6px)", left: mobile ? 14 : 24, width: "min(380px,calc(100% - 28px))", boxShadow: "var(--admin-shadow)", animation: "up .2s both" }}>
                    <div className="flex items-center justify-between border-b border-ln px-4 py-3"><span className="text-sm font-semibold text-ink">التنبيهات</span><span className="text-[11px] text-fnt">تصلك أيضًا على البريد</span></div>
                    <div className="max-h-[420px] overflow-y-auto">
                      {bellItems.length === 0 && <p className="m-0 px-4 py-8 text-center text-[13px] text-fnt">لا توجد تنبيهات.</p>}
                      {bellItems.map((n) => (
                        <button key={n.key} type="button" onClick={() => { setBell(false); n.go(); }} className="flex w-full cursor-pointer items-start gap-3 border-0 border-b border-ln px-4 py-3 text-right hover:bg-sf2" style={{ background: n.fresh && unread ? tint("var(--gold)", 6) : "transparent" }}>
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]" style={{ background: tint(n.color === "var(--goldT)" ? "var(--gold)" : n.color, 14), color: n.color }}><AIcon d={n.icon} size={15} stroke={1.8} /></span>
                          <span className="min-w-0 flex-1"><span className="block text-[13px] font-semibold text-ink">{n.title}</span><span className="mt-0.5 block text-xs leading-[1.6] text-mut">{n.body}</span></span>
                          <span className="whitespace-nowrap text-[11px] text-fnt">{n.when}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
                          {hasRange && mobile && <div className="flex justify-center px-3.5 pb-2.5">{rangeSwitch}</div>}
            </header>

            <main className="flex flex-1 flex-col gap-4" style={{ padding: mobile ? "14px 14px 24px" : "22px 24px 40px" }}>{children}</main>

            {mobile && (
              <nav aria-label="تنقل سريع" className="sticky bottom-0 z-40 grid grid-cols-5 border-t border-ln px-1.5 pt-1.5" style={{ paddingBottom: "calc(8px + env(safe-area-inset-bottom))", background: "color-mix(in oklab, var(--sf) 92%, transparent)", WebkitBackdropFilter: "blur(14px)", backdropFilter: "blur(14px)" }}>
                {bottom.map((b) => (
                  <button key={b.id} type="button" onClick={b.go} className="relative flex min-h-[54px] cursor-pointer flex-col items-center justify-center gap-[3px] rounded-[14px] border-0 bg-transparent text-[10px] font-semibold" style={{ color: b.on ? "var(--ink)" : "var(--fnt)" }}>
                    <AIcon d={b.icon} size={20} stroke={1.8} />{b.label}
                    {b.badge > 0 && <span className="absolute top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-gold px-[5px] text-[10px] text-white" style={{ left: "calc(50% - 20px)" }}>{formatAr(b.badge)}</span>}
                  </button>
                ))}
              </nav>
            )}
          </div>
        </div>

        {mobile && drawer && (
          <>
            <div onClick={() => setDrawer(false)} className="fixed inset-0 z-[60]" style={{ background: "rgba(8,10,10,.45)", animation: "fade .2s both" }} />
            <aside className="fixed bottom-0 right-0 top-0 z-[61] flex flex-col gap-0.5 bg-sf px-3.5 py-[18px]" style={{ width: "min(86%,320px)", animation: "drawer .35s cubic-bezier(.2,.7,.2,1) both" }}>
              <div className="flex items-center justify-between px-1.5 pb-4">
                <Logo height={26} />
                <button type="button" onClick={() => setDrawer(false)} aria-label="إغلاق" className="h-11 w-11 cursor-pointer border-0 bg-transparent text-xl text-mut">×</button>
              </div>
              {navItems.map((n) => <NavButton key={n.id} n={n} big />)}
              <button type="button" onClick={exit} className="mt-auto flex min-h-11 cursor-pointer items-center border-0 bg-transparent px-3 text-[13px] text-mut">← لوحة المستخدم</button>
              <button type="button" onClick={async () => { await logout(); router.push("/"); }} className="flex min-h-11 cursor-pointer items-center border-0 bg-transparent px-3 text-[13px] text-mut">تسجيل الخروج</button>
            </aside>
          </>
        )}

        {toastMsg && (
          <div role="status" className="fixed left-1/2 z-[400] -translate-x-1/2 rounded-[14px] bg-ink px-[18px] py-3 text-[13px] leading-[1.7] text-bg" style={{ bottom: mobile ? 90 : 28, maxWidth: "min(92%,460px)", boxShadow: "var(--admin-shadow)", animation: "up .3s both" }}>{toastMsg}</div>
        )}
      </div>
    </Ctx.Provider>
  );
}
