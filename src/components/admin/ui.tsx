import Link from "next/link";
import type { KeyboardEvent, ReactNode } from "react";
import { formatAr } from "@/lib/arabicDigits";
import { tint } from "./format";

/** Shared look of the admin screens: one card, one badge, one sub-tab row. Presentation only. */
export const ADMIN_SECTION = "flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-4";

export type BadgeTone = "ok" | "bad" | "warn" | "mute" | "gold";
const TONE: Record<BadgeTone, { fg: string; bg: string }> = {
  ok: { fg: "var(--ok)", bg: tint("var(--ok)", 14) },
  bad: { fg: "var(--bad)", bg: tint("var(--bad)", 14) },
  warn: { fg: "var(--goldT)", bg: tint("var(--gold)", 18) },
  gold: { fg: "var(--onac)", bg: "var(--gold)" },
  mute: { fg: "var(--mut)", bg: "var(--sf2)" },
};

/** A coloured pill: the colour never carries the meaning alone, the word does. */
export function StatusBadge({ tone, children, dot = true, testId }: { tone: BadgeTone; children: ReactNode; dot?: boolean; testId?: string }) {
  const t = TONE[tone];
  return (
    <span data-testid={testId} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none" style={{ background: t.bg, color: t.fg }}>
      {dot && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: "currentColor" }} />}
      {children}
    </span>
  );
}

/** A row of short views of one screen (for example the four views of a provider). One is shown at a time. */
export function SubTabs<T extends string>({ label, value, items, onChange, idPrefix = "view" }: { label: string; value: T; items: Array<[T, string]>; onChange: (v: T) => void; idPrefix?: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1.5">
      {items.map(([id, text]) => {
        const on = value === id;
        return (
          <button key={id} id={`${idPrefix}-${id}`} type="button" role="tab" aria-selected={on} onClick={() => onChange(id)}
            className="min-h-11 cursor-pointer rounded-full border px-4 text-[13px] font-semibold"
            style={{ background: on ? "var(--ac)" : "var(--sf)", color: on ? "var(--onac)" : "var(--ink)", borderColor: on ? "var(--ac)" : "var(--ln2)" }}>{text}</button>
        );
      })}
    </div>
  );
}

/** Filter chips of a list (DT-20261118-06 phase 1B): one row that scrolls sideways on a phone, each with its count (Arabic-Indic digits). One is selected at a time. */
export function SegmentChips<T extends string>({ label, items, value, counts, onChange }: { label: string; items: Array<[T, string]>; value: T; counts?: Partial<Record<T, number>>; onChange: (v: T) => void }) {
  return (
    <div role="tablist" aria-label={label} className="no-scrollbar flex max-w-full gap-1 overflow-x-auto rounded-[14px] bg-sf2 p-1">
      {items.map(([id, text]) => {
        const on = value === id;
        const n = counts?.[id];
        return (
          <button key={id} type="button" role="tab" aria-selected={on} onClick={() => onChange(id)}
            className="min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-[10px] border-0 px-3 text-xs font-semibold"
            style={{ background: on ? "var(--sf)" : "transparent", color: on ? "var(--ink)" : "var(--mut)", boxShadow: on ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}>
            {text}{typeof n === "number" && <span className="ms-1 opacity-60">{formatAr(n)}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ── DT-20261118-06 phase 0: one card, one tile, one meter, one chart, one ranked list, one empty and one error sentence for every admin screen. Logical properties only. ── */

export type CardTone = "default" | "warn" | "bad";
const CARD_BORDER: Record<CardTone, string> = { default: "var(--ln)", warn: tint("var(--gold)", 45), bad: tint("var(--bad)", 35) };

/** The one card recipe (radius 20, surface, border): an optional title with a short line under it and an action on the inline-end side. */
export function Card({ title, sub, action, tone = "default", testId, children }: { title?: ReactNode; sub?: ReactNode; action?: ReactNode; tone?: CardTone; testId?: string; children?: ReactNode }) {
  return (
    <section data-testid={testId} className="flex min-w-0 flex-col gap-3 rounded-[20px] border bg-sf p-4 min-[900px]:p-[18px]" style={{ borderColor: CARD_BORDER[tone] }}>
      {(title || action) && (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title && <h2 className="m-0 text-[15px] font-semibold text-ink">{title}</h2>}
            {sub && <p className="mb-0 mt-1 text-xs text-mut">{sub}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** A card-sized placeholder while a card loads: the same height as the loaded card, no pulse when the reader asked for less motion. */
export function CardSkeleton({ height = 160 }: { height?: number }) {
  return <div aria-hidden="true" className="rounded-[20px] bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" style={{ height }} />;
}

/** «▲ ٣٫٢٪» / «▼ ١٢٪»: the change against the previous period, one decimal, Arabic-Indic digits. */
export function deltaAr(pct: number): string {
  const v = Number.isFinite(pct) ? Math.round(Math.abs(pct) * 10) / 10 : 0;
  return `${pct < 0 ? "▼" : "▲"} ${formatAr(v)}٪`;
}

const TILE_TONE: Record<CardTone, string> = { default: "var(--ink)", warn: "var(--goldT)", bad: "var(--bad)" };

/** One number with its label: «—» when it could not be read, a smaller size from seven characters on so a long number never breaks the tile. */
export function StatTile({ label, value, unit, delta, sub, href, tone = "default", testId }: { label: string; value: string | null; unit?: string; delta?: number | null; sub?: ReactNode; href?: string; tone?: CardTone; testId?: string }) {
  const shown = value ?? "—";
  const size = shown.length >= 7 ? "text-[24px]" : "text-[30px]";
  const inner = (
    <>
      <span className="flex items-center justify-between gap-2">
        <span className="text-xs text-mut">{label}</span>
        {typeof delta === "number" && <span className="whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-semibold" style={{ background: tint(delta < 0 ? "var(--bad)" : "var(--ok)", 13), color: delta < 0 ? "var(--bad)" : "var(--ok)" }}>{deltaAr(delta)}</span>}
      </span>
      <span className={`overflow-x-clip whitespace-nowrap font-display leading-none ${size}`} style={{ color: TILE_TONE[tone] }}>
        {shown}{unit && <span className="ms-1.5 font-sans text-xs text-mut">{unit}</span>}
      </span>
      {sub && <span className="text-[12px] text-mut">{sub}</span>}
    </>
  );
  const cls = "flex min-h-11 min-w-0 flex-col gap-2 rounded-[14px] border border-ln bg-sf p-3.5 text-start text-ink";
  return href ? <Link href={href} data-testid={testId} className={`${cls} hover:border-ln2`}>{inner}</Link> : <div data-testid={testId} className={cls}>{inner}</div>;
}

export type MeterLevel = "ok" | "warn" | "bad";
const METER_COLOR: Record<MeterLevel, string> = { ok: "var(--ok)", warn: "var(--gold)", bad: "var(--bad)" };

/** The filled share of a meter, 0..100 (an empty or broken maximum is an empty meter, never a full one). */
export function meterPercent(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

/** A progress bar that always prints its number: the colour never carries the meaning alone. */
export function Meter({ value, max, level = "ok", label, valueText }: { value: number; max: number; level?: MeterLevel; label: string; valueText?: string }) {
  const pct = meterPercent(value, max);
  const text = valueText ?? `${formatAr(Math.round(pct))}٪`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 text-xs"><span className="text-mut">{label}</span><span className="font-semibold text-ink">{text}</span></div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={text} className="h-2 overflow-hidden rounded-full bg-sf2">
        <div className="h-full rounded-full" style={{ width: `${Math.round(pct * 10) / 10}%`, background: METER_COLOR[level] }} />
      </div>
    </div>
  );
}

export interface TrendPoint { label: string; value: number; /** optional second series drawn as a thinner bar (for example the cost next to the revenue) */ value2?: number; /** the sentence the value strip prints for this bar */ detail?: string }

/**
 * Keyboard move inside a TrendBars chart. Time runs right to left (the oldest bar is at the inline-start, the right in Arabic),
 * so ArrowLeft goes to a newer bar and ArrowRight to an older one; Home is the oldest, End the newest. null: not a chart key.
 */
export function trendStep(key: string, index: number, length: number): number | null {
  if (length <= 0) return null;
  const i = index < 0 ? length - 1 : index;
  if (key === "ArrowLeft") return Math.min(length - 1, i + 1);
  if (key === "ArrowRight") return Math.max(0, i - 1);
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return null;
}

/** Bars over time with tap and keyboard selection; the selected value is printed in a fixed strip above (no hover tooltip, so it works on a phone). */
export function TrendBars({ label, series, selected, onSelect, height = 120, labelEvery = 1, emptyText = "لا توجد بيانات في هذه الفترة." }: { label: string; series: TrendPoint[]; selected: number | null; onSelect: (i: number) => void; height?: number; labelEvery?: number; emptyText?: string }) {
  if (series.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <div className="h-px bg-ln2" style={{ marginBlockStart: height }} />
        <p className="m-0 text-center text-[13px] text-mut">{emptyText}</p>
      </div>
    );
  }
  const max = Math.max(1, ...series.map((p) => Math.max(p.value, p.value2 ?? 0)));
  const focusIndex = selected ?? series.length - 1;
  const textOf = (p: TrendPoint) => p.detail ?? `${p.label}: ${formatAr(p.value)}`;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = trendStep(e.key, selected ?? -1, series.length);
    if (next === null) return;
    e.preventDefault();
    onSelect(next);
    e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-bar]")[next]?.focus();
  };
  const h = (v: number) => `${v > 0 ? Math.max(2, (v / max) * 100) : 0}%`;
  return (
    <div className="flex flex-col gap-2">
      <p data-testid="trend-strip" aria-live="polite" className="m-0 min-h-[1.4rem] text-[13px] font-semibold text-ink">{selected !== null && series[selected] ? textOf(series[selected]) : <span className="font-normal text-mut">اضغط عمودًا لرؤية اليوم</span>}</p>
      <div role="group" aria-label={label} onKeyDown={onKeyDown} className="flex items-end gap-[3px] border-b border-ln2" style={{ height }}>
        {series.map((p, i) => (
          <button key={i} type="button" data-bar aria-pressed={selected === i} aria-label={textOf(p)} tabIndex={i === focusIndex ? 0 : -1} onClick={() => onSelect(i)}
            className="flex h-full min-w-0 flex-1 cursor-pointer items-end justify-center gap-px rounded-t border-0 p-0" style={{ background: selected === i ? "var(--sf2)" : "transparent" }}>
            <span className="block w-[46%] rounded-t-[3px]" style={{ height: h(p.value), background: "var(--bar)" }} />
            {p.value2 !== undefined && <span className="block w-[34%] rounded-t-[3px]" style={{ height: h(p.value2), background: "var(--bar2)" }} />}
          </button>
        ))}
      </div>
      <div aria-hidden="true" className="flex gap-[3px]">
        {series.map((p, i) => <span key={i} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center text-[11px] text-mut">{labelEvery <= 1 || (series.length - 1 - i) % labelEvery === 0 ? p.label : ""}</span>)}
      </div>
    </div>
  );
}

/** A ranked list with a thin bar per row (top pages, sources, countries). The share is against the largest row unless given. */
export function BarList({ rows, emptyText }: { rows: Array<{ label: string; value: number; share?: number }>; emptyText: string }) {
  if (rows.length === 0) return <p className="m-0 py-4 text-center text-[13px] text-mut">{emptyText}</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {rows.map((r) => (
        <li key={r.label} className="flex flex-col gap-1">
          <span className="flex items-center justify-between gap-2 text-[13px]"><span className="min-w-0 truncate text-ink" title={r.label}>{r.label}</span><span className="shrink-0 font-semibold text-ink">{formatAr(r.value)}</span></span>
          <span className="block h-1.5 overflow-hidden rounded-full bg-sf2"><span className="block h-full rounded-full" style={{ width: `${Math.round((r.share !== undefined ? r.share : r.value / max) * 1000) / 10}%`, background: "var(--bar)" }} /></span>
        </li>
      ))}
    </ul>
  );
}

/** One calm sentence instead of an empty chart or table. */
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 py-6 text-center">
      <p className="m-0 text-[13px] text-mut">{title}</p>
      {hint && <p className="m-0 text-xs text-mut">{hint}</p>}
      {action}
    </div>
  );
}

/** A card that could not load: the reason and «أعد المحاولة». The other cards keep working. */
export function ErrorState({ title = "تعذّر تحميل هذه البطاقة.", onRetry, retryLabel = "أعد المحاولة" }: { title?: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 py-3">
      <p className="m-0 text-[13px] text-bad">{title}</p>
      {onRetry && <button type="button" onClick={onRetry} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-sf px-4 text-[13px] font-semibold text-ink">{retryLabel}</button>}
    </div>
  );
}
