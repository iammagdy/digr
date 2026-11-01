import { describe, expect, it } from "vitest";
import { buildMethodology, type MissionFacts, type StageRecord } from "../agent/src/methodology";
import { perParentShortfallAr } from "../agent/src/perParentLimits";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * THE LIMITS ROW SPEAKS IN THE TASK'S OWN NOUNS (golden G4, msn_3da66037878465ffbfd5, 2026-11-01 15:20 Cairo: 5 TikTok videos, 10 comments each; 32 of 50 comments delivered). The row said
 * «٣ شركات وُجد فيها موظفون أقل من العدد المطلوب، وزاد ٨ أشخاص عن العدد المعتمد في بقية الشركات»: company and employee words in a task about videos and comments. The words now come from the stages' own titles.
 */
const videos = { key: "videos", title_ar: "فيديوهات تيك توك عن منتخب مصر", endpoint_id: "anyapi.tiktok.search.videos", expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], columns: [], filters: [] };
const comments = { key: "comments", title_ar: "تعليقات كل فيديو عن منتخب مصر", endpoint_id: "tikhub.tiktok.video.comments", expected_rows: 50, planned_rows: 50, parent_key: "videos", per_parent_rows: 10, deliver: true, sample_rows: [], measured_by: [], measured_from_calls: [], columns: [], filters: [] };
const plan = { summary_ar: "x", stages: [videos, comments] as any, price: { totalCostUsd: 0, deliveredRows: 55, costPerFinalRowUsd: 0.0001, unitPricePoints: 3.64, reservePoints: 204, maxChargePoints: 200, overCap: false } as any } as PricedPlan;
const record = (over: Partial<StageRecord> = {}): StageRecord => ({ found: 0, duplicates: 0, accepted: 0, excluded: 0, pending: 0, unchecked: 0, acceptedByRule: 0, acceptedByModel: 0, excludedByReason: {}, stop: "source_exhausted", ...over });
const facts: MissionFacts = { requestText: "هات ٥ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات", deliveredAt: new Date("2026-11-01T13:21:00Z"), reviewStop: null, stages: { videos: record({ found: 20, accepted: 5, excluded: 15 }), comments: record({ found: 40, accepted: 32, excluded: 8, excludedByReason: { target_reached: 8 } }) } } as any;
const videoRows = ["v1", "v2", "v3", "v4", "v5"].map((id) => ({ id }));
const counts: Record<string, number> = { v1: 10, v2: 1, v3: 6, v4: 10, v5: 5 };
const commentRows = Object.entries(counts).flatMap(([parent, n]) => Array.from({ length: n }, (_, i) => ({ id: `${parent}-c${i}`, parent_id: parent, text: "x" })));

describe("F1: the limits row of a comments task says video and comment, never company and employee", () => {
  it("G4 replay: three videos with fewer comments than asked, eight comments beyond the approved number", () => {
    const m = buildMethodology({ plan, layouts: [], rowsByStage: { videos: videoRows, comments: commentRows }, facts });
    const text = m.items.find((i) => i.label === "حدود هذا التسليم")!.values.join("\n");
    expect(text).toContain("سُلّم ٣٢ من ٥٠");
    expect(text).toContain("٣ فيديوهات وُجدت فيها تعليقات أقل من العدد المطلوب");
    expect(text).toContain("وزاد ٨ تعليقات عن العدد المعتمد في بقية الفيديوهات");
    expect(text).not.toMatch(/شرك|موظف|شخص|أشخاص/);
    expect(text).not.toMatch(/[0-9]/);
  });
  it("the one and two forms agree with the noun", () => {
    const base = { parentIds: ["a", "b", "c"], perParent: 10, surplus: 0, parentNoun: "فيديو", childNoun: "تعليق" };
    expect(perParentShortfallAr({ ...base, childParentIds: ["b", "c", "c"] })).toContain("فيديو واحد لم يُعثر فيه على تعليقات");
    expect(perParentShortfallAr({ ...base, parentIds: ["a", "b", "c", "d"], childParentIds: ["c", "d"] })).toContain("فيديوهان لم يُعثر فيهما على تعليقات");
  });
  it("companies and people keep their own words", () => {
    const t = perParentShortfallAr({ parentIds: ["a", "b"], childParentIds: ["b"], perParent: 2, surplus: 3, childNoun: "شخص" })!;
    expect(t).toContain("شركة واحدة لم يُعثر فيها على موظفين");
    expect(t).toContain("وزاد ٣ أشخاص عن العدد المعتمد في بقية الشركات");
  });
});
