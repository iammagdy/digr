import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildResultFollowupReply, type PriorConversationMessage } from "../src/functions/shared/resultFollowup";
import { toSafeReasonCode, reasonCodeToCustomerMessage } from "../src/functions/shared/chatErrors";
import { resultFileManifest } from "../src/lib/server/resultFileManifest";

const firstPlan = "أعددت لك خطة الاستخراج وعرض السعر بالنقاط:\n- الهدف: استخراج بيانات ٣ شركات كهرباء في مصر\n- الحد الأقصى: حتى ٣ سجل\n- التكلفة المتوقعة: ٩ نقطة";
const quote = {
  quoteId: "quote_company_3",
  planHash: "hash_company_3",
  targetVolumeMax: 3,
  outputFormats: ["xlsx"],
  items: [{ capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", targetVolumeMax: 3 }],
};

describe("company result follow-up conversation", () => {
  it("answers the exact repeated email complaint conversationally without posting the same plan again", () => {
    const transcript: PriorConversationMessage[] = [
      { role: "user", content: "عايز ٣ شركات كهرباء في مصر", requestStatus: "accepted" },
      { role: "assistant", content: firstPlan, quote },
      { role: "assistant", content: "جاري سحب البيانات، سيصلك إشعار عند الاكتمال ويمكنك إغلاق الصفحة." },
      { role: "assistant", content: "تم إكمال استخراج ٣ شركات وحفظ ملف النتيجة." },
      { role: "user", content: "الايميلات مش موجوده" },
      { role: "assistant", content: firstPlan, quote },
    ];

    const reply = buildResultFollowupReply("الايميلات مش متاحه بردو يا عم", transcript, {
      platforms: ["companies"],
      targetVolume: 3,
    });

    expect(reply).toBeTruthy();
    expect(reply).toContain("بحث الشركات يعرض بيانات الشركة، ولا يشمل بريد الأشخاص");
    expect(reply).toContain("السجل الأساسي ٨٣ نقطة");
    expect(reply).toContain("٥٥ للبريد المهني");
    expect(reply).toContain("٥٥ للهاتف المكتبي");
    expect(reply).toContain("السعر المتوقع ٥٧٩ نقطة");
    expect(reply).toContain("الحجز المتوقع ٦٠٠ نقطة");
    expect(reply).toContain("هل تريد أن أجهز الخطة؟");
    expect(reply).not.toContain(firstPlan);
    expect(reply).not.toMatch(/[A-Za-z]|\p{Extended_Pictographic}/u);

    const chatHandler = readFileSync("src/functions/shared/chatHandler.ts", "utf8");
    const feedbackRoute = chatHandler.slice(
      chatHandler.indexOf("const resultFeedbackReply = buildResultFollowupReply"),
      chatHandler.indexOf("const requiredDiscoveryQuestion = getDeterministicDiscoveryQuestion"),
    );
    expect(feedbackRoute).toContain('outputType: "answer_question"');
    expect(feedbackRoute).not.toContain("planQuote:");
    expect(chatHandler.indexOf("const resultFeedbackReply = buildResultFollowupReply")).toBeLessThan(
      chatHandler.indexOf("this.llm.executeTurn"),
    );
  });

  it("does not treat a new conversation as result feedback", () => {
    expect(buildResultFollowupReply("الايميلات مش موجوده", [], { platforms: ["companies"] })).toBeNull();
  });

  it.each([
    ["pending plan", "quoted", []],
    ["completed job", "accepted", [{ role: "assistant", content: "تم إكمال البحث وحفظ الملف." }]],
    ["failed job", "quoted", [{ role: "assistant", content: "تعذر إكمال البحث، وأُعيدت النقاط المحجوزة." }]],
  ] as const)("answers both email follow-ups after a %s without returning a plan card", (_state, requestStatus, extraMessages) => {
    const transcript: PriorConversationMessage[] = [
      {
        role: "user",
        content: "عايز ٣ شركات كهرباء في مصر",
        requestStatus,
        requestQuoteId: "quote_pending_company_3",
      },
      { role: "assistant", content: firstPlan, quote },
      ...extraMessages,
    ];

    for (const followup of ["فين الايميلات", "الايميلات مش موجودة"]) {
      const reply = buildResultFollowupReply(followup, transcript, {
        platforms: ["companies"],
        targetVolume: 3,
      });
      expect(reply).toContain("بحث الشركات يعرض بيانات الشركة، ولا يشمل بريد الأشخاص");
      expect(reply).toContain("السعر المتوقع ٥٧٩ نقطة");
      expect(reply).toContain("هل تريد أن أجهز الخطة؟");
      expect(reply).not.toContain(firstPlan);
    }
  });

  it("uses the newest ten messages so a recent pending plan is not hidden by old greetings", () => {
    const chatHandler = readFileSync("src/functions/shared/chatHandler.ts", "utf8");
    // The query now starts in the same wave as the message writes (const historyRead) and is consumed at the history step.
    const history = chatHandler.slice(
      chatHandler.indexOf("const historyRead:"),
      chatHandler.indexOf("const histDelta = Date.now() - tSbHistStart"),
    );
    expect(history.length).toBeGreaterThan(500);

    expect(history).toContain('.order("created_at", { ascending: false })');
    expect(history).toContain("Query.orderDesc(\"createdAt\")");
    expect(history).toContain("].reverse()");
    expect(history).toContain("request_quote_id");
  });

  it("answers other result feedback without re-entering plan generation", () => {
    const reply = buildResultFollowupReply("البيانات دي غلط، ليه؟", [
      { role: "assistant", content: firstPlan, quote },
    ], { platforms: ["companies"] });
    expect(reply).toBe("وصلت ملاحظتك على النتيجة. ما الحقل أو السجل الذي تريد مراجعته؟");
  });

  it("logs only a safe reason code and maps unknown failures to the generic Arabic message", () => {
    const chatHandler = readFileSync("src/functions/shared/chatHandler.ts", "utf8");
    const route = readFileSync("src/app/api/chat/route.ts", "utf8");
    expect(chatHandler).toContain("[chat:handler_failed] step=${currentStep} reason=${safeReason}");
    expect(route).toContain("[chat:request_failed] requestId=${requestId} step=${failingStep} reason=${reason}");
    expect(route).toContain("reasonCodeToCustomerMessage(reason, err?.message)");
    expect(toSafeReasonCode(new Error("unexpected internal exception"), "message_history")).toBe("internal_error");
    expect(reasonCodeToCustomerMessage("internal_error")).toBe("حدث خطأ أثناء معالجة المحادثة. يرجى المحاولة مرة أخرى.");
  });
});

describe("plan approval copy and selected output formats", () => {
  it("does not append free-form model text to a pre-approval plan response", () => {
    const chatHandler = readFileSync("src/functions/shared/chatHandler.ts", "utf8");
    expect(chatHandler).toContain("finalContentAr = planSummaryText;");
    expect(chatHandler).not.toMatch(/llmResult\.textBlockAr[\s\S]{0,180}planSummaryText/);
  });

  it("keeps the post-approval status in the successful explicit-approval handler", () => {
    const chatPage = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    const startHandler = chatPage.slice(
      chatPage.indexOf("async function handleStartExecution("),
      chatPage.indexOf("// Download File Handler"),
    );
    const acceptedCheck = startHandler.indexOf("if (!res.ok || !data.success)");
    const postApproval = startHandler.indexOf("content: postApprovalMessageAr(data.driverMode)");
    expect(acceptedCheck).toBeGreaterThan(-1);
    expect(postApproval).toBeGreaterThan(acceptedCheck);
    expect(startHandler).toContain("explicitApproval: true");
  });

  it("reports only generated files; a non-selected format remains available through on-demand conversion", () => {
    expect(resultFileManifest({
      xlsx: "user/job/result.xlsx",
      pdf: null,
      csv: null,
    })).toEqual({ xlsx: "user/job/result.xlsx", pdf: null, csv: null });

    const specSource = readFileSync("src/lib/server/jobExecutionSpec.ts", "utf8");
    const downloadSource = readFileSync("src/app/api/jobs/[id]/download/route.ts", "utf8");
    expect(specSource).toContain("let outputFormats: Array<\"xlsx\" | \"pdf\" | \"csv\"> = [\"xlsx\"]");
    expect(downloadSource).toContain("Prefer regenerating deliverable formats from the saved dataset");
  });
});
