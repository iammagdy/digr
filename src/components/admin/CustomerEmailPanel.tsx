"use client";

import { useEffect, useMemo, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { CUSTOMER_MESSAGE_CTA_PAGES, CUSTOMER_MESSAGE_LIMITS, CUSTOMER_MESSAGE_PRESETS, renderCustomerMessageHtml, validateCustomerMessage, type CustomerMessage } from "@/lib/customerMessage";
import { dateTimeAr } from "./format";

interface MissionOption { id: string; status: string; createdAt: string | null; requestAr: string; files: string[] }
interface Info { email: string; name: string; greetingName: string; missions: MissionOption[] }

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.floor(Math.random() * 1e9)}`).replace(/[^A-Za-z0-9_-]/g, "");
const field = "min-h-11 rounded-xl border border-ln bg-bg px-3 text-base text-ink outline-none";

/**
 * «راسل العميل»: a message from the admin to this customer in the platform's e-mail design, sent from noreply@diger.tech to the customer's
 * registered address only, optionally with the result file of one of their missions (or of a mission the admin ran for them on the test account).
 * The preview is the exact HTML the server sends (the same render function).
 */
export function CustomerEmailPanel({ userId }: { userId: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState(false);
  const [m, setM] = useState<CustomerMessage>({ subject: "", heading: "", body: "" });
  const [withButton, setWithButton] = useState(false);
  const [missionId, setMissionId] = useState("");
  const [fileName, setFileName] = useState("result.xlsx");
  const [busy, setBusy] = useState<"" | "check" | "send">("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [checkedAttachment, setCheckedAttachment] = useState<string>("");
  const [key, setKey] = useState(newKey);

  useEffect(() => {
    if (!open || info) return;
    adminFetch<Info>(`/api/admin/users/${userId}/email`).then((i) => {
      setInfo(i);
      setM(CUSTOMER_MESSAGE_PRESETS[0].build({ name: i.greetingName }));
      setWithButton(true);
    }).catch((e) => setLoadError(e instanceof Error ? e.message : "تعذّر التحميل"));
  }, [open, info, userId]);

  const message: CustomerMessage = useMemo(() => ({ subject: m.subject, badge: m.badge, heading: m.heading, body: m.body, ...(withButton ? { ctaLabel: m.ctaLabel, ctaPath: m.ctaPath } : {}) }), [m, withButton]);
  const check = useMemo(() => validateCustomerMessage(message), [message]);
  const previewHtml = useMemo(() => (check.ok ? renderCustomerMessageHtml(check.value) : ""), [check]);
  const set = (k: keyof CustomerMessage) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { setM((p) => ({ ...p, [k]: e.target.value })); setStatus(null); };

  const payload = () => ({ ...message, ...(missionId.trim() ? { missionId: missionId.trim(), fileName } : {}), idempotencyKey: key });

  const checkAttachment = async () => {
    if (!check.ok || !missionId.trim()) return;
    setBusy("check"); setStatus(null);
    try {
      const r = await adminFetch<{ attachment: { filename: string; bytes: number } | null }>(`/api/admin/users/${userId}/email`, { method: "POST", body: JSON.stringify({ ...payload(), action: "preview" }) });
      setCheckedAttachment(r.attachment ? `${r.attachment.filename} (${Math.max(1, Math.round(r.attachment.bytes / 1024))} ك.ب)` : "");
      setStatus({ ok: true, text: r.attachment ? "الملف جاهز للإرفاق." : "لا مرفق." });
    } catch (e) { setCheckedAttachment(""); setStatus({ ok: false, text: e instanceof Error ? e.message : "تعذّر فحص المرفق" }); } finally { setBusy(""); }
  };

  const send = async () => {
    if (!check.ok || !info || busy) return;
    const attachLine = missionId.trim() ? `\nمع ملف المهمة ${missionId.trim()}` : "";
    if (!window.confirm(`إرسال الرسالة «${check.value.subject}» إلى ${info.email}؟${attachLine}`)) return;
    setBusy("send"); setStatus(null);
    try {
      const r = await adminFetch<{ messageAr: string }>(`/api/admin/users/${userId}/email`, { method: "POST", body: JSON.stringify({ ...payload(), action: "send" }) });
      setStatus({ ok: true, text: r.messageAr });
      setKey(newKey());
    } catch (e) { setStatus({ ok: false, text: e instanceof Error ? e.message : "تعذّر الإرسال" }); } finally { setBusy(""); }
  };

  if (!open) {
    return (
      <section>
        <h3 className="mb-1.5 mt-0 text-[13px] font-semibold text-mut">راسل العميل</h3>
        <div className="flex flex-col gap-2 rounded-[14px] border border-ln p-3">
          <p className="m-0 text-xs leading-[1.8] text-mut">رسالة بتصميم ديجر من noreply@diger.tech إلى بريد العميل المسجّل، ويمكن إرفاق ملف نتائج مهمة.</p>
          <button type="button" onClick={() => setOpen(true)} className="min-h-11 cursor-pointer self-start rounded-full border border-ln2 bg-transparent px-5 text-[13px] font-semibold text-ink">كتابة رسالة</button>
        </div>
      </section>
    );
  }

  const L = CUSTOMER_MESSAGE_LIMITS;
  return (
    <section>
      <h3 className="mb-1.5 mt-0 text-[13px] font-semibold text-mut">راسل العميل</h3>
      <div className="flex flex-col gap-2.5 rounded-[14px] border border-ln p-3">
        {loadError && <p role="alert" className="m-0 text-xs text-bad">{loadError}</p>}
        {!info && !loadError && <p className="m-0 text-xs text-fnt">جارٍ التحميل…</p>}
        {info && (
          <>
            <p className="m-0 text-xs text-mut">إلى: <span dir="ltr" className="font-semibold text-ink">{info.email}</span> · من: <span dir="ltr">noreply@diger.tech</span> · الردود إلى <span dir="ltr">support@diger.tech</span></p>
            <label className="flex flex-col gap-1.5"><span className="text-xs text-mut">ابدأ من نص جاهز</span>
              <select defaultValue={CUSTOMER_MESSAGE_PRESETS[0].id} onChange={(e) => { const p = CUSTOMER_MESSAGE_PRESETS.find((x) => x.id === e.target.value); if (p) { const b = p.build({ name: info.greetingName }); setM(b); setWithButton(Boolean(b.ctaLabel)); setStatus(null); } }} className={field}>
                {CUSTOMER_MESSAGE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.labelAr}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1.5"><span className="text-xs text-mut">موضوع الرسالة</span><input value={m.subject} maxLength={L.subject.max} onChange={set("subject")} className={field} /></label>
            <label className="flex flex-col gap-1.5"><span className="text-xs text-mut">الشارة (اختياري)</span><input value={m.badge ?? ""} maxLength={L.badge.max} onChange={set("badge")} placeholder="مثال: تحديث بخصوص طلبك" className={field} /></label>
            <label className="flex flex-col gap-1.5"><span className="text-xs text-mut">العنوان داخل الرسالة</span><input value={m.heading} maxLength={L.heading.max} onChange={set("heading")} className={field} /></label>
            <label className="flex flex-col gap-1.5"><span className="text-xs text-mut">نص الرسالة (سطر فارغ = فقرة جديدة)</span><textarea value={m.body} maxLength={L.body.max} rows={9} onChange={set("body")} className={`${field} py-2 leading-[1.8]`} /></label>

            <label className="flex items-center gap-2 text-xs text-ink"><input type="checkbox" checked={withButton} onChange={(e) => { setWithButton(e.target.checked); if (e.target.checked && !m.ctaPath) setM((p) => ({ ...p, ctaLabel: p.ctaLabel || "فتح ديجر", ctaPath: "/dashboard/chat" })); }} /> زر داخل الرسالة</label>
            {withButton && (
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1.5"><span className="text-xs text-mut">نص الزر</span><input value={m.ctaLabel ?? ""} maxLength={L.ctaLabel.max} onChange={set("ctaLabel")} className={field} /></label>
                <label className="flex flex-col gap-1.5"><span className="text-xs text-mut">يفتح</span>
                  <select value={m.ctaPath ?? ""} onChange={set("ctaPath")} className={field}>
                    {CUSTOMER_MESSAGE_CTA_PAGES.map((p) => <option key={p.path} value={p.path}>{p.labelAr}</option>)}
                  </select>
                </label>
              </div>
            )}

            <div className="flex flex-col gap-1.5 rounded-xl bg-sf2 p-2.5">
              <span className="text-xs font-semibold text-ink">إرفاق ملف نتائج (اختياري)</span>
              <span className="text-[11px] leading-[1.7] text-fnt">من مهام هذا العميل، أو اكتب رقم مهمة شغّلتها له من صفحة «الوكيل» (حساب الاختبار).</span>
              <select value={info.missions.some((x) => x.id === missionId) ? missionId : ""} onChange={(e) => { setMissionId(e.target.value); setCheckedAttachment(""); setStatus(null); }} className={field}>
                <option value="">بدون مرفق / رقم آخر</option>
                {info.missions.filter((x) => x.files.length > 0).map((x) => <option key={x.id} value={x.id}>{(x.createdAt ? dateTimeAr(x.createdAt).split("،")[0] + " · " : "") + x.requestAr.slice(0, 60)}</option>)}
              </select>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <input dir="ltr" value={missionId} onChange={(e) => { setMissionId(e.target.value.trim()); setCheckedAttachment(""); setStatus(null); }} placeholder="msn_…" aria-label="رقم المهمة" className={`${field} text-left font-mono text-sm`} />
                <select value={fileName} onChange={(e) => { setFileName(e.target.value); setCheckedAttachment(""); }} aria-label="نوع الملف" className={field}><option value="result.xlsx">Excel</option><option value="result.csv">CSV</option></select>
              </div>
              {missionId && <button type="button" onClick={checkAttachment} disabled={busy !== "" || !check.ok} className="min-h-10 cursor-pointer self-start rounded-full border border-ln2 bg-transparent px-4 text-xs font-semibold text-ink disabled:opacity-50">{busy === "check" ? "جارٍ الفحص…" : "فحص المرفق"}</button>}
              {checkedAttachment && <span className="text-[11px] text-ok">📎 {checkedAttachment}</span>}
            </div>

            {!check.ok && <p className="m-0 text-xs text-bad">{check.errorAr}</p>}
            {check.ok && (
              <div className="overflow-hidden rounded-xl border border-ln">
                <p className="m-0 bg-sf2 px-3 py-1.5 text-[11px] text-mut">معاينة: هكذا تصل الرسالة</p>
                <iframe title="معاينة الرسالة" sandbox="" srcDoc={previewHtml} className="block h-[520px] w-full border-0 bg-white" />
              </div>
            )}

            <button type="button" onClick={send} disabled={!check.ok || busy !== ""} className="min-h-11 cursor-pointer self-start rounded-full border-0 bg-ac px-5 text-[13px] font-semibold text-onac disabled:opacity-50">{busy === "send" ? "جارٍ الإرسال…" : "إرسال الرسالة"}</button>
            <p role="status" aria-live="polite" className="m-0 min-h-[1.1rem] text-xs leading-[1.8]" style={{ color: status ? (status.ok ? "var(--ok)" : "var(--bad)") : "var(--fnt)" }}>{status?.text || "تُسجَّل كل رسالة في سجل الإدارة باسمك."}</p>
          </>
        )}
      </div>
    </section>
  );
}
