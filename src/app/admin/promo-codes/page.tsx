"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr, normalizeDigits } from "@/lib/arabicDigits";
import { useAdmin } from "@/components/admin/AdminShell";
import { dateTimeAr } from "@/components/admin/format";

interface Redemption { userId: string; redeemedAt: string; name: string; email: string; isNewAccount: boolean }
interface Code {
  code: string; points: number; maxRedemptions: number; used: number; remaining: number; state: string; stateAr: string;
  startsAt: string | null; expiresAt: string | null; active: boolean; note: string; createdAt: string; redemptions: Redemption[];
}

const SECTION = "flex flex-col gap-3.5 rounded-[22px] border border-ln bg-sf p-[18px]";
const INPUT = "min-h-[46px] w-full rounded-xl border border-ln bg-bg px-3.5 text-base text-ink outline-none";
const STATE_COLOR: Record<string, string> = { active: "var(--ok)", disabled: "var(--mut)", not_started: "var(--info)", expired: "var(--bad)", exhausted: "var(--goldT)" };

const emptyForm = { code: "", points: "", max: "", expires: "", note: "" };

export default function AdminPromoCodesPage() {
  const { toast } = useAdmin();
  const [codes, setCodes] = useState<Code[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await adminFetch<{ codes: Code[]; migrationPending: boolean }>("/api/admin/promo-codes");
      setCodes(r.codes); setPending(r.migrationPending); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "تعذّر تحميل الأكواد"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await adminFetch("/api/admin/promo-codes", {
        method: "POST",
        body: JSON.stringify({
          code: form.code,
          points: Number(normalizeDigits(form.points)),
          maxRedemptions: Number(normalizeDigits(form.max)),
          expiresAt: form.expires ? new Date(`${form.expires}T23:59:59`).toISOString() : null,
          note: form.note,
        }),
      });
      toast("تم حفظ الكود");
      setForm(emptyForm);
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّر حفظ الكود"); }
    finally { setBusy(false); }
  };

  const edit = (c: Code) => setForm({
    code: c.code, points: String(c.points), max: String(c.maxRedemptions),
    expires: c.expiresAt ? c.expiresAt.slice(0, 10) : "", note: c.note,
  });

  const toggle = async (c: Code) => {
    try {
      await adminFetch("/api/admin/promo-codes", { method: "PATCH", body: JSON.stringify({ code: c.code, active: !c.active }) });
      toast(c.active ? "تم تعطيل الكود" : "تم تفعيل الكود");
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّر تغيير حالة الكود"); }
  };

  if (error) return <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>;

  return (
    <div data-screen-label="PromoCodes" className="flex flex-col gap-3.5">
      {pending && (
        <p role="status" className="m-0 rounded-[14px] border border-ln bg-sf2 p-3 text-[13px] leading-[1.9] text-ink2">
          الأكواد الترويجية غير مفعّلة بعد: تحديث قاعدة البيانات الخاص بها لم يُطبَّق. طبّقه بحسب ملف التعليمات ثم أعد تحميل الصفحة.
        </p>
      )}

      <form onSubmit={submit} className={SECTION}>
        <h2 className="m-0 text-[17px] font-semibold text-ink">إنشاء أو تعديل كود</h2>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,200px),1fr))" }}>
          <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">الكود (حروف لاتينية كبيرة وأرقام)</span><input dir="ltr" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} className={`${INPUT} text-left`} placeholder="FRIENDS500" required /></label>
          <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">القيمة (نقاط)</span><input inputMode="numeric" dir="ltr" value={form.points} onChange={(e) => setForm({ ...form, points: e.target.value })} className={`${INPUT} text-left`} placeholder="500" required /></label>
          <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">أقصى عدد استخدامات</span><input inputMode="numeric" dir="ltr" value={form.max} onChange={(e) => setForm({ ...form, max: e.target.value })} className={`${INPUT} text-left`} placeholder="50" required /></label>
          <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">تاريخ الانتهاء (اختياري)</span><input type="date" dir="ltr" value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} className={`${INPUT} text-left`} /></label>
        </div>
        <label className="flex flex-col gap-1.5"><span className="text-xs font-semibold text-mut">ملاحظة داخلية</span><input value={form.note} maxLength={200} onChange={(e) => setForm({ ...form, note: e.target.value })} className={INPUT} placeholder="مثال: إطلاق الأصدقاء والزملاء" /></label>
        <p className="m-0 text-xs text-fnt">كل حساب يستخدم الكود مرة واحدة فقط. تعديل الكود لا يغيّر ما أُضيف فعلًا لمن استخدموه.</p>
        <button type="submit" disabled={busy} className="min-h-[46px] cursor-pointer self-start rounded-full border-0 bg-ac px-[22px] text-[13px] font-semibold text-onac disabled:opacity-60">{busy ? "جاري الحفظ..." : "حفظ الكود"}</button>
      </form>

      <section className={SECTION}>
        <h2 className="m-0 text-[17px] font-semibold text-ink">الأكواد</h2>
        {!codes && <div className="h-24 rounded-[14px] bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />}
        {codes && codes.length === 0 && <p className="m-0 text-[13px] text-fnt">لا توجد أكواد بعد.</p>}
        {codes?.map((c) => (
          <div key={c.code} className="rounded-[16px] border border-ln p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <span dir="ltr" className="font-mono text-[15px] font-semibold text-ink">{c.code}</span>
              <span className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold" style={{ color: STATE_COLOR[c.state] || "var(--mut)", background: "color-mix(in oklab, currentColor 12%, transparent)" }}>{c.stateAr}</span>
            </div>
            <p className="mb-0 mt-2 text-[13px] leading-[1.9] text-ink2">
              {formatAr(c.points)} نقطة · استُخدم {formatAr(c.used)} من {formatAr(c.maxRedemptions)} · متبقٍ {formatAr(c.remaining)}
              {c.expiresAt ? ` · ينتهي ${dateTimeAr(c.expiresAt).split("،")[0]}` : " · بلا تاريخ انتهاء"}
            </p>
            {c.note && <p className="mb-0 mt-1 text-xs text-fnt">{c.note}</p>}
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button type="button" onClick={() => edit(c)} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-xs text-ink">تعديل</button>
              <button type="button" onClick={() => toggle(c)} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-xs text-ink">{c.active ? "تعطيل" : "تفعيل"}</button>
              <button type="button" onClick={() => setOpen(open === c.code ? null : c.code)} aria-expanded={open === c.code} className="min-h-11 cursor-pointer rounded-full border-0 bg-sf2 px-4 text-xs text-ink">من استخدموه ({formatAr(c.used)})</button>
            </div>
            {open === c.code && (
              <div className="mt-3 flex flex-col">
                {c.redemptions.length === 0 && <p className="m-0 text-xs text-fnt">لم يستخدمه أحد بعد.</p>}
                {c.redemptions.map((r) => (
                  <div key={r.userId} className="flex flex-wrap items-center justify-between gap-2 border-t border-ln py-2.5 text-[13px]">
                    <span className="min-w-0"><span className="block font-semibold text-ink">{r.name || "—"}</span><span dir="ltr" className="block truncate text-right text-[11px] text-fnt">{r.email}</span></span>
                    <span className="text-xs text-mut">{dateTimeAr(r.redeemedAt)}</span>
                    <span className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold" style={{ color: r.isNewAccount ? "var(--info)" : "var(--mut)", background: "color-mix(in oklab, currentColor 12%, transparent)" }}>{r.isNewAccount ? "حساب جديد" : "حساب قائم"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
