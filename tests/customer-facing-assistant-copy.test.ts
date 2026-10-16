import { describe, expect, it } from "vitest";
import { customerFacingAssistantCopy } from "../src/lib/customerFacingAssistantCopy";

describe("customer-facing assistant copy", () => {
  it("hides stale unrelated-capability suggestions in persisted assistant messages", () => {
    const legacyReply = "هتحقق من الطلب وأرجعلك. أقرب خدمة متاحة: استخراج ملف تيك توك الشخصي.";
    const visible = customerFacingAssistantCopy(legacyReply);

    expect(visible).toBe("لم نتمكن من تحديد نوع الطلب المناسب. راجع تفاصيل طلبك وحاول مجددًا.");
    expect(visible).not.toContain("أقرب خدمة متاحة");
  });

  it("leaves normal assistant copy intact", () => {
    expect(customerFacingAssistantCopy("أبحث عن شركات التقنية المالية في ألمانيا."))
      .toBe("أبحث عن شركات التقنية المالية في ألمانيا.");
  });
});
