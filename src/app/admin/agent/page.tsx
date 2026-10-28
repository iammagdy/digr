"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { toArabicDigits } from "@/lib/arabicDigits";
import { useAdmin } from "@/components/admin/AdminShell";
import { countsLineAr } from "@/lib/agentMission/eventText";

const SECTION = "flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-4";
const BTN = "hit min-h-11 cursor-pointer rounded-xl border border-ln2 bg-sf px-4 text-sm font-semibold text-ink disabled:opacity-50";
const POLL_MS = 3000;
const OVERVIEW_POLL_MS = 10000;

interface WorkerMemory { rssMb: number; treeRssMb: number | null; limitMb: number; warn: boolean }
interface WorkerState { alive: boolean; ageSeconds: number | null; lastBeatAt: string | null; workers: Array<{ worker_id: string; active_missions: number; model: string | null; version: string | null }>; memory: WorkerMemory | null }
interface MissionRow { id: string; request_text: string; status: string; question_ar: string | null; reserved_points: number | null; unit_price_points: number | null; delivered_units: number | null; charged_points: number | null; planning_model: string | null; planning_llm_usd: number; execution_model: string | null; execution_llm_usd: number; planning_treg_usd: number; execution_treg_usd: number; created_at: string }
interface Overview { tablesReady: boolean; worker: WorkerState; planningModel: string | null; allowedModels: string[]; testAccountEmail: string; missions: MissionRow[] }
interface EventRow { id: number; kind: string; message_ar: string; counts: Record<string, number>; created_at: string }
interface CustomerStage { key: string; title_ar: string; expected_rows: number; parent_key: string | null; deliver: boolean; columns: Array<{ key: string; title_ar: string }>; sample_rows: Array<Record<string, unknown>>; how_ar?: string }
interface CustomerPlan { summary_ar: string; stages: CustomerStage[]; price: { unit_price_points: number; reserve_points: number; max_charge_points: number; delivered_rows: number } }
interface Detail {
  mission: MissionRow & { summary_ar: string | null; error: string | null; files: Array<{ name: string; kind: string }> | null; job_id: string | null; answer_text: string | null };
  customerPlan: CustomerPlan | null;
  internalPlan: { stages: Array<{ key: string; endpoint_id: string; measured_cost_per_row_usd: number }>; price: { costPerFinalRowUsd: number; totalCostUsd: number } } | null;
  events: EventRow[];
  calls: { total: number; refused: number; items?: Array<{ id: string; phase: string; endpoint_id: string; status: string; refused_reason: string | null; rows_returned: number | null; cost_usd: number; params_digest?: Record<string, unknown> | null }> };
}

const STATUS_AR: Record<string, string> = { queued: "في الانتظار", planning: "يخطّط", needs_input: "ينتظر إجابتك", plan_ready: "الخطة جاهزة", approved: "معتمدة", executing: "ينفّذ", completed: "اكتملت", failed: "تعذّرت", unserved: "لا يمكن خدمتها", cancelled: "أُلغيت" };
const TERMINAL = new Set(["completed", "failed", "unserved", "cancelled"]);
const MODEL_AR: Record<string, string> = { "claude-haiku-5-5": "هايكو ٥٫٥ (الأرخص)", "claude-sonnet-5-5": "سونيت ٥٫٥ (الأقوى)" };

/** USD with Arabic-Indic digits: this screen is admin-only, one of the few places a cost in dollars is shown. */
const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${toArabicDigits(Number(n).toFixed(4))} دولار`);
const pts = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${toArabicDigits(Math.round(Number(n) * 1000) / 1000)} نقطة`);
const num = (n: number | null | undefined) => (n === null || n === undefined ? "—" : toArabicDigits(String(n)));
const hhmm = (iso: string) => toArabicDigits(new Date(iso).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }));
const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).slice(0, 140);

export default function AgentPage() {
  const { toast } = useAdmin();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [answer, setAnswer] = useState("");
  const lastEvent = useRef(0);

  const loadOverview = useCallback(async () => {
    try { setOverview(await adminFetch<Overview>("/api/admin/agent")); } catch (e) { toast(e instanceof Error ? e.message : "تعذّر التحميل"); }
  }, [toast]);

  useEffect(() => { void loadOverview(); const t = setInterval(() => { void loadOverview(); }, OVERVIEW_POLL_MS); return () => clearInterval(t); }, [loadOverview]);

  const loadDetail = useCallback(async (id: string, reset: boolean) => {
    try {
      const d = await adminFetch<Detail>(`/api/admin/agent/${id}?after=${reset ? 0 : lastEvent.current}`);
      setDetail(d);
      setEvents((prev) => {
        const base = reset ? [] : prev;
        const merged = [...base, ...d.events.filter((e) => !base.some((b) => b.id === e.id))];
        lastEvent.current = merged.reduce((n, e) => Math.max(n, e.id), 0);
        return merged;
      });
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّر تحميل المهمة"); }
  }, [toast]);

  useEffect(() => {
    if (!selected) return;
    lastEvent.current = 0;
    void loadDetail(selected, true);
    const t = setInterval(() => { void loadDetail(selected, false); }, POLL_MS);
    return () => clearInterval(t);
  }, [selected, loadDetail]);

  async function create() {
    if (busy || text.trim().length < 3) return;
    setBusy(true);
    try {
      const r = await adminFetch<{ id: string }>("/api/admin/agent", { method: "POST", body: JSON.stringify({ action: "create", text }) });
      setText(""); setSelected(r.id); await loadOverview();
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّر إنشاء المهمة"); } finally { setBusy(false); }
  }
  async function act(action: "approve" | "answer" | "cancel") {
    if (!selected || busy) return;
    if (action === "approve" && !window.confirm("سيُحجز رصيد حساب الاختبار الآن بحسب السعر المحسوب بالكود. هل تعتمد الخطة؟")) return;
    setBusy(true);
    try {
      await adminFetch(`/api/admin/agent/${selected}`, { method: "POST", body: JSON.stringify({ action, text: answer }) });
      if (action === "answer") setAnswer("");
      await loadDetail(selected, false); await loadOverview();
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّر التنفيذ"); } finally { setBusy(false); }
  }
  async function download(name: string) {
    if (!selected) return;
    try { const r = await adminFetch<{ url: string }>(`/api/admin/agent/${selected}/file?name=${encodeURIComponent(name)}`); window.open(r.url, "_blank", "noopener"); } catch (e) { toast(e instanceof Error ? e.message : "تعذّر تنزيل الملف"); }
  }
  async function setModel(model: string) {
    try { await adminFetch("/api/admin/agent", { method: "POST", body: JSON.stringify({ action: "planning_model", model }) }); await loadOverview(); toast("حُفظ نموذج التخطيط"); } catch (e) { toast(e instanceof Error ? e.message : "تعذّر الحفظ"); }
  }

  const w = overview?.worker;
  const m = detail?.mission;
  const plan = detail?.customerPlan;
  const live = m ? !TERMINAL.has(m.status) : false;
  return (
    <div className="flex flex-col gap-4" dir="rtl">
      <section className={SECTION} aria-label="الوكيل">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-base font-semibold text-ink">الوكيل</h2>
          <span data-testid="agent-heartbeat" className="inline-flex items-center gap-2 rounded-full border border-ln px-3 py-1 text-[13px] text-ink" aria-live="polite">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: w ? (w.alive ? "var(--ok)" : "var(--bad)") : "var(--ln2)" }} />
            {!w ? "…" : w.alive ? `العامل يعمل (آخر نبضة قبل ${num(w.ageSeconds)} ث)` : w.lastBeatAt ? `العامل متوقف (آخر نبضة قبل ${num(w.ageSeconds)} ث)` : "العامل لم يبدأ بعد"}
          </span>
        </div>
        {w?.memory ? (
          <p className={`m-0 text-[13px] ${w.memory.warn ? "text-bad" : "text-ink2"}`} data-testid="agent-memory" role={w.memory.warn ? "alert" : undefined}>
            ذاكرة العامل: {num(w.memory.rssMb)} م.ب{w.memory.treeRssMb !== null ? ` · مع العمليات التي بدأها ${num(w.memory.treeRssMb)} م.ب من ${num(w.memory.limitMb)}` : ""}{w.memory.warn ? " — قريبة من حدّ الخادم؛ أبقِ المهام المتزامنة على واحدة" : ""}
          </p>
        ) : <p className="m-0 text-[13px] text-ink2" data-testid="agent-memory">ذاكرة العامل: لم تُسجَّل بعد.</p>}
        <p className="m-0 text-[13px] font-light leading-[1.9] text-ink2">اكتب مهمة بيانات؛ يخطّط لها وكيل Claude، ثم يظهر لك سعرها المحسوب بالكود من التكاليف المقيسة فعلًا، ولا يبدأ التنفيذ ولا يُحجز رصيد إلا بعد زر الاعتماد. تعمل هذه الصفحة <b>لحساب الاختبار فقط</b>{overview ? <> (<span dir="ltr">{overview.testAccountEmail}</span>)</> : null}، ولا تغيّر شيئًا للعملاء.</p>
        {overview && !overview.tablesReady ? <p className="m-0 text-[13px] text-bad" role="alert">جداول الوكيل غير مُطبَّقة بعد: SQL في docs/proposals/agent-worker لم يُطبَّق.</p> : null}
        <label className="flex flex-wrap items-center gap-2 text-[13px] text-ink">
          نموذج التخطيط:
          <select className="min-h-11 rounded-xl border border-ln2 bg-sf px-3 text-sm" value={overview?.planningModel ?? ""} onChange={(e) => { if (e.target.value) void setModel(e.target.value); }} data-testid="agent-model">
            <option value="">الافتراضي (هايكو)</option>
            {(overview?.allowedModels ?? []).map((id) => <option key={id} value={id}>{MODEL_AR[id] ?? id}</option>)}
          </select>
          <span className="text-ink2">تكلفة النموذج تُسجَّل لكل مهمة لتقارن بينهما.</span>
        </label>
        <textarea className="min-h-28 w-full rounded-xl border border-ln2 bg-sf p-3 text-sm" placeholder="مثال: هات لي ٣٠٠ منشور عن القهوة في مصر على إكس مع تعليقات كل منشور" value={text} onChange={(e) => setText(e.target.value)} data-testid="agent-text" />
        <div><button type="button" className={BTN} disabled={busy || text.trim().length < 3} onClick={create} data-testid="agent-create">شغّل الوكيل</button></div>
      </section>

      <section className={SECTION} aria-label="المهام">
        <h3 className="m-0 text-[13px] font-semibold text-ink">آخر المهام</h3>
        {(overview?.missions ?? []).length === 0 ? <p className="m-0 text-[13px] text-ink2">لا مهام بعد.</p> : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {overview!.missions.map((x) => (
              <li key={x.id}>
                <button type="button" onClick={() => setSelected(x.id)} className={`w-full cursor-pointer rounded-xl border px-3 py-2 text-right text-[13px] ${selected === x.id ? "border-gold bg-sf2" : "border-ln bg-bg"}`} data-testid={`mission-${x.id}`}>
                  <b>{STATUS_AR[x.status] ?? x.status}</b> · {hhmm(x.created_at)} · {x.request_text.slice(0, 90)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {m ? (
        <section className={SECTION} aria-label="تفاصيل المهمة" data-testid="agent-detail">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="m-0 text-[14px] font-semibold text-ink">{STATUS_AR[m.status] ?? m.status}{live ? " …" : ""}</h3>
            {["queued", "needs_input", "plan_ready"].includes(m.status) ? <button type="button" className={BTN} disabled={busy} onClick={() => act("cancel")}>إلغاء</button> : null}
          </div>
          <p className="m-0 text-[13px] text-ink2">{m.request_text}</p>

          <div className="flex flex-col gap-1 rounded-xl border border-ln p-3" data-testid="agent-events" aria-live="polite">
            {events.length === 0 ? <span className="text-[13px] text-ink2">لا أحداث بعد…</span> : events.map((e) => (
              <div key={e.id} className="text-[13px] text-ink"><span className="text-ink2">{hhmm(e.created_at)}</span> {e.message_ar}
                {countsLineAr(e.counts) ? <span className="text-ink2"> ({countsLineAr(e.counts)})</span> : null}
              </div>
            ))}
          </div>

          {m.status === "needs_input" && m.question_ar ? (
            <div className="flex flex-col gap-2 rounded-xl border border-gold p-3" data-testid="agent-question">
              <b className="text-[13px]">{m.question_ar}</b>
              <input className="min-h-11 rounded-xl border border-ln2 bg-sf px-3 text-sm" value={answer} onChange={(e) => setAnswer(e.target.value)} />
              <div><button type="button" className={BTN} disabled={busy || !answer.trim()} onClick={() => act("answer")}>أرسل الإجابة</button></div>
            </div>
          ) : null}

          {plan ? (
            <div className="flex flex-col gap-3 rounded-xl border border-ln p-3" data-testid="agent-plan">
              <b className="text-[13px]">الخطة</b>
              <p className="m-0 text-[13px] leading-[1.9] text-ink">{plan.summary_ar}</p>
              {plan.stages.map((s, i) => (
                <div key={s.key} className="rounded-xl border border-ln p-3">
                  <div className="text-[13px] font-semibold text-ink">{num(i + 1)}. {s.title_ar}{s.parent_key ? ` — لكل صف من «${plan.stages.find((p) => p.key === s.parent_key)?.title_ar}»` : ""}</div>
                  <div className="text-[12px] text-ink2">الصفوف المتوقعة {num(s.expected_rows)} · {s.deliver ? "تُسلَّم في الملفات" : "مرحلة وسيطة"}{s.how_ar ? ` · ${s.how_ar}` : ""}</div>
                  <div className="mt-2 overflow-auto"><table className="w-full border-collapse text-[12px]"><thead><tr className="text-right text-ink2">{s.columns.map((c) => <th key={c.key} className="px-2 py-1">{c.title_ar}</th>)}</tr></thead>
                    <tbody>{s.sample_rows.map((r, k) => <tr key={k}>{s.columns.map((c) => <td key={c.key} className="px-2 py-1">{cell(r[c.key])}</td>)}</tr>)}</tbody></table></div>
                </div>
              ))}
              <div className="rounded-xl bg-sf2 p-3 text-[13px] text-ink" data-testid="agent-price">
                <div>سعر الصف: <b>{pts(plan.price.unit_price_points)}</b> · الصفوف المسلَّمة المتوقعة: <b>{num(plan.price.delivered_rows)}</b></div>
                <div>الحجز: <b>{pts(plan.price.reserve_points)}</b> · أقصى خصم: <b>{pts(plan.price.max_charge_points)}</b> (يُخصم فقط ما سُلّم فعلًا، ويُحرَّر الباقي)</div>
                <div className="text-[12px] text-ink2">السعر محسوب بالكود من تكلفة كل صف قيست فعلًا: سعر الصف = تكلفة الصف النهائي × ٥٥٠٠، والحجز = ⌈العدد × السعر × ١٫١٥⌉ بحدّ ٢٥٬٠٠٠ نقطة.</div>
              </div>
              {detail?.internalPlan ? (
                <details className="text-[12px] text-ink2" data-testid="agent-internal">
                  <summary className="cursor-pointer">تفاصيل داخلية للمشرف فقط (المصادر والتكاليف)</summary>
                  <div className="mt-1 leading-[1.9]">{detail.internalPlan.stages.map((s) => `${s.key}: ${s.endpoint_id} ← ${usd(s.measured_cost_per_row_usd)} للصف`).join(" · ")} · تكلفة الصف النهائي {usd(detail.internalPlan.price.costPerFinalRowUsd)} · التكلفة الكلية المتوقعة {usd(detail.internalPlan.price.totalCostUsd)}</div>
                </details>
              ) : null}
              {m.status === "plan_ready" ? <div><button type="button" className={BTN} disabled={busy} onClick={() => act("approve")} data-testid="agent-approve">اعتمد الخطة واحجز الرصيد</button></div> : null}
            </div>
          ) : null}

          {m.summary_ar ? <p className="m-0 rounded-xl bg-sf2 p-3 text-[13px] text-ink" data-testid="agent-summary">{m.summary_ar}</p> : null}
          {m.delivered_units !== null && m.delivered_units !== undefined ? <p className="m-0 text-[13px] text-ink">سُلّم {num(m.delivered_units)} صفًا · خُصم {pts(m.charged_points)} من حجز {pts(m.reserved_points)}</p> : null}
          {m.files && m.files.length ? (
            <div className="flex flex-wrap gap-2" data-testid="agent-files">{m.files.map((f) => <button key={f.name} type="button" className={BTN} onClick={() => download(f.name)}>{f.kind === "xlsx" ? "تنزيل ملف إكسل" : "تنزيل ملف CSV"}</button>)}</div>
          ) : null}
          <div className="text-[12px] leading-[1.9] text-ink2" data-testid="agent-cost">
            تكلفة المهمة (للمشرف): التخطيط {MODEL_AR[m.planning_model ?? ""] ?? m.planning_model ?? "—"} {usd(m.planning_llm_usd)} نموذج + {usd(m.planning_treg_usd)} مصدر · التنفيذ {MODEL_AR[m.execution_model ?? ""] ?? m.execution_model ?? "—"} {usd(m.execution_llm_usd)} نموذج + {usd(m.execution_treg_usd)} مصدر · استدعاءات {num(detail?.calls.total)} (مرفوضة {num(detail?.calls.refused)})
          </div>
          {detail?.calls.items && detail.calls.items.length > 0 ? (
            <details className="text-[12px] text-ink2" data-testid="agent-calls">
              <summary className="cursor-pointer">سجل استدعاءات المصادر (للمشرف فقط)</summary>
              <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0" dir="ltr">
                {detail.calls.items.map((c) => (
                  <li key={c.id}>{c.id.split(":").pop()} · {c.phase} · {c.endpoint_id} · {c.status}{c.refused_reason ? ` (${c.refused_reason})` : ""} · {c.rows_returned ?? 0} rows · {Number(c.cost_usd).toFixed(5)} USD{c.params_digest?.cost_basis === "estimated" ? " (estimated)" : ""}{c.params_digest?._why ? ` · why: ${String(c.params_digest._why)}` : ""}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {m.error ? <p className="m-0 text-[12px] text-bad" dir="ltr">{m.error}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
