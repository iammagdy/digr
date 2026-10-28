import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { planApprovalNoteAr, shouldShowPlanPanel } from "../src/lib/quoteApprovalState";
import { volumeLimitStatementAr } from "../src/lib/jobCaps";
import { openJobHref } from "../src/lib/requestLinks";
import { getJobIdForQuote } from "../src/lib/md5";

const APPROVE = "أوافق وابدأ البحث";
const future = () => new Date(Date.now() + 20 * 60_000).toISOString();
const quote = (extra: Partial<PlanQuoteData> = {}): PlanQuoteData => ({
  quoteId: "q_retry", summaryAr: "سحب تعليقات تيك توك عن كرة القدم",
  items: [{ capabilitySlug: "social-tiktok-comments", params: { query: "كرة القدم", region: "EG", dateFrom: "2026-09-20", dateTo: "2026-10-20" }, targetVolumeMin: 1, targetVolumeMax: 28 }],
  targetVolumeMax: 28, unitPricePoints: 6, expectedPoints: 168, quotedPoints: 194, isAffordable: true, userBalance: 1398, outputFormats: ["xlsx"],
  expiresAt: future(), status: "quoted", ...extra,
});
const render = (q: PlanQuoteData, locked = false, available: number | null = 1398) => renderToStaticMarkup(createElement(PlanQuoteCard, {
  quote: q, locked, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {},
} as any));

describe("a plan card of a quote that is still valid always has its approve button", () => {
  it("the retry plan of the live test: asked 30, capacity allows 28, reserve 194, warning and button together", () => {
    const html = render(quote({ askedVolumeMax: 30, requestedVolumeMax: 30, capacityConstrained: true }));
    expect(html).toContain(APPROVE);
    expect(html).toContain('data-testid="plan-volume-limit"');
    expect(html).toContain("طلبت ٣٠ سجل، والذي تتسع له سعة الاستخراج المتاحة الآن ٢٨ سجل، وسيُحجز للخطة حتى ١٩٤ نقطة ولا يُخصم منها إلا ما يُسلَّم.");
    expect(html).not.toContain("سقف المهمة الحالي");
    expect(html).not.toContain('data-testid="plan-approval-note"');
  });

  it("a plain valid plan, a points-cap shrink and a default volume all keep the button", () => {
    expect(render(quote())).toContain(APPROVE);
    expect(render(quote({ askedVolumeMax: 2000, requestedVolumeMax: 1000, pointsCapConstrained: true, pointsCap: 600 }))).toContain(APPROVE);
  });
});

describe("the button is hidden only for an expired, accepted, incomplete or read-only plan, and the card says why", () => {
  it("accepted: a plain sentence, no button", () => {
    const html = render(quote({ status: "accepted" }));
    expect(html).not.toContain(APPROVE);
    expect(html).toContain("بدأ تنفيذ هذه الخطة بالفعل، ولا يمكن الموافقة عليها مرة ثانية.");
  });

  it("superseded (expired status): the existing sentence, no button", () => {
    const html = render(quote({ status: "expired" }));
    expect(html).not.toContain(APPROVE);
    expect(html).toContain("هذا العرض لم يعد صالحاً للموافقة. استخدم أحدث عرض سعر في هذه المحادثة.");
  });

  it("expired by time: the sentence and the refresh button, no approve", () => {
    const html = render(quote({ expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    expect(html).not.toContain(APPROVE);
    expect(html).toContain("انتهت صلاحية عرض السعر. نحتاج تحديثه قبل الموافقة.");
    expect(html).toContain("تحديث السعر");
  });

  it("status that could not be read: asks to reload", () => {
    const html = render(quote({ status: "unknown" }));
    expect(html).not.toContain(APPROVE);
    expect(html).toContain("أعد تحميل المحادثة قبل الموافقة");
  });

  it("incomplete plan: no button and a sentence that says what to do", () => {
    const html = render(quote({ items: [] }));
    expect(html).not.toContain(APPROVE);
    expect(html).toContain('data-testid="plan-approval-note"');
    expect(html).toContain("الخطة غير مكتملة بعد، لذلك لا يظهر زر الموافقة.");
  });

  it("read-only beside a running request: no button and a sentence that says when", () => {
    const html = render(quote(), true);
    expect(html).not.toContain(APPROVE);
    expect(html).toContain('data-testid="plan-approval-note"');
    expect(html).toContain("يمكنك الموافقة عليها بعد انتهاء الطلب الجاري.");
  });

  it("balance too low: the top-up offer instead of the button", () => {
    const html = render(quote({ isAffordable: false }), false, 50);
    expect(html).not.toContain(APPROVE);
    expect(html).toContain("شحن الرصيد");
  });

  it("the note helper: every state in one place", () => {
    const base = { locked: false, status: "quoted", expiredByTime: false, planComplete: true };
    expect(planApprovalNoteAr(base)).toBeNull();
    expect(planApprovalNoteAr({ ...base, status: "accepted" })).toContain("بدأ تنفيذ هذه الخطة");
    expect(planApprovalNoteAr({ ...base, status: "expired" })).toBeNull();
    expect(planApprovalNoteAr({ ...base, expiredByTime: true })).toBeNull();
    expect(planApprovalNoteAr({ ...base, planComplete: false })).toContain("الخطة غير مكتملة");
    expect(planApprovalNoteAr({ ...base, locked: true })).toContain("بعد انتهاء الطلب الجاري");
  });
});

describe("the panel shows the plan to act on after a failed request", () => {
  const latest = { quoteId: "q_retry", status: "quoted", expiresAt: future() };
  const failedJob = { jobId: getJobIdForQuote("q_first"), status: "failed" };
  const base = { restPlanQuoteId: null as string | null, jobIdForQuote: getJobIdForQuote };

  it("a retry plan beside the open failed request takes the panel (it was locked behind the results)", () => {
    expect(shouldShowPlanPanel({ ...base, latestQuote: latest, activeJob: failedJob })).toBe(true);
  });

  it("also beside a completed or cancelled request", () => {
    for (const status of ["done", "completed", "cancelled"]) expect(shouldShowPlanPanel({ ...base, latestQuote: latest, activeJob: { jobId: failedJob.jobId, status } })).toBe(true);
  });

  it("never while a request is running, and never replacing the results of the job the plan itself started", () => {
    for (const status of ["running", "queued"]) expect(shouldShowPlanPanel({ ...base, latestQuote: latest, activeJob: { jobId: failedJob.jobId, status } })).toBe(false);
    expect(shouldShowPlanPanel({ ...base, latestQuote: latest, activeJob: { jobId: getJobIdForQuote("q_retry"), status: "done" } })).toBe(false);
  });

  it("an expired or superseded plan does not take the panel away from the results", () => {
    expect(shouldShowPlanPanel({ ...base, latestQuote: { ...latest, status: "expired" }, activeJob: failedJob })).toBe(false);
    expect(shouldShowPlanPanel({ ...base, latestQuote: { ...latest, expiresAt: new Date(Date.now() - 1000).toISOString() }, activeJob: failedJob })).toBe(false);
  });

  it("no job open: the plan; no plan: never; the rest-of-request plan keeps working", () => {
    expect(shouldShowPlanPanel({ ...base, latestQuote: latest, activeJob: null })).toBe(true);
    expect(shouldShowPlanPanel({ ...base, latestQuote: null, activeJob: failedJob })).toBe(false);
    expect(shouldShowPlanPanel({ ...base, restPlanQuoteId: "q_retry", latestQuote: latest, activeJob: { jobId: failedJob.jobId, status: "running" } })).toBe(true);
  });

  it("the chat page uses it for the panel", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("const panelShowsPlan = shouldShowPlanPanel({");
  });
});

describe("a volume cut names its reason and the points held", () => {
  it("capacity: what was asked, what fits now, the points held back, one sentence", () => {
    expect(volumeLimitStatementAr({ askedUnits: 30, fittedUnits: 28, reason: "capacity", reservedPoints: 194 }))
      .toBe("طلبت ٣٠ سجل، والذي تتسع له سعة الاستخراج المتاحة الآن ٢٨ سجل، وسيُحجز للخطة حتى ١٩٤ نقطة ولا يُخصم منها إلا ما يُسلَّم.");
    expect(volumeLimitStatementAr({ askedUnits: 30, fittedUnits: 28, reason: "capacity", unitLabelAr: "تعليق" })).toBe("طلبت ٣٠ تعليق، والذي تتسع له سعة الاستخراج المتاحة الآن ٢٨ تعليق.");
    expect(volumeLimitStatementAr({ askedUnits: 30, fittedUnits: 30, reason: "capacity", reservedPoints: 207 })).toBeNull();
  });

  it("no provider words, USD or technical names in it", () => {
    const text = volumeLimitStatementAr({ askedUnits: 30, fittedUnits: 28, reason: "capacity", reservedPoints: 194 })!;
    expect(text).not.toMatch(/[A-Za-z$]|USD|دولار/);
  });

  it("the points cap keeps its own sentence unchanged", () => {
    expect(volumeLimitStatementAr({ askedUnits: 2000, fittedUnits: 57 })).toBe("طلبت ٢٠٠٠ سجل، والذي يناسب الطلب الواحد الآن ٥٧ سجل. يتحدد الحد بسبب سقف المهمة الحالي.");
  });
});

describe("tapping a request on «طلباتي» only opens it", () => {
  it("the link carries a retry only when it is asked for", () => {
    expect(openJobHref({ jobId: "job_1", conversationId: "c1" })).toBe("/dashboard/chat?jobId=job_1&c=c1");
    expect(openJobHref({ jobId: "job_1", conversationId: "c1", retry: false })).not.toContain("retry");
    expect(openJobHref({ jobId: "job_1", conversationId: "c1", retry: true })).toBe("/dashboard/chat?jobId=job_1&c=c1&retry=1");
    expect(openJobHref({ jobId: "job_1" })).toBe("/dashboard/chat?jobId=job_1");
  });

  it("the title of a request opens without a retry; only the «إعادة المحاولة» button asks for one", () => {
    const page = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    const marker = page.indexOf('data-testid="request-title"');
    const title = page.slice(page.lastIndexOf("<button", marker), page.indexOf("</button>", marker));
    expect(title).toContain("onClick={() => openFile(j)}");
    expect(title).not.toContain('k === "refunded"');
    expect(title).not.toContain("openFile(j, ");
    const retryButtons = page.match(/openFile\(j, k === "refunded"\)/g) ?? [];
    expect(retryButtons).toHaveLength(1);
    expect(page).toContain("إعادة المحاولة");
    // (the old line named quotes[job.$id]?.conversationId inline: the conversation is now resolved first, by the list or by the server, and only then passed; `retry` is still passed only from the explicit button)
    expect(page).toContain("openJobHref({ jobId: job.$id, conversationId, retry })");
    expect(page).toContain("quotes[job.$id]?.conversationId");
  });

  it("the chat page sends the retry message only for an explicit link, and removes the parameter so a reload cannot repeat it", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain('const retry = search.get("retry") === "1";');
    expect(page).toContain('url.searchParams.delete("retry")');
    expect(page.indexOf('url.searchParams.delete("retry")')).toBeLessThan(page.indexOf("sendRef.current(RETRY_SAME_PLAN_MESSAGE)"));
  });
});
