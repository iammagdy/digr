"use client";

import { useRef, type FormEvent } from "react";

/** Design composer: «اسأل ديجر» + arrow. 16px input (no iOS zoom); the shell's visualViewport height keeps it above the keyboard. */
export default function Composer({
  value, onChange, onSend, disabled,
}: { value: string; onChange: (v: string) => void; onSend: (text: string) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (disabled || !value.trim()) return;
    onSend(value);
  };
  return (
    <div className="shrink-0 px-4 pb-4 pt-2" style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}>
      <form
        onSubmit={submit}
        className="mx-auto flex max-w-[720px] items-center gap-1.5 rounded-full border border-ln bg-sf p-1.5"
        style={{ boxShadow: "var(--shadow)" }}
      >
        <input
          ref={ref} type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder="اسأل ديجر" aria-label="اسأل ديجر"
          enterKeyHint="send" autoComplete="off" maxLength={2000}
          className="min-h-[46px] min-w-0 flex-1 border-0 bg-transparent px-[18px] text-base font-light text-ink outline-none"
        />
        <button
          type="submit" aria-label="إرسال" disabled={disabled}
          className="flex h-[46px] w-[46px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-ac text-onac disabled:cursor-not-allowed disabled:opacity-60"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" /></svg>
        </button>
      </form>
    </div>
  );
}
