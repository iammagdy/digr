import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { customerMissionView, isMinimumSettingPrice } from "../src/lib/agentMission/customerView";
import { customerPlanView } from "../src/lib/agentMission/plan";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";

describe("D-0196 / DT-20261123-card-minimum-line: Plan Card Minimum Line Before Approval", () => {
  it("Case 1 (2 rows × 10 = 20 < 200): shows minimum line when min_applied is true", () => {
    const plan = {
      summary_ar: "ستحصل على تغريدتين عن الشائعات.",
      stages: [
        {
          key: "tweets",
          title_ar: "تغريدات الشائعات",
          deliver: true,
          expected_rows: 2,
          columns: [{ key: "text", title_ar: "نص التغريدة" }],
        },
      ],
      price: {
        unit_price_points: 10,
        delivered_rows: 2,
        min_charge_points: 200,
        max_charge_points: 200,
        reserve_points: 200,
        min_applied: true,
        minimum_line_ar: "الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.",
      },
    };

    expect(isMinimumSettingPrice(plan.price, 2)).toBe(true);

    const mission: any = {
      id: "msn_case1",
      status: "plan_ready",
      request_text: "تغريدات عن الشائعات",
      created_at: new Date().toISOString(),
      plan_public: plan,
    };

    const view = customerMissionView({ mission, events: [] });
    expect(view.headlineCountAr).toBe("هتستلم تغريدتين، والحد الأدنى للطلب ٢٠٠ نقطة");
    expect(view.minimumLineAr).toBe("الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.");

    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false }));
    expect(html).toContain('data-testid="agent-minimum-line"');
    expect(html).toContain("الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.");
    expect(html).toContain("والحد الأدنى للطلب ٢٠٠ نقطة");
    expect(html).toContain("أقصى سعر");
  });

  it("Case 2 (20 rows × 10 = 200): does NOT show minimum line when min_applied is false (even if maxCharge <= minCharge)", () => {
    const plan = {
      summary_ar: "ستحصل على ٢٠ تغريدة.",
      stages: [
        {
          key: "tweets",
          title_ar: "تغريدات",
          deliver: true,
          expected_rows: 20,
          columns: [{ key: "text", title_ar: "نص التغريدة" }],
        },
      ],
      price: {
        unit_price_points: 10,
        delivered_rows: 20,
        min_charge_points: 200,
        max_charge_points: 200,
        reserve_points: 200,
        min_applied: false,
        minimum_line_ar: "الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.",
      },
    };

    expect(isMinimumSettingPrice(plan.price, 20)).toBe(false);

    const mission: any = {
      id: "msn_case2",
      status: "plan_ready",
      request_text: "تغريدات",
      created_at: new Date().toISOString(),
      plan_public: plan,
    };

    const view = customerMissionView({ mission, events: [] });
    expect(view.headlineCountAr).toBeNull();
    expect(view.minimumLineAr).toBeUndefined();

    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false }));
    expect(html).not.toContain('data-testid="agent-minimum-line"');
    expect(html).not.toContain('data-testid="agent-minimum-note"');
    expect(html).not.toContain("والحد الأدنى للطلب");
  });

  it("Case 3 (25 rows × 10 = 250): does NOT show minimum line when min_applied is false", () => {
    const plan = {
      summary_ar: "ستحصل على ٢٥ تغريدة.",
      stages: [
        {
          key: "tweets",
          title_ar: "تغريدات",
          deliver: true,
          expected_rows: 25,
          columns: [{ key: "text", title_ar: "نص التغريدة" }],
        },
      ],
      price: {
        unit_price_points: 10,
        delivered_rows: 25,
        min_charge_points: 200,
        max_charge_points: 250,
        reserve_points: 250,
        min_applied: false,
        minimum_line_ar: "الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.",
      },
    };

    expect(isMinimumSettingPrice(plan.price, 25)).toBe(false);

    const mission: any = {
      id: "msn_case3",
      status: "plan_ready",
      request_text: "تغريدات",
      created_at: new Date().toISOString(),
      plan_public: plan,
    };

    const view = customerMissionView({ mission, events: [] });
    expect(view.headlineCountAr).toBeNull();
    expect(view.minimumLineAr).toBeUndefined();

    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false }));
    expect(html).not.toContain('data-testid="agent-minimum-line"');
    expect(html).not.toContain('data-testid="agent-minimum-note"');
    expect(html).not.toContain("والحد الأدنى للطلب");
  });

  it("Case 4 (payload without min_applied): does NOT show minimum line (older payloads)", () => {
    const legacyPlan = {
      summary_ar: "ستحصل على تغريدتين.",
      stages: [
        {
          key: "tweets",
          title_ar: "تغريدات",
          deliver: true,
          expected_rows: 2,
          columns: [{ key: "text", title_ar: "نص التغريدة" }],
        },
      ],
      price: {
        unit_price_points: 100,
        delivered_rows: 2,
        min_charge_points: 200,
        max_charge_points: 200,
        reserve_points: 200,
        minimum_line_ar: "الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.",
      },
    };

    expect(isMinimumSettingPrice(legacyPlan.price, 2)).toBe(false);

    const mission: any = {
      id: "msn_legacy",
      status: "plan_ready",
      request_text: "تغريدات",
      created_at: new Date().toISOString(),
      plan_public: legacyPlan,
    };

    const view = customerMissionView({ mission, events: [] });
    expect(view.headlineCountAr).toBeNull();
    expect(view.minimumLineAr).toBeUndefined();

    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false }));
    expect(html).not.toContain('data-testid="agent-minimum-line"');
    expect(html).not.toContain('data-testid="agent-minimum-note"');
    expect(html).not.toContain("والحد الأدنى للطلب");
  });

  it("plan.ts: customerPlanView emits min_applied: true when minApplied is true, and omits it when false (preserving public plan invariance)", () => {
    const makePlan = (minApplied: boolean): any => ({
      summary_ar: "ملخص تجريبي",
      stages: [],
      price: {
        rule: 2,
        unitPricePoints: 10,
        reservePoints: 200,
        maxChargePoints: 200,
        deliveredRows: 2,
        minChargePoints: 200,
        minApplied,
        settings: { minChargePoints: 200 },
      },
    });

    const publicPlanTrue = customerPlanView(makePlan(true));
    expect(publicPlanTrue.price.min_applied).toBe(true);

    const publicPlanFalse = customerPlanView(makePlan(false));
    expect(publicPlanFalse.price.min_applied).toBeUndefined();
  });
});
