import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/functions/shared/catalogClient", () => ({
  searchCatalog: vi.fn(async () => []),
  getCachedCatalogEndpoints: vi.fn(() => []),
}));

import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import {
  estimateFromSample,
  explorationOffer,
  explorationOfferLineAr,
  explorationResultMessageAr,
  isExplorationCandidate,
} from "../src/lib/exploration";
import { JOB_MAX_POINTS_CAP_LARGE, capStatementAr, largeJobCapEnabled, resolveJobPointsCap } from "../src/lib/jobCaps";
import { DEFAULT_JOB_POINTS_CAP, getConfiguredJobPointsCap } from "../src/functions/shared/providerSpend";
import { calculateCapabilityUnitPricePoints, DEFAULT_PRICING_SETTINGS } from "../src/functions/shared/quotes";
import { makeTables } from "./helpers/memoryTables";
import { sampleOffer, sampleTargetPoints } from "../src/lib/sampleFirst";
import { reserveForUnits } from "../src/lib/recordPricing";
import { toArabicDigits } from "../src/lib/arabicDigits";

const socialQuote = (overrides: Record<string, unknown> = {}) => ({
  items: [{ capabilitySlug: "social-tiktok-comments", params: { query: "كرة القدم" } }],
  targetVolumeMax: 500,
  unitPricePoints: 6,
  quotedPoints: 3450,
  ...overrides,
});

describe("8. paid exploration", () => {
  it("is offered when the estimate of the whole request reaches 1,500 points, for a discovered (not single-link) one-item plan", () => {
    expect(isExplorationCandidate(socialQuote())).toBe(true); // 500 x 6 = 3000
    expect(isExplorationCandidate(socialQuote({ targetVolumeMax: 250, quotedPoints: 1725 }))).toBe(true); // 250 x 6 = 1500 exactly
    expect(isExplorationCandidate(socialQuote({ targetVolumeMax: 249, quotedPoints: 1718 }))).toBe(false); // 1494: just under
    expect(isExplorationCandidate(socialQuote({ targetVolumeMax: 50, quotedPoints: 345 }))).toBe(false); // 300: a small job
    // a plan the cap cut down is judged by the whole request, not by what was left of it
    expect(isExplorationCandidate(socialQuote({ targetVolumeMax: 57, quotedPoints: 400, requestedVolumeMax: 2000, pointsCapConstrained: true }))).toBe(true);
    // not only social: a large company job is worth a sample too
    expect(isExplorationCandidate(socialQuote({ unitPricePoints: 3, items: [{ capabilitySlug: "icypeas-companies-search", params: {} }] }))).toBe(true);
    expect(isExplorationCandidate(socialQuote({ items: [{ capabilitySlug: "social-tiktok-comments", params: { url: "https://www.tiktok.com/@x/video/1" } }] }))).toBe(false);
    expect(isExplorationCandidate(socialQuote({ items: [{ capabilitySlug: "social-tiktok-comments" }, { capabilitySlug: "social-tiktok-videos" }] }))).toBe(false);
  });

  it("the sample is about 5% of the estimate, held between 100 and 300 points, priced by the shared formula with the 15% buffer on the reserve only", () => {
    const unit = calculateCapabilityUnitPricePoints(0.001, DEFAULT_PRICING_SETTINGS); // 0.001 USD -> 6 points
    expect(unit).toBe(6);
    // 3000 expected points: 5% is 150 -> 21 records (floor(150 / 6.9)), reserve ceil(21 x 6 x 1.15) = 145, expected 126
    const offer = explorationOffer(socialQuote({ unitPricePoints: unit }));
    expect(offer).toMatchObject({ sampleUnits: 21, samplePoints: 145, sampleExpectedPoints: 126, fullUnits: 500, fullEstimatePoints: 3000 });
    // a very large request is held at 300 points, a request just over 1,500 at 100
    expect(sampleTargetPoints(60000)).toBe(300);
    expect(sampleTargetPoints(1500)).toBe(100);
    expect(sampleTargetPoints(4000)).toBe(200);
    for (const estimate of [1500, 2200, 6000, 20000, 500000]) {
      const o = sampleOffer({ items: [{ capabilitySlug: "social-tiktok-comments", params: { query: "x" } }], targetVolumeMax: Math.ceil(estimate / 6), unitPricePoints: 6 })!;
      expect(o.samplePoints).toBeLessThanOrEqual(sampleTargetPoints(estimate));
      expect(o.samplePoints).toBeGreaterThanOrEqual(1);
      expect(o.sampleUnits).toBeLessThan(Math.ceil(estimate / 6));
      expect(o.fullEstimatePoints).toBeGreaterThanOrEqual(1500);
    }
    // never offered when the sample would not be smaller than the plan
    expect(sampleOffer({ items: [{ capabilitySlug: "social-x-posts", params: { query: "x" } }], targetVolumeMax: 20, unitPricePoints: 400 })).toBeNull(); // one record alone holds 460 points
    const cheapest = explorationOffer(socialQuote({ unitPricePoints: 1, targetVolumeMax: 11, quotedPoints: 13 }));
    expect(cheapest.samplePoints).toBeGreaterThanOrEqual(1);
    expect(explorationOffer({ ...socialQuote(), unitPricePoints: 0.01 } as any).samplePoints).toBe(1);
  });

  it("the offer text is Arabic only, uses only code-computed numbers and promises nothing it cannot", () => {
    const text = explorationOfferLineAr(explorationOffer(socialQuote({ unitPricePoints: 6 })));
    expect(text).toContain("عينة أولًا: ٢١ سجل فقط بحجز ١٤٥ نقطة");
    expect(text).toContain("الطلب الكامل (٥٠٠ سجل) تكلفته المتوقعة حوالي ٣٠٠٠ نقطة");
    expect(text).toContain("لا يُخصم إلا ثمن ما يُسلَّم");
    expect(text).not.toMatch(/[A-Za-z0-9]|\p{Extended_Pictographic}/u);
  });

  it("estimates from the sample only, and says so when the source ran out", () => {
    const commentRows = Array.from({ length: 10 }, (_, i) => ({ comment_text: "x", video_id: `v${i % 2}` }));
    const e = estimateFromSample({ delivered: 10, requested: 10, rows: commentRows, fullUnits: 500, unitPricePoints: 6 });
    expect(e).toMatchObject({ sourceExhausted: false, distinctVideos: 2, commentsPerVideo: 5, videosNeededForFullComments: 100, fullExpectedPoints: 3000, fullReservePoints: 3450 });

    const videoRows = [{ video_id: "a", comments_count: 40 }, { video_id: "b", comments_count: 60 }];
    const v = estimateFromSample({ delivered: 2, requested: 2, rows: videoRows, fullUnits: 100, unitPricePoints: 5 });
    expect(v).toMatchObject({ commentsPerVideo: 50, commentsInFullVideos: 5000, videosNeededForFullComments: null });

    const exhausted = estimateFromSample({ delivered: 4, requested: 10, rows: commentRows.slice(0, 4), fullUnits: 500, unitPricePoints: 6 });
    expect(exhausted.sourceExhausted).toBe(true);
    const text = explorationResultMessageAr(exhausted, 500);
    expect(text).toContain("المتاح فعليًا لهذا الطلب هو ٤");
    expect(text).not.toContain("تقديرات");

    const blind = estimateFromSample({ delivered: 3, requested: 3, rows: [{ x: 1 }, { x: 2 }, { x: 3 }], fullUnits: 100, unitPricePoints: 5 });
    expect(blind.commentsPerVideo).toBeNull();
    expect(blind.commentsInFullVideos).toBeNull();
    const estimateText = explorationResultMessageAr(e, 500);
    expect(estimateText).toContain("حوالي ١٠٠ فيديو");
    expect(estimateText).toContain("تقديرات من العينة وليست وعدًا");
    expect(estimateText).not.toMatch(/[A-Za-z0-9]/);
  });

  describe("in the real chat handler and the chat page", () => {
    beforeEach(() => clearBriefCacheForTesting());
    afterEach(() => clearBriefCacheForTesting());

    it("a large request gets the offer inside the plan message and on the quote, priced like the plan", async () => {
      // a social request can no longer reach the 1,500-point threshold (the most one job holds is 522 points at the per-record prices and the cap of 600);
      // 500 companies are 1,584 points of charge, of which one job holds 164
      const res: any = await new ChatHandler(makeTables() as any).handleUserMessage({
        userId: "u_explore", message: "عايز ٥٠٠ شركة كهرباء في مصر", userBalance: 5000, personaProfile: { name: "سلمى" },
      });
      expect(res.outputType).toBe("propose_plan");
      const offer = res.planQuote.explorationOffer;
      const unit = res.planQuote.unitPricePoints;
      const expected = sampleOffer({ items: res.planQuote.items, targetVolumeMax: res.planQuote.targetVolumeMax, requestedVolumeMax: res.planQuote.requestedVolumeMax, unitPricePoints: unit })!;
      expect(offer.sampleUnits).toBe(expected.sampleUnits);
      // exact: ceil(records x unit price x 1.15)
      expect(unit).toBe(3.168);
      expect(offer.samplePoints).toBe(reserveForUnits(offer.sampleUnits, unit));
      expect(offer.samplePoints).toBeGreaterThanOrEqual(1);
      expect(offer.samplePoints).toBeLessThanOrEqual(300);
      expect(res.contentAr).toContain("عينة أولًا");
      expect(res.contentAr).toContain(`بحجز ${toArabicDigits(offer.samplePoints)} نقطة`);
    });

    it("a company request gets no exploration offer", async () => {
      const res: any = await new ChatHandler(makeTables() as any).handleUserMessage({
        userId: "u_company", message: "عايز ٣ شركات كهرباء في مصر", userBalance: 5000, personaProfile: { name: "سلمى" },
      });
      expect(res.planQuote.explorationOffer).toBeUndefined();
      expect(res.contentAr).not.toContain("عينة أولًا");
    });

    it("the sample is an ordinary quote: the edit route recalculates it with the shared pricing, and only carries the flag", () => {
      const route = readFileSync("src/app/api/chat/edit-plan/route.ts", "utf8");
      expect(route).toContain("createAndSaveManagedQuote(adminClient");
      expect(route).toContain("They change no price.");
      const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
      expect(page).toContain("onExplore={handleExplore}");
      expect(page).toContain("explorationByJob.current.set(data.jobId, quote)");
      expect(page).toContain("fullVolume: offer.fullUnits");
      expect(page).toContain("sampleRestMessageAr(");
      expect(page).toContain('"/api/chat/sample-remainder"');
    });
  });
});

describe("8. the quote above the cap says plainly how many records fit", () => {
  it("states the full need, the cap, what fits and what is held, from the quote's numbers", () => {
    const text = capStatementAr({ requestedUnits: 1000, fittedUnits: 86, unitPricePoints: 6, pointsCap: 600, safetyBuffer: 0.15, quotedPoints: 594 })!;
    expect(text).toContain("طلبك الكامل (١٠٠٠ سجل) يحتاج حجز حوالي ٦٩٠٠ نقطة");
    expect(text).toContain("سقف الطلب الواحد (٦٠٠ نقطة)");
    expect(text).toContain("تشمل الخطة ٨٦ سجل بحجز ٥٩٤ نقطة");
    expect(text).toContain("طلب منفصل");
    expect(text).not.toMatch(/[A-Za-z0-9]/);
  });

  it("says nothing when nothing was reduced", () => {
    expect(capStatementAr({ requestedUnits: 50, fittedUnits: 50, unitPricePoints: 6, pointsCap: 600, safetyBuffer: 0.15, quotedPoints: 345 })).toBeNull();
  });
});

describe("8. JOB_MAX_POINTS_CAP_LARGE: documented, off, behind an explicit confirmation, live cap unchanged", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
    });

  it("the live cap is still 600", () => {
    expect(DEFAULT_JOB_POINTS_CAP).toBe(600);
    expect(JOB_MAX_POINTS_CAP_LARGE).toBe(2000);
    const saved = process.env.JOB_MAX_POINTS_CAP;
    delete process.env.JOB_MAX_POINTS_CAP;
    expect(getConfiguredJobPointsCap()).toBe(600);
    if (saved !== undefined) process.env.JOB_MAX_POINTS_CAP = saved;
  });

  it("the larger cap needs the flag AND the customer's explicit extra confirmation; the flag defaults off", () => {
    expect(largeJobCapEnabled({})).toBe(false);
    expect(largeJobCapEnabled({ LARGE_JOB_CAP_ENABLED: "true" })).toBe(true);
    expect(resolveJobPointsCap(600, { enabled: false, customerConfirmedLarge: false })).toBe(600);
    expect(resolveJobPointsCap(600, { enabled: false, customerConfirmedLarge: true })).toBe(600);
    expect(resolveJobPointsCap(600, { enabled: true, customerConfirmedLarge: false })).toBe(600);
    expect(resolveJobPointsCap(600, { enabled: true, customerConfirmedLarge: true })).toBe(2000);
  });

  it("nothing in the quote builder, the worker or the SQL reads the large cap", () => {
    const readers = walk("src").filter((file) => readFileSync(file, "utf8").includes("JOB_MAX_POINTS_CAP_LARGE"));
    expect(readers.map((f) => f.replaceAll("\\", "/"))).toEqual(["src/lib/jobCaps.ts"]);
    for (const file of readdirSync("supabase/migrations")) {
      expect(readFileSync(path.join("supabase/migrations", file), "utf8")).not.toContain("JOB_MAX_POINTS_CAP_LARGE");
    }
  });
});
