import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Composer & Activity Feed Integrity", () => {
  it("enforces spreadsheet-only upload restrictions and clarifies multimodal/PDF unavailability", () => {
    const composerCode = readFileSync("src/app/dashboard/chat/components/Composer.tsx", "utf8");

    // Acceptance strictly limited to XLSX and CSV
    expect(composerCode).toContain(".xlsx,.csv");
    // Clear disclosure of unsupported PDF / image / media formats
    expect(composerCode).toContain("ملفات بي دي إف والمستندات المصورة غير مدعومة حاليًا");
    // Helper text visible to users below the form
    expect(composerCode).toContain("يدعم إرفاق ملفات الاستبعاد بصيغتي إكسل وسي إس في حتى ٥ ميجابايت.");
    // Size cap enforced at 5 MB
    expect(composerCode).toContain("5 * 1024 * 1024");
  });

  it("maps Supabase job_events schema fields (message, units, event_type) into chat activity feed", () => {
    const chatPageCode = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");

    // mapJobEvents function must read from Supabase column names
    expect(chatPageCode).toContain("e.message || e.text_ar || e.textAr");
    expect(chatPageCode).toContain("e.event_type || e.kind || \"info\"");
    expect(chatPageCode).toContain("typeof e.units === \"number\" ? e.units");
  });

  it("clears the chat input after a successful assistant response, while preserving it on failure", () => {
    const chatPageCode = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    const sendHandler = chatPageCode.slice(
      chatPageCode.indexOf("async function handleSendMessage("),
      chatPageCode.indexOf("async function handleSubmitClarification(")
    );

    expect(sendHandler).toMatch(/setMessages\(\(prev\) => \[\.\.\.prev, assistantMsg\]\);\r?\n\s*setInputText\(""\);\r?\n\s*return true;/);
    expect(sendHandler).toContain("return false;");
    expect(sendHandler).toContain("errorRetryPrompt: textToSend");
  });

  it("records progress and completion in public.job_events table", () => {
    const workerCode = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    const acceptCode = readFileSync("src/app/api/chat/accept-quote/route.ts", "utf8");
    const startupFailureCode = readFileSync("src/lib/server/workerStartFailure.ts", "utf8");

    // Failed worker starts record one terminal event through the shared helper.
    expect(acceptCode).toContain("recordWorkerStartFailure");
    expect(startupFailureCode).toContain('.from("job_events").insert');
    // Worker records chunk progress in job_events
    expect(workerCode).toContain('.from("job_events").insert');
    // Worker uploads data.json to partials bucket (results bucket strictly restricts MIME types to xlsx, csv, and pdf)
    expect(workerCode).toContain('partialsBucket.upload');
    expect(workerCode).toContain('${jobId}/data.json');
  });

  it("verifies RevisionQuoteCard displays 10-point pricing and disclosure note", () => {
    const revCardCode = readFileSync("src/app/dashboard/chat/components/RevisionQuoteCard.tsx", "utf8");

    expect(revCardCode).toContain("طلب تعديل مخرجات");
    expect(revCardCode).toContain("تكلفة التعديل ١٠ نقاط");
    expect(revCardCode).toContain("تتطلب العملية تفعيل الخصم الذري المعتمد");
  });
});
