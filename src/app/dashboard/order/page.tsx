"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function OrderRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard/chat");
  }, [router]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="flex items-center gap-3 text-sm text-ink-500 font-medium">
        <span className="h-4 w-4 rounded-full border-2 border-ink-900 border-t-transparent animate-spin" />
        <span>جاري التحويل إلى المساعد الذكي...</span>
      </div>
    </div>
  );
}
