import { AGENT_CAPABILITY_SLUG } from "../src/lib/agentMission/constants";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { applyCustomerCap, reserveForUnits, volumeForPointsCap } from "../src/lib/pointsCap";
import { capQuestionFor, nextStep, understandMission } from "../src/lib/consultantCopy";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";

describe("the customer's own budget cap (points)", () => {
  it("is the most records whose reserve (with the 15% buffer) fits under it", () => {
    expect(volumeForPointsCap(590, 9)).toBe(57);
    expect(reserveForUnits(57, 9)).toBe(590);
    expect(volumeForPointsCap(100, 6)).toBe(14);
    expect(volumeForPointsCap(5, 6)).toBe(0); // not even one record
    expect(volumeForPointsCap(0, 6)).toBe(0);
    expect(volumeForPointsCap(100, 0)).toBe(0);
    expect(volumeForPointsCap(Number.NaN, 6)).toBe(0);
  });

  it("the reserve never passes the cap, for any cap and unit price", () => {
    for (const unit of [1, 2, 3, 5, 6, 9, 11, 83]) {
      for (let cap = 1; cap <= 700; cap += 7) {
        const units = volumeForPointsCap(cap, unit);
        expect(reserveForUnits(units, unit)).toBeLessThanOrEqual(cap);
        // and one more record would pass it (the largest volume that fits)
        expect(reserveForUnits(units + 1, unit)).toBeGreaterThan(cap);
      }
    }
  });

  it("only lowers a plan, never raises it", () => {
    expect(applyCustomerCap({ capPoints: 590, unitPricePoints: 9, currentVolume: 30 })).toEqual({ ok: true, volume: 30, reservePoints: reserveForUnits(30, 9) });
    expect(applyCustomerCap({ capPoints: 590, unitPricePoints: 9, currentVolume: 500 })).toEqual({ ok: true, volume: 57, reservePoints: 590 });
    expect(applyCustomerCap({ capPoints: 100000, unitPricePoints: 9, currentVolume: 57 })).toMatchObject({ ok: true, volume: 57 });
  });

  it("refuses a cap that cannot hold one record, in plain Arabic with the lowest possible cap", () => {
    const result = applyCustomerCap({ capPoints: 5, unitPricePoints: 9, currentVolume: 50 });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reasonAr).toContain("لا يكفي لسجل واحد");
      expect(result.reasonAr).toContain("١١ نقطة"); // ceil(9 x 1.15)
      expect(result.reasonAr).not.toMatch(/[A-Za-z0-9]/);
    }
  });
});

describe("«all …» always carries a cap", () => {
  const URL_ALL = "عايز كل التعليقات على https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  it("all comments of a link, with no number: ONE question for the cap (comments)", () => {
    const u = understandMission(URL_ALL);
    expect(u.missing).toEqual(["cap"]);
    expect(nextStep(u)).toMatchObject({ type: "ask_one", id: "volume_cap_required", textAr: "ما الحد الأقصى لعدد التعليقات الذي تريده؟", options: ["٥٠٠ تعليق", "١٠٠٠ تعليق", "٢٠٠٠ تعليق", "٥٠٠٠ تعليق"] });
    expect(capQuestionFor(u)?.id).toBe("volume_cap_required");
  });

  it("all posts about a subject, with no number: ONE question for the cap (records)", () => {
    const u = understandMission("عايز كل المنشورات عن القهوة على إكس آخر شهر");
    expect(u.missing).toEqual(["cap"]);
    expect(nextStep(u)).toMatchObject({ id: "volume_cap_required", textAr: "ما الحد الأقصى لعدد السجلات الذي تريده؟" });
  });

  it("with a number, or without «all», there is no cap question", () => {
    expect(understandMission("عايز كل التعليقات على https://www.youtube.com/watch?v=dQw4w9WgXcQ حتى ٥٠٠ تعليق").missing).toEqual([]);
    expect(understandMission("عايز ١٠٠ تعليق على https://www.youtube.com/watch?v=dQw4w9WgXcQ").missing).toEqual([]);
  });
});

describe("the cap on the plan", () => {
  const quote: PlanQuoteData = {
    quoteId: "q_cap", summaryAr: "تغريدات عن القهوة",
    items: [{ capabilitySlug: "social-x-posts", params: { query: "القهوة" }, targetVolumeMin: 1, targetVolumeMax: 57 }],
    targetVolumeMax: 57, unitPricePoints: 9, expectedPoints: 513, quotedPoints: 590, isAffordable: true, userBalance: 5000,
    outputFormats: ["xlsx"], expiresAt: new Date(Date.now() + 3600_000).toISOString(), status: "quoted",
  };
  const render = (locked = false) => renderToStaticMarkup(createElement(PlanQuoteCard, { quote, locked, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {} } as any));

  it("states the plan's hold (its cap), from the quote's own reserve, and that only what is delivered is charged; there is no editor for a retired quote", () => {
    const html = render();
    expect(html).toContain('data-testid="plan-price-vs-hold"');
    expect(html).toContain("والحجز المؤقت ٥٩٠ نقطة هو هذا السعر مع احتياطي ١٥٪ على الحجز وحده");
    expect(html).toContain("ويُخصم منه فقط ما يُسلَّم فعلًا");
    expect(html).not.toContain('data-testid="plan-edit-hint"');
    expect(html).toContain("العرض ده قديم ومبقاش متاح");
  });

  it("an approved plan states its hold and offers no change", () => {
    const html = render(true);
    expect(html).toContain("والحجز المؤقت ٥٩٠ نقطة هو هذا السعر");
    expect(html).not.toContain("تقدر تخفض");
    expect(html).not.toContain('data-testid="plan-edit-hint"');
  });

});
