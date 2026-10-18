"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr, normalizeDigits } from "@/lib/arabicDigits";
import { useAdmin } from "@/components/admin/AdminShell";
import { agoAr, initials } from "@/components/admin/format";

interface Settings { creditValueEgp: number; maxPendingTopups: number; ipa: string; admins: Array<{ id: string; name: string; email: string; lastLogin: string | null }> }

const SECTION = "flex flex-col gap-3.5 rounded-[22px] border border-ln bg-sf p-[18px]";
const INPUT = "min-h-[46px] w-full rounded-xl border border-ln bg-bg px-3.5 text-base text-ink outline-none text-left";

export default function AdminSettingsPage() {
  const { isMobile, toast } = useAdmin();
  const [s, setS] = useState<Settings | null>(null);
  const [credit, setCredit] = useState("");
  const [maxPending, setMaxPending] = useState("");
  const [ipa, setIpa] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [supportEmail, setSupportEmail] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [supportBusy, setSupportBusy] = useState(false);

  useEffect(() => {
    adminFetch<Settings>("/api/admin/settings").then((r) => { setS(r); setCredit(r.creditValueEgp.toFixed(2)); setMaxPending(String(r.maxPendingTopups)); setIpa(r.ipa); }).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    adminFetch<{ supportEmail: string; whatsappNumber: string }>("/api/admin/support-settings").then((r) => { setSupportEmail(r.supportEmail); setWhatsapp(r.whatsappNumber); }).catch(() => {});
  }, []);

  const saveSupport = async () => {
    if (supportBusy) return;
    setSupportBusy(true);
    try {
      await adminFetch("/api/admin/support-settings", { method: "POST", body: JSON.stringify({ supportEmail, whatsappNumber: normalizeDigits(whatsapp) }) });
      toast("تم حفظ بيانات الدعم");
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّر الحفظ"); }
    finally { setSupportBusy(false); }
  };

  const creditNum = Number(normalizeDigits(credit).replace(",", "."));
  const hint = creditNum > 0 ? `١٠٠ ج.م = ${formatAr(Math.floor(100 / creditNum))} نقطة` : "قيمة غير صالحة";

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await adminFetch("/api/admin/settings", { method: "POST", body: JSON.stringify({ creditValueEgp: credit, maxPendingTopups: maxPending, ipa }) });
      toast("تم حفظ الإعدادات في settings_public");
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّر الحفظ"); }
    finally { setBusy(false); }
  };

  if (error) return <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>;
  if (!s) return <div className="grid gap-3" style={{ gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr" }}>{[0, 1].map((i) => <div key={i} className="h-72 rounded-[22px] bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />)}</div>;

  return (
    <div data-screen-label="Settings" className="grid items-start gap-3" style={{ gridTemplateColumns: isMobile ? "1fr" : "minmax(0,1fr) minmax(0,1fr)" }}>
      <section className={SECTION}>
        <div><p className="m-0 text-[11px] text-fnt">settings_public · pricing</p><h2 className="mb-0 mt-1 text-[17px] font-semibold text-ink">التسعير والشحن</h2></div>
        <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">قيمة النقطة الواحدة (ج.م) · creditValueEgp</span><input type="text" inputMode="decimal" dir="ltr" value={credit} onChange={(e) => setCredit(e.target.value)} className={INPUT} /></label>
        <p className="-mt-1.5 mb-0 text-xs text-fnt">{hint}</p>
        <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">الحد الأقصى للطلبات المعلقة لكل مستخدم</span><input type="text" inputMode="numeric" dir="ltr" value={maxPending} onChange={(e) => setMaxPending(e.target.value)} className={INPUT} /></label>
        <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">عنوان الدفع اللحظي (IPA)</span><input type="text" dir="ltr" value={ipa} onChange={(e) => setIpa(e.target.value)} className={INPUT} /></label>
        <button type="button" onClick={save} disabled={busy} className="min-h-[46px] cursor-pointer self-start rounded-full border-0 bg-ac px-[22px] text-[13px] font-semibold text-onac disabled:opacity-60">حفظ الإعدادات</button>
      </section>

      <section className={SECTION}>
        <div><p className="m-0 text-[11px] text-fnt">settings_public · support</p><h2 className="mb-0 mt-1 text-[17px] font-semibold text-ink">بيانات الدعم</h2></div>
        <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">بريد الدعم الإلكتروني</span><input type="email" dir="ltr" value={supportEmail} onChange={(e) => setSupportEmail(e.target.value)} placeholder="support@diger.tech" className={INPUT} /></label>
        <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">رقم واتساب (بصيغة دولية)</span><input type="text" inputMode="tel" dir="ltr" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="201000000000" className={INPUT} /></label>
        <p className="m-0 text-xs text-fnt">يظهران في صفحة «تواصل معنا». ما دامت الخانتان فارغتين تظهر عبارة «سيُضاف قريبًا».</p>
        <button type="button" onClick={saveSupport} disabled={supportBusy} className="min-h-[46px] cursor-pointer self-start rounded-full border-0 bg-ac px-[22px] text-[13px] font-semibold text-onac disabled:opacity-60">حفظ بيانات الدعم</button>
      </section>

      <section className={`${SECTION} !gap-2.5`}>
        <div><p className="m-0 text-[11px] text-fnt">labels: admin</p><h2 className="mb-0 mt-1 text-[17px] font-semibold text-ink">فريق الإدارة</h2></div>
        {s.admins.map((a) => (
          <div key={a.id} className="flex items-center gap-2.5 border-b border-ln py-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-sf2 text-xs font-semibold text-ink2">{initials(a.name)}</span>
            <span className="min-w-0 flex-1"><span className="block text-[13px] font-semibold text-ink">{a.name || "—"}</span><span dir="ltr" className="block text-right text-[11px] text-fnt">{a.email}</span></span>
            <span className="text-[11px] text-mut">{a.lastLogin ? agoAr(a.lastLogin) : "—"}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
