"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import { useAdmin } from "./AdminShell";
import { KV, Sheet, SheetHandle } from "./Sheet";
import { EGP, agoAr, badgeFor, dateTimeAr, initials } from "./format";

interface UserDetail {
  id: string; name: string; email: string; registration: string; lastLogin: string | null; balance: number; totalTopupsEgp: number;
  lastTopupAt: string | null; jobs: number; topups: Array<{ id: string; amountEgp: number; status: string; createdAt: string }>;
}

/** Design user sheet: balance / total top-ups / searches, account data, the user's top-ups. */
export function UserSheet({ userId, onClose }: { userId: string; onClose: () => void }) {
  const router = useRouter();
  const { toast } = useAdmin();
  const [u, setU] = useState<UserDetail | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => { adminFetch<UserDetail>(`/api/admin/users/${userId}`).then(setU).catch((e) => setError(e.message)); }, [userId]);

  const copyEmail = async () => {
    if (!u) return;
    try { await navigator.clipboard?.writeText(u.email); } catch { /* blocked */ }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Sheet label="بيانات المستخدم" onClose={onClose}>
      <div className="shrink-0 border-b border-ln px-[18px] pb-4 pt-3.5">
        <SheetHandle />
        <div className="flex items-center gap-3">
          <span className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-sf2 text-base font-semibold text-ink">{initials(u?.name || "")}</span>
          <div className="min-w-0 flex-1"><p className="m-0 truncate text-[17px] font-semibold text-ink">{u?.name || "…"}</p><p dir="ltr" className="mb-0 mt-0.5 truncate text-right text-xs text-fnt">{u?.email}</p></div>
          <button type="button" onClick={onClose} aria-label="إغلاق" className="h-11 w-11 shrink-0 cursor-pointer rounded-full border-0 bg-sf2 text-xl text-ink">×</button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto p-[18px]">
        {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}
        <div className="grid grid-cols-3 gap-2">
          {[["الرصيد", u ? formatAr(u.balance) : "…"], ["إجمالي الشحن", u ? (u.totalTopupsEgp ? EGP(u.totalTopupsEgp) : "—") : "…"], ["الأبحاث", u ? formatAr(u.jobs) : "…"]].map(([k, v]) => (
            <div key={k} className="rounded-[14px] border border-ln bg-sf p-3"><p className="m-0 text-[11px] text-mut">{k}</p><p className="mb-0 mt-1 font-display text-[26px] leading-none text-ink">{v}</p></div>
          ))}
        </div>
        {u && (
          <>
            <section>
              <h3 className="mb-1.5 mt-0 text-[13px] font-semibold text-mut">الحساب</h3>
              <KV k="تاريخ التسجيل" v={dateTimeAr(u.registration)} />
              <KV k="آخر تسجيل دخول" v={u.lastLogin ? agoAr(u.lastLogin) : "—"} />
              <KV k="آخر شحن" v={u.lastTopupAt ? agoAr(u.lastTopupAt) : "—"} />
              <KV k="معرف العميل" v={u.id} dir="ltr" mono />
              <KV k="طريقة الدخول" v="بريد إلكتروني وكلمة مرور" />
            </section>
            <section>
              <h3 className="mb-1.5 mt-0 text-[13px] font-semibold text-mut">طلبات الشحن</h3>
              {u.topups.map((t) => {
                const b = badgeFor(t.status);
                return (
                  <div key={t.id} className="flex min-h-[50px] items-center justify-between gap-3 border-b border-ln">
                    <span><span className="block text-[13px] font-semibold text-ink">{EGP(t.amountEgp)}</span><span className="block text-[11px] text-fnt">{dateTimeAr(t.createdAt)}</span></span>
                    <span className="rounded-full px-[9px] py-0.5 text-[11px] font-semibold" style={{ background: b.bg, color: b.fg }}>{b.label}</span>
                  </div>
                );
              })}
              {u.topups.length === 0 && <p className="m-0 text-xs text-fnt">لم يشحن بعد.</p>}
            </section>
          </>
        )}
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-2 border-t border-ln px-[18px] pt-3" style={{ paddingBottom: "calc(16px + env(safe-area-inset-bottom))" }}>
        <button type="button" onClick={copyEmail} className="min-h-[50px] cursor-pointer rounded-full border border-ln2 bg-transparent text-[13px] font-semibold text-ink">{copied ? "تم نسخ البريد" : "نسخ البريد"}</button>
        <button type="button" onClick={() => { onClose(); router.push("/admin/topups?status=all"); toast("عرض كل طلبات الشحن"); }} className="min-h-[50px] cursor-pointer rounded-full border-0 bg-ac text-[13px] font-semibold text-onac">طلبات الشحن</button>
      </div>
    </Sheet>
  );
}
