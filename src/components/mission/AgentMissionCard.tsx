"use client";

import { refreshBalanceAfterSettle } from "@/lib/missionBalance";
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import { formatSampleCell } from "@/lib/customerDates";
import { PLANNING_USUAL_TIME_AR } from "@/lib/missionView";
import { AGENT_CLOSE_NOTICE_AR } from "@/lib/agentMission/constants";
import { panelPollDelayMs } from "@/lib/missionPanelContent";
import { MISSION_READ_LIMIT_MS, startMissionPolling } from "@/lib/missionPoller";
import type { CustomerMissionView } from "@/lib/agentMission/customerView";
import { MissionPlanBody } from "@/components/mission/MissionPlanPanel";
import { PlanEditor } from "@/components/mission/PlanEditor";
import { approveWithRecovery } from "@/lib/missionApprove";
import { useBalance } from "@/hooks/useBalance";
import { holdLimitOf } from "@/lib/agentMission/holdLimit";
import { pointsAr } from "@/lib/pointsFormat";
import { fileNameFromDisposition } from "@/lib/downloadName";
import { MethodologyOffer } from "@/components/mission/MethodologyOffer";
import { CARD_FAST_AFTER_ACTION_MS, cardPollDelayMs, holdingLineAr } from "@/lib/agentMission/pollDelay";
import type { PlanEdits } from "@/lib/agentMission/planEdit";

/**
 * THE MISSION CARD of the chat: what the agent will deliver, in plain Arabic and in one place. It draws ONE answer of /api/missions/<id> (the customer's own mission): a summary sentence, the
 * numbered stages with their rows (they add up to the total), two or three sample rows with readable columns, the price, the hold and the expected time on one line, and the buttons
 * «اعتمد» and «عدّل الطلب» (which opens the PLAN EDITOR: the number of items, the period, the language, each exclusion and the columns, priced again by code; retyping the request stays beside it). While the mission waits or works it shows the live panel «خطة المهمة»; when it ends it shows what was delivered and the files.
 * No endpoint, no provider, no cost in dollars and no internal id ever reaches this card: the server leaves them out.
 */
/** ROUND 21: a delivered compiled mission carries the offer of its data-collection methodology (the job the purchase route takes, and whether it was bought). */
interface MethodologyOfferInfo { jobId: string; titleAr: string; purchased: boolean }
interface MissionAnswer { success: boolean; isGuest?: boolean; status?: string; requestText?: string; view?: CustomerMissionView; error?: string; methodology?: MethodologyOfferInfo }

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

export default function AgentMissionCard({ missionId, onEdit, onApproved, onSettled }: { missionId: string; onEdit?: (requestText: string) => void; onApproved?: () => void; /** The mission is over: the release and the charge are written, so the page refreshes the balance it shows. */ onSettled?: () => void }) {
  const [answer, setAnswer] = useState<MissionAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [editing, setEditing] = useState(false);
  // the approval is on its way (the button and a status line say so at once) / the server accepted it (the card shows the running state before the next read returns)
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [approvedHere, setApprovedHere] = useState(false);
  const alive = useRef(true);
  // ROUND 26 (item 2): the choice on its way (its own label «جارٍ الإرسال…»), and the time of the customer's last action (the card asks fast for a few minutes after it)
  const [pendingText, setPendingText] = useState<string | null>(null);
  const fastUntilRef = useRef(0);
  // ROUND 26 (item 2): when the card last SAW a change (its own clock, so no skew with the server): the holding line counts from it
  const [quietSinceMs, setQuietSinceMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const signatureRef = useRef<string | null>(null);
  // THE CUSTOMER'S BALANCE (the shared provider: null while it loads or when it failed, never a made-up zero): a hold above it is a limit like the job cap
  const { balance } = useBalance();
  const balancePoints = balance.status === "ready" ? balance.value : null;

  const read = useCallback(async () => {
    // a read that does not answer is cut off (the connection is freed) and the next one is made by the polling loop, which also has its own limit
    const cut = new AbortController();
    const limit = setTimeout(() => cut.abort(), MISSION_READ_LIMIT_MS);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}`, { cache: "no-store", headers: await authHeaders(), signal: cut.signal });
      const json = (await res.json()) as MissionAnswer;
      if (alive.current && json?.success && json.view) setAnswer(json);
    } catch { /* the card keeps what it has */ } finally { clearTimeout(limit); }
  }, [missionId]);

  const live = answer?.view?.live ?? true;
  const ended = TERMINAL_PHASES.has(answer?.view?.phase ?? "");
  // THE BALANCE AFTER THE END (missionBalance.ts): the header kept the hold taken because nothing asked for the balance when the mission ended
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  useEffect(() => { if (!ended) return undefined; return refreshBalanceAfterSettle(() => onSettledRef.current?.()); }, [ended]);
  // THE CARD NEVER GOES DEAF: it reads every 2 to 3 seconds while the mission works and every few seconds while it waits for the customer (so an approval or an ending that happened elsewhere shows by itself), and reads at once when the tab comes back; it stops only when the mission has ended
  // The loop is startMissionPolling's: every read has a limit, so ONE read that never answers cannot end it (live: the plan was stored and the card showed «تستغرق وقتًا أطول» until a reload)
  useEffect(() => {
    alive.current = true;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const onVisible = () => { if (typeof document !== "undefined" && document.visibilityState === "visible") void read(); };
    // ROUND 26 (item 1): every 2 to 3 seconds while the mission is live or for a few minutes after the customer's own action; slower otherwise (cardPollDelayMs)
    const stop = ended ? (void read(), () => undefined) : startMissionPolling({ read, nextDelayMs: () => cardPollDelayMs({ live, fastUntil: fastUntilRef.current, now: Date.now(), hidden: hidden() }) });
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    return () => { alive.current = false; stop(); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible); };
  }, [read, live, ended]);

  async function act(action: "approve" | "cancel" | "edit" | "edit_plan" | "answer" | "smaller", text?: string, edits?: PlanEdits) {
    if (busy) return;
    setBusy(true);
    setPendingAction(action);
    setPendingText(action === "answer" && typeof text === "string" ? text : null);
    fastUntilRef.current = Date.now() + CARD_FAST_AFTER_ACTION_MS;
    setError(null);
    try {
      // THE APPROVE CLICK RECOVERS (round 14, missionApprove.ts): a first request that never reaches the money step is retried once with a fresh session, and a lost answer is settled by reading the mission
      if (action === "approve") {
        const url = `/api/missions/${encodeURIComponent(missionId)}`;
        const outcome = await approveWithRecovery({
          post: async () => { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ action: "approve" }) }); return { status: r.status, body: await r.json().catch(() => null) }; },
          refreshSession: async () => { await createClient().auth.refreshSession(); },
          isApproved: async () => { const r = await fetch(url, { cache: "no-store", headers: await authHeaders() }); const j = await r.json().catch(() => null); return j?.success && typeof j.status === "string" ? j.status !== "plan_ready" : null; },
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        });
        if (!outcome.ok) { setError(outcome.error); return; }
        setApprovedHere(true);
        onApproved?.();
        await read();
        setTimeout(() => { if (alive.current) void read(); }, 1500);
        return;
      }
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}`, { method: "POST", headers: { "Content-Type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ action, ...(text !== undefined ? { text } : {}), ...(edits !== undefined ? { edits } : {}), ...(action === "smaller" && typeof balancePoints === "number" ? { maxHoldPoints: Math.max(0, Math.floor(balancePoints)) } : {}) }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) { setError(String(json?.error || "تعذّر تنفيذ الطلب الآن؛ حاول بعد قليل. لم يُخصم شيء.")); return; }
      if (action === "edit" && typeof json.requestText === "string") onEdit?.(json.requestText);
      if (action === "answer") setReply("");
      if (action === "edit_plan") setEditing(false);
      await read();
    } catch {
      setError("تعذّر الاتصال الآن؛ حاول بعد قليل. لم يُخصم شيء.");
    } finally {
      setBusy(false);
      setPendingAction(null);
      setPendingText(null);
    }
  }

  // ROUND 26 (item 2): a change of what the card shows restarts the quiet clock; the clock ticks once a second while the mission is live
  const v0 = answer?.view;
  useEffect(() => {
    if (!v0) return;
    const sig = `${v0.phase}|${v0.savedSoFar}|${v0.lastEventAt ?? ""}|${v0.steps.map((s) => s.state).join(",")}|${v0.currentLineAr}`;
    if (sig !== signatureRef.current) { signatureRef.current = sig; setQuietSinceMs(Date.now()); }
  }, [v0]);
  useEffect(() => {
    if (!live) return undefined;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  async function download(name: string) {
    try {
      // ROUND 20: the file itself from the site (its own Content-Disposition: the mission's Arabic name), never a bare storage link, which saves the name percent-encoded («%D8%AA...xlsx»)
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/file?name=${encodeURIComponent(name)}&stream=1`, { headers: await authHeaders() });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        setError(String(json?.error || "تعذّر تنزيل الملف الآن."));
        return;
      }
      const blobUrl = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = fileNameFromDisposition(res.headers.get("Content-Disposition")) || name;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => { URL.revokeObjectURL(blobUrl); link.remove(); }, 30000);
    } catch { setError("تعذّر تنزيل الملف الآن."); }
  }

  const v = answer?.view;
  if (!v) {
    return <div dir="rtl" data-testid="agent-card" data-phase="loading" className="mt-3 rounded-[18px] border border-ln bg-sf p-4 text-[13px] text-ink2" role="status">جارٍ تجهيز مهمتك…</div>;
  }
  return <AgentMissionCardBody view={v} isGuest={Boolean(answer?.isGuest)} busy={busy} pendingAction={pendingAction} pendingText={pendingText} quietSinceMs={quietSinceMs} nowMs={nowMs} approved={approvedHere} error={error} reply={reply} onReply={setReply} onAct={act} onDownload={download} balancePoints={balancePoints} editing={editing} onEditing={setEditing} methodology={answer?.methodology ?? null} onSettled={onSettled} />;
}

/** The card itself, drawn from one view: pure (no network), so it renders the same on the server and in the tests. */
export function AgentMissionCardBody({ view: v, isGuest, busy = false, pendingAction = null, pendingText = null, quietSinceMs = null, nowMs = 0, approved = false, error = null, reply = "", onReply = () => undefined, onAct = () => undefined, onDownload = () => undefined, balancePoints = null, editing = false, onEditing = () => undefined, methodology = null, onSettled }: { view: CustomerMissionView; isGuest: boolean; busy?: boolean; pendingAction?: string | null; /** ROUND 26 (item 2): the choice on its way (its own label). */ pendingText?: string | null; /** ROUND 26 (item 2): when the card last saw a change, and the clock now (the holding line). */ quietSinceMs?: number | null; nowMs?: number; approved?: boolean; error?: string | null; reply?: string; onReply?: (text: string) => void; onAct?: (action: "approve" | "cancel" | "edit" | "edit_plan" | "answer" | "smaller", text?: string, edits?: PlanEdits) => void; onDownload?: (name: string) => void; /** The customer's balance in points (null: not known, never zero). */ balancePoints?: number | null; editing?: boolean; onEditing?: (open: boolean) => void; /** ROUND 21: the methodology offer of a delivered compiled mission (the same offer the chat's chooser draws). */ methodology?: MethodologyOfferInfo | null; onSettled?: () => void }) {
  // the close-page sentence belongs to the status block of the card (on the page, from the moment of approval): the details list below does not say it a second time
  const panelContent = { title: "خطة المهمة", steps: v.steps, currentLineAr: v.currentLineAr, delayAr: v.delayAr, remainingAr: v.remainingAr, closePageAr: null, startedAt: v.startedAt ?? undefined, live: v.live };
  // the plan the customer has just approved is shown as a running mission at once, before the next read of the mission returns
  const planShown = v.phase === "plan" && !approved;
  const approving = pendingAction === "approve";
  // A PLAN THAT CANNOT BE APPROVED HAS NO APPROVE BUTTON (live round 11): its hold is above the job cap (the plan says so) or above the customer's balance (the card compares it)
  const hold = v.limit ? holdLimitOf(v.limit.reservePoints, balancePoints) : null;
  const overLimit = Boolean(v.limit?.over) || hold !== null;
  const byBalance = !v.limit?.over && hold !== null && hold.kind === "balance";
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
      {/* ROUND 26 (item 2): WHILE THE MISSION WAITS OR WORKS, the live step (a real event's title) and the time since the last change; after a minute one honest line */}
      {v.live && typeof quietSinceMs === "number" && nowMs > 0 ? <p role="status" aria-live="off" className="m-0 text-[12px] leading-[1.8] text-ink2" data-testid="agent-holding">{holdingLineAr(v.currentLineAr || "نعمل على طلبك", nowMs - quietSinceMs)}</p> : null}

      {v.phase === "question" && v.questionAr ? (
        <div className="flex flex-col gap-2" data-testid="agent-question">
          <p className="m-0 text-[14px] font-semibold leading-[1.9] text-ink">{v.questionAr}</p>
          {v.questionOptionsAr.length > 0 ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="إجابات جاهزة" data-testid="agent-question-options">
              {v.questionOptionsAr.map((o) => <button key={o} type="button" className={BTN_PLAIN} disabled={busy} onClick={() => onAct("answer", o)}>{busy && pendingAction === "answer" && pendingText === o ? "جارٍ الإرسال…" : o}</button>)}
            </div>
          ) : null}
          <input value={reply} onChange={(e) => onReply(e.target.value)} disabled={busy} className="min-h-11 rounded-xl border border-ln2 bg-bg px-3 text-sm text-ink disabled:opacity-60" aria-label="أو اكتب إجابتك" />
          <div><button type="button" className={BTN_PRIMARY} disabled={busy || !reply.trim()} onClick={() => onAct("answer", reply)}>{busy && pendingAction === "answer" && pendingText === reply ? "جارٍ الإرسال…" : "أرسل إجابتك"}</button></div>
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

      {planShown && !isGuest && overLimit && v.limit ? (
        <div className="flex flex-col gap-2 rounded-[14px] border border-ln2 bg-sf2 px-3 py-2.5" role="alert" data-testid="agent-over-limit">
          <p className="m-0 text-[14px] font-semibold leading-[1.9] text-ink">
            {byBalance && hold ? `رصيدك الحالي ${pointsAr(hold.limit_points)}، والحجز المؤقت المطلوب لهذه الخطة ${pointsAr(hold.reserve_points)}؛ فلا يمكن اعتمادها كما هي.` : v.limit.sentenceAr ?? `هذه الخطة أكبر من الحد المسموح لحجز واحد (${pointsAr(v.limit.capPoints)})، فلا يمكن اعتمادها كما هي.`}
          </p>
          {v.limit.rowsAr && !byBalance ? <p className="m-0 text-[13px] leading-[1.9] text-ink2" data-testid="agent-over-limit-rows">{v.limit.rowsAr}</p> : null}
          {v.limit.smaller && !byBalance ? <p className="m-0 text-[13px] leading-[1.9] text-ink" data-testid="agent-smaller-line">{`نسخة أصغر: حتى ${formatAr(v.limit.smaller.perPost)} تعليق من كل منشور، وحجزها المؤقت ${pointsAr(v.limit.smaller.reservePoints)}.`}</p> : null}
          {byBalance ? <p className="m-0 text-[13px] leading-[1.9] text-ink2">يمكنك اعتماد نسخة أصغر تناسب رصيدك، أو تغيير طلبك، أو إلغاء المهمة؛ ولم يُخصم شيء.</p> : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            {byBalance || v.limit.smaller ? <button type="button" className={`${BTN_PRIMARY} inline-flex min-h-12 w-full items-center justify-center text-[15px] font-semibold sm:w-auto sm:min-w-[200px]`} disabled={busy} onClick={() => onAct("smaller")} data-testid="agent-smaller">{pendingAction === "smaller" ? "جارٍ التجهيز…" : "جهّز نسخة أصغر"}</button> : null}
            <button type="button" className={`${BTN_PLAIN} w-full sm:w-auto`} disabled={busy} onClick={() => (v.edit ? onEditing(!editing) : onAct("edit"))} data-testid="agent-edit" aria-expanded={v.edit ? editing : undefined}>{pendingAction === "edit" ? "جارٍ التجهيز…" : "عدّل الطلب"}</button>
            <button type="button" className={`${BTN_PLAIN} w-full sm:w-auto`} disabled={busy} onClick={() => onAct("cancel")} data-testid="agent-cancel">{pendingAction === "cancel" ? "جارٍ الإلغاء…" : "ألغِ المهمة"}</button>
          </div>
        </div>
      ) : null}

      {planShown && !(overLimit && !isGuest) ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {isGuest
            ? <a href="/register" className={`${BTN_PRIMARY} inline-flex min-h-12 items-center justify-center text-[15px] font-semibold no-underline sm:min-w-[200px]`} data-testid="agent-signup">سجّل لتعتمد</a>
            : overLimit ? null
            : <button type="button" className={`${BTN_PRIMARY} inline-flex min-h-12 w-full items-center justify-center gap-2 text-[15px] font-semibold sm:w-auto sm:min-w-[200px]`} disabled={busy} onClick={() => onAct("approve")} data-testid="agent-approve">
                {approving ? <><span className="h-4 w-4 rounded-full border-2 border-onac/30 border-t-onac motion-safe:animate-spin motion-reduce:animate-none" aria-hidden="true" />جارٍ الاعتماد…</> : "اعتمد"}
              </button>}
          <button type="button" className={`${BTN_PLAIN} w-full sm:w-auto`} disabled={busy} onClick={() => (v.edit ? onEditing(!editing) : onAct("edit"))} data-testid="agent-edit" aria-expanded={v.edit ? editing : undefined}>{pendingAction === "edit" ? "جارٍ التجهيز…" : "عدّل الطلب"}</button>
        </div>
      ) : null}
      {approving ? <p role="status" aria-live="polite" className="m-0 text-[13px] leading-[1.8] text-ink2" data-testid="agent-approving">جارٍ اعتماد خطتك… لن تحتاج لفعل شيء بعدها.</p> : null}
      {planShown && v.edit && editing ? <PlanEditor edit={v.edit} busy={busy} pendingAction={pendingAction} onSave={(edits) => onAct("edit_plan", undefined, edits)} onCancel={() => onEditing(false)} onRetype={() => onAct("edit")} /> : null}
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
                {/* ROUND 14 (390 px): a long step line («١٧ ردًا بحسب عدّادات ... وحتى ٥٦٩ ردًا ...») wraps INSIDE the card; the label and the value stack on a narrow screen and sit side by side from 640 px up. The value never takes `shrink-0`: that pushed the label to a letter-wide column and the text off the edge. */}
                <ol className="m-0 flex list-none flex-col gap-1 p-0">
                  {v.stages.map((s) => (
                    <li key={s.n} className="flex min-w-0 items-baseline gap-1.5 text-[13px] leading-[1.7] text-ink" data-testid={`agent-stage-${s.n}`}>
                      <b className="shrink-0 text-mut">{toArabicDigits(s.n)}</b>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3" data-testid={`agent-stage-body-${s.n}`}>
                        <span className="min-w-0 break-words sm:flex-1">{s.titleAr}{s.noteAr ? <span className="block break-words text-[11px] font-light text-mut">{s.noteAr}</span> : null}</span>
                        <span className="min-w-0 break-words text-ink2 sm:max-w-[60%] sm:text-end" data-testid={`agent-stage-rows-${s.n}`}>{s.rowsAr}</span>
                      </div>
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
                    <thead><tr className="text-right text-mut">{v.samples.columns.map((c) => <th key={c.key} className="min-w-[88px] whitespace-normal break-words border-b border-ln px-1.5 py-1 font-semibold">{c.titleAr}</th>)}</tr></thead>
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
          {/* ROUND 26 (item 6): ONE sentence that follows the state and carries the one counter; never «بدأنا جمع ... نحو دقيقتين» once collecting is over */}
          <p className="m-0 text-[15px] font-semibold leading-[1.8] text-ink" data-testid="agent-started-line">
            {v.collectLineAr ?? `نجمع ${v.totalRowsAr}`}
          </p>
          <div className="flex flex-col gap-1" data-testid="agent-progress">
            <div className="flex items-baseline justify-between gap-2 text-[13px] text-ink2">
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
      {(v.phase === "done" || v.phase === "partial") && methodology ? <MethodologyOffer jobId={methodology.jobId} titleAr={methodology.titleAr} purchased={methodology.purchased} onCharged={onSettled} /> : null}
      {error ? <p role="alert" className="m-0 text-[13px] leading-[1.8]" style={{ color: "var(--bad)" }} data-testid="agent-error">{error}{/رصيد/.test(error) ? <> <a href="/dashboard/topup" className="text-ac">اشحن رصيدك</a></> : null}</p> : null}
    </section>
  );
}
