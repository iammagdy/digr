import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { createChatDb } from "./helpers/chatSession";
import { planScopeRows } from "../src/lib/quoteScopeGaps";
import { X_ACCOUNT_FILTER_STEP_AR, xAccountOfItem, xAccountReadStepAr } from "../src/lib/planMethodSteps";
import { rowDateMs, filterRowsByDateRange } from "../src/lib/server/dateRangeFilter";
import { rejectionReasonCode } from "../src/lib/server/rejectedRowSample";
import { ACCOUNT_OTHER_AUTHOR_REASON_AR, ACCOUNT_REPLY_REASON_AR, ACCOUNT_REPOST_REASON_AR } from "../src/lib/server/researchRelevanceGate";

/**
 * The plan card of an X ACCOUNT plan (the live request «هات ١٠ بوستات من حساب @elonmusk على أكس»): the quote is the one the real chat path builds, the card is the real component.
 * FAKE database and FAKE model (it throws if asked).
 */
beforeEach(() => { vi.stubEnv("JOB_MAX_POINTS_CAP", ""); resetProviderBalanceCacheForTesting(); setProviderBalanceForTesting(50); });
afterEach(() => { vi.unstubAllEnvs(); resetProviderBalanceCacheForTesting(); });

let seq = 0;
async function planOf(message: string): Promise<PlanQuoteData> {
  const db: any = createChatDb();
  const handler = new ChatHandler(db);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); });
  const conversationId = `conv_card_${++seq}`;
  await db.createRow({ tableId: "conversations", rowId: conversationId, data: { userId: "user_card", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  clearBriefCacheForTesting();
  const reply: any = await handler.handleUserMessage({ userId: "user_card", conversationId, message, userBalance: 40_000 });
  return reply.planQuote as PlanQuoteData;
}
const render = (q: PlanQuoteData, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(PlanQuoteCard, { ...props, quote: q, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {}, conversationTitle: "سحب أحدث المنشورات للحساب المحدد على منصة إكس،…" } as any));
const stepsOf = (html: string) => html.slice(html.indexOf("خطوات التنفيذ المنهجية"), html.indexOf("صيغ التسليم المعتمدة"));
const inputValues = (html: string) => [...html.matchAll(/<input[^>]*value="([^"]*)"/g)].map((m) => m[1]);

describe("the card of an X account plan reads the account, never a topic", () => {
  it("the real plan of «هات ١٠ بوستات من حساب @elonmusk على أكس»: steps say «قراءة أحدث منشورات الحساب @elonmusk», and none of the topic sentences appear", async () => {
    const quote = await planOf("هات ١٠ بوستات من حساب @elonmusk على أكس");
    expect(xAccountOfItem(quote.items?.[0] as any)).toBe("@elonmusk");
    const html = render(quote);
    const steps = stepsOf(html);
    expect(steps).toContain("قراءة أحدث منشورات الحساب @elonmusk");
    expect(steps).toContain(xAccountReadStepAr("@elonmusk").replace("@elonmusk", "@elonmusk"));
    expect(steps).toContain(X_ACCOUNT_FILTER_STEP_AR);
    for (const topicPhrase of ["البحث عن", "حول «", "فرز النتائج حسب صلتها", "حسب الصلة", "الموضوع المطلوب", "موضوع المحتوى", "على المنصة المحددة"]) {
      expect(html, topicPhrase).not.toContain(topicPhrase);
    }
    // the editor (opened) asks for the account, with the account in the field
    const editing = render(quote, { initiallyEditing: true });
    expect(editing).toContain("اسم الحساب");
    expect(editing).not.toContain("موضوع المحتوى / الاستعلام");
    expect(inputValues(editing)).toContain("@elonmusk");
  });

  it("the scope row of the plan is «الحساب: @elonmusk», not a topic", async () => {
    const quote = await planOf("هات ١٠ بوستات من حساب @elonmusk على أكس");
    const chips = planScopeRows(quote.items as any, "سحب أحدث المنشورات للحساب المحدد على منصة إكس،…");
    expect(chips[0]).toEqual({ label: "الحساب:", value: "@elonmusk" });
    expect(chips.map((chip) => chip.label)).not.toContain("موضوع المحتوى:");
  });

  it("a topic search on X keeps its own card (the topic sentences, the topic label), and a Facebook page keeps its page sentences", async () => {
    const quote = await planOf("عايز ٤٠٠ منشور عن الذكاء الاصطناعي على منصة إكس آخر شهر");
    expect(xAccountOfItem(quote.items?.[0] as any)).toBeNull();
    const html = render(quote);
    expect(stepsOf(html)).toContain("حول «الذكاء الاصطناعي»");
    expect(stepsOf(html)).toContain("فرز النتائج حسب صلتها بموضوع");
    expect(planScopeRows(quote.items as any, "x").map((chip) => chip.label)).toContain("موضوع المحتوى:");
    expect(xAccountOfItem({ capabilitySlug: "social-facebook-posts", params: { channel: "youm7" } })).toBeNull();
    expect(xAccountOfItem({ capabilitySlug: "social-x-posts", params: { channel: "@a", query: "كلمة" } })).toBeNull();
  });
});

describe("a Unix timestamp the source sends as TEXT is read as seconds (createdUtc: «1792308962»)", () => {
  it("rowDateMs: text seconds, text milliseconds and numbers agree; dates and short digit strings are read as before", () => {
    expect(rowDateMs({ createdUtc: "1792308962" })).toBe(1792308962000);
    expect(rowDateMs({ createdUtc: 1792308962 })).toBe(1792308962000);
    expect(rowDateMs({ createdUtc: "1792308962000" })).toBe(1792308962000);
    expect(rowDateMs({ createdUtc: " 1792308962 " })).toBe(1792308962000);
    expect(rowDateMs({ published_at: "2026-10-18T07:36:02Z" })).toBe(Date.parse("2026-10-18T07:36:02Z"));
    expect(rowDateMs({ date: "2026" })).toBe(Date.parse("2026"));
    expect(rowDateMs({ date: "20261018" })).toBeNull(); // eight digits are not a timestamp
    expect(rowDateMs({ createdUtc: "abc" })).toBeNull();
  });

  it("the window filter keeps a text-seconds row inside the window and drops the one outside it; before the fix every such row was «without a date»", () => {
    const rows = [{ id: "in", createdUtc: "1792308962" }, { id: "out", createdUtc: "1792000000" }];
    const kept = filterRowsByDateRange(rows, "2026-10-18", "2026-10-18");
    expect(kept.rows.map((row) => row.id)).toEqual(["in"]);
    expect(kept.excludedCount).toBe(1);
  });
});

describe("the account gate's reasons have their own codes (counted by cause, never «other»)", () => {
  it("reply, repost and another account's post", () => {
    expect(rejectionReasonCode(ACCOUNT_REPLY_REASON_AR)).toBe("reply");
    expect(rejectionReasonCode(ACCOUNT_REPOST_REASON_AR)).toBe("repost");
    expect(rejectionReasonCode(ACCOUNT_OTHER_AUTHOR_REASON_AR)).toBe("other_account");
    expect(rejectionReasonCode("سبب غير معروف")).toBe("other_mismatch");
  });
});
