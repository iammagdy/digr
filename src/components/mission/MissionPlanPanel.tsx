"use client";

import { useEffect, useState } from "react";
import { toArabicDigits } from "@/lib/arabicDigits";
import type { PanelStep, StepState } from "@/lib/missionView";

/**
 * THE MISSION PLAN PANEL «خطة المهمة»: a task list in the manner of a coding agent's plan (a finished step has a check mark and a struck-through name, the step in progress has a spinner,
 * the others are plain), in Arabic, right to left, in the site's own tokens (light and dark). It only DRAWS the steps it is given: they come from the planner's real events and the approved
 * plan's stages (see missionView.ts), never from a text written here. Motion is for what is really happening and stands still when the customer asked for less motion.
 */

const ICON_BOX = "inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center";

export function StepIcon({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <span className={ICON_BOX} data-testid="step-icon-done" aria-hidden="true" style={{ color: "var(--ok)" }}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9.5" strokeWidth={1.6} /><path d="m8 12.4 2.7 2.7L16 9.6" /></svg>
      </span>
    );
  }
  if (state === "running") {
    return (
      <span className={ICON_BOX} data-testid="step-icon-running" aria-hidden="true" style={{ color: "var(--ac)" }}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" className="motion-safe:animate-spin"><circle cx="12" cy="12" r="9" strokeOpacity={0.22} /><path d="M21 12a9 9 0 0 0-9-9" /></svg>
      </span>
    );
  }
  if (state === "stopped") {
    return (
      <span className={ICON_BOX} data-testid="step-icon-stopped" aria-hidden="true" style={{ color: "var(--bad)" }}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><circle cx="12" cy="12" r="9.5" strokeWidth={1.6} /><path d="M8.5 12h7" /></svg>
      </span>
    );
  }
  return (
    <span className={ICON_BOX} data-testid="step-icon-waiting" aria-hidden="true" style={{ color: "var(--mut)" }}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.6}><circle cx="12" cy="12" r="9.5" /></svg>
    </span>
  );
}

const STATE_LABEL_AR: Record<StepState, string> = { done: "تمّ", running: "جارٍ", waiting: "في الانتظار", stopped: "متوقّف" };

export function MissionStepRow({ step }: { step: PanelStep }) {
  const done = step.state === "done";
  const percent = typeof step.ratio === "number" ? Math.round(step.ratio * 100) : null;
  return (
    <li className="flex gap-2 py-1.5" data-testid={`mission-step-${step.id}`} data-state={step.state} aria-label={`${step.titleAr}: ${STATE_LABEL_AR[step.state]}`}>
      <StepIcon state={step.state} />
      <div className="min-w-0 flex-1">
        <p className={`m-0 text-[13px] leading-[1.7] ${done ? "text-mut line-through decoration-1" : step.state === "waiting" ? "text-ink2" : "font-semibold text-ink"}`}>{step.titleAr}</p>
        {step.detailAr ? <p className="m-0 text-[12px] font-light leading-[1.7] text-ink2" data-testid="step-detail">{step.detailAr}</p> : null}
        {step.state === "stopped" && step.reasonAr ? <p className="m-0 text-[12px] leading-[1.7]" style={{ color: "var(--bad)" }} data-testid="step-reason">{step.reasonAr}</p> : null}
        {step.metricsAr && step.metricsAr.length > 0 && step.state !== "waiting" ? (
          <ul className="m-0 mt-0.5 list-none p-0" data-testid="step-metrics" aria-live="off">{step.metricsAr.map((line) => <li key={line} className="text-[12px] font-light leading-[1.7] text-ink2">{line}</li>)}</ul>
        ) : null}
        {step.countAr && step.state !== "waiting" ? (
          <div className="mt-1" data-testid="step-count">
            <div className="flex items-baseline justify-between gap-2 text-[12px] text-ink2">
              <span>{step.countAr}</span>
              {step.excludedAr ? <span className="text-mut">{step.excludedAr}</span> : null}
            </div>
            {percent !== null ? (
              <div role="progressbar" aria-label={step.titleAr} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="mt-1 h-1 w-full overflow-hidden rounded-full bg-sf2">
                <div className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${percent}%`, background: done ? "var(--ok)" : "var(--ac)" }} />
              </div>
            ) : null}
          </div>
        ) : null}
        {step.etaAr && step.state === "running" ? <p className="m-0 mt-1 text-[12px] font-light text-mut" data-testid="step-eta">{step.etaAr.startsWith("بنحسب") ? step.etaAr : `المتبقي ${step.etaAr}`}</p> : null}
      </div>
    </li>
  );
}

export interface LiveRows { stageTitleAr: string; columns: Array<{ key: string; titleAr: string }>; rows: string[][] }

/** The newest rows of the stage that is filling: a small table that grows as the mission runs. */
export function MissionLiveRows({ latest }: { latest: LiveRows }) {
  if (!latest.rows.length) return null;
  return (
    <section className="mt-3 rounded-[14px] border border-ln bg-bg p-2.5" data-testid="mission-live-rows" aria-label="أحدث ما جُمع">
      <h4 className="m-0 mb-1.5 text-[12px] font-semibold text-ink">أحدث ما جُمع{latest.stageTitleAr ? ` · ${latest.stageTitleAr}` : ""}</h4>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead><tr className="text-right text-mut">{latest.columns.map((c) => <th key={c.key} className="border-b border-ln px-1.5 py-1 font-semibold">{c.titleAr}</th>)}</tr></thead>
          <tbody>{latest.rows.map((row, i) => <tr key={i}>{row.map((v, j) => <td key={j} className="max-w-[160px] truncate border-b border-ln px-1.5 py-1 text-ink2">{v || "—"}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

/** «مضى ٢ د ١٢ ث»: the real time since the work began; it moves every second only while the work runs. */
export function elapsedAr(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `مضى ${toArabicDigits(h)} س ${toArabicDigits(m % 60)} د`;
  if (m > 0) return `مضى ${toArabicDigits(m)} د ${toArabicDigits(s % 60)} ث`;
  return `مضى ${toArabicDigits(s)} ث`;
}

function Elapsed({ startedAt, live }: { startedAt?: number; live: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || !startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live, startedAt]);
  if (!startedAt) return null;
  return <span className="text-[11px] font-light text-mut" data-testid="mission-elapsed">{elapsedAr(now - startedAt)}</span>;
}

export interface MissionPanelContent {
  title: string;
  steps: PanelStep[];
  currentLineAr: string;
  delayAr?: string | null;
  /** The time left of the running stage, shown only once its real speed is measured. */
  remainingAr?: string | null;
  latest?: LiveRows | null;
  /** Short Arabic lines the model wrote at its decision points. */
  notesAr?: string[];
  /** The page may be closed (the background driver is live): said once, in the friendly sentence. */
  closePageAr?: string | null;
  /** The completion summary lines (a finished mission). */
  summaryAr?: string[];
  startedAt?: number;
  live: boolean;
}

/** The list and what goes with it: the honest delay, the model's notes, the newest rows. Used by the side panel, the mobile sheet and «طلباتي». */
export function MissionPlanBody({ content }: { content: MissionPanelContent }) {
  return (
    <div dir="rtl" data-testid="mission-plan-body">
      <ol className="m-0 list-none p-0">{content.steps.map((s) => <MissionStepRow key={s.id} step={s} />)}</ol>
      {content.remainingAr ? <p className="m-0 mt-2 text-[12px] text-ink2" data-testid="mission-remaining">{content.remainingAr}</p> : null}
      {content.delayAr ? <p role="status" className="m-0 mt-2 rounded-[12px] bg-sf2 px-3 py-2 text-[12px] leading-[1.8] text-ink" data-testid="mission-delay">{content.delayAr}</p> : null}
      {content.notesAr && content.notesAr.length > 0 ? (
        <ul className="m-0 mt-2 list-none space-y-1 p-0" data-testid="mission-notes">{content.notesAr.map((n, i) => <li key={i} className="text-[12px] font-light leading-[1.8] text-ink2">{n}</li>)}</ul>
      ) : null}
      {content.summaryAr && content.summaryAr.length > 0 ? (
        <section className="mt-3 rounded-[12px] border border-ln bg-bg px-3 py-2" data-testid="mission-summary" aria-label="ملخص المهمة">
          {content.summaryAr.map((line, i) => <p key={i} className="m-0 text-[12px] leading-[1.9] text-ink">{line}</p>)}
        </section>
      ) : null}
      {content.closePageAr ? <p className="m-0 mt-3 rounded-[12px] px-3 py-2 text-[12px] leading-[1.8] text-ink" style={{ background: "color-mix(in oklab, var(--ok) 10%, var(--sf))" }} data-testid="mission-close-page">{content.closePageAr}</p> : null}
      {content.latest ? <MissionLiveRows latest={content.latest} /> : null}
    </div>
  );
}

const RAIL_BTN = "inline-flex min-h-9 min-w-9 cursor-pointer items-center justify-center rounded-xl border border-ln2 bg-sf px-2 text-ink hover:bg-sf2 focus-visible:outline-2";

/** DESKTOP: a side panel that can be expanded, collapsed to a thin rail and pinned. Hidden below the large breakpoint (the mobile bar and sheet take over). */
export function MissionPlanSidePanel({ content, expanded, pinned, onToggleExpanded, onTogglePinned }: { content: MissionPanelContent; expanded: boolean; pinned: boolean; onToggleExpanded: () => void; onTogglePinned: () => void }) {
  if (!expanded) {
    return (
      <aside aria-label={content.title} data-testid="mission-side-panel" data-expanded="false" dir="rtl" className="hidden w-[52px] shrink-0 flex-col items-center gap-2 border-s border-ln bg-sf py-3 lg:flex">
        <button type="button" className={RAIL_BTN} onClick={onToggleExpanded} aria-label="فتح خطة المهمة" aria-expanded={false} data-testid="mission-expand"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h9" /></svg></button>
        <StepIcon state={content.steps.some((s) => s.state === "running") ? "running" : content.steps.every((s) => s.state === "done") ? "done" : "waiting"} />
      </aside>
    );
  }
  return (
    <aside aria-label={content.title} data-testid="mission-side-panel" data-expanded="true" data-pinned={pinned ? "true" : "false"} dir="rtl" className="hidden w-[300px] shrink-0 flex-col border-s border-ln bg-sf lg:flex">
      <header className="flex items-center justify-between gap-2 border-b border-ln px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="m-0 text-sm font-semibold text-ink">{content.title}</h2>
          <Elapsed startedAt={content.startedAt} live={content.live} />
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" className={RAIL_BTN} onClick={onTogglePinned} aria-pressed={pinned} aria-label={pinned ? "إلغاء تثبيت الخطة" : "تثبيت الخطة"} data-testid="mission-pin" style={pinned ? { background: "var(--sf2)" } : undefined}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 4h6l-1 6 3 3v1.5H7V13l3-3-1-6Z" /><path d="M12 14.5V20" /></svg>
          </button>
          <button type="button" className={RAIL_BTN} onClick={onToggleExpanded} aria-label="طيّ خطة المهمة" aria-expanded={true} data-testid="mission-collapse"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg></button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-1"><MissionPlanBody content={content} /></div>
    </aside>
  );
}

/** MOBILE: the one-line bar with the current step, always visible above the composer. Tapping it opens the sheet. */
export function MissionPlanMobileBar({ content, onOpen }: { content: MissionPanelContent; onOpen: () => void }) {
  const state: StepState = content.steps.some((s) => s.state === "running") ? "running" : content.steps.some((s) => s.state === "stopped") ? "stopped" : content.steps.every((s) => s.state === "done") ? "done" : "waiting";
  return (
    <button type="button" onClick={onOpen} data-testid="mission-mobile-bar" aria-haspopup="dialog" dir="rtl" className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 border-0 border-t border-ln bg-sf px-4 text-start text-[13px] text-ink lg:hidden">
      <StepIcon state={state} />
      <span className="min-w-0 flex-1 truncate" data-testid="mission-current-line" aria-live="polite">{content.currentLineAr}</span>
      <span className="shrink-0 text-[12px] text-mut">خطة المهمة</span>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-mut"><path d="m6 15 6-6 6 6" /></svg>
    </button>
  );
}

/** MOBILE: the bottom sheet with the whole plan. */
export function MissionPlanSheet({ content, onClose }: { content: MissionPanelContent; onClose: () => void }) {
  return (
    <div className="lg:hidden" data-testid="mission-sheet">
      <div onClick={onClose} aria-hidden="true" className="fixed inset-0 z-[60] bg-ink/40 backdrop-blur-xs" />
      <section role="dialog" aria-modal="true" aria-label={content.title} dir="rtl" className="fixed inset-x-0 bottom-0 z-[61] flex max-h-[80dvh] w-full flex-col overflow-hidden rounded-t-[24px] bg-sf pb-[env(safe-area-inset-bottom)] shadow-2xl" style={{ animation: "sheetUp .25s cubic-bezier(.2,.7,.2,1) both" }}>
        <header className="flex items-center justify-between gap-2 border-b border-ln px-4 py-3">
          <div><h2 className="m-0 text-sm font-semibold text-ink">{content.title}</h2><Elapsed startedAt={content.startedAt} live={content.live} /></div>
          <button type="button" onClick={onClose} aria-label="إغلاق خطة المهمة" data-testid="mission-sheet-close" className={RAIL_BTN}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5 pt-1"><MissionPlanBody content={content} /></div>
      </section>
    </div>
  );
}
