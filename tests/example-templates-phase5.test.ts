import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

describe("Phase 5: Ready-to-Use Example Templates on Landing & Chat", () => {
  it("the start page shows example chips that open forms (UI pass 1), with no invented prices in the UI", () => {
    const empty = readFileSync("src/app/dashboard/chat/components/EmptyChat.tsx", "utf-8");
    const chatSource = readFileSync("src/app/dashboard/chat/page.tsx", "utf-8");
    expect(empty).toContain("TEMPLATE_FORMS.map");
    expect(readFileSync("src/lib/templateForms.ts", "utf-8")).toContain("منشورات حساب");
    expect(chatSource).not.toContain("تقريبيًا");
  });
});
