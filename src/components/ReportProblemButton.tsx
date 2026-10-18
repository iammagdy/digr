"use client";

import { useState } from "react";

/** «بلّغ عن مشكلة» on a failed or partial job: sends the job id automatically; the server writes the message. */
export default function ReportProblemButton({ jobId, className = "" }: { jobId: string; className?: string }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [text, setText] = useState("");

  async function report() {
    if (state === "sending") return;
    setState("sending");
    try {
      const res = await fetch("/api/support/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId }) });
      const data = await res.json().catch(() => ({}));
      setText(data?.messageAr || "");
      setState(res.ok && data?.success ? "done" : "error");
    } catch {
      setText("تعذر الاتصال الآن. حاول مرة أخرى.");
      setState("error");
    }
  }

  return (
    <span className={`inline-flex flex-col gap-1 ${className}`}>
      <button
        type="button"
        onClick={report}
        disabled={state === "sending" || state === "done"}
        className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-xs text-ink disabled:cursor-default disabled:opacity-60"
      >
        {state === "sending" ? "جاري الإرسال..." : state === "done" ? "تم إرسال البلاغ" : "بلّغ عن مشكلة"}
      </button>
      {(state === "done" || state === "error") && (
        <span role="status" aria-live="polite" className="text-[11px] leading-[1.7]" style={{ color: state === "done" ? "var(--ok)" : "var(--bad)" }}>{text}</span>
      )}
    </span>
  );
}
