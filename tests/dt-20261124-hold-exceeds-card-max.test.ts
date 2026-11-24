import { describe, expect, it } from "vitest";
import { buildPriceRows } from "../src/lib/pricingPage";
import { executionBudgetUsd, priceMissionByCode, settlementCharge, type StagePriceInput } from "../src/lib/agentMission/price";
import { catalogPage } from "./helpers/discoveryWorld";
import { tregResult } from "./helpers/agentHarness";
import { replay, readWorkbook } from "./helpers/agentReplay";
import type { PlannerModel } from "../agent/src/llmPlanner/planner";

const YOUTUBE_FIVE_POINT_RATE = buildPriceRows().find((row) => row.id === "youtube-videos")!.unitPricePoints;

function youtubeCase2PricingStages(rows = 5): StagePriceInput[] {
  // 20 worst-case calls x $0.015 = $0.300 -> previously inflated reservePoints above 200 card max
  // and caused 60 videos (300 pts) to fail overCap above 600.
  return [{
    stageKey: "videos",
    parentKey: null,
    rows,
    costPerRowUsd: 0.003,
    deliver: true,
    listedRate: { unitPoints: YOUTUBE_FIVE_POINT_RATE, nounAr: "فيديو" },
    executionFunding: Array.from({ length: 10 }, () => ({
      rowsPerPage: rows,
      callUsdMicro: 15_000,
      mode: "paged" as const,
    })),
  }];
}

describe("DT-20261124-hold-exceeds-card-max: single-stage listed hold never exceeds card max", () => {
  it("quotes YouTube 5 videos at 200/200/200 with minApplied and keeps spend budget sufficient for 9 worst-case calls", () => {
    const price = priceMissionByCode(youtubeCase2PricingStages(5));
    expect(price).toMatchObject({
      ruleUnitPoints: YOUTUBE_FIVE_POINT_RATE,
      maxChargePoints: 200,
      reservePoints: 200,
      minApplied: true,
      overCap: false,
    });
    expect(price.executionFundingApplied).toBeUndefined();
    expect(executionBudgetUsd(price.reservePoints)).toBeGreaterThanOrEqual(9 * 0.015);
    expect(executionBudgetUsd(price.reservePoints)).toBeLessThan(10 * 0.015);
  });

  it("quotes YouTube 60 videos (above minimum) at 300/300 without +15% reserve drift and funds 14 worst-case calls", () => {
    const price = priceMissionByCode(youtubeCase2PricingStages(60));
    expect(price).toMatchObject({
      ruleUnitPoints: YOUTUBE_FIVE_POINT_RATE,
      maxChargePoints: 300,
      reservePoints: 300,
      minApplied: false,
      overCap: false,
    });
    expect(price.executionFundingApplied).toBeUndefined();
    expect(executionBudgetUsd(price.reservePoints)).toBeGreaterThanOrEqual(14 * 0.015);
    expect(executionBudgetUsd(price.reservePoints)).toBeLessThan(15 * 0.015);
  });

  it("runs YouTube Case 2 end-to-end on a 200-pt wallet: approves, preserves execution_funding for runEngine, delivers 5 videos, settles 200", async () => {
    const primaryEndpoint = "justoneapi.x.youtube-search-v1";
    const request = "عايز ٥ فيديوهات من يوتيوب عن نصائح التغذية الصحية لمرضى السكري";
    const searchTerms = ["نصائح التغذية الصحية لمرضى السكري"];
    const modelAnswers: Record<string, unknown> = {
      request_plan: {
        decision: "plan",
        understanding_ar: request,
        steps: [{
          key: "videos",
          title_ar: "الفيديوهات",
          platform: "youtube",
          capability: "youtube.search.videos",
          parent: null,
          deliver: true,
          count: { total: 5, per_parent: null, all: false },
          source: null,
          topic: "نصائح التغذية الصحية لمرضى السكري",
          search_terms: searchTerms,
          period: null,
        }],
      },
      tool_choice: {
        options: [
          {
            endpoint_id: primaryEndpoint,
            params: { keyword: searchTerms[0] },
            cursor_input: "continuationToken",
            parent_input: null,
          },
        ],
      },
      field_map: { fields: { id: ["video_id"], text: ["title"], link: ["url"] }, extra: [] },
    };
    const plannerModel: PlannerModel = async ({ tool }) => ({ input: modelAnswers[tool.name], costUsd: 0 });
    const rows = Array.from({ length: 5 }, (_, i) => ({
      video_id: `yt_${String(i + 1).padStart(4, "0")}`,
      title: `نصائح التغذية الصحية لمرضى السكري ${i + 1}`,
      url: `https://www.youtube.com/watch?v=yt_${String(i + 1).padStart(4, "0")}`,
    }));
    const page = tregResult(catalogPage(primaryEndpoint, rows), 0.015);
    const approvingReview = async ({ rows: count }: { rows: number }) => ({
      text: JSON.stringify(Array.from({ length: count }, () => 1)),
      usage: { input_tokens: 10, output_tokens: 10 },
    });

    const result = await replay({
      request,
      balance: 200,
      planning: [],
      execution: () => [],
      answers: [page, page],
      deps: (base) => ({ ...base, plannerModel, reviewCall: approvingReview as never }),
    });

    expect(result.plannedPlan.stages[0].execution_funding?.length).toBeGreaterThan(0);
    expect(result.plannedPlan.price).toMatchObject({
      ruleUnitPoints: YOUTUBE_FIVE_POINT_RATE,
      unitPricePoints: 40,
      maxChargePoints: 200,
      reservePoints: 200,
      minApplied: true,
    });
    expect(result.plannedPlan.price.executionFundingApplied).toBeUndefined();
    expect(result.planView.minimumLineAr).toBe("الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.");
    expect(result.mission).toMatchObject({ status: "completed", delivered_units: 5, charged_points: 200 });
    expect(result.money.ledger.filter((row) => row.type !== "topup").map(({ type, delta }) => [type, delta]))
      .toEqual([["reserve", -200], ["release", 200], ["charge", -200]]);
    expect(result.money.balance()).toBe(0);
    expect((await readWorkbook(result)).getWorksheet("الفيديوهات")?.actualRowCount).toBe(6);
  });

  it("keeps non-listed Cases 1 (Companies) & 3 (News) at 200/200 and enforces settlement <= maxChargePoints", () => {
    const companiesPrice = priceMissionByCode([{
      stageKey: "companies", parentKey: null, rows: 10, costPerRowUsd: 0.0005, deliver: true,
    }]);
    const newsPrice = priceMissionByCode([{
      stageKey: "news", parentKey: null, rows: 10, costPerRowUsd: 0.0005, deliver: true,
    }]);
    expect(companiesPrice).toMatchObject({ maxChargePoints: 200, reservePoints: 200, minApplied: true });
    expect(newsPrice).toMatchObject({ maxChargePoints: 200, reservePoints: 200, minApplied: true });

    expect(settlementCharge({ deliveredUnits: 6, unitPricePoints: 40, reservedPoints: 200 })).toEqual({
      chargedPoints: 200,
      releasedPoints: 0,
    });
    expect(settlementCharge({
      deliveredUnits: 6,
      unitPricePoints: 40,
      reservedPoints: 434,
      maxChargePoints: 200,
    })).toEqual({
      chargedPoints: 200,
      releasedPoints: 234,
    });
  });
});
