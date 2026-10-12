"use client";

import { useEffect, type ReactNode } from "react";
import { useAdmin } from "./AdminShell";

/** Admin detail sheet: from the left on desktop, bottom sheet on mobile (safe-area aware). */
export function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const { isMobile } = useAdmin();
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [onClose]);

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 z-[300]" style={{ background: "rgba(8,10,10,.45)", animation: "fade .2s both" }} />
      <aside
        role="dialog" aria-label={label} aria-modal="true"
        className="fixed z-[301] flex flex-col overflow-hidden bg-bg"
        style={{
          ...(isMobile
            ? { inset: "auto 0 0 0", width: "100%", maxHeight: "92dvh", borderRadius: "28px 28px 0 0", animation: "sheetUp .38s cubic-bezier(.2,.7,.2,1) both" }
            : { inset: "0 auto 0 0", width: "min(520px,100%)", height: "100dvh", animation: "sheetL .38s cubic-bezier(.2,.7,.2,1) both" }),
          boxShadow: "0 30px 80px -20px rgba(0,0,0,.45)",
        }}
      >
        {children}
      </aside>
    </>
  );
}

export function SheetHandle() {
  const { isMobile } = useAdmin();
  return isMobile ? <span className="mx-auto mb-3 block h-1 w-10 rounded bg-ln2" /> : null;
}

export function KV({ k, v, dir = "rtl", mono = false, copy }: { k: string; v: string; dir?: "rtl" | "ltr"; mono?: boolean; copy?: { label: string; onCopy: () => void } }) {
  return (
    <div className="flex min-h-[46px] items-center justify-between gap-3 border-b border-ln">
      <span className="shrink-0 text-[13px] text-mut">{k}</span>
      <span className="flex min-w-0 items-center gap-2">
        <span dir={dir} className="truncate text-[13px] font-medium text-ink" style={{ fontFamily: mono ? "ui-monospace,monospace" : "inherit" }}>{v}</span>
        {copy && <button type="button" onClick={copy.onCopy} className="min-h-11 shrink-0 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-[11px] text-ink">{copy.label}</button>}
      </span>
    </div>
  );
}
