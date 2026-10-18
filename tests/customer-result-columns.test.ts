import { describe, expect, it } from "vitest";
import { customerResultColumnLabel } from "../src/lib/customerResultColumns";

describe("customer-facing result column labels", () => {
  it("localizes source-native fields seen in X, TikTok, and company results", () => {
    for (const [key, label] of [
      ["author_name", "اسم الناشر"],
      ["authorFollowers", "عدد المتابعين"],
      ["createdUtc", "تاريخ النشر"],
      ["likeCount", "عدد الإعجابات"],
      ["video_caption", "وصف الفيديو"],
      ["work_email_presence_status", "توفر البريد المهني"],
      ["job_title_presence_status", "توفر المسمى الوظيفي"],
    ]) {
      expect(customerResultColumnLabel(key)).toBe(label);
    }
  });
});
