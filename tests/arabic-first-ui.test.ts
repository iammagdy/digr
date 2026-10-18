import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Arabic-first customer experience", () => {
  it("keeps browser translation from replacing the Arabic RTL interface", () => {
    const layout = readFileSync("src/app/layout.tsx", "utf8");

    expect(layout).toContain('<html lang="ar" dir="rtl" translate="no"');
    expect(layout).toContain("notranslate");
    expect(layout).toContain('<meta name="google" content="notranslate" />');
  });

  it("keeps Diger AI replies in Arabic when the user greets in English", () => {
    const prompt = readFileSync("src/functions/shared/systemPrompt.ts", "utf8");

    expect(prompt).toContain("Always answer in Arabic, even when the customer's message is in English");
    expect(prompt).toContain("unless the customer explicitly asks for an English response");
  });
});
