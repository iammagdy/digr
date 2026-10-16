import { describe, expect, it } from "vitest";
import { customerFacingConversationTitle } from "../src/lib/customerFacingConversationTitle";

describe("customer facing conversation titles", () => {
  it("does not title a conversation from a greeting", () => {
    expect(customerFacingConversationTitle("السلام عليكم يا مجدي")).toBe("محادثة جديدة");
    expect(customerFacingConversationTitle("Hello!")).toBe("محادثة جديدة");
  });

  it("keeps the first substantive question and localizes known industry names", () => {
    expect(customerFacingConversationTitle("شركات FinTech في ألمانيا")).toBe("شركات التقنية المالية في ألمانيا");
  });
});
