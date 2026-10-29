import type { ReactNode } from "react";
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
