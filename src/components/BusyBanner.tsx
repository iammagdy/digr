"use client";

import { useBusyStatus } from "@/hooks/useBusyStatus";

/** A calm notice above the chat while new requests are paused (the provider's daily allowance or capacity is used up). Silent otherwise. */
export default function BusyBanner() {
  const { busy, messageAr } = useBusyStatus();
  if (!busy || !messageAr) return null;
  return (
    <div role="status" data-testid="busy-banner" className="mx-auto mb-3 w-full max-w-[680px] rounded-[18px] border border-ln bg-sf2 px-4 py-3 text-[13px] leading-[1.9] text-ink2">
      {messageAr}
    </div>
  );
}
