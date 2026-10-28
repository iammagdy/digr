"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toArabicDigits } from "@/lib/arabicDigits";
import { panelPollDelayMs } from "@/lib/missionPanelContent";
import type { CustomerMissionView } from "@/lib/agentMission/customerView";
import { MissionPlanBody } from "@/components/mission/MissionPlanPanel";

/**
 * THE MISSION CARD of the chat: what the agent will deliver, in plain Arabic and in one place. It draws ONE answer of /api/missions/<id> (the customer's own mission): a summary sentence, the
 * numbered stages with their rows (they add up to the total), two or three sample rows with readable columns, the price, the hold and the expected time on one line, and the buttons
 * «اعتمد» and «عدّل الطلب». While the mission waits or works it shows the live panel «خطة المهمة»; when it ends it shows what was delivered and the files.
 * No endpoint, no provider, no cost in dollars and no internal id ever reaches this card: the server leaves them out.
 */
interface MissionAnswer { success: boolean; isGuest?: boolean; status?: string; requestText?: string; view?: CustomerMissionView; error?: string }

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
  const alive = useRef(true);

  const read = useCallback(async () => {
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}`, { cache: "no-store", headers: await authHeaders() });
      const json = (await res.json()) as MissionAnswer;
      if (alive.current && json?.success && json.view) setAnswer(json);
    } catch { /* the card keeps what it has */ }
  }, [missionId]);

  const live = answer?.view?.live ?? true;
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      await read();
      if (!alive.current) return;
      timer = setTimeout(loop, panelPollDelayMs(typeof document !== "undefined" && document.visibilityState === "hidden"));
    };
    if (live) void loop(); else void read();
    return () => { alive.current = false; if (timer) clearTimeout(timer); };
  }, [read, live]);

  async function act(action: "approve" | "cancel" | "edit" | "answer", text?: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}`, { method: "POST", headers: { "Content-Type": "application/json", ...(await authHeaders()) }, body: JSON.stringify({ action, ...(text !== undefined ? { text } : {}) }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) { setError(String(json?.error || "تعذّر تنفيذ الطلب الآن؛ حاول بعد قليل. لم يُخصم شيء.")); return; }
      if (action === "edit" && typeof json.requestText === "string") onEdit?.(json.requestText);
      if (action === "approve") onApproved?.();
      if (action === "answer") setReply("");
      await read();
    } catch {
      setError("تعذّر الاتصال الآن؛ حاول بعد قليل. لم يُخصم شيء.");
    } finally {
      setBusy(false);
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
  return <AgentMissionCardBody view={v} isGuest={Boolean(answer?.isGuest)} busy={busy} error={error} reply={reply} onReply={setReply} onAct={act} onDownload={download} />;
}

/** The card itself, drawn from one view: pure (no network), so it renders the same on the server and in the tests. */
export function AgentMissionCardBody({ view: v, isGuest, busy = false, error = null, reply = "", onReply = () => undefined, onAct = () => undefined, onDownload = () => undefined }: { view: CustomerMissionView; isGuest: boolean; busy?: boolean; error?: string | null; reply?: string; onReply?: (text: string) => void; onAct?: (action: "approve" | "cancel" | "edit" | "answer", text?: string) => void; onDownload?: (name: string) => void }) {
  const panelContent = { title: "خطة المهمة", steps: v.steps, currentLineAr: v.currentLineAr, delayAr: v.delayAr, remainingAr: v.remainingAr, closePageAr: v.closePageAr, summaryAr: v.resultLinesAr, startedAt: v.startedAt ?? undefined, live: v.live };
  return (
    <section dir="rtl" data-testid="agent-card" data-phase={v.phase} aria-label="مهمتك" className="mt-3 flex w-full max-w-[640px] flex-col gap-3 rounded-[18px] border border-ln bg-sf p-4">
      {v.queueLineAr ? <p role="status" className="m-0 rounded-[12px] bg-sf2 px-3 py-2 text-[13px] leading-[1.8] text-ink" data-testid="agent-queue">{v.queueLineAr}</p> : null}

      {v.phase === "question" && v.questionAr ? (
        <div className="flex flex-col gap-2" data-testid="agent-question">
          <p className="m-0 text-[14px] font-semibold leading-[1.9] text-ink">{v.questionAr}</p>
          <input value={reply} onChange={(e) => onReply(e.target.value)} className="min-h-11 rounded-xl border border-ln2 bg-bg px-3 text-sm text-ink" aria-label="إجابتك" />
          <div><button type="button" className={BTN_PRIMARY} disabled={busy || !reply.trim()} onClick={() => onAct("answer", reply)}>أرسل إجابتك</button></div>
        </div>
      ) : null}

      {(v.phase === "plan" || v.phase === "running" || v.phase === "done" || v.phase === "partial") && v.summaryAr ? <p className="m-0 text-[14px] font-semibold leading-[1.9] text-ink" data-testid="agent-summary">{v.summaryAr}</p> : null}

      {v.notesAr.length > 0 && (v.phase === "plan" || v.phase === "running") ? <p className="m-0 text-[13px] leading-[1.9] text-ink2" data-testid="agent-notes">{v.notesAr.join(" ")}</p> : null}

      {v.stages.length > 0 && (v.phase === "plan" || v.phase === "running") ? (
        <div data-testid="agent-stages">
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
            {v.stages.map((s) => (
              <li key={s.n} className="text-[13px] leading-[1.8] text-ink" data-testid={`agent-stage-${s.n}`}>
                <b>{toArabicDigits(s.n)}.</b> {s.titleAr} <span className="text-ink2">— {s.rowsAr}</span>
                {s.noteAr ? <span className="block text-[12px] font-light text-mut">{s.noteAr}</span> : null}
              </li>
            ))}
          </ol>
          <p className="m-0 mt-1.5 text-[13px] font-semibold text-ink" data-testid="agent-total">المجموع في ملفك: {v.totalRowsAr}</p>
        </div>
      ) : null}

      {v.samples && v.phase === "plan" ? (
        <div className="overflow-x-auto rounded-[14px] border border-ln bg-bg p-2.5" data-testid="agent-samples" aria-label="أمثلة من النتيجة">
          <p className="m-0 mb-1.5 text-[12px] font-semibold text-ink">أمثلة من النتيجة{v.samples.stageTitleAr ? ` · ${v.samples.stageTitleAr}` : ""}</p>
          <table className="w-full border-collapse text-[12px]">
            <thead><tr className="text-right text-mut">{v.samples.columns.map((c) => <th key={c.key} className="border-b border-ln px-1.5 py-1 font-semibold">{c.titleAr}</th>)}</tr></thead>
            <tbody>{v.samples.rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j} className="max-w-[220px] truncate border-b border-ln px-1.5 py-1 text-ink2">{cell || "—"}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : null}

      {v.priceLineAr && v.phase === "plan" ? <p className="m-0 rounded-[12px] bg-sf2 px-3 py-2 text-[13px] leading-[1.9] text-ink" data-testid="agent-price">{v.priceLineAr}</p> : null}

      {v.phase === "plan" ? (
        <div className="flex flex-wrap items-center gap-2">
          {isGuest
            ? <a href="/register" className={`${BTN_PRIMARY} inline-flex items-center no-underline`} data-testid="agent-signup">سجّل لتعتمد</a>
            : <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => onAct("approve")} data-testid="agent-approve">اعتمد</button>}
          <button type="button" className={BTN_PLAIN} disabled={busy} onClick={() => onAct("edit")} data-testid="agent-edit">عدّل الطلب</button>
        </div>
      ) : null}
      {v.phase === "plan" && isGuest ? <p className="m-0 text-[12px] font-light leading-[1.8] text-mut" data-testid="agent-guest-note">بعد التسجيل تُنقل محادثتك لحسابك؛ اكتب «موافق» فيها ثم اضغط «اعتمد».</p> : null}

      {(v.phase === "waiting" || v.phase === "planning" || v.phase === "running" || v.phase === "done" || v.phase === "partial") ? (
        <details open={v.live} className="rounded-[14px] border border-ln bg-bg px-3 py-1" data-testid="agent-panel">
          <summary className="cursor-pointer py-2 text-[13px] font-semibold text-ink">خطة المهمة</summary>
          <MissionPlanBody content={panelContent} />
        </details>
      ) : null}

      {(v.phase === "done" || v.phase === "partial" || v.phase === "unserved" || v.phase === "failed") && v.resultSummaryAr ? <p className="m-0 text-[13px] leading-[1.9] text-ink" data-testid="agent-result">{v.resultSummaryAr}</p> : null}
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
