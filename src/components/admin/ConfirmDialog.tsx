"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { foldSeparatorMarks } from "@/lib/arabicNormalize";
import { normalizeDigits } from "@/lib/arabicDigits";

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";
const plain = (s: string) => foldSeparatorMarks(normalizeDigits(s)).replace(/[\s,]/g, "");

/** True when the typed text equals the expected one (Arabic-Indic or Latin digits, spaces and group separators ignored); always true when nothing must be typed. */
export function typedConfirmMatches(typed: string, expected?: string): boolean {
  if (!expected) return true;
  return plain(typed) === plain(expected);
}

/** The confirm button works only when no request is running and the typed text (if one is asked for) matches. */
export function confirmEnabled(input: { working?: boolean; typed: string; typeToConfirm?: string }): boolean {
  return !input.working && typedConfirmMatches(input.typed, input.typeToConfirm);
}

/** Focus trap: the index Tab (or Shift+Tab when `back`) moves to from `current`, wrapping at both ends; -1 when nothing can take focus. */
export function trapFocusIndex(current: number, count: number, back: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return back ? count - 1 : 0;
  return back ? (current - 1 + count) % count : (current + 1) % count;
}

/**
 * THE CONFIRM STEP of every money, account or send action (DT-20261118-06 §5.4): a money or account action never fires from one tap.
 * A bottom sheet on a phone, a centred card on a wide screen; focus stays inside; Esc closes (not while the request runs); the confirm button is the last tab stop
 * and stays disabled while `working` or until the typed text equals `typeToConfirm`. No emoji, 44 px buttons.
 */
export function ConfirmDialog(props: { open: boolean; title: string; body: ReactNode; confirmLabel: string; cancelLabel?: string; typeToConfirm?: string; danger?: boolean; working?: boolean; error?: string | null; onConfirm: () => void; onCancel: () => void }) {
  const { open, title, body, confirmLabel, cancelLabel = "إلغاء", typeToConfirm, danger = false, working = false, error = null, onConfirm, onCancel } = props;
  const [typed, setTyped] = useState("");
  const box = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => { if (!open) setTyped(""); }, [open]);
  useEffect(() => {
    if (!open) return;
    const before = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    box.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => { before?.focus?.(); };
  }, [open]);

  if (!open) return null;
  const ready = confirmEnabled({ working, typed, typeToConfirm });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      // the sheet under the dialog also closes on Esc: this Esc belongs to the dialog only
      e.stopPropagation();
      e.preventDefault();
      if (!working) onCancel();
      return;
    }
    if (e.key !== "Tab" || !box.current) return;
    const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const next = trapFocusIndex(items.indexOf(document.activeElement as HTMLElement), items.length, e.shiftKey);
    if (next >= 0) { e.preventDefault(); items[next].focus(); }
  };

  return (
    <div className="fixed inset-0 z-[350] flex items-end justify-center min-[900px]:items-center" onKeyDown={onKeyDown}>
      <div aria-hidden="true" onClick={() => { if (!working) onCancel(); }} className="absolute inset-0" style={{ background: "rgba(8,10,10,.5)" }} />
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="relative flex max-h-[90dvh] w-full max-w-[460px] flex-col gap-3 overflow-y-auto rounded-t-[20px] border border-ln bg-sf p-[18px] min-[900px]:rounded-[20px] motion-safe:animate-[sheetUp_.3s_both]"
        style={{ boxShadow: "var(--admin-shadow)", paddingBlockEnd: "calc(18px + env(safe-area-inset-bottom))" }}>
        <h2 id={titleId} className="m-0 text-[17px] font-semibold text-ink">{title}</h2>
        <div className="text-[14px] leading-[1.9] text-ink2">{body}</div>
        {typeToConfirm && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-mut">للتأكيد اكتب الرقم {typeToConfirm}</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} inputMode="numeric" autoComplete="off" className="min-h-11 rounded-xl border border-ln bg-bg px-3 text-base text-ink outline-none" />
          </label>
        )}
        {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={working} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-5 text-[13px] font-semibold text-ink disabled:opacity-50">{cancelLabel}</button>
          <button type="button" onClick={() => { if (ready) onConfirm(); }} disabled={!ready} className="min-h-11 cursor-pointer rounded-full border-0 px-5 text-[13px] font-semibold disabled:opacity-50"
            style={{ background: danger ? "var(--bad)" : "var(--ac)", color: danger ? "#fff" : "var(--onac)" }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
