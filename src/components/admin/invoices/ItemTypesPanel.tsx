"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { useAdmin } from "@/components/admin/AdminShell";
import { toArabicDigits } from "@/lib/arabicDigits";
import { formatScaled, parseScaled } from "@/lib/invoices/money";
import { BTN, BTN_PRIMARY, INPUT, SECTION } from "./ui";

interface ItemType { id: string; nameAr: string; unitCc: number; sortOrder: number; isActive: boolean }

/** The owner's item types and default SALE prices (in cents, up to two decimals: 0.45 = less than half a cent). Editing a default never changes a document already made. */
export function ItemTypesPanel() {
  const { toast } = useAdmin();
  const [types, setTypes] = useState<Array<ItemType & { price: string }> | null>(null);
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState({ name: "", price: "" });
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await adminFetch<{ types: ItemType[] }>("/api/admin/invoices/types");
      setTypes(r.types.map((t) => ({ ...t, price: formatScaled(t.unitCc, 2) })));
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "تعذّر تحميل الأنواع"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (t: ItemType & { price: string }) => {
    const unitCc = parseScaled(t.price, 2);
    if (unitCc === null) { toast("السعر غير صالح (بالسنت، حتى منزلتين عشريتين)"); return; }
    setBusy(t.id);
    try {
      await adminFetch(`/api/admin/invoices/types/${t.id}`, { method: "PATCH", body: JSON.stringify({ nameAr: t.nameAr, unitCc, sortOrder: t.sortOrder, isActive: t.isActive }) });
      toast("تم الحفظ");
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّر الحفظ"); } finally { setBusy(""); }
  };

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const unitCc = parseScaled(fresh.price || "0", 2);
    if (unitCc === null) { toast("السعر غير صالح"); return; }
    setBusy("new");
    try {
      await adminFetch("/api/admin/invoices/types", { method: "POST", body: JSON.stringify({ nameAr: fresh.name, unitCc }) });
      setFresh({ name: "", price: "" });
      toast("تمت الإضافة");
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّرت الإضافة"); } finally { setBusy(""); }
  };

  const patch = (id: string, change: Partial<ItemType & { price: string }>) => setTypes((list) => (list ?? []).map((t) => (t.id === id ? { ...t, ...change } : t)));

  return (
    <div className="flex min-w-0 flex-col gap-3.5" data-testid="item-types-panel">
      <section className={SECTION}>
        <h2 className="m-0 text-base font-semibold text-ink">أنواع البنود وأسعارها الافتراضية</h2>
        <p className="m-0 text-[13px] leading-[1.9] text-ink2">السعر هو سعر البيع بالسنت الأمريكي للوحدة (يقبل منزلتين عشريتين: ٠٫٤٥ = أقل من نصف سنت). يُملأ تلقائيًا في كل بند جديد ويمكن تعديله في كل بند. تعديل السعر هنا لا يغيّر أي وثيقة سبق إنشاؤها.</p>
        {error ? <p role="alert" className="m-0 text-[13px] text-bad">{error}</p> : null}
        <div className="min-w-0 overflow-x-auto" data-testid="types-scroll">
          <table className="w-full min-w-[520px] border-collapse text-[13px]">
            <thead><tr className="text-right text-xs text-mut"><th className="p-2 font-semibold">الاسم</th><th className="p-2 font-semibold">السعر (سنت)</th><th className="p-2 font-semibold">يظهر في القائمة</th><th className="p-2" /></tr></thead>
            <tbody>
              {(types ?? []).map((t) => (
                <tr key={t.id} className="border-t border-ln">
                  <td className="p-2"><input className={INPUT} value={t.nameAr} onChange={(e) => patch(t.id, { nameAr: e.target.value })} aria-label="اسم النوع" /></td>
                  <td className="p-2"><input className={INPUT} inputMode="decimal" dir="ltr" value={toArabicDigits(t.price)} onChange={(e) => patch(t.id, { price: e.target.value })} aria-label="السعر بالسنت" /></td>
                  <td className="p-2"><input type="checkbox" className="h-5 w-5" checked={t.isActive} onChange={(e) => patch(t.id, { isActive: e.target.checked })} aria-label="يظهر" /></td>
                  <td className="p-2"><button type="button" className={BTN} disabled={busy === t.id} onClick={() => save(t)}>حفظ</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <form className={SECTION} onSubmit={add}>
        <h3 className="m-0 text-sm font-semibold text-ink">نوع جديد</h3>
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <input className={INPUT} placeholder="الاسم (مثل: رابط حساب)" value={fresh.name} onChange={(e) => setFresh({ ...fresh, name: e.target.value })} required aria-label="اسم النوع الجديد" />
          <input className={INPUT} inputMode="decimal" dir="ltr" placeholder="السعر بالسنت (مثل ١٢ أو ٠.٤٥)" value={toArabicDigits(fresh.price)} onChange={(e) => setFresh({ ...fresh, price: e.target.value })} aria-label="سعر النوع الجديد" />
        </div>
        <div><button type="submit" className={BTN_PRIMARY} disabled={busy === "new"}>إضافة</button></div>
      </form>
    </div>
  );
}
