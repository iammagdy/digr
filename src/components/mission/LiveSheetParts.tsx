"use client";

import { formatAr } from "@/lib/arabicDigits";
import { LIVE_PROGRESS_LABEL_AR, counterPartsAr, type LiveTone, type StatusLine } from "@/lib/agentMission/stage2/liveSheetView";

/**
 * THE SMALL PARTS THE DESKTOP SHEET AND THE PHONE CARD SHARE (handoff «Diger live sheet»): the live dot, the counter, the progress bar and the status line. Pure drawing.
 */

/** The dot: breathing green while rows land, still grey when quiet, gold while reconnecting, still green once done. */
export function LiveSheetDot({ tone }: { tone: LiveTone }) {
  const color = tone === "retry" ? "var(--gold)" : tone === "quiet" ? "var(--fnt)" : "var(--ok)";
  const breathing = tone === "live" || tone === "waiting";
  return <span aria-hidden="true" data-testid="live-dot" data-tone={tone} className={`h-2 w-2 shrink-0 rounded-full ${breathing ? "ls-breathe" : ""}`} style={{ background: color }} />;
}

/** «٨٠ من ١٢٠»: the number in the display face, the words after it quieter; before the first row only the words (never a lone «٠»). */
export function LiveSheetCounter({ delivered, promised, size = "desk" }: { delivered: number; promised: number | null; size?: "desk" | "phone" }) {
  const c = counterPartsAr(delivered, promised);
  return (
    <p role="status" aria-live="polite" aria-label={c.label} className="m-0 flex min-w-0 items-baseline gap-[5px] whitespace-nowrap" data-testid="live-grid-counter">
      {c.num ? <span className="font-display text-[22px] font-semibold leading-none text-ink [font-variant-numeric:tabular-nums]" data-testid="live-counter-num">{c.num}</span> : null}
      <span className={`min-w-0 truncate text-mut ${size === "phone" ? "text-[12px]" : "text-[12.5px]"}`} data-testid="live-counter-rest">{c.rest}</span>
    </p>
  );
}

/** The bar: delivered of promised (full above the promise; the counter says why). With no promised total a hairline instead (`rule`), or nothing. */
export function LiveSheetBar({ delivered, promised, thick = 3, rule = true }: { delivered: number; promised: number | null; thick?: number; rule?: boolean }) {
  if (promised === null || !(promised > 0)) return rule ? <div aria-hidden="true" className="h-px bg-ln" /> : null;
  const pct = Math.min(100, (delivered / promised) * 100);
  return (
    <div role="progressbar" aria-label={LIVE_PROGRESS_LABEL_AR} aria-valuemin={0} aria-valuemax={promised} aria-valuenow={Math.min(delivered, promised)} data-testid="live-progress" className="overflow-hidden bg-ln" style={{ height: thick, borderRadius: thick > 3 ? 2 : 0 }}>
      <div className="h-full transition-[width] duration-[600ms] [transition-timing-function:cubic-bezier(.2,.7,.2,1)] motion-reduce:transition-none" style={{ width: `${pct}%`, background: "var(--bar)" }} />
    </div>
  );
}

/** The status line: the time of the newest work-log line, its text, and how long ago the last row landed. */
export function LiveStatusLine({ line, wrap = false }: { line: StatusLine; wrap?: boolean }) {
  return (
    <p className={`m-0 flex min-w-0 gap-2 text-[12px] ${wrap ? "items-start leading-[1.55]" : "items-center"}`} style={{ color: line.tone === "retry" ? "var(--goldT)" : "var(--mut)" }} data-testid="live-status" data-tone={line.tone}>
      {line.timeAr ? <span className="shrink-0 text-fnt [font-variant-numeric:tabular-nums]">{line.timeAr}</span> : null}
      <span className={`min-w-0 flex-1 ${wrap ? "" : "truncate"}`} data-testid="live-status-text">{line.textAr}{wrap && line.agoAr ? <span className="text-fnt"> · {line.agoAr === "الآن" ? "آخر إضافة الآن" : line.agoAr}</span> : null}</span>
      {!wrap && line.agoAr ? <span className="shrink-0 text-fnt">{line.agoAr}</span> : null}
    </p>
  );
}

export const countAr = (n: number): string => formatAr(n);
