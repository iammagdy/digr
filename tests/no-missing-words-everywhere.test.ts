import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { customerFacingAssistantCopy } from "../src/lib/customerFacingAssistantCopy";
import { containsMissingToken, scrubQuoteTexts, stripMissingValueWords } from "../src/lib/quoteScopeGaps";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";
import { createChatDb } from "./helpers/chatSession";

/**
 * No customer-facing string prints undefined, null or NaN: not in a new message, not in a new card, and not in a message or card
 * that was stored before the guard existed (the stored rows are never rewritten; the text is cleaned where it is drawn).
 */
describe("old stored texts read cleanly when they are drawn", () => {
  it("an old message saying «في undefined» is shown without it, and line breaks are kept", () => {
    expect(customerFacingAssistantCopy("استخراج بيانات ٢ سجل من شركات الكهرباء في undefined")).toBe("استخراج بيانات ٢ سجل من شركات الكهرباء");
    expect(customerFacingAssistantCopy("الدولة: null\nالعدد: ٢")).not.toMatch(/null/);
    expect(customerFacingAssistantCopy("سطر أول\n\nسطر ثانٍ")).toBe("سطر أول\n\nسطر ثانٍ");
  });

  it("an old priced card has its summary and methodology cleaned; real text and other fields are untouched", () => {
    const stored = {
      quoteId: "Q", quotedPoints: 6,
      summaryAr: "استخراج بيانات ٢ سجل من شركات الكهرباء في undefined",
      methodologyNotes: "جمع وتوثيق البيانات (الكهرباء في null) وفق المعايير",
      items: [{ capabilitySlug: "x", params: {} }],
    };
    const shown = scrubQuoteTexts(stored);
    expect(containsMissingToken(shown.summaryAr)).toBe(false);
    expect(shown.summaryAr).toBe("استخراج بيانات ٢ سجل من شركات الكهرباء");
    expect(containsMissingToken(shown.methodologyNotes)).toBe(false);
    expect(shown.quotedPoints).toBe(6);
    expect(shown.items).toBe(stored.items);
    expect(stored.summaryAr).toContain("undefined"); // the stored object itself is not changed
    expect(scrubQuoteTexts({ summaryAr: "خطة سليمة" })).toEqual({ summaryAr: "خطة سليمة" });
  });

  it("text without a missing word comes back exactly as it was", () => {
    const text = "السطر الأول\n\n- نقطة   بها مسافات\n- أخرى";
    expect(stripMissingValueWords(text)).toBe(text);
  });
});

describe("the page draws every stored text through the guard", () => {
  it("assistant messages go through customerFacingAssistantCopy and the plan card scrubs its quote", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("customerFacingAssistantCopy(m.content)");
    const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
    expect(card).toContain("const quote = useMemo(() => scrubQuoteTexts(storedQuote), [storedQuote]);");
    const manager = readFileSync("src/functions/shared/planManager.ts", "utf8");
    expect(manager.match(/summaryAr: stripMissingValueWords\(plan\.summaryAr\)/g)).toHaveLength(2);
  });
});

describe("a new plan card from a summary with a missing value never carries it", () => {
  it("the created quote and its stored row have a clean summary", async () => {
    const { createAndSaveManagedQuote } = await import("../src/functions/shared/planManager");
    const db = createChatDb();
    const quote: any = await createAndSaveManagedQuote(db as any, {
      conversationId: "c_nm",
      userId: "u_nm",
      plan: {
        summaryAr: "استخراج بيانات ٢ سجل من شركات الكهرباء في undefined",
        items: [{ capabilitySlug: "icypeas-companies-search", params: { country: "Egypt", query: { location: { include: ["Egypt"] }, industry: { include: ["Utilities"] } } }, targetVolumeMax: 2 }],
      } as any,
      userBalance: 5000,
      capabilities: APPROVED_CAPABILITY_CATALOG as any,
    });
    expect(quote.summaryAr).toBe("استخراج بيانات ٢ سجل من شركات الكهرباء");
    for (const row of (db.store.get("plans_quotes") || []) as any[]) expect(containsMissingToken(row.summaryAr ?? row.summary_ar ?? ""), JSON.stringify(row).slice(0, 120)).toBe(false);
    expect(((db.store.get("plans_quotes") || []) as any[]).length).toBeGreaterThan(0);
  });
});
