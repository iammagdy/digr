import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { QUOTE_LIMIT_POINTS, TOTAL_PROVIDER_USD_LIMIT, largestVolumeWithin, testerQuote, testerRequests, totalExpectedProviderUsd } from "../src/lib/measurementPlan";

describe("the seven small requests for the tester", () => {
  const plans = testerRequests();
  const byId = (id: string) => plans.find((plan) => plan.id === id)!;

  it("one per source: YouTube comments, TikTok comments, TikTok channels, X posts, Facebook page posts, companies, decision makers", () => {
    expect(plans.map((plan) => plan.id)).toEqual(["youtube-comments", "tiktok-comments", "tiktok-channels-top-videos", "x-posts-event", "facebook-page-posts", "companies", "decision-makers"]);
  });

  it("the volumes are the owner's caps, quoted and settled by the existing public quote function", () => {
    // per-record prices (cost per delivered record x 5,500): 0.275 a comment, 0.11715 an X post, 3.4485 a Facebook page post, 3.168 a company
    expect(byId("youtube-comments").asSpecified).toMatchObject({ volume: 30, unitPricePoints: 0.275, quotedPoints: 10, settledIfAllDeliveredPoints: 9 });
    expect(byId("tiktok-comments").asSpecified).toMatchObject({ volume: 30, unitPricePoints: 0.275, quotedPoints: 10, settledIfAllDeliveredPoints: 9 });
    expect(byId("tiktok-channels-top-videos").asSpecified).toMatchObject({ volume: 120, cutToOneJob: false, volumeHeld: 120, quotedPoints: 38, settledIfAllDeliveredPoints: 33 });
    expect(byId("x-posts-event").asSpecified).toMatchObject({ volume: 100, unitPricePoints: 0.11715, quotedPoints: 14, settledIfAllDeliveredPoints: 12 });
    expect(byId("facebook-page-posts").asSpecified).toMatchObject({ volume: 20, unitPricePoints: 3.4485, quotedPoints: 80, settledIfAllDeliveredPoints: 69 });
    expect(byId("companies").asSpecified).toMatchObject({ volume: 5, unitPricePoints: 3.168, quotedPoints: 19, settledIfAllDeliveredPoints: 16 });
    expect(byId("decision-makers").asSpecified).toMatchObject({ volume: 1, unitPricePoints: 258, quotedPoints: 297, settledIfAllDeliveredPoints: 258 });
  });

  it("the owner's two limits: at the per-record prices only the channels mission, the Facebook page posts and decision makers quote above 20 points at the specified volume", () => {
    const over = plans.filter((plan) => plan.asSpecified.quotedPoints > QUOTE_LIMIT_POINTS).map((plan) => plan.id);
    expect(over).toEqual(["tiktok-channels-top-videos", "facebook-page-posts", "decision-makers"]);
    expect(byId("companies").asSpecified.quotedPoints).toBeLessThanOrEqual(QUOTE_LIMIT_POINTS);
    expect(byId("decision-makers").within20Points).toBeNull();
    expect(largestVolumeWithin("professional-people-search", 20, 5)).toBeNull();
  });

  it("the within-20-points versions: the largest volume whose quote is at most 20, and every one is", () => {
    expect(byId("youtube-comments").within20Points).toMatchObject({ volume: 30, quotedPoints: 10, settledIfAllDeliveredPoints: 9 });
    expect(byId("tiktok-comments").within20Points).toMatchObject({ volume: 30, quotedPoints: 10, settledIfAllDeliveredPoints: 9 });
    expect(byId("tiktok-channels-top-videos").within20Points).toMatchObject({ volume: 63, quotedPoints: 20, settledIfAllDeliveredPoints: 18 });
    expect(byId("x-posts-event").within20Points).toMatchObject({ volume: 100, quotedPoints: 14, settledIfAllDeliveredPoints: 12 });
    expect(byId("facebook-page-posts").within20Points).toMatchObject({ volume: 5, quotedPoints: 20, settledIfAllDeliveredPoints: 18 });
    expect(byId("companies").within20Points).toMatchObject({ volume: 5, quotedPoints: 19, settledIfAllDeliveredPoints: 16 });
    for (const plan of plans) if (plan.within20Points) {
      expect(plan.within20Points.quotedPoints).toBeLessThanOrEqual(QUOTE_LIMIT_POINTS);
      // one more record would pass the limit (unless the request itself stops there)
      const next = testerQuote(plan.slug, plan.within20Points.volume + 1);
      if (plan.within20Points.volume < plan.asSpecified.volume) expect(next.quotedPoints).toBeGreaterThan(QUOTE_LIMIT_POINTS);
    }
  });

  it("the expected provider spend as specified is over 0.02 USD; the recommended set (two videos per channel) is under it", () => {
    expect(totalExpectedProviderUsd(plans)).toBe(0.02134);
    expect(totalExpectedProviderUsd(plans)).toBeGreaterThan(TOTAL_PROVIDER_USD_LIMIT);
    expect(totalExpectedProviderUsd(plans, "recommended")).toBe(0.01934);
    expect(totalExpectedProviderUsd(plans, "recommended")).toBeLessThan(TOTAL_PROVIDER_USD_LIMIT);
    const adjusted = byId("tiktok-channels-top-videos").adjustedForBudget!;
    expect(adjusted.quote).toMatchObject({ volume: 80, cutToOneJob: false, quotedPoints: 26, settledIfAllDeliveredPoints: 22 });
    expect(adjusted.providerCallsExpected).toBe(6);
    expect(adjusted.providerUsdExpected).toBe(0.0064);
    expect(plans.filter((plan) => plan.adjustedForBudget).map((plan) => plan.id)).toEqual(["tiktok-channels-top-videos"]);
  });

  it("a settlement never passes its quote, and the quote for the volume held is what one job reserves", () => {
    for (const plan of plans) expect(plan.asSpecified.settledIfAllDeliveredPoints).toBeLessThanOrEqual(plan.asSpecified.quotedPoints);
  });

  it("the requests are in plain Arabic: only the brackets for the tester to fill in, no Latin letters, no digits outside Arabic-Indic, no provider names", () => {
    for (const plan of plans) {
      for (const text of [plan.textAr, plan.sourceAr, plan.measureAr, plan.adjustedForBudget?.textAr ?? "", plan.adjustedForBudget?.reasonAr ?? ""]) {
        expect(text).not.toMatch(/[A-Za-z0-9]|undefined|null|NaN|https?:/);
        expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      }
      expect(plan.textAr).toMatch(/\[/);
    }
  });

  it("the plan file states every number the code states", () => {
    const doc = readFileSync("docs/LONG_JOB_MEASUREMENT_PLAN.md", "utf8");
    for (const plan of plans) {
      expect(doc).toContain(plan.textAr);
      expect(doc).toContain(`| ${plan.asSpecified.quotedPoints} |`);
    }
    for (const needle of ["0.02134", "0.01934", "26 points", "138", "193", "0.0084 (8)", "0.00288 (1)"]) expect(doc).toContain(needle);
    expect(doc).toContain(byId("tiktok-channels-top-videos").adjustedForBudget!.textAr);
  });
});
