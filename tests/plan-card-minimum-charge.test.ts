import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { customerMissionView, isMinimumSettingPrice } from "../src/lib/agentMission/customerView";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";

describe("D-0196 / DT-20261123-card-minimum-line: Plan Card Minimum Line Before Approval", () => {
  it("renders the minimum line and headline count before approval for live incident payload shape (msn_a9e3167d3cb1d7e60ef7)", () => {
    const livePlan = {
      summary_ar: "ستحصل على تغريدات عن الشائعات.",
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
        unit_price_points: 100,
        delivered_rows: 2,
        min_charge_points: 200,
        max_charge_points: 200,
        reserve_points: 200,
        minimum_line_ar: "الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.",
      },
    };

    expect(isMinimumSettingPrice(livePlan.price, 2)).toBe(true);

    const mission: any = {
      id: "msn_a9e3167d3cb1d7e60ef7",
      status: "plan_ready",
      request_text: "تغريدات عن الشائعات",
      created_at: new Date().toISOString(),
      plan_public: livePlan,
    };

    const view = customerMissionView({ mission, events: [] });

    // 1) Customer view properties
    expect(view.headlineCountAr).toBe("هتستلم تغريدتين، والحد الأدنى للطلب ٢٠٠ نقطة");
    expect(view.minimumLineAr).toBe("الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.");

    // 2) Component renders both the headline fact and the dedicated minimum line
    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false }));
    expect(html).toContain('data-testid="agent-minimum-line"');
    expect(html).toContain("الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.");
    expect(html).toContain("والحد الأدنى للطلب ٢٠٠ نقطة");
    expect(html).toContain("أقصى سعر");
    expect(html).toContain("٢٠٠ نقطة");
  });

  it("recognizes minimum when field name variations are used (min_charge / max_charge / minApplied)", () => {
    const planWithAliases = {
      summary_ar: "ملخص طلب",
      stages: [
        {
          key: "news",
          title_ar: "الأخبار",
          deliver: true,
          expected_rows: 2,
          columns: [{ key: "title", title_ar: "العنوان" }],
        },
      ],
      price: {
        min_charge: 200,
        max_charge: 200,
        unit_price_points: 100,
        delivered_rows: 2,
        minimum_line_ar: "الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.",
        min_applied: true,
      },
    };

    expect(isMinimumSettingPrice(planWithAliases.price, 2)).toBe(true);

    const mission: any = {
      id: "msn_alias_test",
      status: "plan_ready",
      request_text: "أخبار",
      created_at: new Date().toISOString(),
      plan_public: planWithAliases,
    };

    const view = customerMissionView({ mission, events: [] });
    expect(view.headlineCountAr).toContain("والحد الأدنى للطلب ٢٠٠ نقطة");
    expect(view.minimumLineAr).toBe("الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.");

    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false }));
    expect(html).toContain('data-testid="agent-minimum-line"');
    expect(html).toContain("الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.");
  });

  it("does not render the minimum line when delivery cost exceeds the minimum charge", () => {
    const regularPlan = {
      summary_ar: "ستحصل على ٢٠ خبرًا.",
      stages: [
        {
          key: "news",
          title_ar: "الأخبار",
          deliver: true,
          expected_rows: 20,
          columns: [{ key: "title", title_ar: "العنوان" }],
        },
      ],
      price: {
        unit_price_points: 50,
        delivered_rows: 20,
        min_charge_points: 200,
        max_charge_points: 1000,
        reserve_points: 1150,
        min_applied: false,
        minimum_line_ar: "الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.",
      },
    };

    expect(isMinimumSettingPrice(regularPlan.price, 20)).toBe(false);

    const mission: any = {
      id: "msn_regular_test",
      status: "plan_ready",
      request_text: "أخبار",
      created_at: new Date().toISOString(),
      plan_public: regularPlan,
    };

    const view = customerMissionView({ mission, events: [] });
    expect(view.headlineCountAr).toBeNull();
    expect(view.minimumLineAr).toBeUndefined();

    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false }));
    expect(html).not.toContain('data-testid="agent-minimum-line"');
    expect(html).not.toContain("والحد الأدنى للطلب");
    expect(html).toContain("أقصى سعر");
    expect(html).toContain("١٬٠٠٠ نقطة");
  });
});
