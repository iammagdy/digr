import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { START_NOT_STARTED_AR, START_UNKNOWN_AR, startFailureText } from "../src/lib/startFailure";
import { startFailureEventAr, START_FAILURE_REASON_CODES } from "../src/lib/server/workerStartFailure";
import { startFailureMessageAr, ChatRequestError } from "../src/lib/customerError";
import ResultsCanvas, { formatCell } from "../src/app/dashboard/chat/components/ResultsCanvas";
import { normalizeDataset } from "../src/lib/server/normalizationPipeline";

describe("the sentence after a start that did not come back", () => {
  it("the request did start (its job exists): nothing is said as a failure, the page shows it as started", () => {
    expect(startFailureText({ deliberateText: null, jobState: "exists" })).toBeNull();
  });

  it("no job after looking: it did not start, and the sentence says so without blaming the balance", () => {
    const text = startFailureText({ deliberateText: null, jobState: "none" })!;
    expect(text).toBe(START_NOT_STARTED_AR);
    expect(text).not.toContain("تحقق من رصيدك");
  });

  it("could not look: asks to open «طلباتي», with no claim about the balance", () => {
    const text = startFailureText({ deliberateText: null, jobState: "unknown" })!;
    expect(text).toBe(START_UNKNOWN_AR);
    expect(text).toContain("«طلباتي»");
    expect(text).not.toContain("تحقق من رصيدك");
  });

  it("a sentence the server wrote (insufficient balance, expired quote, active-request limit) passes through whatever the job state is", () => {
    for (const jobState of ["exists", "none", "unknown"] as const) {
      expect(startFailureText({ deliberateText: "رصيدك الحالي (٥٠ نقطة) غير كافٍ لتغطية تكلفة هذا العرض.", jobState })).toBe("تعذر بدء الاستخراج: رصيدك الحالي (٥٠ نقطة) غير كافٍ لتغطية تكلفة هذا العرض.");
    }
    expect(startFailureMessageAr(new ChatRequestError("انتهت صلاحية هذا العرض.", 410))).toBe("تعذر بدء الاستخراج: انتهت صلاحية هذا العرض.");
  });

  it("the reason codes are numbers with a plain sentence and no technical word", () => {
    const codes = Object.values(START_FAILURE_REASON_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of Object.keys(START_FAILURE_REASON_CODES)) {
      const { message } = startFailureEventAr(code);
      expect(message).toMatch(/رمز السبب [٠-٩]+\)\.$/);
      expect(message).not.toMatch(/[A-Za-z]/);
    }
    expect(startFailureEventAr("something new").message).toContain("رمز السبب ١٠");
  });

  it("the chat page looks the job up before it says anything and never blames the balance on its own", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("const jobState = deliberate ? \"unknown\" : await lookupQuoteJobState(quote.quoteId);");
    expect(page).toContain("if (text !== null) {");
    // The request did start (its job exists): the page continues with the normal started path, not with an error.
    expect(page).toContain("data = { success: true, jobId: getJobIdForQuote(quote.quoteId), workerDispatch: { started: true }, reservedCredits: quote.quotedPoints };");
    // Only an error while showing an accepted request reaches the last catch, and it does not blame the balance.
    expect(page.match(/startFailureMessageAr\(err\)/g)).toHaveLength(1);
    const lookup = page.slice(page.indexOf("async function lookupQuoteJobState"), page.indexOf("async function handleStartExecution"));
    expect(lookup).toContain('.from("jobs").select("id").eq("id", jobId)');
    expect(lookup).toContain("attempt < 3");
  });
});

describe("dates in the data preview are in Arabic-Indic digits (display only)", () => {
  it("ISO dates and date-times become Arabic-Indic; numbers, text and other values are untouched", () => {
    expect(formatCell("2026-10-18")).toBe("٢٠٢٦-١٠-١٨");
    expect(formatCell("2026-10-18T07:36:02Z")).toBe("٢٠٢٦-١٠-١٨T٠٧:٣٦:٠٢Z");
    expect(formatCell("2026-10-18 07:36")).toBe("٢٠٢٦-١٠-١٨ ٠٧:٣٦");
    expect(formatCell("أحمد 2026")).toBe("أحمد 2026");
    expect(formatCell("2026")).toBe("2026");
    expect(formatCell("")).toBe("—");
    expect(formatCell(true)).toBe("نعم");
  });

  it("the table of a real social dataset shows the publication date and time in Arabic-Indic digits, and the data itself keeps ISO text", () => {
    const normalized = normalizeDataset({ metadata: { template: "x" }, rows: [{ tweet_id: "1", text: "منشور", createdUtc: 1792308962, likes: 4 }] }, { socialKind: "posts", title: "x" });
    expect(normalized.rows[0].published_at).toBe("2026-10-18 07:36");
    const html = renderToStaticMarkup(createElement(ResultsCanvas as any, { records: normalized.rows, profile: null, jobId: "job_x", jobStatus: "done", onDownload: () => {}, fileIds: { xlsx: "ready", pdf: null, csv: null } }));
    expect(html).toContain("٢٠٢٦-١٠-١٨ ٠٧:٣٦");
    expect(html).not.toContain(">2026-10-18 07:36<");
  });
});
