import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildResultFollowupReply, type PriorConversationMessage } from "../src/functions/shared/resultFollowup";
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

  it("answers other result feedback without re-entering plan generation", () => {
    const reply = buildResultFollowupReply("البيانات دي غلط، ليه؟", [
      { role: "assistant", content: firstPlan, quote },
    ], { platforms: ["companies"] });
    expect(reply).toBe("وصلت ملاحظتك على النتيجة. ما الحقل أو السجل الذي تريد مراجعته؟");
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
    const postApproval = startHandler.indexOf("content: POST_APPROVAL_MESSAGE_AR");
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
