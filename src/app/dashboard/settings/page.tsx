"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Functions } from "appwrite";
import { account, client } from "@/lib/appwrite";
import { useUser } from "@/hooks/useUser";
import { useTheme } from "@/lib/theme";

const functions = new Functions(client);

const NOTIF_PREFS: Array<[id: "topup" | "done" | "refund" | "news", label: string, sub: string]> = [
  ["topup", "اعتماد أو رفض الشحن", "بريد إلكتروني + إشعار داخل التطبيق"],
  ["done", "اكتمال البحث", "بريد إلكتروني عند جاهزية الملفات"],
  ["refund", "استرداد النقاط", "عند رجوع أي نقاط لرصيدك"],
  ["news", "أخبار ونصائح بحثية", "رسالة شهرية على الأكثر"],
];
const DEFAULT_PREFS = { topup: true, done: true, refund: true, news: false };
type Prefs = typeof DEFAULT_PREFS;

const SECTION = "flex flex-col gap-3.5 rounded-3xl border border-ln bg-sf p-5";
const INPUT = "min-h-14 w-full rounded-[18px] border border-ln bg-bg px-[18px] text-base font-light text-ink outline-none transition-colors focus:border-ln2";
const initials = (n: string) => { const p = n.trim().split(/\s+/); return [p[0]?.[0] ?? "؟", p[1]?.[0]].filter(Boolean).join(" "); };

function Status({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return <p role={ok ? "status" : "alert"} className={`m-0 text-[13px] ${ok ? "text-ok" : "text-bad"}`} style={{ animation: "up .3s both" }}>{children}</p>;
}

export default function SettingsPage() {
  const { user, refresh, logout } = useUser();
  const { theme, setTheme } = useTheme();
  const router = useRouter();

  const [name, setName] = useState("");
  const [nameMsg, setNameMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [delOpen, setDelOpen] = useState(false);
  const [delTxt, setDelTxt] = useState("");
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState("");

  useEffect(() => {
    if (!user) return;
    setName(user.name || "");
    const saved = (user.prefs as { notif?: Partial<Prefs> } | undefined)?.notif;
    setPrefs({ ...DEFAULT_PREFS, ...(saved || {}) });
  }, [user]);

  if (!user) return null;

  async function saveName() {
    const n = name.trim();
    if (n.length < 2) return setNameMsg({ ok: false, text: "اكتب اسمك (حرفان على الأقل)." });
    try {
      await account.updateName(n);
      await refresh();
      setNameMsg({ ok: true, text: "تم حفظ الاسم." });
    } catch {
      setNameMsg({ ok: false, text: "تعذّر حفظ الاسم. حاول مرة أخرى." });
    }
  }

  async function savePw() {
    if (!oldPw) return setPwMsg({ ok: false, text: "اكتب كلمة المرور الحالية." });
    if (newPw.length < 8) return setPwMsg({ ok: false, text: "كلمة المرور الجديدة يجب ألا تقل عن 8 خانات." });
    try {
      await account.updatePassword(newPw, oldPw);
      setOldPw(""); setNewPw("");
      setPwMsg({ ok: true, text: "تم تغيير كلمة المرور." });
    } catch (e) {
      const code = (e as { code?: number }).code;
      setPwMsg({ ok: false, text: code === 401 ? "كلمة المرور الحالية غير صحيحة." : "تعذّر تغيير كلمة المرور. حاول مرة أخرى." });
    }
  }

  async function togglePref(id: keyof Prefs) {
    const next = { ...prefs, [id]: !prefs[id] };
    setPrefs(next);
    try {
      // updatePrefs replaces the whole object, so carry the other keys along.
      await account.updatePrefs({ ...(user!.prefs || {}), notif: next });
      await refresh();
    } catch {
      setPrefs(prefs);
    }
  }

  async function deleteAccount() {
    if (delTxt.trim() !== "حذف" || delBusy) return;
    setDelBusy(true);
    setDelErr("");
    try {
      const exec = await functions.createExecution("request-account-deletion", JSON.stringify({ confirm: delTxt.trim() }), false);
      const res = JSON.parse(exec.responseBody || "{}");
      if (!res.success) throw new Error(res.error || "تعذّر تنفيذ طلب حذف الحساب.");
      await logout().catch(() => {});
      router.replace("/");
    } catch (e) {
      setDelErr(e instanceof Error ? e.message : "تعذّر تنفيذ طلب حذف الحساب.");
      setDelBusy(false);
    }
  }

  return (
    <div data-screen-label="Settings" className="flex-1">
      <div className="mx-auto flex max-w-[720px] flex-col gap-3.5 px-[18px] pb-16 pt-[22px]">
        <h2 className="m-0 mb-1 font-display text-[40px] font-medium leading-[1.1] text-ink">الإعدادات</h2>

        <section className={SECTION}>
          <h3 className="m-0 text-[15px] font-semibold text-ink">الملف الشخصي</h3>
          <div className="flex items-center gap-3.5">
            <span className="flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-full bg-ac text-sm font-semibold text-onac" style={{ fontSize: 19 }}>{initials(user.name || user.email)}</span>
            <div className="min-w-0">
              <p dir="ltr" className="m-0 truncate text-right text-sm text-ink">{user.email}</p>
              {user.emailVerification && (
                <p className="mb-0 mt-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold text-ok" style={{ background: "color-mix(in oklab, var(--ok) 12%, transparent)" }}>✓ البريد موثّق</p>
              )}
            </div>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-mut">الاسم</span>
            <input type="text" value={name} onChange={(e) => { setName(e.target.value); setNameMsg(null); }} autoComplete="name" className={INPUT} />
          </label>
          <button type="button" onClick={saveName} className="min-h-11 cursor-pointer self-start rounded-full border-0 bg-ac px-5 text-[13px] text-onac">حفظ</button>
          {nameMsg && <Status ok={nameMsg.ok}>{nameMsg.text}</Status>}
        </section>

        <section className={SECTION}>
          <h3 className="m-0 text-[15px] font-semibold text-ink">كلمة المرور</h3>
          <input type="password" dir="ltr" autoComplete="current-password" value={oldPw} onChange={(e) => { setOldPw(e.target.value); setPwMsg(null); }} placeholder="كلمة المرور الحالية" className={`${INPUT} text-left`} />
          <input type="password" dir="ltr" autoComplete="new-password" value={newPw} onChange={(e) => { setNewPw(e.target.value); setPwMsg(null); }} placeholder="كلمة المرور الجديدة · 8 خانات على الأقل" className={`${INPUT} text-left`} />
          <button type="button" onClick={savePw} className="min-h-11 cursor-pointer self-start rounded-full border border-ln2 bg-transparent px-5 text-[13px] text-ink">تغيير كلمة المرور</button>
          {pwMsg && <Status ok={pwMsg.ok}>{pwMsg.text}</Status>}
        </section>

        <section className={SECTION}>
          <h3 className="m-0 text-[15px] font-semibold text-ink">الإشعارات</h3>
          {NOTIF_PREFS.map(([id, label, sub]) => {
            const on = prefs[id];
            return (
              <div key={id} className="flex items-center justify-between gap-3.5 py-1">
                <span className="min-w-0">
                  <span className="block text-sm text-ink">{label}</span>
                  <span className="mt-0.5 block text-xs font-light text-fnt">{sub}</span>
                </span>
                <button
                  type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => togglePref(id)}
                  className="relative h-[30px] w-[50px] shrink-0 cursor-pointer rounded-full border-0 transition-colors duration-[250ms]"
                  style={{ background: on ? "var(--ok)" : "var(--ln2)" }}
                >
                  <span className="absolute top-[3px] h-6 w-6 rounded-full bg-white" style={{ right: on ? 3 : 23, boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "right .25s cubic-bezier(.2,.7,.2,1)" }} />
                </button>
              </div>
            );
          })}
        </section>

        <section className={SECTION}>
          <h3 className="m-0 text-[15px] font-semibold text-ink">المظهر</h3>
          <div className="grid grid-cols-2 gap-1 rounded-[14px] bg-sf2 p-1">
            {([["light", "فاتح"], ["dark", "داكن"]] as const).map(([t, label]) => (
              <button key={t} type="button" onClick={() => setTheme(t)} aria-pressed={theme === t} className="min-h-[42px] cursor-pointer rounded-[10px] border-0 text-[13px] text-ink" style={{ background: theme === t ? "var(--sf)" : "transparent" }}>{label}</button>
            ))}
          </div>
        </section>

        <section className={`${SECTION} !gap-1`}>
          <Link href="/legal/terms" className="flex min-h-12 items-center justify-between border-b border-ln text-sm text-ink"><span>الشروط والأحكام</span><span className="text-fnt">‹</span></Link>
          <Link href="/legal/privacy" className="flex min-h-12 items-center justify-between text-sm text-ink"><span>سياسة الخصوصية</span><span className="text-fnt">‹</span></Link>
        </section>

        <section className={SECTION} style={{ borderColor: "color-mix(in oklab, var(--bad) 30%, var(--ln))" }}>
          <h3 className="m-0 text-[15px] font-semibold text-bad">حذف الحساب</h3>
          <p className="m-0 text-[13px] font-light leading-[1.9] text-ink2">سيتم حذف حسابك وملفات أبحاثك نهائيًا خلال ٣٠ يومًا. الرصيد المتبقي غير قابل للاسترداد بعد الحذف.</p>
          {!delOpen ? (
            <button type="button" onClick={() => { setDelOpen(true); setDelTxt(""); }} className="min-h-11 cursor-pointer self-start rounded-full border border-bad bg-transparent px-5 text-[13px] text-bad">حذف حسابي</button>
          ) : (
            <div className="flex flex-col gap-2.5" style={{ animation: "up .25s both" }}>
              <label className="flex flex-col gap-1.5">
                <span className="text-[13px] text-mut">اكتب «حذف» للتأكيد</span>
                <input type="text" value={delTxt} onChange={(e) => setDelTxt(e.target.value)} className={INPUT} style={{ borderColor: "var(--bad)" }} />
              </label>
              <div className="flex gap-2">
                <button type="button" onClick={deleteAccount} disabled={delTxt.trim() !== "حذف" || delBusy} className="min-h-11 cursor-pointer rounded-full border-0 bg-bad px-5 text-[13px] text-bg" style={{ opacity: delTxt.trim() === "حذف" ? 1 : 0.4 }}>حذف نهائي</button>
                <button type="button" onClick={() => setDelOpen(false)} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-[18px] text-[13px] text-ink">إلغاء</button>
              </div>
              {delErr && <Status ok={false}>{delErr}</Status>}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
