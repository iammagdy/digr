"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Query } from "appwrite";
import { Wordmark } from "@/components/Brand";
import { useUser } from "@/hooks/useUser";
import { useBalance } from "@/hooks/useBalance";
import { useOnline } from "@/hooks/useOnline";
import { useNotifications, type NotificationKind } from "@/hooks/useNotifications";
import { useTheme } from "@/lib/theme";
import { databases } from "@/lib/appwrite";
import { DATABASE_ID, HELP_CENTER_URL, JOBS_COLLECTION, SUPPORT_URL } from "@/lib/constants";
import { balanceText } from "@/lib/honestDisplay";
import { toArabicDigits, timeAgoAr } from "@/lib/arabicDigits";
import { Icon, UI } from "./icons";

/* ── shell context: pages set their header title, anyone can open the drawer / start a new question ── */
interface ShellContextValue {
  setTitle: (t: string) => void;
  newQuestion: () => void;
}
const ShellContext = createContext<ShellContextValue>({ setTitle: () => {}, newQuestion: () => {} });
export const useShell = () => useContext(ShellContext);

const PAGE_TITLES: Record<string, string> = {
  "/dashboard/topup": "الرصيد والشحن",
  "/dashboard/requests": "طلباتي",
  "/dashboard/settings": "الإعدادات",
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return [parts[0]?.[0] ?? "؟", parts[1]?.[0]].filter(Boolean).join(" ");
}

const NOTIF_STYLE: Record<NotificationKind, { icon: string; color: string; tint: string }> = {
  topup_approved: { icon: UI.check, color: "var(--ok)", tint: "var(--ok)" },
  welcome: { icon: UI.check, color: "var(--ok)", tint: "var(--ok)" },
  job_done: { icon: UI.folder, color: "var(--ink2)", tint: "var(--ink)" },
  refund: { icon: UI.refund, color: "var(--goldT)", tint: "var(--gold)" },
  topup_rejected: { icon: UI.x, color: "var(--bad)", tint: "var(--bad)" },
};

function useIsMobile(bp = 760) {
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

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useUser();
  const { balance, refresh: refreshBalance } = useBalance();
  const { theme, toggleTheme } = useTheme();
  const online = useOnline();
  const pathname = usePathname();
  const router = useRouter();
  const mobile = useIsMobile();
  const notifs = useNotifications(user?.$id);

  const [drawer, setDrawer] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);
  const [notifsOpen, setNotifsOpen] = useState(false);
  const [title, setTitleState] = useState("");
  const [running, setRunning] = useState(0);
  const acctRef = useRef<HTMLDivElement>(null);

  const isAdmin = Array.isArray(user?.labels) && user.labels.includes("admin");
  const isChat = pathname === "/dashboard/chat";

  /* close overlays on navigation */
  useEffect(() => { setDrawer(false); setAcctOpen(false); setNotifsOpen(false); }, [pathname]);

  /* keyboard: keep the shell exactly as tall as the visible viewport so the composer is never hidden */
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const on = () => {
      if (vv.height > 0) document.documentElement.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
    };
    vv.addEventListener("resize", on);
    on();
    return () => { vv.removeEventListener("resize", on); document.documentElement.style.removeProperty("--vvh"); };
  }, []);

  /* running-jobs badge on «طلباتي» */
  useEffect(() => {
    if (!user) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await databases.listDocuments(DATABASE_ID, JOBS_COLLECTION, [
          Query.equal("userId", user.$id), Query.equal("status", "running"), Query.limit(1),
        ]);
        if (alive) setRunning(res.total);
      } catch { if (alive) setRunning(0); }
    };
    void load();
    const t = setInterval(load, 20000);
    return () => { alive = false; clearInterval(t); };
  }, [user, pathname]);

  const newQuestion = useCallback(() => {
    setDrawer(false);
    if (pathname === "/dashboard/chat") window.dispatchEvent(new Event("digr:new-chat"));
    else router.push("/dashboard/chat");
  }, [pathname, router]);

  const setTitle = useCallback((t: string) => setTitleState(t), []);
  const ctx = useMemo(() => ({ setTitle, newQuestion }), [setTitle, newQuestion]);

  const pageTitle = isChat ? title || "محادثة جديدة" : PAGE_TITLES[pathname] || "";

  const handleLogout = async () => { await logout(); router.push("/"); };

  /* outside-click for the account menu */
  useEffect(() => {
    if (!acctOpen) return;
    const on = (e: MouseEvent) => { if (!acctRef.current?.contains(e.target as Node)) setAcctOpen(false); };
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, [acctOpen]);

  if (!user) return null;

  const navItems: Array<{ id: string; label: string; icon: string; href?: string; meta?: string; badge?: number; active: boolean; onClick?: () => void }> = [
    { id: "chat", label: "المساعد البحثي", icon: UI.chat, href: "/dashboard/chat", active: pathname === "/dashboard/chat" },
    { id: "requests", label: "طلباتي", icon: UI.folder, href: "/dashboard/requests", badge: running, active: pathname.startsWith("/dashboard/requests") },
    { id: "wallet", label: "المحفظة", icon: UI.wallet, href: "/dashboard/topup", meta: balance.status === "ready" ? balanceText(balance) : undefined, active: pathname.startsWith("/dashboard/topup") },
    { id: "notifs", label: "الإشعارات", icon: UI.bell, badge: notifs.unread, active: notifsOpen, onClick: () => { setNotifsOpen((v) => !v); setDrawer(false); setAcctOpen(false); } },
    { id: "settings", label: "الإعدادات", icon: UI.gear, href: "/dashboard/settings", active: pathname.startsWith("/dashboard/settings") },
  ];

  const menu: Array<{ label: string; icon: string; meta?: string; danger?: boolean; href?: string; onClick?: () => void }> = [
    { label: "الإعدادات", icon: UI.gear, href: "/dashboard/settings" },
    { label: theme === "dark" ? "المظهر الفاتح" : "المظهر الداكن", icon: UI.moon, onClick: () => { toggleTheme(); setAcctOpen(false); } },
    { label: "الشروط والخصوصية", icon: UI.doc, href: "/legal/terms" },
    ...(isAdmin ? [{ label: "لوحة الإدارة", icon: UI.shield, meta: "مسؤول", href: "/admin" }] : []),
    { label: "تسجيل الخروج", icon: UI.logout, danger: true, onClick: handleLogout },
  ];

  const helpLinks = [
    { label: "مركز المساعدة", icon: UI.help, href: HELP_CENTER_URL },
    { label: "تواصل مع الدعم", icon: UI.chat, href: SUPPORT_URL },
    { label: "الشروط والخصوصية", icon: UI.doc, href: "/legal/terms" },
  ];

  const sideVisible = !mobile || drawer;

  return (
    <ShellContext.Provider value={ctx}>
      <div className="relative flex overflow-hidden bg-bg text-ink2" style={{ height: "var(--vvh, 100dvh)" }}>
        {mobile && drawer && (
          <div onClick={() => setDrawer(false)} aria-hidden="true" className="absolute inset-0 z-40" style={{ background: "rgba(10,12,12,.38)", animation: "fade .25s both" }} />
        )}

        {sideVisible && (
          <aside
            aria-label="القائمة الرئيسية"
            className="z-[41] flex shrink-0 flex-col border-ln bg-sf"
            style={{
              position: mobile ? "absolute" : "relative", insetBlock: 0, insetInlineStart: 0,
              width: mobile ? "min(86%,320px)" : 272, borderInlineEnd: "1px solid var(--ln)",
              boxShadow: mobile ? "var(--shadow)" : "none", animation: mobile ? "drawer .4s cubic-bezier(.2,.7,.2,1) both" : "none",
            }}
          >
            <div className="flex min-h-16 items-center justify-between gap-2 px-4">
              <Link href="/dashboard/chat" aria-label="ديجر"><Wordmark height={26} /></Link>
              {mobile && (
                <button type="button" onClick={() => setDrawer(false)} aria-label="إغلاق القائمة" className="h-11 w-11 cursor-pointer rounded-full border-0 bg-transparent text-xl text-mut">×</button>
              )}
            </div>
            <div className="px-3">
              <button
                type="button" onClick={newQuestion}
                className="flex min-h-12 w-full cursor-pointer items-center gap-2.5 rounded-[14px] border border-ln2 bg-bg px-2 text-sm font-medium text-ink transition-[border-color,box-shadow] duration-200 hover:border-gold hover:shadow-[var(--shadow)]"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-ac text-onac"><Icon d={UI.plus} size={16} /></span>
                <span className="flex-1 text-right">سؤال بحثي جديد</span>
              </button>
            </div>
            <nav aria-label="التنقل" className="no-scrollbar flex min-h-0 shrink flex-col gap-0.5 overflow-y-auto px-2 pb-1 pt-2.5">
              {navItems.map((n) => {
                const cls = `relative flex min-h-[44px] shrink-0 cursor-pointer items-center gap-3 rounded-xl border-0 px-3 text-right text-sm transition-colors hover:bg-sf2 ${n.active ? "bg-sf2 font-semibold text-ink" : "bg-transparent font-normal text-mut"}`;
                const inner = (
                  <>
                    <Icon d={n.icon} />
                    <span className="flex-1">{n.label}</span>
                    {n.meta && <span className="text-xs font-medium text-goldT">{n.meta}</span>}
                    {!!n.badge && n.badge > 0 && (
                      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-gold px-1.5 text-[11px] font-bold text-white">{toArabicDigits(n.badge)}</span>
                    )}
                  </>
                );
                return n.href ? (
                  <Link key={n.id} href={n.href} aria-current={n.active ? "page" : undefined} className={cls}>{inner}</Link>
                ) : (
                  <button key={n.id} type="button" onClick={n.onClick} aria-expanded={n.active} className={cls}>{inner}</button>
                );
              })}
            </nav>
            <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3 pb-3 pt-1">
              <div className="mt-auto flex flex-col gap-0.5">
                <p className="mx-1 mb-1 mt-0 text-[11px] font-medium text-fnt">المساعدة</p>
                {helpLinks.map((h) => (
                  <Link key={h.label} href={h.href} className="flex min-h-[44px] items-center gap-2.5 rounded-[10px] px-2 text-right text-[13px] text-mut transition-colors hover:bg-sf2 hover:text-ink">
                    <Icon d={h.icon} size={16} />{h.label}
                  </Link>
                ))}
              </div>
            </div>
            {/* account row: pinned to the bottom, never scrolls away */}
            <div ref={acctRef} className="relative flex flex-col gap-2.5 border-t border-ln p-3">
              {acctOpen && (
                <div role="menu" className="absolute inset-x-3 bottom-[calc(100%-4px)] z-[5] flex flex-col rounded-[18px] border border-ln bg-sf p-1.5" style={{ boxShadow: "var(--shadow)", animation: "up .2s both" }}>
                  {menu.map((m) => {
                    const cls = "flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-xl border-0 bg-transparent px-2.5 text-right text-[13px] transition-colors hover:bg-sf2";
                    const style = { color: m.danger ? "var(--bad)" : "var(--ink)" };
                    const inner = (<><Icon d={m.icon} size={17} /><span className="flex-1">{m.label}</span>{m.meta && <span className="text-[11px] text-fnt">{m.meta}</span>}</>);
                    return m.href ? (
                      <Link key={m.label} href={m.href} role="menuitem" className={cls} style={style}>{inner}</Link>
                    ) : (
                      <button key={m.label} type="button" role="menuitem" onClick={m.onClick} className={cls} style={style}>{inner}</button>
                    );
                  })}
                </div>
              )}
              <button
                type="button" onClick={() => { setAcctOpen((v) => !v); setNotifsOpen(false); }} aria-haspopup="menu" aria-expanded={acctOpen}
                className={`flex min-h-[52px] cursor-pointer items-center gap-2.5 rounded-[14px] border-0 px-1.5 text-right transition-colors hover:bg-sf2 ${acctOpen ? "bg-sf2" : "bg-transparent"}`}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ac text-[13px] font-semibold text-onac">{initials(user.name || user.email)}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                    <span className="truncate">{user.name || "حسابي"}</span>
                    <span className="rounded-full bg-sf2 px-[7px] py-px text-[10px] font-medium text-mut">باحث</span>
                  </span>
                  <span dir="ltr" className="block truncate text-right text-[11px] text-fnt">{user.email}</span>
                </span>
                <span className="text-xs text-fnt transition-transform duration-200" style={{ transform: `rotate(${acctOpen ? 0 : 180}deg)` }}>⌃</span>
              </button>
            </div>
          </aside>
        )}

        <div className="relative flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 shrink-0 items-center justify-between gap-3 px-3.5" style={{ borderBottom: `1px solid ${mobile ? "transparent" : "var(--ln)"}` }}>
            <div className="flex min-w-0 items-center gap-2">
              {mobile && (
                <button type="button" onClick={() => setDrawer(true)} aria-label="القائمة" className="flex h-11 w-11 shrink-0 cursor-pointer flex-col items-center justify-center gap-[5px] rounded-full border-0 bg-transparent text-ink hover:bg-sf2">
                  <span className="h-[1.5px] w-[18px] bg-current" /><span className="h-[1.5px] w-[18px] bg-current" />
                </button>
              )}
              <h1 className="m-0 truncate text-[15px] font-medium text-ink">{pageTitle}</h1>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button" onClick={() => { setNotifsOpen((v) => !v); setAcctOpen(false); }} aria-label="الإشعارات" aria-expanded={notifsOpen}
                className={`relative flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border-0 text-ink hover:bg-sf2 ${notifsOpen ? "bg-sf2" : "bg-transparent"}`}
              >
                <Icon d={UI.bell} size={19} />
                {notifs.unread > 0 && (
                  <span className="absolute left-1.5 top-1.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full border-2 border-bg bg-gold px-1 text-[9px] font-bold text-white">{toArabicDigits(notifs.unread)}</span>
                )}
              </button>
              <Link href="/dashboard/topup" className="flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-full bg-sf2 px-3.5">
                <span className="text-sm font-medium text-ink">{balanceText(balance)}</span>
                <span className="text-xs font-light text-mut">نقطة</span>
              </Link>
            </div>
          </header>

          {!online && (
            <div role="alert" className="flex shrink-0 items-center gap-2.5 px-4 py-2.5 text-[13px] text-ink" style={{ background: "color-mix(in oklab, var(--bad) 10%, var(--bg))", animation: "up .3s both" }}>
              <span className="flex text-bad"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 12.6a10 10 0 0 1 5.2-2.6M19 12.6a10 10 0 0 0-2.1-1.4M12 20h.01" /></svg></span>
              <span className="flex-1 leading-[1.7]">أنت غير متصل بالإنترنت. سنحاول مجددًا تلقائيًا — لن تُخصم أي نقاط.</span>
              <button type="button" onClick={() => { if (navigator.onLine) void refreshBalance(); }} className="min-h-11 cursor-pointer whitespace-nowrap rounded-full border border-ln2 bg-sf px-3 text-xs text-ink">إعادة المحاولة</button>
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-shell-scroll>{children}</div>

          {notifsOpen && (
            <>
              <div onClick={() => setNotifsOpen(false)} className="absolute inset-0 z-[44]" />
              <div
                role="dialog" aria-label="الإشعارات"
                className="absolute left-3 top-[60px] z-[45] flex flex-col overflow-hidden rounded-[22px] border border-ln bg-sf"
                style={{ width: "min(380px,calc(100% - 24px))", maxHeight: "min(520px,calc(100% - 80px))", boxShadow: "var(--shadow)", animation: "up .22s both" }}
              >
                <div className="flex shrink-0 items-center justify-between gap-2.5 border-b border-ln px-4 py-3.5">
                  <span className="text-[15px] font-semibold text-ink">الإشعارات</span>
                  {notifs.unread > 0 && (
                    <button type="button" onClick={notifs.markAllRead} className="cursor-pointer border-0 bg-transparent py-1.5 text-xs font-semibold text-goldT">تعليم الكل كمقروء</button>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {notifs.items.length === 0 && <p className="m-0 px-4 py-8 text-center text-[13px] text-fnt">لا توجد إشعارات بعد.</p>}
                  {notifs.items.map((n) => {
                    const st = NOTIF_STYLE[n.kind] ?? NOTIF_STYLE.job_done;
                    const unread = !n.readAt;
                    return (
                      <button
                        key={n.$id} type="button"
                        onClick={() => { void notifs.markRead(n.$id); setNotifsOpen(false); if (n.link) router.push(n.link); }}
                        className="flex w-full cursor-pointer items-start gap-3 border-0 border-b border-ln px-4 py-3.5 text-right hover:bg-sf2"
                        style={{ background: unread ? "color-mix(in oklab, var(--gold) 6%, var(--sf))" : "transparent" }}
                      >
                        <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[11px]" style={{ background: `color-mix(in oklab, ${st.tint} 12%, transparent)`, color: st.color }}><Icon d={st.icon} size={16} stroke={1.8} /></span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5"><span className="text-[13px] font-semibold text-ink">{n.title}</span>{unread && <span className="h-[7px] w-[7px] rounded-full bg-gold" />}</span>
                          <span className="mt-[3px] block text-xs font-light leading-[1.7] text-ink2">{n.body}</span>
                          <span className="mt-1 block text-[11px] text-fnt">{timeAgoAr(n.createdAt)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="m-0 shrink-0 bg-sf2 px-4 py-2.5 text-[11px] text-fnt">نرسل الإشعارات المهمة على بريدك أيضًا — غيّرها من الإعدادات.</p>
              </div>
            </>
          )}
        </div>
      </div>
    </ShellContext.Provider>
  );
}
