import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { readFileSync } from "node:fs";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import {
  lowBalanceMessageAr,
  lowBalanceState,
  shortfallEgp,
  shortfallPoints,
  topupContinuationMessageAr,
} from "../src/lib/lowBalance";
import { makeTables } from "./helpers/memoryTables";

const base = { quotedPoints: 11, expectedPoints: 9, targetVolumeMax: 3 };

describe("7. low balance: the states", () => {
  it("affordable: no message at all", () => {
    expect(lowBalanceState({ ...base, balance: 11 })).toBe("affordable");
    expect(lowBalanceMessageAr({ ...base, balance: 500 })).toBeNull();
  });

  it("can reduce: offers what fits and a top-up that continues in the same conversation, numbers from the quote", () => {
    const input = { ...base, balance: 5, downscaledOffer: { maxAffordableUnits: 1, affordableQuotedPoints: 4 } };
    expect(lowBalanceState(input)).toBe("can_reduce");
    const text = lowBalanceMessageAr(input)!;
    expect(text).toContain("رصيدك الحالي ٥ نقطة");
    expect(text).toContain("تحجز ١١ نقطة");
    expect(text).toContain("التكلفة المتوقعة ٩ نقطة");
    expect(text).toContain("ينقصك ٦ نقطة");
    expect(text).toContain("أقلل العدد إلى ١ سجل مقابل ٤ نقطة");
    expect(text).toContain("اشحن ٥٠ جنيهًا");
    expect(text).toContain("نفس");
    expect(text).toContain("الخطة نفسها");
    expect(text).not.toMatch(/[A-Za-z0-9]|\p{Extended_Pictographic}/u);
  });

  it("top-up only: nothing fits, so only the top-up is offered", () => {
    const input = { ...base, balance: 0 };
    expect(lowBalanceState(input)).toBe("top_up_only");
    const text = lowBalanceMessageAr(input)!;
    expect(text).toContain("ينقصك ١١ نقطة");
    expect(text).toContain("لا يوجد عدد أقل يناسب رصيدك الحالي");
    expect(text).not.toContain("أقلل العدد");
  });

  it("an offer that does not actually fit the balance is not offered", () => {
    expect(lowBalanceState({ ...base, balance: 3, downscaledOffer: { maxAffordableUnits: 1, affordableQuotedPoints: 4 } })).toBe("top_up_only");
  });

  it("the shortfall is computed by code: points, and EGP rounded up to the next 50 (minimum 50)", () => {
    expect(shortfallPoints({ balance: 5, quotedPoints: 11 })).toBe(6);
    expect(shortfallEgp(6)).toBe(50);
    expect(shortfallEgp(600)).toBe(100);
    expect(shortfallEgp(579 + 21)).toBe(100);
    expect(shortfallEgp(1000, 0.1)).toBe(100);
    expect(shortfallEgp(1001, 0.1)).toBe(150);
  });

  it("after the top-up is approved the same plan is announced as approvable; before that, nothing", () => {
    expect(topupContinuationMessageAr({ balance: 5, quotedPoints: 11 })).toBeNull();
    const text = topupContinuationMessageAr({ balance: 61, quotedPoints: 11 })!;
    expect(text).toContain("تم اعتماد الشحن");
    expect(text).toContain("رصيدك الآن ٦١ نقطة");
    expect(text).toContain("الخطة نفسها");
    expect(text).toContain("اضغط موافقة");
  });

  it("the chat page announces it once per plan, only when the plan was short and no job is running", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("announcedTopupFor");
    expect(page).toContain("lastPlan.isAffordable");
    expect(page).toContain("topupContinuationMessageAr");
    expect(page).toContain("if (balanceValue === null || activeJob) return;");
  });
});

describe("7. low balance inside the real chat handler (offline)", () => {
  beforeEach(() => clearBriefCacheForTesting());
  afterEach(() => clearBriefCacheForTesting());

  const ask = (userBalance: number, personaProfile: any = { name: "سلمى" }) =>
    new ChatHandler(makeTables() as any).handleUserMessage({
      userId: `user_${Math.random().toString(36).slice(2)}`,
      message: "عايز ٣ شركات كهرباء في مصر",
      userBalance,
      personaProfile,
    }) as Promise<any>;

  it("enough balance: a plain plan, no low-balance text", async () => {
    const res = await ask(700);
    expect(res.outputType).toBe("propose_plan");
    expect(res.planQuote.isAffordable).toBe(true);
    expect(res.contentAr).not.toContain("تنبيه الرصيد");
  });

  it("some balance: the plan message offers to reduce or top up, written by code from the quote", async () => {
    const res = await ask(5);
    expect(res.planQuote.isAffordable).toBe(false);
    expect(res.contentAr).toContain("تنبيه الرصيد");
    expect(res.contentAr).toContain("رصيدك الحالي ٥ نقطة");
    expect(res.contentAr).toContain(`تحجز ${String(res.planQuote.quotedPoints).replace(/\d/g, (d: string) => "٠١٢٣٤٥٦٧٨٩"[Number(d)])} نقطة`);
    expect(res.contentAr).toContain("أقلل العدد إلى");
    expect(res.contentAr).toContain("الخطة نفسها");
    expect(res.contentAr).not.toMatch(/[A-Za-z]|\p{Extended_Pictographic}/u);
  });

  it("zero balance: only the top-up is offered and the same plan card is returned for approval later", async () => {
    const res = await ask(0);
    expect(res.planQuote).toBeDefined();
    expect(res.contentAr).toContain("لا يوجد عدد أقل يناسب رصيدك الحالي");
    expect(res.contentAr).not.toContain("أقلل العدد إلى");
  });

  it("the price and the quote are the same for every account type and balance", async () => {
    const [poor, rich, researcher, business, withPromoHistory] = await Promise.all([
      ask(0),
      ask(100000),
      ask(700, { name: "سلمى", persona: "researcher" }),
      ask(700, { name: "سلمى", persona: "business" }),
      ask(700, { name: "سلمى", persona: "researcher", accountKind: "promo" }),
    ]);
    const fingerprint = (r: any) => ({
      quoted: r.planQuote.quotedPoints,
      expected: r.planQuote.expectedPoints,
      unit: r.planQuote.unitPricePoints,
      volume: r.planQuote.targetVolumeMax,
      formats: r.planQuote.outputFormats,
    });
    const expected = fingerprint(rich);
    for (const other of [poor, researcher, business, withPromoHistory]) expect(fingerprint(other)).toEqual(expected);
    // 3 company records at 3.168 points: 9.504 -> charge 10; reserve ceil(9.504 x 1.15 = 10.93) = 11
    expect(expected.unit).toBe(3.168);
    expect(expected.quoted).toBe(11);
    expect(expected.expected).toBe(10);
  });
});
