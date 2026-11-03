import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { USER_ID, fakeRecorder } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import type { StageFilter } from "../src/lib/agentMission/filters";
import { priceMissionByCode } from "../src/lib/agentMission/price";

import { matchesCustomerConditions } from "../src/lib/agentMission/customerConditions";
import { DEFAULT_MISSION_PRICING_SETTINGS } from "../src/lib/missionPricing";
import { topicDiscussionClass, topicMeaningOf, topicQueryOf, TOPIC_OPTIONS_AR, topicQuestionAr } from "../src/lib/agentMission/topicMeaning";
import { buildToolInput } from "../src/lib/agentMission/toolInput";

/**
 * S8, the live test of 2026-11-02 ~13:35 Cairo (docs/S1-LIVE-FINDINGS.md, S8): both videos were AI-generated drama stories (#قصص_بالذكاء_الاصطناعي) and not videos ABOUT artificial intelligence: the keyword matched a hashtag and the most-commented order picked the viral stories.
 * OWNER DECISION (request understanding, not filtering): «عن X» means content that talks about or explains X; «معمول بـ X» (made with X) is a different request. The query is built from that meaning; among the results the videos whose own text discusses the topic are preferred over videos where the topic
 * appears only as a made-with hashtag (choosing which videos to read; nothing delivered is removed, no comment is filtered); an ambiguous request gets a question card before planning.
 * The videos are the stored ones of that mission (tests/fixtures/live/msn_5851abc9-videos.json; two rows are marked synthetic: explainers added to prove the choice).
 */
const FIX = JSON.parse(readFileSync(new URL("./fixtures/live/msn_5851abc9-videos.json", import.meta.url), "utf8")) as { request: string; videos: Array<{ id: string; synthetic: boolean; delivered: boolean; comments: number; country: string; language: string; text: string }> };
const REQUEST = FIX.request;

describe("what the request means", () => {
  it("the exact request says «عن الذكاء الاصطناعي»: ABOUT the topic", () => {
    const m = topicMeaningOf(REQUEST);
    expect(m.kind).toBe("about");
    expect(m.topic).toBe("الذكاء الاصطناعي");
  });
  it("«معمول بالذكاء الاصطناعي» is a different request: made with it", () => {
    expect(topicMeaningOf("هات فيديوهين تيك توك معمولة بالذكاء الاصطناعي من مصر").kind).toBe("made_with");
    expect(topicMeaningOf("عايز فيديوهات مصنوعة بالذكاء الاصطناعي").kind).toBe("made_with");
  });
  it("the topic word alone («فيديوهات الذكاء الاصطناعي») is ambiguous between the two", () => {
    expect(topicMeaningOf("هات فيديوهين تيك توك الذكاء الاصطناعي من مصر مع التعليقات").kind).toBe("ambiguous");
  });
  it("a request with no such topic is not about this decision at all", () => {
    expect(topicMeaningOf("هات ٥ فيديوهات تيك توك عن منتخب مصر").kind).toBe("none");
  });
  it("the customer's answer to the question decides it", () => {
    expect(topicMeaningOf(`هات فيديوهين تيك توك الذكاء الاصطناعي ${TOPIC_OPTIONS_AR("الذكاء الاصطناعي")[0]}`).kind).toBe("about");
    expect(topicMeaningOf(`هات فيديوهين تيك توك الذكاء الاصطناعي ${TOPIC_OPTIONS_AR("الذكاء الاصطناعي")[1]}`).kind).toBe("made_with");
  });
  it("the question card says exactly what the owner asked, with two ready answers", () => {
    expect(topicQuestionAr("الذكاء الاصطناعي")).toBe("تقصد فيديوهات بتتكلم عن الذكاء الاصطناعي، ولا فيديوهات معمولة بيه؟");
    expect(TOPIC_OPTIONS_AR("الذكاء الاصطناعي")).toHaveLength(2);
  });
});

describe("the query carries the meaning", () => {
  it("about: the topic with explainer and news wording; made with: the topic as it is", () => {
    const about = topicMeaningOf(REQUEST);
    expect(topicQueryOf(about)).toContain("الذكاء الاصطناعي");
    expect(topicQueryOf(about)).toMatch(/شرح|أخبار/);
    expect(topicQueryOf(topicMeaningOf("فيديوهات معمولة بالذكاء الاصطناعي"))).toBe("الذكاء الاصطناعي");
  });
  it("the code-built request writes it into the tool's query field (and no exclusion is invented for a search with no operators)", () => {
    const catalog = loadTregCatalog();
    const e = catalog.byId.get("tikhub.tiktok.search.videos")!;
    const built = buildToolInput(e, { nowMs: Date.now(), topicQuery: topicQueryOf(topicMeaningOf(REQUEST)) ?? undefined }, { keyword: "الذكاء الاصطناعي", region: "EG", count: 20, sort_type: 1 });
    expect(built.ok).toBe(true);
    expect(String(built.params.keyword)).toMatch(/الذكاء الاصطناعي.*(شرح|أخبار)/);
    expect(String(built.params.keyword)).not.toContain("-");
  });
});

describe("a video whose own text discusses the topic over one where it is only a made-with hashtag", () => {
  const about = topicMeaningOf(REQUEST);
  const cls = (id: string) => topicDiscussionClass(FIX.videos.find((v) => v.id === id)!.text, about);
  it("the stories of the live mission are made-with (class 0): the topic is only inside #قصص_بالذكاء_الاصطناعي / #AIStory", () => {
    expect(cls("7663879872137252114")).toBe(0);
    expect(cls("7690257663250205974")).toBe(0);
    expect(cls("7683623292564933910")).toBe(0);
  });
  it("a plain topic hashtag with no made-with marker is neutral (class 1); a text that talks about the topic is class 2", () => {
    expect(cls("7692547380482346263")).toBe(1);
    expect(cls("synthetic-explainer-1")).toBe(2);
    expect(cls("synthetic-explainer-2")).toBe(2);
  });
});

const stage = (o: Partial<PricedStage> & Pick<PricedStage, "key" | "title_ar" | "endpoint_id" | "parent_key" | "planned_rows">): PricedStage => ({ expected_rows: o.planned_rows, deliver: true, columns: [], sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0.00005, measured_from_calls: [], ...o });
const SPEC = { endpoint_id: "tikhub.tiktok.video.comments", params: {}, cursor_param: "cursor", map_code: "return []", map_file_id: "p", parent_binding: { param: "aweme_id", from: "id" }, built_by: "code" };
const FILTERS = [{ kind: "language", lang: "ar" }, { kind: "place", field: "country", fields: ["country"], places: ["EG"], values: ["مصر"] }] as unknown as StageFilter[];
const basePlan = (): PricedPlan => {
  const stages = [
    stage({ key: "videos", title_ar: "الفيديوهات", endpoint_id: "tikhub.tiktok.search.videos", parent_key: null, planned_rows: 2, columns: [{ key: "text", title_ar: "وصف الفيديو" }, { key: "country", title_ar: "الدولة" }, { key: "comments", title_ar: "التعليقات" }], filters: FILTERS, engine: { ...SPEC, endpoint_id: "tikhub.tiktok.search.videos", parent_binding: null } as never }),
    stage({ key: "comments", title_ar: "التعليقات", endpoint_id: "tikhub.tiktok.video.comments", parent_key: "videos", planned_rows: 800, per_parent_rows: 400, columns: [{ key: "comments", title_ar: "التعليق" }], engine: SPEC as never }),
  ];
  return { summary_ar: "x", stages, price: priceMissionByCode(stagePriceInputs(stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) } as unknown as PricedPlan;
};
const cands = (videos = FIX.videos) => videos.map((v) => ({ id: v.id, counter: v.comments, row: { id: v.id, text: v.text, country: v.country, language: v.language, comments: v.comments } }));
const pinsOf = (p: PricedPlan) => p.stages.find((s) => s.key === "comments")!.parent_pins;



import { runS4, QUERY, STORIES, EXPLAINERS } from "./helpers/s4World";
import { vid } from "./helpers/g4RepliesWorld";

