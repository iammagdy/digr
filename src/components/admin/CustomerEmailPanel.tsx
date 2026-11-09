"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { CUSTOMER_MESSAGE_CTA_PAGES, CUSTOMER_MESSAGE_LIMITS, CUSTOMER_MESSAGE_PRESETS, renderCustomerMessageHtml, validateCustomerMessage, type CustomerMessage } from "@/lib/customerMessage";
import { dateTimeAr } from "./format";

interface MissionOption { id: string; status: string; createdAt: string | null; requestAr: string; files: string[] }
interface Info { email: string; name: string; greetingName: string; adminEmail: string | null; uploadMaxBytes: number; missions: MissionOption[] }
interface AttachmentInfo { filename: string; bytes: number; source: string }

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.floor(Math.random() * 1e9)}`).replace(/[^A-Za-z0-9_-]/g, "");
const field = "min-h-11 rounded-xl border border-ln bg-bg px-3 text-base text-ink outline-none";
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} ك.ب`;
const ACCEPT = ".xlsx,.csv,.pdf,.docx";

/**
 * «راسل العميل»: a message from the admin to this customer in the platform's e-mail design, sent from noreply@diger.tech to the customer's
 * registered address only. Attachments: a file from the admin's computer (the results sheet, a report) and/or the result file of one of the
 * customer's missions (or of a mission the admin ran for them on the test account). «نسخة تجريبية لي» sends the same e-mail to the admin first.
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
  const [upload, setUpload] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<"" | "check" | "send" | "test">("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [checked, setChecked] = useState<AttachmentInfo[] | null>(null);
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
  const maxUpload = info?.uploadMaxBytes ?? 4 * 1024 * 1024;

  /** JSON, or multipart when a file from the computer is attached (the payload is the same JSON). */
  const call = <T,>(action: "preview" | "send" | "test") => {
    const payload = { ...message, action, ...(missionId.trim() ? { missionId: missionId.trim(), fileName } : {}), idempotencyKey: key };
    if (!upload) return adminFetch<T>(`/api/admin/users/${userId}/email`, { method: "POST", body: JSON.stringify(payload) });
    const form = new FormData();
    form.append("payload", JSON.stringify(payload));
    form.append("file", upload, upload.name);
    return adminFetch<T>(`/api/admin/users/${userId}/email`, { method: "POST", body: form });
  };

  const pickFile = (f: File | null) => {
    setChecked(null); setStatus(null);
    if (!f) { setUpload(null); return; }
    const ext = f.name.toLowerCase().split(".").pop() ?? "";
    if (!["xlsx", "csv", "pdf", "docx"].includes(ext)) { setUpload(null); setStatus({ ok: false, text: "نوع الملف غير مسموح؛ المسموح: Excel أو CSV أو PDF أو Word." }); return; }
    if (f.size > maxUpload) { setUpload(null); setStatus({ ok: false, text: "الملف أكبر من ٤ ميجابايت." }); return; }
    setUpload(f);
  };
  const clearFile = () => { setUpload(null); setChecked(null); if (fileInput.current) fileInput.current.value = ""; };

  const checkAttachments = async () => {
    if (!check.ok) return;
    setBusy("check"); setStatus(null);
    try {
      const r = await call<{ attachments: AttachmentInfo[] }>("preview");
      setChecked(r.attachments);
      setStatus({ ok: true, text: r.attachments.length ? "المرفقات جاهزة." : "لا مرفقات." });
    } catch (e) { setChecked(null); setStatus({ ok: false, text: e instanceof Error ? e.message : "تعذّر فحص المرفقات" }); } finally { setBusy(""); }
  };

  const send = async (action: "send" | "test") => {
    if (!check.ok || !info || busy) return;
    const names = [upload?.name, missionId.trim() ? `ملف المهمة ${missionId.trim()}` : ""].filter(Boolean).join("، ");
    const to = action === "test" ? (info.adminEmail ?? "بريدك") : info.email;
    if (!window.confirm(`${action === "test" ? "إرسال نسخة تجريبية" : "إرسال الرسالة"} «${check.value.subject}» إلى ${to}؟${names ? `\nالمرفقات: ${names}` : ""}`)) return;
    setBusy(action); setStatus(null);
    try {
      const r = await call<{ messageAr: string; attachments: AttachmentInfo[] }>(action);
      setStatus({ ok: true, text: r.messageAr });
      setChecked(r.attachments);
      setKey(newKey());
    } catch (e) { setStatus({ ok: false, text: e instanceof Error ? e.message : "تعذّر الإرسال" }); } finally { setBusy(""); }
  };

  if (!open) {
    return (
      <section>
        <h3 className="mb-1.5 mt-0 text-[13px] font-semibold text-mut">راسل العميل</h3>
        <div className="flex flex-col gap-2 rounded-[14px] border border-ln p-3">
          <p className="m-0 text-xs leading-[1.8] text-mut">رسالة بتصميم ديجر من noreply@diger.tech إلى بريد العميل المسجّل، مع مرفق من جهازك أو ملف نتائج مهمة.</p>
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

            <div className="flex flex-col gap-2 rounded-xl bg-sf2 p-2.5">
              <span className="text-xs font-semibold text-ink">المرفقات (اختياري)</span>

              <span className="text-[11px] text-fnt">ملف من جهازك: Excel أو CSV أو PDF أو Word، حتى ٤ ميجابايت.</span>
              <input ref={fileInput} type="file" accept={ACCEPT} onChange={(e) => pickFile(e.target.files?.[0] ?? null)} aria-label="ملف مرفق من جهازك" className="text-xs text-ink file:mr-0 file:ml-2 file:min-h-10 file:cursor-pointer file:rounded-full file:border file:border-ln2 file:bg-sf file:px-4 file:text-xs file:font-semibold file:text-ink" />
              {upload && (
                <span className="flex items-center gap-2 text-[11px] text-ink">📎 <span dir="ltr">{upload.name}</span> ({kb(upload.size)})
                  <button type="button" onClick={clearFile} className="cursor-pointer rounded-full border border-ln2 bg-transparent px-2.5 py-0.5 text-[11px] text-ink">إزالة</button>
                </span>
              )}

              <span className="mt-1 text-[11px] text-fnt">أو ملف نتائج مهمة: من مهام هذا العميل، أو رقم مهمة شغّلتها له من «الوكيل» أو «إعادة تشغيل مجانية».</span>
              <select value={info.missions.some((x) => x.id === missionId) ? missionId : ""} onChange={(e) => { setMissionId(e.target.value); setChecked(null); setStatus(null); }} className={field}>
                <option value="">بدون ملف مهمة / رقم آخر</option>
                {info.missions.filter((x) => x.files.length > 0).map((x) => <option key={x.id} value={x.id}>{(x.createdAt ? dateTimeAr(x.createdAt).split("،")[0] + " · " : "") + x.requestAr.slice(0, 60)}</option>)}
              </select>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <input dir="ltr" value={missionId} onChange={(e) => { setMissionId(e.target.value.trim()); setChecked(null); setStatus(null); }} placeholder="msn_…" aria-label="رقم المهمة" className={`${field} text-left font-mono text-sm`} />
                <select value={fileName} onChange={(e) => { setFileName(e.target.value); setChecked(null); }} aria-label="نوع ملف المهمة" className={field}><option value="result.xlsx">Excel</option><option value="result.csv">CSV</option></select>
              </div>
              {(upload || missionId) && <button type="button" onClick={checkAttachments} disabled={busy !== "" || !check.ok} className="min-h-10 cursor-pointer self-start rounded-full border border-ln2 bg-transparent px-4 text-xs font-semibold text-ink disabled:opacity-50">{busy === "check" ? "جارٍ الفحص…" : "فحص المرفقات"}</button>}
              {checked && checked.length > 0 && checked.map((a) => <span key={a.filename + a.source} className="text-[11px] text-ok">📎 {a.filename} ({kb(a.bytes)})</span>)}
            </div>

            {!check.ok && <p className="m-0 text-xs text-bad">{check.errorAr}</p>}
            {check.ok && (
              <div className="overflow-hidden rounded-xl border border-ln">
                <p className="m-0 bg-sf2 px-3 py-1.5 text-[11px] text-mut">معاينة: هكذا تصل الرسالة{upload || missionId ? " (والمرفقات معها)" : ""}</p>
                <iframe title="معاينة الرسالة" sandbox="" srcDoc={previewHtml} className="block h-[520px] w-full border-0 bg-white" />
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => send("send")} disabled={!check.ok || busy !== ""} className="min-h-11 cursor-pointer rounded-full border-0 bg-ac px-5 text-[13px] font-semibold text-onac disabled:opacity-50">{busy === "send" ? "جارٍ الإرسال…" : "إرسال الرسالة"}</button>
              <button type="button" onClick={() => send("test")} disabled={!check.ok || busy !== "" || !info.adminEmail} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-5 text-[13px] font-semibold text-ink disabled:opacity-50">{busy === "test" ? "جارٍ الإرسال…" : "نسخة تجريبية لي"}</button>
            </div>
            <p role="status" aria-live="polite" className="m-0 min-h-[1.1rem] text-xs leading-[1.8]" style={{ color: status ? (status.ok ? "var(--ok)" : "var(--bad)") : "var(--fnt)" }}>{status?.text || "تُسجَّل كل رسالة للعميل في سجل الإدارة باسمك."}</p>
          </>
        )}
      </div>
    </section>
  );
}
