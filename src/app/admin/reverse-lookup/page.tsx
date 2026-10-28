"use client";

import { useEffect, useRef, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { toArabicDigits } from "@/lib/arabicDigits";
import { useAdmin } from "@/components/admin/AdminShell";
import { FIELD_KEYS, FIELD_LABEL_AR, fieldCount, type LookupFields } from "@/lib/adminLookupResult";

const SECTION = "flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-4";
const FIELD = "min-h-[46px] w-full rounded-xl border border-ln bg-bg px-3.5 text-sm text-ink outline-none text-left";
const BTN = "hit min-h-11 cursor-pointer rounded-xl border border-ln2 bg-sf px-4 text-sm font-semibold text-ink disabled:opacity-50";

interface PlanEntry { id: string; paramName: string; usd: number; paid: boolean; state: "auto" | "confirm" | "skipped"; skipReasonAr?: string; warningAr?: string }
interface Attempt { endpointId: string; outcome: string; costUsd: number; note: string }
interface HistoryRow { id: string; createdAt: string; kind: "phone" | "email"; maskedInput: string; found: boolean; fields: LookupFields; attempts: Attempt[]; costUsd: number }
interface AttemptReply { ok: boolean; reason?: string; attempt?: Attempt; found?: boolean; fields?: LookupFields; spentTodayUsd?: number; capUsd?: number; message?: string }

const ATTEMPT_AR: Record<string, string> = { found: "وجد بيانات", no_data: "لا بيانات", failed: "فشل", skipped_country: "تخطّاه: لا يغطي دولة الرقم", skipped: "تخطّاه", cap: "أوقفه الحد اليومي", needs_confirmation: "ينتظر تأكيد السعر" };
const REASON_AR: Record<string, string> = {
  bad_input: "اكتب رقم هاتف أو بريدًا إلكترونيًا صحيحًا.",
  daily_cap: "بلغ البحث العكسي حدّه اليومي من التكلفة؛ جرّب غدًا.",
  audit_unavailable: "تعذّر تسجيل البحث في سجل المراجعة فلم يُنفَّذ.",
  needs_confirmation: "هذه الخدمة مدفوعة: أكّد سعرها أولًا.",
};

const HISTORY_KEY = "diger.admin.reverseLookupHistory.v1";
const HISTORY_MAX = 30;
const readLocalHistory = (): HistoryRow[] => { try { const v = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
const writeLocalHistory = (rows: HistoryRow[]) => { try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(rows.slice(0, HISTORY_MAX))); } catch { /* the history is a convenience */ } };

/** USD with Arabic-Indic digits: this screen is admin-only, the only place a cost in dollars is shown. */
const usd = (n: number) => `${toArabicDigits(n.toFixed(4))} دولار`;
const maskOf = (raw: string) => { const t = raw.trim(); if (t.includes("@")) return `*@${t.split("@")[1] ?? ""}`; const d = t.replace(/\D/g, ""); return `***${d.slice(-3)}`; };

export default function AdminReverseLookupPage() {
  const { toast } = useAdmin();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanEntry[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [fields, setFields] = useState<LookupFields>({});
  const [cursor, setCursor] = useState(0);
  const [finished, setFinished] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [spent, setSpent] = useState<{ spentTodayUsd: number; capUsd: number } | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyOnServer, setHistoryOnServer] = useState(false);
  const [reopened, setReopened] = useState<HistoryRow | null>(null);
  const [message, setMessage] = useState("");
  const inputValue = useRef("");
  // every attempt of THIS lookup, kept synchronously so the history row saved at the end carries all of them
  const attemptsRef = useRef<Attempt[]>([]);
  const pushAttempt = (a: Attempt) => { attemptsRef.current = [...attemptsRef.current, a]; setAttempts(attemptsRef.current); };

  useEffect(() => {
    adminFetch<{ spentTodayUsd: number; capUsd: number; historyAvailable?: boolean; history?: HistoryRow[] }>("/api/admin/reverse-lookup").then((r) => {
      setSpent({ spentTodayUsd: r.spentTodayUsd, capUsd: r.capUsd });
      if (r.historyAvailable) { setHistoryOnServer(true); setHistory(r.history ?? []); } else setHistory(readLocalHistory());
    }).catch(() => setHistory(readLocalHistory()));
  }, []);

  const post = <T,>(body: Record<string, unknown>) => adminFetch<T>("/api/admin/reverse-lookup", { method: "POST", body: JSON.stringify({ input: inputValue.current, ...body }) });

  async function attempt(entry: PlanEntry, previous: LookupFields, confirmedUsd?: number): Promise<{ fields: LookupFields; found: boolean; stop: boolean }> {
    setRunning(entry.id);
    try {
      const r = await post<AttemptReply>({ action: "attempt", endpointId: entry.id, previous, ...(confirmedUsd !== undefined ? { confirmedUsd } : {}) });
      if (typeof r.spentTodayUsd === "number") setSpent({ spentTodayUsd: r.spentTodayUsd, capUsd: r.capUsd ?? 2 });
      if (r.attempt) pushAttempt(r.attempt);
      if (!r.ok) { if (r.reason && REASON_AR[r.reason] && r.reason !== "needs_confirmation") setMessage(REASON_AR[r.reason]); return { fields: previous, found: false, stop: r.reason === "daily_cap" || r.reason === "audit_unavailable" }; }
      return { fields: r.fields ?? previous, found: Boolean(r.found), stop: false };
    } catch (e) {
      pushAttempt({ endpointId: entry.id, outcome: "failed", costUsd: 0, note: e instanceof Error ? e.message : "" });
      return { fields: previous, found: false, stop: false };
    } finally { setRunning(null); }
  }

  async function saveHistory(finalFields: LookupFields, finalAttempts: Attempt[]) {
    if (fieldCount(finalFields) === 0 && finalAttempts.every((a) => a.costUsd === 0)) return;
    const row: HistoryRow = { id: `local_${Date.now()}`, createdAt: new Date().toISOString(), kind: inputValue.current.includes("@") ? "email" : "phone", maskedInput: maskOf(inputValue.current), found: fieldCount(finalFields) > 0, fields: finalFields, attempts: finalAttempts, costUsd: Number(finalAttempts.reduce((s, a) => s + a.costUsd, 0).toFixed(6)) };
    try {
      const r = await post<{ stored: boolean; id: string | null }>({ action: "save", result: { fields: finalFields, attempts: finalAttempts } });
      if (r.stored) { setHistoryOnServer(true); setHistory((h) => [{ ...row, id: r.id ?? row.id }, ...h].slice(0, HISTORY_MAX)); return; }
    } catch { /* kept in the browser below */ }
    const next = [row, ...readLocalHistory()].slice(0, HISTORY_MAX);
    writeLocalHistory(next);
    setHistory(next);
  }

  /** Runs the automatic endpoints of the plan in order from `from`, until one gives a useful answer; a paid phone endpoint waits for its own confirmation. */
  async function walk(entries: PlanEntry[], from: number, previous: LookupFields) {
    let current = previous;
    let index = from;
    let found = false;
    for (; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.state === "skipped") { const a: Attempt = { endpointId: entry.id, outcome: /محدودة/.test(entry.skipReasonAr ?? "") ? "skipped_country" : "skipped", costUsd: 0, note: entry.skipReasonAr ?? "" }; pushAttempt(a); continue; }
      if (entry.state === "confirm") continue;
      const r = await attempt(entry, current);
      current = r.fields;
      setFields(r.fields);
      if (r.stop) { index += 1; break; }
      if (r.found) { found = true; index += 1; break; }
    }
    setCursor(index);
    setFinished(true);
    return { fields: current, found };
  }

  async function start() {
    if (busy || !text.trim()) return;
    attemptsRef.current = []; setBusy(true); setReopened(null); setAttempts([]); setFields({}); setFinished(false); setConfirming(null); setMessage(""); setCursor(0);
    inputValue.current = text.trim();
    try {
      const p = await post<{ ok: boolean; plan: PlanEntry[] }>({ action: "plan" });
      setPlan(p.plan);
      const r = await walk(p.plan, 0, {});
      await saveHistory(r.fields, attemptsRef.current);
    } catch (e) { toast(e instanceof Error ? e.message : "تعذّر البحث"); } finally { setBusy(false); }
  }

  async function deeper() {
    if (busy) return;
    setBusy(true); setFinished(false);
    try {
      const r = await walk(plan, cursor, fields);
      await saveHistory(r.fields, attemptsRef.current);
    } finally { setBusy(false); }
  }

  async function runPaid(entry: PlanEntry) {
    if (busy) return;
    setBusy(true); setConfirming(null);
    try {
      const r = await attempt(entry, fields, entry.usd);
      setFields(r.fields);
      await saveHistory(r.fields, attemptsRef.current);
    } finally { setBusy(false); }
  }

  const hasDeeper = finished && plan.slice(cursor).some((p) => p.state === "auto");
  const paidPending = plan.filter((p) => p.state === "confirm" && !attempts.some((a) => a.endpointId === p.id && (a.outcome === "found" || a.outcome === "no_data" || a.outcome === "failed")));
  const total = attempts.reduce((s, a) => s + a.costUsd, 0);
  const shownFields: LookupFields = reopened ? reopened.fields : fields;
  const shownAttempts = reopened ? reopened.attempts : attempts;
  const hasFields = fieldCount(shownFields) > 0;

  return (
    <div className="flex flex-col gap-4" dir="rtl">
      <section className={SECTION} aria-label="بحث عكسي">
        <h2 className="m-0 text-base font-semibold text-ink">بحث عكسي</h2>
        <p className="m-0 text-[13px] font-light leading-[1.9] text-ink2">اكتب رقم هاتف أو بريدًا إلكترونيًا. البريد يمرّ على الخدمات بترتيبها المبني على التجربة ويتوقف عند أول إجابة مفيدة، و«بحث أعمق» يكمل ويضم الحقول. الهاتف يستخدم الخدمات المجانية فقط، وأي خدمة مدفوعة لا تعمل إلا بعد أن تؤكد سعرها. لا نقاط من أي عميل، وكل بحث يُسجَّل في سجل المراجعة.</p>
        <input className={FIELD} inputMode="email" dir="ltr" placeholder="+20… أو name@company.com" value={text} onChange={(e) => setText(e.target.value)} aria-label="رقم الهاتف أو البريد" disabled={busy} onKeyDown={(e) => { if (e.key === "Enter") start(); }} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BTN} disabled={busy || !text.trim()} onClick={start} data-testid="lookup-start" aria-busy={busy}>{busy ? "جارٍ البحث…" : "بحث"}</button>
          {hasDeeper && !reopened ? <button type="button" className={BTN} disabled={busy} onClick={deeper} data-testid="lookup-deeper">بحث أعمق</button> : null}
        </div>
        {spent ? <p className="m-0 text-[12px] font-light text-mut" data-testid="admin-lookup-cap">تكلفة اليوم {usd(spent.spentTodayUsd)} من حدّ {usd(spent.capUsd)}</p> : null}
      </section>

      {plan.length > 0 && !reopened ? (
        <section className={SECTION} aria-label="المحاولات" data-testid="admin-lookup-attempts" aria-live="polite">
          <h3 className="m-0 text-[13px] font-semibold text-ink">المحاولات</h3>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px] text-ink2">
            {shownAttempts.map((a, i) => (
              <li key={`${a.endpointId}-${i}`} className="flex flex-wrap gap-x-3"><span dir="ltr">{a.endpointId}</span><span>{ATTEMPT_AR[a.outcome] ?? a.outcome}</span><span>{usd(a.costUsd)}</span>{a.note ? <span className="text-mut">{a.note}</span> : null}</li>
            ))}
            {running ? <li className="flex flex-wrap gap-x-3 text-ink" data-testid="lookup-running"><span dir="ltr">{running}</span><span>يعمل الآن…</span></li> : null}
          </ul>
          {paidPending.length > 0 ? (
            <div className="flex flex-col gap-2 border-t border-ln pt-2" data-testid="lookup-paid">
              <h4 className="m-0 text-[12px] font-semibold text-ink">خدمات مدفوعة (لا تعمل إلا بتأكيدك)</h4>
              {paidPending.map((p) => (
                <div key={p.id} className="flex flex-col gap-1 rounded-xl border border-ln bg-sf2 p-2 text-[12px]">
                  <div className="flex flex-wrap items-center gap-x-3"><span dir="ltr">{p.id}</span><span>{usd(p.usd)}</span></div>
                  {p.warningAr ? <p className="m-0 text-ink2" role="note">تنبيه: {p.warningAr}</p> : null}
                  {confirming === p.id ? (
                    <div className="flex flex-wrap gap-2"><button type="button" className={BTN} disabled={busy} onClick={() => runPaid(p)} data-testid="lookup-confirm">أؤكد دفع {usd(p.usd)}</button><button type="button" className={BTN} onClick={() => setConfirming(null)}>إلغاء</button></div>
                  ) : <button type="button" className={BTN} disabled={busy} onClick={() => setConfirming(p.id)} data-testid="lookup-paid-open">شغّل هذه الخدمة</button>}
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {message ? <p className="m-0 rounded-xl border border-ln bg-sf2 px-3 py-2 text-[13px] text-ink" role="status">{message}</p> : null}

      {finished || reopened ? (
        <section className={SECTION} aria-label="النتيجة" data-testid="admin-lookup-result">
          {reopened ? <p className="m-0 text-[12px] font-medium text-ink2" data-testid="lookup-reopened">نتيجة محفوظة لـ {reopened.maskedInput} — بلا مكالمة جديدة</p> : null}
          {hasFields ? (
            <dl className="m-0 grid grid-cols-[auto_1fr_auto] items-baseline gap-x-4 gap-y-1 text-[13px]">
              {FIELD_KEYS.filter((k) => shownFields[k]?.value).map((k) => (
                <div key={k} className="contents" data-testid={`field-${k}`}>
                  <dt className="font-medium text-ink2">{FIELD_LABEL_AR[k]}</dt>
                  <dd className="m-0 text-ink" dir={k === "profileUrl" ? "ltr" : undefined}>{k === "profileUrl" ? <a className="underline" href={shownFields[k]!.value} target="_blank" rel="noreferrer noopener">{shownFields[k]!.value}</a> : shownFields[k]!.value}</dd>
                  <dd className="m-0 text-[11px] text-mut" dir="ltr">{shownFields[k]!.source}</dd>
                </div>
              ))}
            </dl>
          ) : <p className="m-0 text-[13px] text-ink2">لم تُرجع الخدمات بيانات عن هذا المدخل.</p>}
          <p className="m-0 text-[12px] font-light text-mut" data-testid="admin-lookup-cost">تكلفة هذا البحث {usd(reopened ? reopened.costUsd : total)}</p>
        </section>
      ) : null}

      <section className={SECTION} aria-label="سجل البحث" data-testid="lookup-history">
        <h3 className="m-0 text-[13px] font-semibold text-ink">سجل البحث</h3>
        <p className="m-0 text-[12px] font-light text-mut">{historyOnServer ? "محفوظ على الخادم." : "محفوظ في متصفحك فقط (جدول السجل على الخادم لم يُفعَّل بعد)."} فتح نتيجة سابقة لا يستدعي أي خدمة.</p>
        {history.length === 0 ? <p className="m-0 text-[12px] text-ink2">لا توجد عمليات بحث سابقة.</p> : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px]">
            {history.map((h) => (
              <li key={h.id}><button type="button" className="flex w-full cursor-pointer flex-wrap gap-x-3 rounded-lg border border-ln bg-bg px-3 py-2 text-right text-ink" onClick={() => { setReopened(h); setMessage(""); }} data-testid="lookup-history-item"><span dir="ltr">{h.maskedInput}</span><span>{h.fields.name?.value || h.fields.company?.value || (h.found ? "بيانات" : "بلا بيانات")}</span><span className="text-mut">{usd(h.costUsd)}</span></button></li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
