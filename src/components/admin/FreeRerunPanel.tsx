"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import { dateTimeAr } from "./format";

interface Source { id: string; status: string; requestAr: string; createdAt: string | null }
interface Rerun {
  id: string; status: string; requestAr: string; createdAt: string | null; summaryAr: string | null; questionAr: string | null;
  reservePoints: number | null; deliveredUnits: number | null; chargedPoints: number | null; holdGrant: number; refunded: number; files: string[];
}
interface Data { sources: Source[]; reruns: Rerun[] }

const STATUS_AR: Record<string, string> = {
  queued: "في الانتظار", planning: "يخطط الوكيل", needs_input: "سؤال للعميل", plan_ready: "الخطة جاهزة للاعتماد", approved: "قيد التنفيذ", executing: "قيد التنفيذ",
  completed: "اكتملت", failed: "فشلت", unserved: "لم تُخدم", cancelled: "أُلغيت",
};
const ACTIVE = new Set(["queued", "planning", "approved", "executing"]);
const SOURCE_STATUS_AR: Record<string, string> = { failed: "فشلت", unserved: "لم تُخدم", completed: "اكتملت", cancelled: "أُلغيت" };
const field = "min-h-11 rounded-xl border border-ln bg-bg px-3 text-base text-ink outline-none";
const pill = "min-h-10 cursor-pointer rounded-full px-4 text-xs font-semibold disabled:opacity-50";

/**
 * «إعادة تشغيل مجانية»: the admin runs a request again ON THE CUSTOMER'S ACCOUNT (their requests, their notices, their file) and the customer pays nothing:
 * whatever the settlement charges is given back at once (src/lib/agentMission/freeRerun.ts). The admin approves the plan here; the customer is never asked to.
 */
export function FreeRerunPanel({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [source, setSource] = useState("");
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => adminFetch<Data>(`/api/admin/users/${userId}/reruns`).then((d) => { setData(d); setError(""); }).catch((e) => setError(e instanceof Error ? e.message : "تعذّر التحميل")), [userId]);
  useEffect(() => { if (open) void load(); }, [open, load]);
  // while a re-run is being planned or carried out, the list follows it
  useEffect(() => {
    if (!open || !data?.reruns.some((r) => ACTIVE.has(r.status))) return;
    const t = setInterval(() => { void load(); }, 8000);
    return () => clearInterval(t);
  }, [open, data, load]);

  const act = async (key: string, body: Record<string, unknown>, confirmAr?: string) => {
    if (busy || (confirmAr && !window.confirm(confirmAr))) return;
    setBusy(key); setMsg(null);
    try {
      const r = await adminFetch<{ messageAr: string }>(`/api/admin/users/${userId}/reruns`, { method: "POST", body: JSON.stringify(body) });
      setMsg({ ok: true, text: r.messageAr });
      if (body.action === "create") { setSource(""); setText(""); }
      await load();
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "تعذّر التنفيذ" }); } finally { setBusy(""); }
  };

  const pickSource = (id: string) => {
    setSource(id);
    const s = data?.sources.find((x) => x.id === id);
    setText(s ? s.requestAr : "");
    setMsg(null);
  };

  if (!open) {
    return (
      <section>
        <h3 className="mb-1.5 mt-0 text-[13px] font-semibold text-mut">إعادة تشغيل مجانية</h3>
        <div className="flex flex-col gap-2 rounded-[14px] border border-ln p-3">
          <p className="m-0 text-xs leading-[1.8] text-mut">تشغّل طلبًا للعميل على حسابه هو (يظهر في طلباته ويصله الإشعار والملف)، ويُعاد له ما يُخصم فور التسوية فلا يدفع شيئًا.</p>
          <button type="button" onClick={() => setOpen(true)} className="min-h-11 cursor-pointer self-start rounded-full border border-ln2 bg-transparent px-5 text-[13px] font-semibold text-ink">فتح</button>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h3 className="mb-1.5 mt-0 text-[13px] font-semibold text-mut">إعادة تشغيل مجانية</h3>
      <div className="flex flex-col gap-3 rounded-[14px] border border-ln p-3">
        {error && <p role="alert" className="m-0 text-xs text-bad">{error}</p>}
        {!data && !error && <p className="m-0 text-xs text-fnt">جارٍ التحميل…</p>}
        {data && (
          <>
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1.5"><span className="text-xs text-mut">الطلب الأصلي</span>
                <select value={source} onChange={(e) => pickSource(e.target.value)} className={field}>
                  <option value="">نص جديد</option>
                  {data.sources.map((s) => <option key={s.id} value={s.id}>{[(s.createdAt ? dateTimeAr(s.createdAt).split("،")[0] : ""), SOURCE_STATUS_AR[s.status] ?? "", s.requestAr.slice(0, 50)].filter(Boolean).join(" · ")}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1.5"><span className="text-xs text-mut">نص الطلب (يمكنك تعديله)</span>
                <textarea value={text} onChange={(e) => { setText(e.target.value); setMsg(null); }} rows={3} maxLength={4000} className={`${field} py-2 leading-[1.8]`} />
              </label>
              <button type="button" disabled={busy !== "" || text.trim().length < 3} onClick={() => act("create", { action: "create", sourceMissionId: source || undefined, text }, "تشغيل هذا الطلب مجانًا على حساب العميل؟")} className={`${pill} self-start border-0 bg-ac text-onac`}>{busy === "create" ? "جارٍ الإنشاء…" : "تشغيل مجانًا"}</button>
            </div>

            {data.reruns.length > 0 && <div className="h-px bg-ln" />}
            {data.reruns.map((r) => (
              <div key={r.id} className="flex flex-col gap-2 rounded-xl bg-sf2 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold text-ink">{STATUS_AR[r.status] ?? r.status}</span>
                  <span dir="ltr" className="font-mono text-[11px] text-fnt">{r.id}</span>
                </div>
                <p className="m-0 text-xs leading-[1.8] text-ink2">{r.requestAr}</p>
                {r.status === "needs_input" && (
                  <div className="flex flex-col gap-1.5">
                    <p className="m-0 text-xs font-semibold text-ink">سؤال الوكيل: {r.questionAr}</p>
                    <input value={answer[r.id] ?? ""} onChange={(e) => setAnswer((a) => ({ ...a, [r.id]: e.target.value }))} placeholder="الإجابة" className={field} />
                    <button type="button" disabled={busy !== "" || !(answer[r.id] ?? "").trim()} onClick={() => act(`answer:${r.id}`, { action: "answer", missionId: r.id, text: answer[r.id] })} className={`${pill} self-start border border-ln2 bg-transparent text-ink`}>إرسال الإجابة</button>
                  </div>
                )}
                {r.status === "plan_ready" && (
                  <>
                    {r.summaryAr && <p className="m-0 text-xs leading-[1.8] text-mut">الخطة: {r.summaryAr}</p>}
                    {r.reservePoints !== null && <p className="m-0 text-xs text-mut">الحجز: {formatAr(r.reservePoints)} نقطة، ويُعاد للعميل ما يُخصم بعد التسوية.</p>}
                  </>
                )}
                {["completed", "failed", "unserved"].includes(r.status) && (
                  <p className="m-0 text-xs leading-[1.8] text-mut">
                    {r.deliveredUnits !== null ? `عدد ما سُلّم: ${formatAr(r.deliveredUnits)}. ` : ""}
                    {r.chargedPoints ? `خُصم ${formatAr(r.chargedPoints)} نقطة، ومُنح العميل مقابله ${formatAr(r.refunded + r.holdGrant)} نقطة.` : r.holdGrant > 0 ? `لم يُخصم شيء، وبقي للعميل رصيد الحجز الممنوح (${formatAr(r.holdGrant)} نقطة).` : "لم يُخصم شيء."}
                    {r.files.length > 0 ? " الملف في طلبات العميل، ويمكنك إرساله له من «راسل العميل» برقم المهمة." : ""}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {r.status === "plan_ready" && <button type="button" disabled={busy !== ""} onClick={() => act(`approve:${r.id}`, { action: "approve", missionId: r.id }, `اعتماد الخطة مجانًا للعميل؟ يُحجز ${r.reservePoints !== null ? formatAr(r.reservePoints) : ""} نقطة من رصيده ثم يُعاد له ما يُخصم.`)} className={`${pill} border-0 bg-ac text-onac`}>{busy === `approve:${r.id}` ? "جارٍ الاعتماد…" : "اعتماد مجاني"}</button>}
                  {["queued", "needs_input", "plan_ready"].includes(r.status) && <button type="button" disabled={busy !== ""} onClick={() => act(`cancel:${r.id}`, { action: "cancel", missionId: r.id }, "إلغاء هذه المهمة؟")} className={`${pill} border border-ln2 bg-transparent text-ink`}>إلغاء</button>}
                  {["completed", "failed", "unserved"].includes(r.status) && (r.chargedPoints ?? 0) > r.refunded + r.holdGrant && <button type="button" disabled={busy !== ""} onClick={() => act(`refund:${r.id}`, { action: "refund", missionId: r.id })} className={`${pill} border border-ln2 bg-transparent text-ink`}>رد المبلغ الآن</button>}
                </div>
              </div>
            ))}
          </>
        )}
        <p role="status" aria-live="polite" className="m-0 min-h-[1.1rem] text-xs leading-[1.8]" style={{ color: msg ? (msg.ok ? "var(--ok)" : "var(--bad)") : "var(--fnt)" }}>{msg?.text || "كل إجراء يُسجَّل في سجل الإدارة باسمك."}</p>
      </div>
    </section>
  );
}
