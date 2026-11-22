import { describe, expect, it } from "vitest";
import { fakeChatModel } from "./helpers/fakeChatModel";
import { decideTurn, type TurnContext } from "../src/lib/agentMission/conversationModel";
import { classifyMessage } from "../src/lib/agentMission/messageType";

const ctx = (message: string, open = null): TurnContext => ({
  message,
  open,
  balancePoints: 1000,
});

/**
 * N16 (D-0086): Keyword overrules and hardcoded platform lists are removed.
 * The LLM + catalog metadata decide message type and brief.
 * Keywords remain strictly as fallback when the model call fails.
 */
describe("N16 (D-0086): LLM authority over message classification", () => {
  it("model decision is authoritative and never overruled by keywords", async () => {
    // When text has strong collection words, model's decision still governs
    const requestText = "هات ٥٠ تعليق من فيسبوك عن الغلاء";

    for (const chosen of ["service_question", "greeting_or_small_talk", "other", "methodology_request"] as const) {
      const model = fakeChatModel([], { override: () => ({ type: chosen, reply: "إجابة الموديل" }) });
      const d = await decideTurn(ctx(requestText), model.call);
      expect(d.type, `model chose ${chosen}`).toBe(chosen);
      expect(d.source).toBe("model");
    }
  });

  it("data requests with arbitrary / non-standard platforms route to data_request without regex platform lists", async () => {
    // Under D-0086, no PLATFORM_NAME_RE exists. Model classifies arbitrary platforms.
    const nonStandardRequests = [
      "عايز بيانات المنتجات والأسعار من موقع 1688",
      "هات ريبوزيتوريز وبايثون كود من جيت هب عن الذكاء الاصطناعي",
      "اجمع مراجعات المنتجات من أمازون مصر",
      "محتاج بيانات المناقصات من بوابة المشتريات الحكومية",
    ];

    for (const text of nonStandardRequests) {
      const model = fakeChatModel([], {
        override: () => ({
          type: "data_request",
          brief: {
            request: text,
            topic: text,
            objectives: [{ id: "o1", capability: "web.search", params: { request: text } }],
          },
        }),
      });
      const d = await decideTurn(ctx(text), model.call);
      expect(d.type).toBe("data_request");
      expect(d.source).toBe("model");
    }
  });

  it("keyword fallback operates when model call fails", async () => {
    const failingModel = fakeChatModel([], { override: () => "fail" });
    const d = await decideTurn(ctx("هات ٥٠ تعليق عن الغلاء"), failingModel.call);
    expect(d.source).toBe("keyword");
    expect(d.type).toBe("data_request");
  });

  it("counter-case: service questions regarding pricing or account are not planned", async () => {
    const questions = [
      "بكام الاشتراك الشهري؟",
      "ازاي أشحن رصيد النقط بتاعي؟",
      "هل بتقدموا خدمات تحليل بيانات إحصائية؟",
    ];

    for (const q of questions) {
      const model = fakeChatModel([], {
        override: () => ({ type: "service_question", reply: "توضيح الخدمة والأسعار" }),
      });
      const d = await decideTurn(ctx(q), model.call);
      expect(d.type).toBe("service_question");
      expect(d.source).toBe("model");
    }
  });

  it("classifyMessage fallback classifies strong nouns without platform list", () => {
    // classifyMessage no longer requires PLATFORM_NAME_RE to match data requests
    expect(classifyMessage("هات ٥٠ تعليق عن الأسعار")).toBe("data_request");
    expect(classifyMessage("اجمع بيانات الشركات وإيميلاتها")).toBe("data_request");
  });
});
