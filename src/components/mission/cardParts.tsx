"use client";

import type { ReactNode } from "react";
import type { PanelStep } from "@/lib/missionView";

/**
 * THE SMALL PARTS OF THE MISSION CARD (the redesign of 16 Nov 2026; handoff «Mission Card Redesign»). Every state of the card answers the same four questions in the same four places:
 * what it is doing (the live line), whether it is about my request (the headline), whether I am charged (the money line at the bottom) and what to press (one primary button).
 * Pure drawing: no network, no clock of its own (the card passes `pulsing`), so it renders the same on the server and in the tests.
 */

/** The green tick of the money line. */
export function Tick({ size = 18 }: { size?: number }) {
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center rounded-full font-bold" style={{ width: size, height: size, fontSize: Math.round(size * 0.6), background: "color-mix(in oklab, var(--ok) 16%, transparent)", color: "var(--ok)" }}>✓</span>
  );
}

/** THE MONEY LINE: always the last line of the card, with the tick, in formal Arabic; `sub` is a quieter second line (for example that the page can be closed). */
export function MoneyLine({ children, sub, border = true }: { children: ReactNode; sub?: ReactNode; border?: boolean }) {
  return (
    <div className={`flex flex-col gap-1 ${border ? "border-t border-ln pt-3" : ""}`} data-testid="agent-money">
      <p className="m-0 flex items-start gap-2 text-[13px] leading-[1.8] text-ink2"><Tick /><span className="min-w-0">{children}</span></p>
      {sub ? <p className="m-0 ps-[26px] text-[12.5px] leading-[1.7] text-mut" data-testid="agent-money-sub">{sub}</p> : null}
    </div>
  );
}

/** THE LIVE DOT: it pulses only while a real event arrived lately (the card decides `pulsing`); otherwise it rests grey. Reduced motion: it stands still. */
export function LiveDot({ pulsing }: { pulsing: boolean }) {
  return (
    <span aria-hidden="true" data-testid="live-dot" data-pulsing={pulsing ? "true" : "false"} className={`mt-[0.62em] h-2 w-2 shrink-0 rounded-full ${pulsing ? "motion-safe:animate-pulse" : ""}`} style={{ background: pulsing ? "var(--ok)" : "var(--fnt)" }} />
  );
}

/** THE LIVE LINE: what the platform is doing now (a real event's title), with an optional detail under it. */
export function LiveLine({ textAr, detailAr, pulsing, size = "lg" }: { textAr: string; detailAr?: string | null; pulsing: boolean; size?: "lg" | "md" }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-1" data-testid="agent-live-line">
      <p className={`m-0 flex items-start gap-2.5 leading-[1.7] text-ink ${size === "lg" ? "text-[16px] font-semibold" : "text-[14px]"}`}><span className="min-w-0 flex-1">{textAr}</span><LiveDot pulsing={pulsing} /></p>
      {detailAr ? <p className="m-0 pe-[18px] text-[13px] leading-[1.8] text-ink2" data-testid="agent-live-detail">{detailAr}</p> : null}
    </div>
  );
}

const TRACK_LABELS_AR = ["فهمنا الطلب", "المصادر", "العينة", "السعر"];

/** THE PLANNING TRACK: four segments with short labels (it replaces the vertical list that repeated the headline). Done = filled, current = half, next = empty. */
export function StepTrack({ steps }: { steps: ReadonlyArray<PanelStep> }) {
  if (steps.length === 0) return null;
  const labelOf = (s: PanelStep, i: number) => (steps.length === TRACK_LABELS_AR.length ? TRACK_LABELS_AR[i] : s.titleAr);
  return (
    <ol className="m-0 grid list-none gap-1.5 p-0" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} data-testid="agent-track" aria-label="مراحل التجهيز">
      {steps.map((s, i) => (
        <li key={s.id} className="flex flex-col gap-1.5" data-state={s.state} {...(s.state === "running" ? { "aria-current": "step" as const } : {})}>
          <span className="h-1 w-full rounded-full" style={{ background: s.state === "done" ? "var(--bar)" : s.state === "running" ? "color-mix(in oklab, var(--bar) 35%, var(--ln))" : "var(--ln)" }} />
          <span className={`text-[11.5px] leading-[1.4] ${s.state === "running" ? "font-semibold text-ink" : s.state === "done" ? "text-ink2" : "text-mut"}`}>{labelOf(s, i)}</span>
        </li>
      ))}
    </ol>
  );
}

/** A collapsed row under the buttons (the caveat, the plan details): 44 px summary, a badge or a plus on the start side, «اعرض» on the end side. */
export function FoldRow({ testId, label, badge, children, open = false }: { testId: string; label: string; badge?: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details data-testid={testId} className="group border-t border-ln" open={open}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2.5 py-1 text-[13.5px] text-ink focus-visible:outline-2">
        {badge ?? <span aria-hidden="true" className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-ln2 text-[12px] text-mut">+</span>}
        <span className="min-w-0 flex-1">{label}</span>
        <span className="text-[12.5px] text-mut group-open:hidden">اعرض</span>
        <span className="hidden text-[12.5px] text-mut group-open:inline">أخفِ</span>
      </summary>
      <div className="flex flex-col gap-3 pb-3 ps-[30px]">{children}</div>
    </details>
  );
}

/** The count badge of the caveat row (gold). */
export function CountBadge({ n }: { n: string }) {
  return <span aria-hidden="true" className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11.5px] font-semibold" style={{ background: "color-mix(in oklab, var(--gold) 20%, transparent)", color: "var(--goldT)" }}>{n}</span>;
}

/** THE REQUEST LINE (zone 1): what was asked, the same line in every state: «طلبك: ٣٠ تغريدة · إكس · لقاح الإنفلونزا · ١٦ أكتوبر – ١٦ نوفمبر ٢٠٢٦». */
export function RequestLine({ parts }: { parts: ReadonlyArray<string> }) {
  if (parts.length === 0) return null;
  return <p className="m-0 text-[12.5px] leading-[1.8] text-mut" data-testid="agent-request-line"><b className="font-semibold text-ink2">طلبك: </b>{parts.join(" · ")}</p>;
}

export interface Snippet { handle: string | null; textAr: string }

/** «عيّنة مما وصل»: at most two real rows (the last of the window the sheet already read; the window is the first rows of the sheet, so it is a sample, never called the newest), one line each with an ellipsis. */
export function Snippets({ items, title = "عيّنة مما وصل" }: { items: ReadonlyArray<Snippet>; title?: string }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="agent-snippets">
      <p className="m-0 text-[12px] text-mut">{title}</p>
      {items.map((it, i) => (
        <p key={i} className="m-0 flex min-w-0 items-center gap-2 rounded-xl border border-ln bg-bg px-3 py-2 text-[13px] text-ink2">
          {it.handle ? <span dir="ltr" className="shrink-0 text-[12px] text-mut">@{it.handle.replace(/^@/, "")}</span> : null}
          <span className="min-w-0 flex-1 truncate">{it.textAr}</span>
        </p>
      ))}
    </div>
  );
}
