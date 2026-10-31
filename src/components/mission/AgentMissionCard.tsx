"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toArabicDigits } from "@/lib/arabicDigits";
import { formatSampleCell } from "@/lib/customerDates";
import { PLANNING_USUAL_TIME_AR } from "@/lib/missionView";
import { AGENT_CLOSE_NOTICE_AR } from "@/lib/agentMission/constants";
import { panelPollDelayMs } from "@/lib/missionPanelContent";
import type { CustomerMissionView } from "@/lib/agentMission/customerView";
import { MissionPlanBody } from "@/components/mission/MissionPlanPanel";
import { PlanEditor } from "@/components/mission/PlanEditor";
import type { PlanEdits } from "@/lib/agentMission/planEdit";

/**
 * THE MISSION CARD of the chat: what the agent will deliver, in plain Arabic and in one place. It draws ONE answer of /api/missions/<id> (the customer's own mission): a summary sentence, the
 * numbered stages with their rows (they add up to the total), two or three sample rows with readable columns, the price, the hold and the expected time on one line, and the buttons
 * «اعتمد» and «عدّل الطلب» (which opens the PLAN EDITOR: the number of items, the period, the language, each exclusion and the columns, priced again by code; retyping the request stays beside it). While the mission waits or works it shows the live panel «خطة المهمة»; when it ends it shows what was delivered and the files.
 * No endpoint, no provider, no cost in dollars and no internal id ever reaches this card: the server leaves them out.
 */
interface MissionAnswer { success: boolean; isGuest?: boolean; status?: string; requestText?: string; view?: CustomerMissionView; error?: string }

const TERMINAL_PHASES: ReadonlySet<string> = new Set(["done", "partial", "unserved", "failed", "cancelled"]);
const WAITING_POLL_MS = 8000;
const WAITING_POLL_HIDDEN_MS = 20000;
const BTN = "min-h-11 cursor-pointer rounded-full border px-5 text-[13px] focus-visible:outline-2 disabled:cursor-wait disabled:opacity-60";
const BTN_PRIMARY = `${BTN} border-0 bg-ac text-onac`;
const BTN_PLAIN = `${BTN} border-ln2 bg-transparent text-ink`;

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await createClient().auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch { return {}; }
}

export default function AgentMissionCard({ missionId, onEdit, onApproved }: { missionId: string; onEdit?: (requestText: string) => void; onApproved?: () => void }) {
  const [answer, setAnswer] = useState<MissionAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [editing, setEditing] = useState(false);
  // the approval is on its way (the button and a status line say so at once) / the server accepted it (the card shows the running state before the next read returns)
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [approvedHere, setApprovedHere] = useState(false);
  const alive = useRef(true);

  const read = useCallback(async () => {
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}`, { cache: "no-store", headers: await authHeaders() });
      const json = (await res.json()) as MissionAnswer;
      if (alive.current && json?.success && json.view) setAnswer(json);
    } catch { /* the card keeps what it has */ }
  }, [missionId]);

  const live = answer?.view?.live ?? true;
  const ended = TERMINAL_PHASES.has(answer?.view?.phase ?? "");
  // THE CARD NEVER GOES DEAF: it reads every 2 to 3 seconds while the mission works and every few seconds while it waits for the customer (so an approval or an ending that happened elsewhere shows by itself), and reads at once when the tab comes back; it stops only when the mission has ended
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const loop = async () => {
      await read();
      if (!alive.current) return;
      timer = setTimeout(loop, live ? panelPollDelayMs(hidden()) : hidden() ? WAITING_POLL_HIDDEN_MS : WAITING_POLL_MS);
    };
    const onVisible = () => { if (typeof document !== "undefined" && document.visibilityState === "visible") void read(); };
    if (ended) void read(); else void loop();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    return () => { alive.current = false; if (timer) clearTimeout(timer); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible); };
  }, [read, live, ended]);

  async function act(action: "approve" | "cancel" | "edit" | "edit_plan" | "answer", text?: string, edits?: PlanEdits) {
    if (busy) return;
    setBusy(true);
    setPendingAction(action);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}`, { method: "POST", headers: { "Content-Type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ action, ...(text !== undefined ? { text } : {}), ...(edits !== undefined ? { edits } : {}) }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) { setError(String(json?.error || "تعذّر تنفيذ الطلب الآن؛ حاول بعد قليل. لم يُخصم شيء.")); return; }
      if (action === "edit" && typeof json.requestText === "string") onEdit?.(json.requestText);
      if (action === "approve") { setApprovedHere(true); onApproved?.(); }
      if (action === "answer") setReply("");
      if (action === "edit_plan") setEditing(false);
      await read();
      // an approval is followed by a second read at once: the work may already have started (or ended) by the time the first answer was written
      if (action === "approve") setTimeout(() => { if (alive.current) void read(); }, 1500);
    } catch {
      setError("تعذّر الاتصال الآن؛ حاول بعد قليل. لم يُخصم شيء.");
    } finally {
      setBusy(false);
      setPendingAction(null);
    }
  }

  async function download(name: string) {
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/file?name=${encodeURIComponent(name)}`, { headers: await authHeaders() });
      const json = await res.json();
      if (json?.success && json.url) window.open(String(json.url), "_blank", "noopener");
      else setError(String(json?.error || "تعذّر تنزيل الملف الآن."));
    } catch { setError("تعذّر تنزيل الملف الآن."); }
  }

  const v = answer?.view;
  if (!v) {
    return <div dir="rtl" data-testid="agent-card" data-phase="loading" className="mt-3 rounded-[18px] border border-ln bg-sf p-4 text-[13px] text-ink2" role="status">جاري تجهيز مهمتك…</div>;
  }
  return <AgentMissionCardBody view={v} isGuest={Boolean(answer?.isGuest)} busy={busy} pendingAction={pendingAction} approved={approvedHere} error={error} reply={reply} onReply={setReply} onAct={act} onDownload={download} editing={editing} onEditing={setEditing} />;
}

/** The card itself, drawn from one view: pure (no network), so it renders the same on the server and in the tests. */
export function AgentMissionCardBody({ view: v, isGuest, busy = false, pendingAction = null, approved = false, error = null, reply = "", onReply = () => undefined, onAct = () => undefined, onDownload = () => undefined, editing = false, onEditing = () => undefined }: { view: CustomerMissionView; isGuest: boolean; busy?: boolean; pendingAction?: string | null; approved?: boolean; error?: string | null; reply?: string; onReply?: (text: string) => void; onAct?: (action: "approve" | "cancel" | "edit" | "edit_plan" | "answer", text?: string, edits?: PlanEdits) => void; onDownload?: (name: string) => void; editing?: boolean; onEditing?: (open: boolean) => void }) {
  // the close-page sentence belongs to the status block of the card (on the page, from the moment of approval): the details list below does not say it a second time
  const panelContent = { title: "خطة المهمة", steps: v.steps, currentLineAr: v.currentLineAr, delayAr: v.delayAr, remainingAr: v.remainingAr, closePageAr: null, startedAt: v.startedAt ?? undefined, live: v.live };
  // the plan the customer has just approved is shown as a running mission at once, before the next read of the mission returns
  const planShown = v.phase === "plan" && !approved;
  const approving = pendingAction === "approve";
  const showStarted = v.phase === "running" || (v.phase === "plan" && approved);
  const facts = [
    ...(v.totalRowsAr ? [{ labelAr: "هتستلم", valueAr: v.totalRowsAr }] : []),
    ...(v.periodAr ? [{ labelAr: "الفترة", valueAr: v.periodAr }] : []),
    ...v.priceFacts,
  ];
  const sampleRows = v.samples?.rows ?? [];
  const hasDetails = v.assumptionsAr.length > 0 || v.stages.length > 0 || Boolean(v.samples) || Boolean(v.fileContentsAr) || v.notesAr.length > 0;
  return (
    <section dir="rtl" data-testid="agent-card" data-phase={v.phase} aria-label="مهمتك" className="mt-3 flex w-full max-w-[640px] min-w-0 flex-col gap-3 rounded-[18px] border border-ln bg-sf p-3.5 sm:p-4">
      {v.queueLineAr ? <p role="status" className="m-0 rounded-[12px] bg-sf2 px-3 py-2 text-[13px] leading-[1.8] text-ink" data-testid="agent-queue">{v.queueLineAr}</p> : null}

      {v.phase === "question" && v.questionAr ? (
        <div className="flex flex-col gap-2" data-testid="agent-question">
          <p className="m-0 text-[14px] font-semibold leading-[1.9] text-ink">{v.questionAr}</p>
          {v.questionOptionsAr.length > 0 ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="إجابات جاهزة" data-testid="agent-question-options">
              {v.questionOptionsAr.map((o) => <button key={o} type="button" className={BTN_PLAIN} disabled={busy} onClick={() => onAct("answer", o)}>{o}</button>)}
            </div>
          ) : null}
          <input value={reply} onChange={(e) => onReply(e.target.value)} className="min-h-11 rounded-xl border border-ln2 bg-bg px-3 text-sm text-ink" aria-label="أو اكتب إجابتك" />
          <div><button type="button" className={BTN_PRIMARY} disabled={busy || !reply.trim()} onClick={() => onAct("answer", reply)}>أرسل إجابتك</button></div>
        </div>
      ) : null}

      {/* THE ONE LINE: what the customer will receive */}
      {(v.phase === "plan" || v.phase === "running" || v.phase === "done" || v.phase === "partial") && v.summaryAr ? (
        <div className="flex flex-col gap-1" data-testid="agent-hero">
          {planShown ? <p className="m-0 text-[12px] font-medium text-mut">هتستلم إيه</p> : null}
          <p className={`m-0 font-semibold leading-[1.8] text-ink ${planShown ? "text-[17px]" : "text-[14px]"}`} data-testid="agent-summary">{v.summaryAr}</p>
        </div>
      ) : null}

      {v.unservedAr.length > 0 && planShown ? (
        <div className="rounded-[12px] border border-ln2 bg-sf2 px-3 py-2" role="note" data-testid="agent-unserved">
          <p className="m-0 text-[12px] font-semibold text-ink">خطوة لم تُضَف إلى الخطة</p>
          <ul className="m-0 mt-0.5 list-disc pe-4 text-[13px] leading-[1.75] text-ink">{v.unservedAr.map((a) => <li key={a}>{a}</li>)}</ul>
        </div>
      ) : null}

      {/* count, period, price and the hold, each in its own cell; full sentences, never cut */}
      {planShown && facts.length > 0 ? (
        <div className="rounded-[14px] bg-sf2 px-3 py-2.5" data-testid="agent-price">
          <dl className={`m-0 grid grid-cols-2 gap-x-3 gap-y-2.5 ${facts.length === 4 ? "sm:grid-cols-4" : "sm:grid-cols-3"}`} data-testid="agent-facts">
            {facts.map((f) => (
              <div key={f.labelAr} className="min-w-0"><dt className="text-[11px] font-light text-mut">{f.labelAr}</dt><dd className="m-0 mt-0.5 break-words text-[14px] font-semibold leading-[1.6] text-ink">{f.valueAr}</dd></div>
            ))}
          </dl>
          {v.priceNoteAr ? <p className="m-0 mt-2 border-t border-ln pt-2 text-[12px] leading-[1.8] text-ink2" data-testid="agent-price-note">{v.priceNoteAr}</p> : null}
        </div>
      ) : planShown && v.priceLineAr ? <p className="m-0 rounded-[12px] bg-sf2 px-3 py-2 text-[13px] leading-[1.9] text-ink" data-testid="agent-price">{v.priceLineAr}</p> : null}

      {(v.phase === "plan" || v.phase === "running") && v.notesAr.length > 0 ? <p className="m-0 text-[13px] leading-[1.9] text-ink2" data-testid="agent-notes">{v.notesAr.join(" ")}</p> : null}

      {planShown ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {isGuest
            ? <a href="/register" className={`${BTN_PRIMARY} inline-flex min-h-12 items-center justify-center text-[15px] font-semibold no-underline sm:min-w-[200px]`} data-testid="agent-signup">سجّل لتعتمد</a>
            : <button type="button" className={`${BTN_PRIMARY} inline-flex min-h-12 w-full items-center justify-center gap-2 text-[15px] font-semibold sm:w-auto sm:min-w-[200px]`} disabled={busy} onClick={() => onAct("approve")} data-testid="agent-approve">
                {approving ? <><span className="h-4 w-4 rounded-full border-2 border-onac/30 border-t-onac motion-safe:animate-spin motion-reduce:animate-none" aria-hidden="true" />جاري الاعتماد…</> : "اعتمد"}
              </button>}
          <button type="button" className={`${BTN_PLAIN} w-full sm:w-auto`} disabled={busy} onClick={() => (v.edit ? onEditing(!editing) : onAct("edit"))} data-testid="agent-edit" aria-expanded={v.edit ? editing : undefined}>عدّل الطلب</button>
        </div>
      ) : null}
      {approving ? <p role="status" aria-live="polite" className="m-0 text-[13px] leading-[1.8] text-ink2" data-testid="agent-approving">جاري اعتماد خطتك… لن تحتاج لفعل شيء بعدها.</p> : null}
      {planShown && v.edit && editing ? <PlanEditor edit={v.edit} busy={busy} onSave={(edits) => onAct("edit_plan", undefined, edits)} onCancel={() => onEditing(false)} onRetype={() => onAct("edit")} /> : null}
      {planShown && isGuest ? <p className="m-0 text-[12px] font-light leading-[1.8] text-mut" data-testid="agent-guest-note">بعد التسجيل تُنقل محادثتك لحسابك؛ اكتب «موافق» فيها ثم اضغط «اعتمد».</p> : null}

      {/* THE DETAILS, folded: how we understood the request, the steps, the example rows and what the file holds */}
      {planShown && hasDetails ? (
        <details className="rounded-[14px] border border-ln bg-bg px-3 py-1" data-testid="agent-details">
          <summary className="cursor-pointer py-2 text-[13px] font-semibold text-ink">تفاصيل الخطة</summary>
          <div className="flex flex-col gap-3 pb-3 pt-1">
            {v.assumptionsAr.length > 0 ? (
              <div className="rounded-[12px] bg-sf2 px-3 py-2" data-testid="agent-assumptions">
                <p className="m-0 text-[12px] font-semibold text-ink">كيف فهمنا طلبك</p>
                <ul className="m-0 mt-0.5 list-disc pe-4 text-[13px] leading-[1.75] text-ink2">{v.assumptionsAr.map((a) => <li key={a}>{a}</li>)}</ul>
                <p className="m-0 mt-1 text-[11px] font-light leading-[1.7] text-mut">لو فهمنا شيئًا بشكل مختلف، اضغط «عدّل الطلب» وغيّره قبل الاعتماد.</p>
              </div>
            ) : null}

            {v.stages.length > 0 ? (
              <div data-testid="agent-stages">
                <p className="m-0 mb-1 text-[12px] font-semibold text-ink">الخطوات</p>
                <ol className="m-0 flex list-none flex-col gap-1 p-0">
                  {v.stages.map((s) => (
                    <li key={s.n} className="flex items-baseline gap-1.5 text-[13px] leading-[1.7] text-ink" data-testid={`agent-stage-${s.n}`}>
                      <b className="shrink-0 text-mut">{toArabicDigits(s.n)}</b>
                      <span className="min-w-0 flex-1">{s.titleAr}{s.noteAr ? <span className="block text-[11px] font-light text-mut">{s.noteAr}</span> : null}</span>
                      <span className="shrink-0 text-ink2">{s.rowsAr}</span>
                    </li>
                  ))}
                </ol>
                {v.stages.length > 1 ? <p className="m-0 mt-1 border-t border-ln pt-1 text-[13px] font-semibold text-ink" data-testid="agent-total">المجموع في ملفك: {v.totalRowsAr}</p> : null}
              </div>
            ) : null}

            {v.samples ? (
              <div className="rounded-[12px] border border-ln bg-bg p-2" data-testid="agent-samples" aria-label="أمثلة من النتيجة">
                <p className="m-0 mb-1 text-[12px] font-semibold text-ink">أمثلة من النتيجة{v.samples.stageTitleAr ? ` · ${v.samples.stageTitleAr}` : ""}</p>
                {/* its own scrolling box: the table never widens the card or the page, and a cell wraps instead of being cut */}
                <div className="max-w-full overflow-x-auto" data-testid="agent-samples-scroll">
                  <table className="w-full min-w-[420px] border-collapse text-[12px]">
                    <thead><tr className="text-right text-mut">{v.samples.columns.map((c) => <th key={c.key} className="border-b border-ln px-1.5 py-1 font-semibold">{c.titleAr}</th>)}</tr></thead>
                    <tbody>{sampleRows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j} className="min-w-[88px] max-w-[260px] whitespace-normal break-words border-b border-ln px-1.5 py-1 align-top text-ink2">{formatSampleCell(cell) || "—"}</td>)}</tr>)}</tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {v.fileContentsAr ? <p className="m-0 text-[13px] leading-[1.9] text-ink2" data-testid="agent-file-contents">{v.fileContentsAr}</p> : null}
          </div>
        </details>
      ) : null}

      {(v.phase === "unserved" || v.phase === "failed") && v.endLineAr ? <p role="status" aria-live="polite" className="m-0 rounded-[12px] bg-sf2 px-3 py-2 text-[13px] font-semibold leading-[1.9] text-ink" data-testid="agent-end-line">{v.endLineAr}</p> : null}

      {/* THE STATUS OF AN APPROVED MISSION, on the page: what was started, how far it is, the time, and that the page can be closed */}
      {showStarted ? (
        <div role="status" aria-live="polite" className="flex flex-col gap-2 rounded-[14px] border border-ln bg-sf2 p-3.5" data-testid="agent-started">
          <p className="m-0 text-[15px] font-semibold leading-[1.8] text-ink" data-testid="agent-started-line">
            {v.queueLineAr ? "اعتمدنا خطتك" : "بدأنا جمع"} {v.totalRowsAr}{v.expectedAr ? `، ${v.expectedAr}` : ""}.
          </p>
          <div className="flex flex-col gap-1" data-testid="agent-progress">
            <div className="flex items-baseline justify-between gap-2 text-[13px] text-ink2">
              <span data-testid="agent-progress-line">{v.savedSoFar > 0 && v.progressLineAr ? `وصلنا ${v.progressLineAr}` : "لسه ما وصلتش أول دفعة، وهتظهر هنا أول ما تتجمع."}</span>
              {v.remainingAr ? <span className="text-mut" data-testid="agent-remaining">{v.remainingAr}</span> : null}
            </div>
            <div role="progressbar" aria-label="تقدّم المهمة" aria-valuemin={0} aria-valuemax={Math.max(1, v.totalRows)} aria-valuenow={Math.min(v.savedSoFar, Math.max(1, v.totalRows))} className="h-1.5 w-full overflow-hidden rounded-full bg-sf">
              <div className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${v.totalRows > 0 ? Math.min(100, Math.round((v.savedSoFar / v.totalRows) * 100)) : 0}%`, background: "var(--ac)" }} />
            </div>
          </div>
          <p className="m-0 text-[13px] font-semibold leading-[1.8] text-ink" data-testid="agent-close-notice">{AGENT_CLOSE_NOTICE_AR}</p>
        </div>
      ) : null}

      {(v.phase === "waiting" || v.phase === "planning") ? <p className="m-0 text-[13px] leading-[1.8] text-ink2" data-testid="agent-planning-usual">{PLANNING_USUAL_TIME_AR}</p> : null}

      {(v.phase === "waiting" || v.phase === "planning" || v.phase === "running" || v.phase === "done" || v.phase === "partial" || (v.phase === "failed" && v.steps.length > 1) || (v.phase === "unserved" && v.steps.length > 1)) ? (
        <details open={v.live} className="rounded-[14px] border border-ln bg-bg px-3 py-1" data-testid="agent-panel">
          <summary className="cursor-pointer py-2 text-[13px] font-semibold text-ink">خطة المهمة</summary>
          <MissionPlanBody content={panelContent} />
        </details>
      ) : null}

      {(v.phase === "done" || v.phase === "partial" || v.phase === "unserved" || v.phase === "failed") && v.resultLinesAr.length > 0 ? (
        <div className="rounded-[12px] bg-sf2 px-3 py-2" data-testid="agent-result-lines">{v.resultLinesAr.map((line) => <p key={line} className="m-0 text-[13px] leading-[1.8] text-ink">{line}</p>)}</div>
      ) : null}
      {(v.phase === "done" || v.phase === "partial") && v.resultSummaryAr ? <p className="m-0 text-[13px] leading-[1.9] text-ink" data-testid="agent-result">{v.resultSummaryAr}</p> : null}
      {v.phase === "cancelled" ? <p className="m-0 text-[13px] text-ink2" data-testid="agent-cancelled">أُلغيت هذه المهمة ولم يُخصم شيء.</p> : null}
      {v.files.length > 0 ? (
        <div className="flex flex-wrap gap-2" data-testid="agent-files">
          {v.files.map((f) => <button key={f.name} type="button" className={BTN_PRIMARY} onClick={() => onDownload(f.name)}>{f.labelAr}</button>)}
          <a href="/dashboard/requests" className={`${BTN_PLAIN} inline-flex items-center no-underline`}>افتح طلباتي</a>
        </div>
      ) : null}
      {error ? <p role="alert" className="m-0 text-[13px] leading-[1.8]" style={{ color: "var(--bad)" }} data-testid="agent-error">{error}{/رصيد/.test(error) ? <> <a href="/dashboard/topup" className="text-ac">اشحن رصيدك</a></> : null}</p> : null}
    </section>
  );
}
