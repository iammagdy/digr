"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { adminFetch } from "@/lib/adminApi";
import { formatAr, normalizeDigits } from "@/lib/arabicDigits";
import { useAdmin } from "./AdminShell";
import { KV, Sheet, SheetHandle } from "./Sheet";
import { EGP, agoAr, badgeFor, dateTimeAr, initials } from "./format";

interface HistoryRow { id: string; at: string; kind: string; kindAr: string; amount: number; runningBalance: number; note: string; grantedBy: string | null; jobId: string | null }
interface UserDetail {
  id: string; name: string; email: string; registration: string; lastLogin: string | null; balance: number; totalTopupsEgp: number;
  lastTopupAt: string | null; jobs: number; lastJobAt: string | null; promo: { used: boolean; codes: Array<{ code: string; redeemedAt: string }> };
  topups: Array<{ id: string; amountEgp: number; status: string; createdAt: string }>; history: HistoryRow[];
}

/** Design user sheet: balance / total top-ups / searches, account data, the user's top-ups. */
export function UserSheet({ userId, onClose }: { userId: string; onClose: () => void }) {
  const router = useRouter();
  const { toast } = useAdmin();
  const [u, setU] = useState<UserDetail | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");
  const [granting, setGranting] = useState(false);
  const [grantMsg, setGrantMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // «verified business»: the flag that lets a customer account use the sensitive data category (the admin sets it; the table may not be applied yet).
  const [vb, setVb] = useState<{ verified: boolean; available: boolean } | null>(null);
  const [vbBusy, setVbBusy] = useState(false);
  const [vbMsg, setVbMsg] = useState("");
  const [requestId, setRequestId] = useState(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.floor(Math.random() * 1e6)}`));

  useEffect(() => { adminFetch<{ verified: boolean; available: boolean }>(`/api/admin/users/${userId}/verified-business`).then(setVb).catch(() => setVb(null)); }, [userId]);
  const toggleVerified = async () => {
    if (!vb || vbBusy) return;
    setVbBusy(true); setVbMsg("");
    try {
      await adminFetch(`/api/admin/users/${userId}/verified-business`, { method: "PUT", body: JSON.stringify({ verified: !vb.verified }) });
      setVb({ ...vb, verified: !vb.verified });
      setVbMsg(!vb.verified ? "تم توثيق الحساب كحساب أعمال." : "أُلغي توثيق الحساب.");
    } catch (e) { setVbMsg(e instanceof Error ? e.message : "تعذّر الحفظ"); } finally { setVbBusy(false); }
  };

  const load = useCallback(() => adminFetch<UserDetail>(`/api/admin/users/${userId}`).then(setU).catch((e) => setError(e.message)), [userId]);
  useEffect(() => { void load(); }, [load]);

  const grant = async (event: React.FormEvent) => {
    event.preventDefault();
    if (granting) return;
    setGranting(true);
    setGrantMsg(null);
    try {
      const r = await adminFetch<{ messageAr: string }>(`/api/admin/users/${userId}/credit`, {
        method: "POST",
        body: JSON.stringify({ points: normalizeDigits(points), note, requestId }),
      });
      setGrantMsg({ ok: true, text: r.messageAr });
      setPoints(""); setNote("");
      setRequestId(typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `req-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
      await load();
    } catch (e) {
      setGrantMsg({ ok: false, text: e instanceof Error ? e.message : "تعذرت إضافة الرصيد" });
    } finally { setGranting(false); }
  };

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
              <KV k="آخر بحث" v={u.lastJobAt ? agoAr(u.lastJobAt) : "—"} />
              <KV k="استخدم كودًا ترويجيًا" v={u.promo.used ? `نعم (${u.promo.codes.map((c) => c.code).join("، ")})` : "لا"} />
              <KV k="معرف العميل" v={u.id} dir="ltr" mono />
              <KV k="طريقة الدخول" v="بريد إلكتروني وكلمة مرور" />
            </section>
            <section>
              <h3 className="mb-1.5 mt-0 text-[13px] font-semibold text-mut">حساب أعمال موثّق</h3>
              <div className="flex flex-col gap-2 rounded-[14px] border border-ln p-3">
                <p className="m-0 text-xs leading-[1.8] text-mut">الحساب الموثّق يستطيع طلب الخدمات الحسّاسة (بيانات شخصية وبحث عكسي) بعد ذكر الغرض، وكل استعلام يُسجَّل.</p>
                <button type="button" onClick={toggleVerified} disabled={!vb || vbBusy || vb.available === false} aria-pressed={vb?.verified === true} className="min-h-11 cursor-pointer self-start rounded-full border border-ln2 bg-transparent px-5 text-[13px] font-semibold text-ink disabled:opacity-50">{vb?.verified ? "إلغاء التوثيق" : "توثيق كحساب أعمال"}</button>
                <p role="status" aria-live="polite" className="m-0 min-h-[1.1rem] text-xs text-fnt">{vb && vb.available === false ? "الميزة غير مُفعَّلة بعد في قاعدة البيانات." : vbMsg}</p>
              </div>
            </section>
            <section>
              <h3 className="mb-1.5 mt-0 text-[13px] font-semibold text-mut">إضافة رصيد يدوي</h3>
              <form onSubmit={grant} className="flex flex-col gap-2.5 rounded-[14px] border border-ln p-3">
                <label className="flex flex-col gap-1.5"><span className="text-xs text-mut">عدد النقاط</span><input inputMode="numeric" dir="ltr" value={points} onChange={(e) => setPoints(e.target.value)} placeholder="100" required className="min-h-11 rounded-xl border border-ln bg-bg px-3 text-left text-base text-ink outline-none" /></label>
                <label className="flex flex-col gap-1.5"><span className="text-xs text-mut">السبب (يُسجَّل مع اسمك)</span><input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="مثال: تعويض عن مشكلة" required className="min-h-11 rounded-xl border border-ln bg-bg px-3 text-base text-ink outline-none" /></label>
                <button type="submit" disabled={granting || !points.trim() || note.trim().length < 3} className="min-h-11 cursor-pointer self-start rounded-full border-0 bg-ac px-5 text-[13px] font-semibold text-onac disabled:opacity-50">{granting ? "جاري الإضافة..." : "إضافة الرصيد"}</button>
                <p role="status" aria-live="polite" className="m-0 min-h-[1.1rem] text-xs leading-[1.8]" style={{ color: grantMsg ? (grantMsg.ok ? "var(--ok)" : "var(--bad)") : "var(--fnt)" }}>{grantMsg?.text || "تُضاف النقاط فورًا ويظهر السجل أدناه."}</p>
              </form>
            </section>
            <section>
              <h3 className="mb-1.5 mt-0 text-[13px] font-semibold text-mut">سجل الرصيد الكامل</h3>
              {u.history.map((h) => (
                <div key={h.id} className="flex min-h-[54px] items-center justify-between gap-3 border-b border-ln py-1.5">
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-ink">{h.kindAr}</span>
                    <span className="block text-[11px] text-fnt">{dateTimeAr(h.at)}{h.grantedBy ? ` · بواسطة ${h.grantedBy}` : ""}</span>
                    {h.note && <span className="block truncate text-[11px] text-mut">{h.note}</span>}
                  </span>
                  <span className="shrink-0 text-left" dir="ltr">
                    <span className="block text-[14px] font-semibold" style={{ color: h.amount > 0 ? "var(--ok)" : "var(--ink)" }}>{h.amount > 0 ? "+" : "−"}{formatAr(Math.abs(h.amount))}</span>
                    <span className="block text-[11px] text-fnt">{formatAr(h.runningBalance)}</span>
                  </span>
                </div>
              ))}
              {u.history.length === 0 && <p className="m-0 text-xs text-fnt">لا توجد حركات بعد.</p>}
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
