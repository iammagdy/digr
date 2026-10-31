import { Icon } from "@/components/app/icons";
import { formatAr } from "@/lib/arabicDigits";

/**
 * THE ONE LINE OF A JOB in the wallet («خُصم ٢٠٠ نقطة مقابل ٥٠ تغريدة»), a real button: its open state is kept by the page (`aria-expanded`), not by the browser's native <details>, so it opens and folds the same in
 * every browser. The day AND the time (Cairo) are on the line, so two jobs of the same size on the same day are two different lines.
 */
export function WalletJobToggle({ lineAr, whenAr, net, open, panelId, onToggle }: { lineAr: string; whenAr: string; net: number; open: boolean; panelId: string; onToggle: () => void }) {
  return (
    <button type="button" aria-expanded={open} aria-controls={panelId} onClick={onToggle} data-testid="wallet-mission-toggle" className="flex min-h-11 w-full cursor-pointer items-center gap-3 border-0 bg-transparent p-0 text-right">
      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[11px]" style={{ background: "color-mix(in oklab, var(--mut) 12%, transparent)", color: "var(--ink2)" }}><Icon d="M5 12h14" size={16} stroke={1.8} /></span>
      <span className="block min-w-0 flex-1">
        <span className="m-0 block text-sm text-ink" data-testid="wallet-mission-line">{lineAr}</span>
        <span className="mb-0 mt-[3px] block text-xs font-light leading-[1.7] text-fnt" data-testid="wallet-mission-when">{whenAr} · <span className="text-ink2 underline decoration-dotted underline-offset-4">{open ? "إخفاء التفاصيل" : "تفاصيل الحركات"}</span></span>
      </span>
      <span dir="ltr" className="text-[15px] font-semibold" style={{ color: net > 0 ? "var(--ok)" : "var(--ink)" }}>{net > 0 ? "+" : "−"}{formatAr(Math.abs(net))}</span>
    </button>
  );
}
