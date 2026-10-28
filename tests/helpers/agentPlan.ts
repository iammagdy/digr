import { validateAndPricePlan, type PlanLookup, type PricedPlan } from "../../src/lib/agentMission/plan";

/** A priced plan, built the only way a plan is ever built: validateAndPricePlan over recorded calls. */
export function pricedTwoStagePlan(): PricedPlan {
  const calls = new Map([
    ["call_0001", { id: "call_0001", endpointId: "x.x.search-posts-all", ok: true, costUsd: 0.05, rows: 10 }],
    ["call_0002", { id: "call_0002", endpointId: "anyapi.instagram.post.comments", ok: true, costUsd: 0.00144, rows: 12 }],
  ]);
  const lookup: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: () => "9000 9001 9000-c0 https://x.example/p/9000", endpointAllowed: () => true };
  const checked = validateAndPricePlan({
    summary_ar: "ستحصل على منشورات وتعليقاتها في ورقتين مرتبطتين.",
    stages: [
      { key: "posts", title_ar: "المنشورات", endpoint_id: "x.x.search-posts-all", expected_rows: 20, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ id: "9000", text: "a", url: "https://x.example/p/9000" }], measured_by: ["call_0001"] },
      { key: "comments", title_ar: "التعليقات", endpoint_id: "anyapi.instagram.post.comments", expected_rows: 200, parent_key: "posts", per_parent_rows: 12, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ id: "9000-c0", text: "x" }], measured_by: ["call_0002"] },
    ],
  }, lookup);
  if (!checked.ok) throw new Error(checked.issues.join("; "));
  return checked.plan;
}

