import { afterEach, describe, expect, it } from "vitest";
import { chargeForUnits } from "../src/lib/recordPricing";
import { LARGE_JOB_PAGE_ALLOWANCE as SCALE_ALLOWANCE, scaleValue, setScaleOverridesForTesting } from "../src/lib/scaleConfig";
import {
  ABSOLUTE_MAX_PAGES, evaluateProviderCallCap, FEED_SMALL_JOB_MAX_PAGES, LARGE_JOB_PAGE_ALLOWANCE, MAX_CONSECUTIVE_EMPTY_PAGES_LARGE, maxPagesForJob,
  SMALL_JOB_MAX_PAGES,
} from "../src/lib/server/providerCallCaps";
import { collectableRows, REVIEW_BUDGET_PAGE_ALLOWANCE, REVIEW_JOB_CEILING_USD, socialReviewCapUsd } from "../src/lib/server/rowReviewAdvisor";
import { estimateSocialChunkCostUsd, getSocialCapability, SOCIAL_MAX_CALLS_PER_CHUNK, SOCIAL_ROWS_PER_CHUNK } from "../src/lib/socialSources";

afterEach(() => setScaleOverridesForTesting(null));

describe("the page cap of a large job: 6 times the pages its target needs, one named constant", () => {
  it("the multiplier is defined once (scaleConfig), is 6, and is the same value everywhere it is read", () => {
    expect(SCALE_ALLOWANCE).toBe(6);
    expect(LARGE_JOB_PAGE_ALLOWANCE).toBe(6);
    expect(scaleValue("largeJobPageAllowance", {})).toBe(6);
  });

  it("an owner setting still wins and is clamped (1 to 10), so the old behaviour is one variable away", () => {
    expect(scaleValue("largeJobPageAllowance", { LONG_JOB_PAGE_ALLOWANCE: "3" })).toBe(3);
    expect(scaleValue("largeJobPageAllowance", { LONG_JOB_PAGE_ALLOWANCE: "100" })).toBe(10);
    expect(scaleValue("largeJobPageAllowance", { LONG_JOB_PAGE_ALLOWANCE: "0" })).toBe(1);
    expect(scaleValue("largeJobPageAllowance", { LONG_JOB_PAGE_ALLOWANCE: "abc" })).toBe(6);
  });

  it("the cap for X posts at 50 rows a chunk: 30 -> 6 pages, 300 -> 36, 1,000 -> 120, 4,000 -> held at the ceiling of 300", () => {
    expect(maxPagesForJob(30, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(6);
    expect(maxPagesForJob(300, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(36);
    expect(maxPagesForJob(1000, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(120);
    expect(maxPagesForJob(4000, SOCIAL_ROWS_PER_CHUNK, "feed")).toBe(ABSOLUTE_MAX_PAGES);
    expect(ABSOLUTE_MAX_PAGES).toBe(300);
  });

  it("the cap is exactly 6 times the pages needed, for every size under the ceiling", () => {
    for (const target of [11, 30, 50, 51, 100, 299, 300, 301, 999, 1000, 1500]) {
      const needed = Math.ceil(target / 50);
      expect(maxPagesForJob(target, 50, "feed"), String(target)).toBe(Math.min(300, needed * 6));
      expect(maxPagesForJob(target, 50, "directory"), String(target)).toBe(Math.min(30, needed * 3));
    }
  });

  it("the absolute ceiling still binds, and it can be moved by its own setting only", () => {
    expect(maxPagesForJob(100_000, 50, "feed")).toBe(300);
    setScaleOverridesForTesting({ absoluteMaxPages: 100 });
    expect(maxPagesForJob(1000, 50, "feed")).toBe(100);
    expect(maxPagesForJob(300, 50, "feed")).toBe(36);
    setScaleOverridesForTesting({ absoluteMaxPages: 20 });
    expect(maxPagesForJob(300, 50, "feed")).toBe(20);
  });

  it("small jobs are untouched: 10 records or fewer keep 4 feed pages and 3 directory pages", () => {
    for (const target of [1, 2, 5, 10]) {
      expect(maxPagesForJob(target, 50, "feed")).toBe(FEED_SMALL_JOB_MAX_PAGES);
      expect(maxPagesForJob(target, 10, "directory")).toBe(SMALL_JOB_MAX_PAGES);
    }
    expect(FEED_SMALL_JOB_MAX_PAGES).toBe(4);
    expect(SMALL_JOB_MAX_PAGES).toBe(3);
  });
});

describe("the stop rules are unchanged", () => {
  const call = (pagesDone: number, acceptedThisPage: number, priorBatchUnits: Array<number | null> = []) => evaluateProviderCallCap({ pagesDone, acceptedThisPage, priorBatchUnits, targetMax: 300, pageSize: 50, kind: "feed" });

  it("the page cap fires at page 36 for 300 posts (35 pages: no stop), no earlier and no later", () => {
    expect(call(35, 5)).toBeNull();
    expect(call(36, 5)).toBe("page_cap");
    expect(call(18, 5)).toBeNull();
    expect(call(37, 5)).toBe("page_cap");
  });

  it("consecutive empty pages still stop a job first: 2 in a row for a large job too (it was 3), whatever the cap", () => {
    expect(MAX_CONSECUTIVE_EMPTY_PAGES_LARGE).toBe(2);
    expect(call(10, 0, [4, 0, 0])).toBe("empty_pages");
    expect(call(10, 0, [4, 0])).toBe("empty_pages");
    expect(call(10, 0, [4, 5])).toBeNull();
    expect(call(36, 0, [4, 0, 0])).toBe("empty_pages");
    expect(call(10, 0, [])).toBeNull();
  });

  it("small jobs keep their rule of 2 empty pages", () => {
    expect(evaluateProviderCallCap({ pagesDone: 1, acceptedThisPage: 0, priorBatchUnits: [0], targetMax: 5, pageSize: 50, kind: "feed" })).toBe("empty_pages");
  });
});

describe("what a larger cap does to the money: the worst case of the provider rises, the reserve and the charge do not", () => {
  const xPosts = getSocialCapability("social-x-posts")!;

  it("the provider gate reserves ONE chunk at a time (0.006 USD for X: the dearest call 0.001 x 6 calls), so no page of a larger job is bought past the daily cap", () => {
    expect(SOCIAL_MAX_CALLS_PER_CHUNK).toBe(6);
    expect(estimateSocialChunkCostUsd(xPosts)).toBe(0.006);
  });

  it("worst case of an X job of 300 posts: 36 chunks (it was 18). At the measured 0.0006 USD a call and one call a chunk: 0.0216 USD (was 0.0108); at 6 calls a chunk: 0.1296 USD (was 0.0648); the gate's own reserve bound 36 x 0.006 = 0.216 USD (was 0.108)", () => {
    const chunks = maxPagesForJob(300, SOCIAL_ROWS_PER_CHUNK, "feed");
    expect(chunks).toBe(36);
    expect(Number((chunks * 0.0006).toFixed(6))).toBe(0.0216);
    expect(Number((chunks * SOCIAL_MAX_CALLS_PER_CHUNK * 0.0006).toFixed(6))).toBe(0.1296);
    expect(Number((chunks * estimateSocialChunkCostUsd(xPosts)).toFixed(6))).toBe(0.216);
    const before = maxPagesForJob(300, SOCIAL_ROWS_PER_CHUNK, "feed", 3);
    expect(before).toBe(18);
    expect(Number((before * 0.0006).toFixed(6))).toBe(0.0108);
  });

  it("the charge is ceil(delivered x unit price) and never above the reserve, whatever the cap: delivered can never pass the target", () => {
    for (const [target, unit] of [[30, 0.11715], [300, 0.11715], [1000, 0.11715], [4000, 0.11715], [300, 0.275]] as Array<[number, number]>) {
      const reserve = Math.ceil(target * unit * 1.15);
      for (const delivered of [0, 1, Math.floor(target / 2), target - 1, target]) {
        const charge = chargeForUnits(delivered, unit);
        expect(charge, `${target}/${delivered}`).toBe(Math.max(0, Math.ceil(delivered * unit - 1e-9)));
        expect(charge, `${target}/${delivered}`).toBeLessThanOrEqual(reserve);
      }
    }
    expect(chargeForUnits(118, 0.11715)).toBe(14);
    expect(Math.ceil(300 * 0.11715 * 1.15)).toBe(41);
  });

  it("the review budget does not move with the page cap: it is sized for the old allowance of 3, so every job size has the budget it had", () => {
    expect(REVIEW_BUDGET_PAGE_ALLOWANCE).toBe(3);
    expect(collectableRows(30)).toBe(120);
    expect(collectableRows(100)).toBe(300);
    expect(collectableRows(300)).toBe(900);
    expect(socialReviewCapUsd(30, 0.11715)).toBe(0.03984);
    expect(socialReviewCapUsd(100, 0.11715)).toBe(0.0996);
    expect(socialReviewCapUsd(300, 0.11715)).toBe(REVIEW_JOB_CEILING_USD);
    expect(socialReviewCapUsd(1000, 0.11715)).toBe(0.15);
    // the cap of the collection itself is wider, and the budget is not
    expect(maxPagesForJob(100, 20, "feed") * 20).toBe(600);
    expect(collectableRows(100)).toBe(300);
  });
});
