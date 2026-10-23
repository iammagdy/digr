"use client";

import { AllCallsLog } from "@/components/admin/AllCallsLog";

export default function AdminCallsLogPage() {
  return (
    <div data-screen-label="CallsLog" className="flex flex-col gap-3.5" style={{ maxWidth: 1100 }}>
      <AllCallsLog />
    </div>
  );
}
