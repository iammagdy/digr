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
import { CSV_PACKAGING_NOTE_AR } from "@/lib/agentMission/csvLabels";
import { MissionPlanBody } from "@/components/mission/MissionPlanPanel";
import { PlanEditor } from "@/components/mission/PlanEditor";
import { approveWithRecovery } from "@/lib/missionApprove";
import { useBalance } from "@/hooks/useBalance";
import { countInputValue, displayDigitsAr } from "@/lib/digitsInput";
import { holdLimitOf } from "@/lib/agentMission/holdLimit";
import { pointsAr } from "@/lib/pointsFormat";
import { fileNameFromDisposition } from "@/lib/downloadName";
import { MethodologyOffer } from "@/components/mission/MethodologyOffer";
import { CARD_FAST_AFTER_ACTION_MS, cardPollDelayMs, holdingLineAr } from "@/lib/agentMission/pollDelay";
import type { PlanEdits } from "@/lib/agentMission/planEdit";
import { AskCard } from "@/components/mission/AskCard";
import { LiveSheetPanel } from "@/components/mission/LiveSheetPanel";
import { CountBadge, FoldRow, LiveLine, MoneyLine, RequestLine, Snippets, StepTrack, Tick, type Snippet } from "@/components/mission/cardParts";
import { SUPPORT_URL } from "@/lib/constants";
import type { AskCardView, AskEdit } from "@/lib/agentMission/stage2/askCard";
import type { LiveData } from "@/lib/agentMission/stage2/livePoller";
import { liveProgressOf, phoneCollectLine } from "@/lib/agentMission/stage2/singleCounter";

/**
 * THE MISSION CARD of the chat: what the agent will deliver, in plain Arabic and in one place. It draws ONE answer of /api/missions/<id> (the customer's own mission): a summary sentence, the
 * numbered stages with their rows (they add up to the total), two or three sample rows with readable columns, the price, the hold and the expected time on one line, and the buttons
 * «اعتمد» and «عدّل الطلب» (which opens the PLAN EDITOR: the number of items, the period, the language, each exclusion and the columns, priced again by code; retyping the request stays beside it). While the mission waits or works it shows the live panel «خطة المهمة»; when it ends it shows what was delivered and the files.
 * No endpoint, no provider, no cost in dollars and no internal id ever reaches this card: the server leaves them out.
 */
/** ROUND 21: a delivered compiled mission carries the offer of its data-collection methodology (the job the purchase route takes, and whether it was bought). */
interface MethodologyOfferInfo { jobId: string; titleAr: string; purchased: boolean }
interface MissionAnswer { success: boolean; isGuest?: boolean; status?: string; requestText?: string; view?: CustomerMissionView; error?: string; methodology?: MethodologyOfferInfo; /** STAGE 2 S4: present only when DIGER_STAGE2_ASK_CARD is on for the viewer and the plan waits for approval. */ askCard?: AskCardView; /** STAGE 2 S10: present only when DIGER_STAGE2_LIVE_SHEET is on for the viewer. */ liveSheet?: true }

/**
 * NOV 6 2026 CAMPAIGN (X, msn_d31f37958788a24ec46d): a step the customer asked for that the plan cannot carry is a SCOPE DECISION, not a footnote. The approve button names it («اعتمد بدون هذه الخطوة»), next to «عدّل الطلب»;
 * the step is not in the price and nothing is charged for it.
 */
/**
 * NOV 6 2026 (Facebook chat table): the plan's sample rows are what the planning READ, before any execution; they were titled «أمثلة من النتيجة» (examples of the result) and their counters could be taken for the delivered ones.
 * They are a PRELIMINARY SAMPLE, said as such; the final numbers are the file's (and the live sheet's «النتائج النهائية», built from the same rows).
 */
export const SAMPLES_TITLE_AR = "عينة أولية قبل التنفيذ";
export const SAMPLES_NOTE_AR = "قرأنا هذه الصفوف عند إعداد الخطة؛ الأرقام في ملفك تُقرأ عند التنفيذ وقد تختلف، وقد لا تكون هذه الصفوف نفسها في الملف.";
export const APPROVE_WITHOUT_UNSERVED_AR = "اعتمد بدون هذه الخطوة";
export const UNSERVED_CHOICE_AR = "هذه الخطوة ليست في السعر ولن تُنفَّذ. اعتمد الخطة بدونها، أو عدّل طلبك.";
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

export default function AgentMissionCard({ missionId, onEdit, onApproved, onSettled, stage2 = false, liveSheet = stage2 }: { missionId: string; onEdit?: (requestText: string) => void; onApproved?: () => void; /** The mission is over: the release and the charge are written, so the page refreshes the balance it shows. */ onSettled?: () => void; /** STAGE 2: the page shows the Stage 2 surfaces (the requests page only, owner decision 1); they still appear only when the server sends them (flags on). */ stage2?: boolean; /** LAUNCH ROUND: the page shows the LIVE SHEET (the requests page through `stage2`, and the conversation, where the customer asked); still only when the server says DIGER_STAGE2_LIVE_SHEET is on for the viewer. Nothing else of Stage 2 comes with it. */ liveSheet?: boolean }) {
  const [askError, setAskError] = useState<string | null>(null);
  // STAGE 2 F-2: the last live data the live sheet reported (null until its first answer). The card reads it to show ONE progress counter on a phone; it is passed on only while the live sheet is shown.
  const [liveData, setLiveData] = useState<LiveData | null>(null);
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

  async function act(action: "approve" | "cancel" | "edit" | "retype" | "edit_plan" | "answer" | "smaller", text?: string, edits?: PlanEdits) {
    if (busy) return;
    // ROUND 27 (item 2): the field SHOWS Arabic-Indic digits; an answer that is only a number is SENT as a plain number (Latin, Arabic-Indic or Persian typed alike)
    const shownText = text;
    if (action === "answer" && typeof text === "string" && /^\s*[\d٠-٩۰-۹]+\s*$/.test(text)) text = String(countInputValue(text));
    setBusy(true);
    setPendingAction(action);
    setPendingText(action === "answer" && typeof shownText === "string" ? shownText : null);
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
      if ((action === "edit" || action === "retype") && typeof json.requestText === "string") onEdit?.(json.requestText);
      if (action === "retype") setEditing(false);
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
  /** STAGE 2 S4: one edit of the «فهمنا طلبك» card; the server checks it again, keeps it and plans again (no money line). */
  async function askEdit(edit: AskEdit) {
    if (busy) return;
    setBusy(true);
    setAskError(null);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}`, { method: "POST", headers: { "Content-Type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ action: "ask_edit", edit }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) { setAskError(String(json?.error || "تعذّر حفظ تعديلك. حاول مرة أخرى؛ لم يُخصم شيء.")); return; }
      await read();
    } catch {
      setAskError("تعذّر الاتصال الآن؛ حاول بعد قليل. لم يُخصم شيء.");
    } finally {
      setBusy(false);
    }
  }

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
    // LLM-FIRST PLANNER ROUND (15 Nov 2026, live): the first read of the mission was a bare line for several seconds; it now shows that work has started and the shape of the card that is coming
    return (
      <div dir="rtl" data-testid="agent-card" data-phase="loading" className="mt-3 flex w-full max-w-[640px] flex-col gap-3 rounded-[18px] border border-ln bg-sf p-4" role="status" aria-live="polite">
        <div className="flex items-center gap-2">
          <span className="h-4 w-4 shrink-0 rounded-full border-2 border-ln2 border-t-ac motion-safe:animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <p className="m-0 text-[14px] font-semibold leading-[1.8] text-ink">جارٍ تجهيز مهمتك…</p>
        </div>
        <p className="m-0 text-[13px] leading-[1.8] text-ink2">{PLANNING_USUAL_TIME_AR}</p>
        <div className="flex flex-col gap-2" aria-hidden="true">
          <div className="h-3 w-4/5 rounded-full bg-sf2 motion-safe:animate-pulse" />
          <div className="h-3 w-3/5 rounded-full bg-sf2 motion-safe:animate-pulse" />
        </div>
      </div>
    );
  }
  // STAGE 2 S10 + LAUNCH ROUND: the live sheet under the card, where the page asks for it (`liveSheet`: the requests page and the conversation) and only when the server said the flag is on for this
  // viewer; from the moment the customer approves here (the plan is shown as started at once) or the mission works, and after it ends (the final rows stay)
  const showLive = liveSheet && answer?.liveSheet === true && (v.phase === "running" || v.phase === "done" || v.phase === "partial" || (v.phase === "plan" && approvedHere));
  return <>{<AgentMissionCardBody view={v} isGuest={Boolean(answer?.isGuest)} busy={busy} pendingAction={pendingAction} pendingText={pendingText} quietSinceMs={quietSinceMs} nowMs={nowMs} approved={approvedHere} error={error} reply={reply} onReply={setReply} onAct={act} onDownload={download} balancePoints={balancePoints} editing={editing} onEditing={setEditing} methodology={answer?.methodology ?? null} onSettled={onSettled} askCard={stage2 ? answer?.askCard ?? null : null} onAskEdit={askEdit} askError={askError} live={showLive ? liveData : null} onRetry={typeof answer?.requestText === "string" && answer.requestText.trim() ? () => onEdit?.(answer.requestText as string) : undefined} />}{showLive ? (
    // THE LIVE SHEET IS SHOWN WHILE THE DATA IS COLLECTED (owner, 16 Nov 2026: the customer watches the rows arrive in a sheet like the Excel file): open by default; the customer may fold it,
    // and it stays mounted while folded so its numbers keep the same source as the card's counter
    <details open className="group mt-2 w-full min-w-0 max-w-[640px] sm:max-w-none" data-testid="agent-live">
      <summary className="flex min-h-11 cursor-pointer list-none items-center text-[13.5px] font-semibold text-ac underline underline-offset-4 focus-visible:outline-2"><span className="group-open:hidden">{`اعرض الجدول${liveProgressOf(liveData) ? ` (${formatAr(liveProgressOf(liveData)!.delivered)} صف)` : ""}`}</span><span className="hidden group-open:inline">أخفِ الجدول</span></summary>
      <div className="mt-2 min-w-0"><LiveSheetPanel missionId={missionId} enabled missionLive={!ended} onData={setLiveData} /></div>
    </details>
  ) : null}</>;
}

/** The card itself, drawn from one view: pure (no network), so it renders the same on the server and in the tests. */
export function AgentMissionCardBody({ view: v, isGuest, busy = false, pendingAction = null, pendingText = null, quietSinceMs = null, nowMs = 0, approved = false, error = null, reply = "", onReply = () => undefined, onAct = () => undefined, onDownload = () => undefined, balancePoints = null, editing = false, onEditing = () => undefined, methodology = null, onSettled, askCard = null, onAskEdit = () => undefined, askError = null, live = null, onRetry }: { /** The customer asks to start again from the same words (the failed, partial and cancelled cards). */ onRetry?: () => void; /** STAGE 2 F-2: the live sheet's last data while it is shown (null: flag off, nothing yet, or finished); with a known promised total the phone shows the live counter as THE progress. */ live?: LiveData | null; /** STAGE 2 S4: the «فهمنا طلبك» card (only when the server sent it). */ askCard?: AskCardView | null; onAskEdit?: (edit: AskEdit) => void; askError?: string | null; view: CustomerMissionView; isGuest: boolean; busy?: boolean; pendingAction?: string | null; /** ROUND 26 (item 2): the choice on its way (its own label). */ pendingText?: string | null; /** ROUND 26 (item 2): when the card last saw a change, and the clock now (the holding line). */ quietSinceMs?: number | null; nowMs?: number; approved?: boolean; error?: string | null; reply?: string; onReply?: (text: string) => void; onAct?: (action: "approve" | "cancel" | "edit" | "retype" | "edit_plan" | "answer" | "smaller", text?: string, edits?: PlanEdits) => void; onDownload?: (name: string) => void; /** The customer's balance in points (null: not known, never zero). */ balancePoints?: number | null; editing?: boolean; onEditing?: (open: boolean) => void; /** ROUND 21: the methodology offer of a delivered compiled mission (the same offer the chat's chooser draws). */ methodology?: MethodologyOfferInfo | null; onSettled?: () => void }) {
  // the close-page sentence belongs to the status block of the card (on the page, from the moment of approval): the details list below does not say it a second time
  const panelContent = { title: "خطة المهمة", steps: v.steps, currentLineAr: v.currentLineAr, delayAr: v.delayAr, remainingAr: v.remainingAr, closePageAr: null, startedAt: v.startedAt ?? undefined, live: v.live };
  // STAGE 2 F-2: the progress the live counter shows (null: nothing to follow, the card is today's), and the card's own bar (its basis: the delivering stages' rows)
  const liveProgress = liveProgressOf(live);
  const cardBar = (
    <div role="progressbar" aria-label="تقدّم المهمة" aria-valuemin={0} aria-valuemax={Math.max(1, v.totalRows)} aria-valuenow={Math.min(v.savedSoFar, Math.max(1, v.totalRows))} className="h-1.5 w-full overflow-hidden rounded-full bg-sf">
      <div className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${v.totalRows > 0 ? Math.min(100, Math.round((v.savedSoFar / v.totalRows) * 100)) : 0}%`, background: "var(--ac)" }} />
    </div>
  );
  // the plan the customer has just approved is shown as a running mission at once, before the next read of the mission returns
  const planShown = v.phase === "plan" && !approved;
  const approving = pendingAction === "approve";
  // A PLAN THAT CANNOT BE APPROVED HAS NO APPROVE BUTTON (live round 11): its hold is above the job cap (the plan says so) or above the customer's balance (the card compares it)
  const hold = v.limit ? holdLimitOf(v.limit.reservePoints, balancePoints) : null;
  const overLimit = Boolean(v.limit?.over) || hold !== null;
  const byBalance = !v.limit?.over && hold !== null && hold.kind === "balance";
  const showStarted = v.phase === "running" || (v.phase === "plan" && approved);
  const sampleRows = v.samples?.rows ?? [];
  const hasDetails = v.assumptionsAr.length > 0 || v.stages.length > 0 || Boolean(v.samples) || Boolean(v.fileContentsAr) || v.notesAr.length > 0;
  // THE REDESIGN (handoff of 16 Nov 2026): the facts of the plan are THREE cells (the count, the highest price, the time); the hold is told in the one money sentence, not as a fourth cell
  const factOf = (word: string) => v.priceFacts.find((f) => f.labelAr.includes(word))?.valueAr ?? null;
  const holdAr = factOf("حجز");
  const maxPriceAr = factOf("السعر");
  const planFacts = [
    ...(v.headlineCountAr || v.totalRowsAr ? [{ labelAr: "هتستلم", valueAr: v.headlineCountAr || v.totalRowsAr }] : []),
    ...(v.periodAr && !(v.summaryAr ?? "").includes(v.periodAr) ? [{ labelAr: "الفترة", valueAr: v.periodAr }] : []),
    ...v.priceFacts.filter((f) => !f.labelAr.includes("حجز")).map((f) => ({ labelAr: f.labelAr === "السعر حتى" ? "أقصى سعر" : f.labelAr === "الوقت المتوقع" ? "الوقت" : f.labelAr, valueAr: f.valueAr })),
  ];
  const caveats = v.notesAr;
  // THE NEWEST TWO ROWS the live sheet has read (a real text, one line each); none before the sheet has answered
  const headersOf = live?.sheets?.[0]?.headers ?? [];
  const snippets: Snippet[] = (liveProgress ? live?.window?.rows ?? [] : []).slice(-2).reverse().map((r) => {
    const texts = r.cells.map((c, i) => ({ c, h: headersOf[i] ?? "" })).filter((x) => x.c.k === "text" && x.c.v.trim() !== "");
    const body = texts.reduce<{ c: { v: string }; h: string } | null>((best, x) => (best === null || x.c.v.length > best.c.v.length ? x : best), null);
    const who = texts.find((x) => /المستخدم|الحساب/.test(x.h) && x !== body);
    return { handle: who && /^[\w.]+$/.test(who.c.v) ? who.c.v : null, textAr: body ? body.c.v.replace(/\s+/g, " ").slice(0, 160) : "" };
  }).filter((x) => x.textAr !== "");
  const requestParts = v.requestPartsAr.length > 0 ? [...(v.headlineCountAr || v.totalRowsAr ? [v.headlineCountAr || v.totalRowsAr] : []), ...v.requestPartsAr] : [];
  // the dot pulses only while a real event arrived in the last 20 seconds (the card's own clock; before it has one the dot is as the server saw it: live)
  const pulsing = v.live && (typeof v.lastEventAt !== "number" || nowMs === 0 || nowMs - v.lastEventAt < 20_000);
  const planning = v.phase === "waiting" || v.phase === "planning";
  const running = showStarted && !approving;
  const finished = v.phase === "done" || v.phase === "partial";
  const excel = v.files.find((f) => f.kind === "xlsx") ?? null;
  const otherFiles = v.files.filter((f) => f !== excel);
  const [deliveredLineAr, ...moneyLinesAr] = v.resultLinesAr;
  const headlineAr = finished ? deliveredLineAr || v.resultSummaryAr || "" : "";
  const counter = liveProgress ? { n: liveProgress.delivered, total: liveProgress.promised } : { n: v.savedSoFar, total: v.totalRows };
  const approveButton = (
    <button type="button" className={`${BTN_PRIMARY} inline-flex min-h-12 min-w-0 flex-1 items-center justify-center gap-2 text-[15px] font-semibold sm:w-auto sm:min-w-[220px] sm:flex-none`} disabled={busy || approving} aria-busy={approving || undefined} style={approving ? { opacity: 0.75 } : undefined} onClick={() => onAct("approve")} data-testid="agent-approve">
      {approving ? <><span className="h-4 w-4 rounded-full border-2 border-onac/30 border-t-onac motion-safe:animate-spin motion-reduce:animate-none" aria-hidden="true" />جارٍ الاعتماد…</> : v.unservedAr.length > 0 ? APPROVE_WITHOUT_UNSERVED_AR : "اعتمد وابدأ الجمع"}
    </button>
  );
  return (
    <section dir="rtl" data-testid="agent-card" data-phase={v.phase} aria-label="مهمتك" className="mt-3 flex w-full max-w-[640px] min-w-0 flex-col gap-3.5 rounded-[18px] border border-ln bg-sf p-4 sm:p-4" style={{ boxShadow: "var(--shadow)" }}>
      {v.queueLineAr ? <p role="status" className="m-0 rounded-[12px] bg-sf2 px-3 py-2 text-[13px] leading-[1.8] text-ink" data-testid="agent-queue">{v.queueLineAr}</p> : null}

      {v.phase !== "question" && v.phase !== "cancelled" ? <RequestLine parts={requestParts} /> : null}

      {/* ZONE 2, WHILE THE MISSION WAITS OR WORKS: the live line, a real event's title; after a quiet minute the one honest holding line */}
      {planning ? <StepTrack steps={v.steps} /> : null}
      {planning || (v.live && !running && v.phase !== "question" && !planShown) ? (
        <LiveLine textAr={v.currentLineAr || "نقرأ طلبك"} detailAr={v.delayAr} pulsing={pulsing && !v.delayAr} />
      ) : null}
      {v.live && typeof quietSinceMs === "number" && nowMs > 0 && nowMs - quietSinceMs >= 20_000 ? <p role="status" aria-live="off" className="m-0 text-[12px] leading-[1.8] text-mut" data-testid="agent-holding">{holdingLineAr(v.currentLineAr || "نعمل على طلبك", nowMs - quietSinceMs)}</p> : null}
      {planning ? <p className="m-0 text-[13px] leading-[1.8] text-ink2" data-testid="agent-planning-usual"><span className="text-mut">بعدها: </span>نحسب السعر ونعرض عليك الخطة.</p> : null}
      {planning ? <MoneyLine>لن يُخصم شيء قبل موافقتك.</MoneyLine> : null}

      {v.phase === "question" && v.questionAr ? (
        <div className="flex flex-col gap-2.5" data-testid="agent-question">
          <p className="m-0 text-[12px] font-semibold" style={{ color: "var(--goldT)" }}>محتاجين رأيك</p>
          <p className="m-0 text-[17px] font-semibold leading-[1.8] text-ink">{v.questionAr}</p>
          {v.questionOptionsAr.length > 0 ? (
            <div className="flex flex-col gap-2" role="group" aria-label="إجابات جاهزة" data-testid="agent-question-options">
              {v.questionOptionsAr.map((o) => <button key={o} type="button" className="min-h-[52px] w-full cursor-pointer rounded-[14px] border border-ln2 bg-bg px-4 text-start text-[14px] font-semibold text-ink focus-visible:outline-2 disabled:cursor-wait disabled:opacity-60" disabled={busy} onClick={() => onAct("answer", o)}>{busy && pendingAction === "answer" && pendingText === o ? "جارٍ الإرسال…" : o}</button>)}
            </div>
          ) : null}
          <div className="flex gap-2">
            <input value={reply} onChange={(e) => onReply(displayDigitsAr(e.target.value))} disabled={busy} className="min-h-11 min-w-0 flex-1 rounded-xl border border-ln2 bg-bg px-3 text-[16px] text-ink disabled:opacity-60" aria-label="أو اكتب إجابتك" />
            <button type="button" className={BTN_PRIMARY} disabled={busy || !reply.trim()} onClick={() => onAct("answer", reply)}>{busy && pendingAction === "answer" && pendingText === reply ? "جارٍ الإرسال…" : "أرسل إجابتك"}</button>
          </div>
          <MoneyLine>المهمة متوقفة لحين ردك، ولم يُخصم شيء.</MoneyLine>
        </div>
      ) : null}

      {/* ZONE 1, THE HEADLINE: what the customer will receive */}
      {(v.phase === "plan" || v.phase === "running") && v.summaryAr ? (
        <div className="flex flex-col gap-1" data-testid="agent-hero">
          {planShown ? <p className="m-0 text-[12.5px] font-medium text-mut">خطتك جاهزة · هتستلم إيه</p> : null}
          <p className={`m-0 leading-[1.4] text-ink ${planShown ? "font-display text-[25px] font-semibold" : "text-[14px] font-semibold leading-[1.8]"}`} data-testid="agent-summary">{v.summaryAr}</p>
        </div>
      ) : null}
      {finished && v.summaryAr ? <p className="m-0 text-[12.5px] leading-[1.8] text-mut" data-testid="agent-summary">{v.summaryAr}</p> : null}

      {v.unservedAr.length > 0 && planShown ? (
        <div className="rounded-[12px] border border-ln2 bg-sf2 px-3 py-2" role="note" data-testid="agent-unserved">
          <p className="m-0 text-[12px] font-semibold text-ink">خطوة لم تُضَف إلى الخطة</p>
          <ul className="m-0 mt-0.5 list-disc pe-4 text-[13px] leading-[1.75] text-ink">{v.unservedAr.map((a) => <li key={a}>{a}</li>)}</ul>
          <p className="m-0 mt-1 text-[12px] leading-[1.75] text-ink2" data-testid="agent-unserved-choice">{UNSERVED_CHOICE_AR}</p>
        </div>
      ) : null}

      {/* THE DECISION AREA: three facts and ONE money sentence; nothing else sits between the price and the buttons */}
      {planShown && !approving && planFacts.length > 0 ? (
        <div className="flex flex-col gap-2.5" data-testid="agent-price">
          <dl className={`m-0 grid overflow-hidden rounded-[14px] border border-ln bg-sf2 ${planFacts.length >= 4 ? "grid-cols-2 sm:grid-cols-4" : planFacts.length === 3 ? "grid-cols-3" : planFacts.length === 2 ? "grid-cols-2" : "grid-cols-1"}`} data-testid="agent-facts">
            {planFacts.map((f, i) => (
              <div key={f.labelAr} className={`min-w-0 px-3 py-2.5 ${planFacts.length >= 4 ? "border-b border-ln last:border-b-0 sm:border-b-0" : ""} ${i > 0 ? "border-s border-ln" : ""}`}><dt className="text-[11.5px] text-mut">{f.labelAr}</dt><dd className="m-0 mt-0.5 break-words text-[15px] font-semibold leading-[1.5] text-ink">{f.valueAr}</dd></div>
            ))}
          </dl>
          <p className="m-0 flex items-start gap-2 text-[13px] leading-[1.8] text-ink2" data-testid="agent-price-sentence"><Tick /><span className="min-w-0">{holdAr ? `تُحجز ${holdAr} عند الاعتماد، ويُخصم منها مقابل ما يُسلَّم فقط، ويعود الباقي إلى رصيدك.` : v.priceNoteAr ?? "يُخصم مقابل ما يُسلَّم فقط."}</span></p>
        </div>
      ) : planShown && !approving && v.priceLineAr ? <p className="m-0 rounded-[12px] bg-sf2 px-3 py-2 text-[13px] leading-[1.9] text-ink" data-testid="agent-price">{v.priceLineAr}</p> : null}

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

      {planShown && !approving && !(overLimit && !isGuest) ? (
        <div className="flex flex-col gap-2 max-sm:sticky max-sm:bottom-0 max-sm:z-10 max-sm:-mx-4 max-sm:border-t max-sm:border-ln max-sm:bg-sf max-sm:px-4 max-sm:py-3 sm:flex-row sm:flex-wrap sm:items-center" data-testid="agent-actions">
          {/* ON A PHONE the bar is the whole decision: the price and the time, the one promise, and the two buttons in one row */}
          {!isGuest && !overLimit && (maxPriceAr || factOf("الوقت")) ? (
            <p className="m-0 flex items-baseline justify-between gap-2 text-[12.5px] leading-[1.6] text-ink2 sm:hidden" data-testid="agent-dock-line"><span>{[maxPriceAr ? `حتى ${maxPriceAr}` : null, factOf("الوقت")].filter(Boolean).join(" · ")}</span><span className="text-mut">يُخصم ما يُسلَّم فقط</span></p>
          ) : null}
          <div className="flex gap-2 sm:contents">
            {isGuest
              ? <a href="/register" className={`${BTN_PRIMARY} inline-flex min-h-12 flex-1 items-center justify-center text-[15px] font-semibold no-underline sm:min-w-[220px] sm:flex-none`} data-testid="agent-signup">سجّل لتعتمد</a>
              : overLimit ? null
              : approveButton}
            <button type="button" className={`${BTN_PLAIN} min-h-12 shrink-0 sm:w-auto`} disabled={busy} onClick={() => (v.edit ? onEditing(!editing) : onAct("edit"))} data-testid="agent-edit" aria-expanded={v.edit ? editing : undefined}>{pendingAction === "edit" ? "جارٍ التجهيز…" : "عدّل الطلب"}</button>
          </div>
        </div>
      ) : null}
      {/* APPROVING: the same card, the button in flight, the status beside it; no counter until the server confirms */}
      {approving ? (
        <div className="flex flex-col gap-2.5" data-testid="agent-approving-block">
          <p className="m-0 text-[14px] leading-[1.8] text-ink2" data-testid="agent-facts-line">{[v.headlineCountAr || v.totalRowsAr, maxPriceAr ? `حتى ${maxPriceAr}` : null, factOf("الوقت")].filter(Boolean).join(" · ")}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">{approveButton}<p role="status" aria-live="polite" className="m-0 text-[13px] leading-[1.8] text-ink2" data-testid="agent-approving">لن تحتاج لفعل شيء بعدها.</p></div>
          <MoneyLine>{holdAr ? `تُحجز ${holdAr} الآن، ويُخصم منها مقابل ما يُسلَّم فقط.` : "يُخصم مقابل ما يُسلَّم فقط."}</MoneyLine>
        </div>
      ) : null}
      {planShown && askCard ? <AskCard view={askCard} busy={busy} onEdit={onAskEdit} errorAr={askError} /> : null}
      {planShown && v.edit && editing ? <PlanEditor edit={v.edit} busy={busy} pendingAction={pendingAction} onSave={(edits) => onAct("edit_plan", undefined, edits)} onCancel={() => onEditing(false)} onRetype={() => onAct("retype")} /> : null}
      {planShown && isGuest ? <p className="m-0 text-[12px] font-light leading-[1.8] text-mut" data-testid="agent-guest-note">بعد التسجيل تُنقل محادثتك لحسابك؛ اكتب «موافق» فيها ثم اضغط «اعتمد».</p> : null}

      {/* BELOW THE BUTTONS, FOLDED: the caveat (what the customer should know before approving) and the plan's details */}
      {planShown && !approving && caveats.length > 0 ? (
        <FoldRow testId="agent-caveats" label="ملاحظة قبل ما تعتمد" badge={<CountBadge n={toArabicDigits(caveats.length)} />}>
          <p className="m-0 text-[13px] leading-[1.9] text-ink2" data-testid="agent-notes">{caveats.join(" ")}</p>
        </FoldRow>
      ) : null}
      {planShown && !approving && hasDetails ? (
        <FoldRow testId="agent-details" label="تفاصيل الخطة: الأعمدة وعينة من النتيجة">
          {(v.countLinesAr ?? []).map((line) => <p key={line} className="m-0 text-[12.5px] leading-[1.8] text-ink2" data-testid="agent-count-explain">{line}</p>)}
          {v.priceNoteAr ? <p className="m-0 text-[12.5px] leading-[1.8] text-ink2" data-testid="agent-price-note">{v.priceNoteAr}</p> : null}
          {(v.priceExplainAr ?? []).map((line) => <p key={line} className="m-0 text-[12.5px] leading-[1.8] text-ink2" data-testid="agent-price-explain">{line}</p>)}
          {v.assumptionsAr.length > 0 ? (
            <div className="rounded-[12px] bg-sf2 px-3 py-2" data-testid="agent-assumptions">
              <p className="m-0 text-[12px] font-semibold text-ink">كيف فهمنا طلبك</p>
              <ul className="m-0 mt-0.5 list-disc pe-4 text-[13px] leading-[1.75] text-ink2">{v.assumptionsAr.map((a) => <li key={a}>{a}</li>)}</ul>
              <p className="m-0 mt-1 text-[11.5px] font-light leading-[1.7] text-mut">لو فهمنا شيئًا بشكل مختلف، اضغط «عدّل الطلب» وغيّره قبل الاعتماد.</p>
            </div>
          ) : null}
          {v.stages.length > 0 ? (
            <div data-testid="agent-stages">
              <p className="m-0 mb-1 text-[12px] font-semibold text-ink">الخطوات</p>
              {/* ROUND 14 (390 px): a long step line wraps INSIDE the card; the label and the value stack on a narrow screen and sit side by side from 640 px up. The value never takes `shrink-0`. */}
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
            <div className="rounded-[12px] border border-ln bg-bg p-2" data-testid="agent-samples" aria-label={SAMPLES_TITLE_AR}>
              <p className="m-0 mb-1 text-[12px] font-semibold text-ink">{SAMPLES_TITLE_AR}{v.samples.stageTitleAr ? ` · ${v.samples.stageTitleAr}` : ""}</p>
              <p className="m-0 mb-1 text-[11px] leading-[1.7] text-mut" data-testid="agent-samples-note">{SAMPLES_NOTE_AR}</p>
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
        </FoldRow>
      ) : null}

      {(v.phase === "unserved" || v.phase === "failed") && v.endLineAr ? <p role="status" aria-live="polite" className="m-0 rounded-[12px] bg-sf2 px-3 py-2 text-[14px] font-semibold leading-[1.9] text-ink" data-testid="agent-end-line">{v.endLineAr}</p> : null}

      {/* RUNNING: ONE counter (the rows saved for delivery), its bar, ONE activity line; the money line says what is held and that the page can be closed */}
      {running ? (
        <div role="status" aria-live="polite" className="flex flex-col gap-3" data-testid="agent-started">
          {/* the sentence that carries the count stays for screen readers and the tests; the eye reads the big number */}
          <p className="sr-only" data-testid="agent-started-line">{liveProgress && v.collectLineAr ? <span data-testid="agent-started-line-phone">{phoneCollectLine(v.collectLineAr, live)}</span> : (v.collectLineAr ?? `نجمع ${v.totalRowsAr}`)}</p>
          <div className="flex items-end justify-between gap-3" data-testid="agent-progress">
            <p className="m-0 flex items-baseline gap-2 text-ink" aria-hidden="true"><span className="font-display text-[46px] font-semibold leading-[0.9]" data-testid="agent-counter">{formatAr(counter.n)}</span><span className="text-[15px] text-ink2">من {v.totalRowsAr}</span></p>
            {v.remainingAr ? <span className="pb-1 text-[12.5px] text-mut" data-testid="agent-remaining">{v.remainingAr}</span> : null}
          </div>
          {liveProgress ? (
            <div className="w-full" data-testid="agent-progress-live">
              <div role="progressbar" aria-label="تقدّم المهمة" aria-valuemin={0} aria-valuemax={liveProgress.promised} aria-valuenow={Math.min(liveProgress.delivered, liveProgress.promised)} className="h-1.5 w-full overflow-hidden rounded-full bg-sf2">
                <div className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${Math.round(liveProgress.ratio * 100)}%`, background: "var(--bar)" }} />
              </div>
            </div>
          ) : cardBar}
          <LiveLine textAr={v.currentLineAr || "نعمل على طلبك"} detailAr={v.delayAr} pulsing={pulsing && !v.delayAr} size="md" />
          <Snippets items={snippets} />
          <MoneyLine sub={AGENT_CLOSE_NOTICE_AR}>{holdAr ? `محجوز ${holdAr}، ويُخصم مقابل ما يُسلَّم فقط.` : "يُخصم مقابل ما يُسلَّم فقط."}</MoneyLine>
        </div>
      ) : null}

      {/* THE PANEL stays only where it explains an ending of several steps */}
      {((v.phase === "failed" && v.steps.length > 1) || (v.phase === "unserved" && v.steps.length > 1)) ? (
        <details open={v.live} className="rounded-[14px] border border-ln bg-bg px-3 py-1" data-testid="agent-panel">
          <summary className="cursor-pointer py-2 text-[13px] font-semibold text-ink">خطة المهمة</summary>
          <MissionPlanBody content={panelContent} />
        </details>
      ) : null}

      {/* DONE: the tick and the headline, Excel as the one big button, the rest as quiet text buttons, the offer apart, the money line once */}
      {finished && headlineAr ? (
        <div className="flex items-center gap-3" data-testid="agent-result-lines">
          <span aria-hidden="true" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[18px] font-bold" style={{ background: "color-mix(in oklab, var(--ok) 16%, transparent)", color: "var(--ok)" }}>✓</span>
          <p className={`m-0 font-semibold text-ink ${headlineAr.length > 40 ? "text-[17px] leading-[1.7]" : "font-display text-[27px] leading-[1.3]"}`}>{headlineAr}</p>
        </div>
      ) : null}
      {finished && !headlineAr && v.resultSummaryAr ? <p className="m-0 text-[13px] leading-[1.9] text-ink2" data-testid="agent-result-summary">{v.resultSummaryAr}</p> : null}
      {(v.phase === "unserved" || v.phase === "failed") && v.resultLinesAr.length > 0 ? (
        <div className="flex flex-col gap-1" data-testid="agent-result-lines">{v.resultLinesAr.map((line) => <MoneyLine key={line} border={false}>{line}</MoneyLine>)}</div>
      ) : null}
      {v.phase === "cancelled" ? <p className="m-0 text-[14px] font-semibold leading-[1.8] text-ink" data-testid="agent-cancelled">أُلغيت هذه المهمة ولم يُخصم شيء.</p> : null}
      {v.files.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2" data-testid="agent-files">
          {excel ? (
            <button type="button" className="flex min-h-[60px] w-full cursor-pointer items-center justify-between gap-3 rounded-2xl border-0 bg-ac px-5 text-start text-onac focus-visible:outline-2" onClick={() => onDownload(excel.name)}>
              <span className="flex min-w-0 flex-col"><span className="text-[16px] font-semibold">{excel.labelAr}</span><span className="text-[12px] opacity-80">{[v.totalRowsAr, v.samples ? `${formatAr(v.samples.columns.length)} أعمدة` : null].filter(Boolean).join(" · ")}</span></span>
              <span aria-hidden="true" className="text-[20px]">↓</span>
            </button>
          ) : null}
          <div className="contents">
            {otherFiles.map((f) => <button key={f.name} type="button" data-testid={`agent-file-${f.kind}`} className="min-h-11 cursor-pointer border-0 bg-transparent p-0 text-[13.5px] font-semibold text-ac underline underline-offset-4 focus-visible:outline-2" onClick={() => onDownload(f.name)}>{f.labelAr}</button>)}
            <a href="/dashboard/requests" className="inline-flex min-h-11 items-center text-[13.5px] font-semibold text-ac underline underline-offset-4">افتح طلباتي</a>
          </div>
          {v.files.some((f) => f.kind === "csv") ? <p className="m-0 basis-full text-[12px] leading-[1.7] text-mut" data-testid="agent-csv-note">{CSV_PACKAGING_NOTE_AR}</p> : null}
        </div>
      ) : null}
      {finished && methodology ? <MethodologyOffer jobId={methodology.jobId} titleAr={methodology.titleAr} purchased={methodology.purchased} onCharged={onSettled} /> : null}
      {finished && moneyLinesAr.length > 0 ? <MoneyLine>{moneyLinesAr.join(" ")}</MoneyLine> : null}
      {onRetry && (v.phase === "failed" || v.phase === "unserved") ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center" data-testid="agent-retry">
          <button type="button" className={`${BTN_PRIMARY} inline-flex min-h-12 w-full items-center justify-center text-[15px] font-semibold sm:w-auto sm:min-w-[220px]`} onClick={onRetry}>عدّل الطلب وجرّب تاني</button>
          <a href={SUPPORT_URL} className="inline-flex min-h-11 items-center justify-center text-[13.5px] font-semibold text-ac underline underline-offset-4">تواصل مع الدعم</a>
        </div>
      ) : null}
      {onRetry && v.phase === "partial" ? <div><button type="button" className="min-h-11 cursor-pointer border-0 bg-transparent p-0 text-[13.5px] font-semibold text-ac underline underline-offset-4" onClick={onRetry} data-testid="agent-retry-partial">عدّل الطلب واطلب الباقي</button></div> : null}
      {onRetry && v.phase === "cancelled" ? <div><button type="button" className={BTN_PLAIN} onClick={onRetry} data-testid="agent-retry-cancelled">ابدأها من جديد</button></div> : null}
      {error ? <p role="alert" className="m-0 text-[13px] leading-[1.8]" style={{ color: "var(--bad)" }} data-testid="agent-error">{error}{/رصيد/.test(error) ? <> <a href="/dashboard/topup" className="text-ac">اشحن رصيدك</a></> : null}</p> : null}
    </section>
  );
}
