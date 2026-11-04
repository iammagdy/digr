"use client";

/**
 * ROUND 26 (item 2): THE CHAT TYPING INDICATOR. From the moment a message is sent until the reply (or the mission card) is in the conversation, the chat shows three moving dots and the
 * status line of the waiting reply («يكتب الرد...»), so a sent message never looks ignored. With reduced motion the dots stand still, fully visible (see `.run-dot`).
 */
export const TYPING_LINE_FALLBACK_AR = "يكتب الرد...";

export default function TypingIndicator({ textAr, className = "" }: { textAr?: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" data-testid="typing-indicator" dir="rtl" className={`flex items-center gap-2.5 text-[15px] font-light text-mut ${className}`}>
      <span aria-hidden="true" className="flex shrink-0 items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="run-dot h-1.5 w-1.5 rounded-full bg-ac" style={{ animationDelay: `${i * 0.18}s` }} />
        ))}
      </span>
      <span>{textAr || TYPING_LINE_FALLBACK_AR}</span>
    </div>
  );
}
