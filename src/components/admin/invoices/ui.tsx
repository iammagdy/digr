"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { STATUS_AR } from "@/lib/invoices/labels";
import type { DocStatus } from "@/lib/invoices/types";

/** Shared look of the invoice screens: the admin's own tokens, 16 px inputs (no zoom on a phone), 44 px touch targets, nothing wider than the screen. */
export const SECTION = "flex min-w-0 flex-col gap-3.5 rounded-[20px] border border-ln bg-sf p-4";
export const INPUT = "min-h-[46px] w-full min-w-0 rounded-xl border border-ln bg-bg px-3.5 text-base text-ink outline-none disabled:opacity-60";
export const BTN = "min-h-[44px] rounded-xl border border-ln bg-sf px-4 text-[13px] font-semibold text-ink disabled:opacity-50";
export const BTN_PRIMARY = "min-h-[44px] rounded-xl bg-ink px-4 text-[13px] font-semibold text-sf disabled:opacity-50";
export const BTN_DANGER = "min-h-[44px] rounded-xl border border-bad px-4 text-[13px] font-semibold text-bad disabled:opacity-50";

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-semibold text-mut">{label}</span>
      {children}
      {hint ? <span className="text-[11px] leading-5 text-mut">{hint}</span> : null}
    </label>
  );
}

const STATUS_COLOR: Record<DocStatus, string> = { draft: "var(--mut)", sent: "var(--info)", paid: "var(--ok)", void: "var(--bad)" };

export function StatusChip({ status }: { status: DocStatus }) {
  return (
    <span className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold" style={{ color: STATUS_COLOR[status], borderColor: STATUS_COLOR[status] }} data-testid="status-chip">
      {STATUS_AR[status]}
    </span>
  );
}

/** A confirmation before a step that cannot be undone («مرسلة», «مدفوعة», «ملغية»). Escape or the backdrop cancels. */
export function ConfirmDialog({ title, body, confirmLabel, danger, busy, onConfirm, onCancel, children }: {
  title: string; body: string; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void; children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 p-3 sm:items-center" onClick={onCancel} data-testid="confirm-backdrop">
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90dvh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-[20px] border border-ln bg-sf p-5 outline-none" data-testid="confirm-dialog">
        <h2 className="m-0 text-base font-semibold text-ink">{title}</h2>
        <p className="m-0 text-[13px] leading-[1.9] text-ink2">{body}</p>
        {children}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={BTN} onClick={onCancel} disabled={busy} data-testid="confirm-cancel">تراجع</button>
          <button type="button" className={danger ? BTN_DANGER : BTN_PRIMARY} onClick={onConfirm} disabled={busy} data-testid="confirm-ok">{busy ? "جارٍ التنفيذ…" : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
