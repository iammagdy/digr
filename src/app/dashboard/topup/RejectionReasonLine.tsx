/** The line under a rejected request: «سبب الرفض: …». Plain text only (React escapes it). Nothing at all when there is no reason: no placeholder. */
export function RejectionReasonLine({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <p data-testid="topup-reject-reason" className="mb-0 mt-1.5 break-words text-xs leading-[1.7] text-bad">
      سبب الرفض: {reason}
    </p>
  );
}
