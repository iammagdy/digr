import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { directEngine, pageOf, type Out } from "./helpers/engineDirect";
import { pinnedSubsetOf } from "../agent/src/engine/run";
import { buildMissionFiles } from "../agent/src/workbook";
import { buildMethodology, type MissionFacts, type StageRecord } from "../agent/src/methodology";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "../src/lib/agentMission/plan";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { DEFAULT_MISSION_PRICING_SETTINGS } from "../src/lib/missionPricing";
import { TOPIC_RELATION_KEY, TOPIC_RELATION_TITLE_AR, topicRelationAr } from "../src/lib/agentMission/foundation/topicChoice";

/**
 * ROUND 29. Live msn_133b26567812f65b49a8 (Facebook, 4 Nov 2026): the customer edited 10 posts to 5, 4, then 3 before approving. The plan edit changes `planned_rows` only (the pinned rows are the plan's own record of the posts it chose, and an edit up again needs them),
 * so the stage carried 10 pinned rows and planned 3. The worker's test was `pinned.length === planned`: false, so it searched the source again, delivered 3 posts that were NOT the pinned ones and that carried no «علاقة النص بالموضوع», and the methodology
 * could not say how many were about the topic. Now: enough valid pinned rows are executed as the FIRST `planned_rows` of them (the order the plan chose them in, the order the sample showed), with no new search; too few or invalid pinned rows keep the old fresh read.
 */
const ABOUT = topicRelationAr(2), TAGS = topicRelationAr(1);
const A = "a.search.posts";

/** The ten posts the plan chose, in rank order, each with the mark the plan wrote (3 about the topic, 7 only in the hashtags). */
const pinned = (n = 10): Array<Record<string, unknown>> => Array.from({ length: n }, (_, i) => ({ id: `fb-${i + 1}`, text: `منشور مختار ${i + 1}`, author: `صفحة ${i + 1}`, link: `https://www.facebook.com/page/posts/fb-${i + 1}`, [TOPIC_RELATION_KEY]: i < 3 ? ABOUT : TAGS }));
const postsStage = (rows: Array<Record<string, unknown>>, planned: number): PricedStage => ({
  key: "posts", title_ar: "المنشورات", endpoint_id: A, expected_rows: planned, planned_rows: planned, parent_key: null, deliver: true,
  columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "link", title_ar: "الرابط" }, { key: TOPIC_RELATION_KEY, title_ar: TOPIC_RELATION_TITLE_AR }],
  sample_rows: rows.slice(0, 3), measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0102, pinned_rows: rows,
} as PricedStage);
const priced = (rows: Array<Record<string, unknown>>, planned: number): PricedPlan => {
  const stages = [postsStage(rows, planned)];
  return { summary_ar: `${planned} منشورات من فيسبوك عن «الذكاء الاصطناعي».`, stages, quantity: { requested: planned, stage_key: "posts", target: planned, source: "request" }, price: priceMissionByCode(stagePriceInputs(stages), { settings: DEFAULT_MISSION_PRICING_SETTINGS }) } as PricedPlan;
};
const edit = (plan: PricedPlan, count: number): PricedPlan => { const r = applyPlanEdits(plan, { count }); if (!r.ok) throw new Error(r.errorAr); return r.plan; };

/** The engine on the plan as stored after the edits: a source that would answer with DIFFERENT posts (and no mark) if it were asked again. */
function engineOn(plan: PricedPlan, storeOf?: ReturnType<typeof directEngine>) {
  const stage = plan.stages[0];
  const h = storeOf ?? directEngine({ [A]: (_p, n): Out => ({ rows: pageOf("fresh", (n - 1) * 20 + 1, 20), next: `c${n}` }) }, { redesign: true, planned: stage.planned_rows, primary: A });
  Object.assign(h.plan.stages[0], { planned_rows: stage.planned_rows, expected_rows: stage.expected_rows, pinned_rows: stage.pinned_rows, filters: [], columns: stage.columns });
  return h;
}
const idsOf = (rows: Array<Record<string, unknown>>) => rows.map((r) => String(r.id));

describe("the plan edit keeps the pinned rows (they are the record of the chosen posts)", () => {
  it.each([
    { name: "10 -> 3", path: [3] },
    { name: "10 -> 5 -> 4 -> 3 (the live path)", path: [5, 4, 3] },
    { name: "unchanged (10)", path: [10] },
  ])("$name: planned_rows follows the edit, the pinned rows and their marks are exactly what the plan chose", ({ path }) => {
    const before = priced(pinned(), 10);
    let plan = before;
    for (const n of path) plan = edit(plan, n);
    const stage = plan.stages[0];
    expect(stage.planned_rows).toBe(path[path.length - 1]);
    expect(stage.pinned_rows).toEqual(before.stages[0].pinned_rows);
    expect(stage.pinned_rows!.map((r) => r[TOPIC_RELATION_KEY])).toEqual([...Array(3).fill(ABOUT), ...Array(7).fill(TAGS)]);
  });
});

describe("the worker executes the approved subset of the pinned rows, with no new search", () => {
  it.each([
    { name: "10 -> 3", path: [3], n: 3 },
    { name: "10 -> 5 -> 4 -> 3", path: [5, 4, 3], n: 3 },
    { name: "10 -> 5", path: [5], n: 5 },
    { name: "10 -> 1", path: [1], n: 1 },
  ])("$name: the first $n pinned posts, in the plan's order, with their real ids, links and marks, and the source is never asked", async ({ path, n }) => {
    let plan = priced(pinned(), 10);
    for (const c of path) plan = edit(plan, c);
    const h = engineOn(plan);
    const { outcome, items } = await h.run();
    expect(h.calls).toHaveLength(0);
    const rows = items.acceptedRows("posts") as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(n);
    expect(idsOf(rows)).toEqual(idsOf(pinned().slice(0, n)));
    for (const r of rows) {
      const want = pinned().find((p) => p.id === r.id)!;
      expect(r.link).toBe(want.link);
      expect(r[TOPIC_RELATION_KEY]).toBe(want[TOPIC_RELATION_KEY]);
    }
    expect(outcome.stops.posts).toBe("target_reached");
    // the chosen posts that were not approved are neither delivered nor reported as read-and-excluded
    expect(items.counts("posts").accepted).toBe(n);
    expect(items.excludedItems("posts")).toHaveLength(0);
  });

  it("unchanged quantity: all ten pinned posts, no search (the case that always worked)", async () => {
    const plan = priced(pinned(), 10);
    const h = engineOn(plan);
    const { items } = await h.run();
    expect(h.calls).toHaveLength(0);
    expect(idsOf(items.acceptedRows("posts") as Array<Record<string, unknown>>)).toEqual(idsOf(pinned()));
  });

  it("an increase beyond the pinned rows keeps the old behaviour: a fresh read, never more than the approved count", async () => {
    const plan = edit(priced(pinned(), 10), 15);
    expect(plan.stages[0].planned_rows).toBe(15);
    const h = engineOn(plan);
    const { items } = await h.run();
    expect(h.calls.length).toBeGreaterThan(0);
    expect(items.acceptedRows("posts")).toHaveLength(15);
  });

  it("the delivered count is never above planned_rows, whatever the pinned count", async () => {
    for (const planned of [1, 2, 3, 7, 10]) {
      const h = engineOn(priced(pinned(), planned));
      const { items } = await h.run();
      expect(items.acceptedRows("posts").length).toBeLessThanOrEqual(planned);
      expect(items.acceptedRows("posts")).toHaveLength(planned);
    }
  });

  it("invalid pinned rows (a post without an id, or a repeated id) are not executed: the old fresh read stays the safe fallback, and nothing is invented", async () => {
    const noId = pinned(); delete noId[1].id;
    const repeated = pinned(); repeated[2].id = repeated[0].id;
    for (const rows of [noId, repeated]) {
      const h = engineOn(priced(rows, 3));
      const { items } = await h.run();
      expect(h.calls.length).toBeGreaterThan(0);
      expect(items.acceptedRows("posts")).toHaveLength(3);
    }
  });

  it("fewer pinned rows than approved (a stored plan of an older shape): the old fresh read, as before", async () => {
    const h = engineOn(priced(pinned(2), 3));
    const { items } = await h.run();
    expect(h.calls.length).toBeGreaterThan(0);
    expect(items.acceptedRows("posts")).toHaveLength(3);
  });

  it("resume and duplicate protection: a second run over the same store makes no call and keeps the same three posts once each", async () => {
    const plan = edit(priced(pinned(), 10), 3);
    const h = engineOn(plan);
    const first = await h.run();
    const idsFirst = idsOf(first.items.acceptedRows("posts") as Array<Record<string, unknown>>);
    const again = await h.run();
    expect(h.calls).toHaveLength(0);
    expect(idsOf(again.items.acceptedRows("posts") as Array<Record<string, unknown>>)).toEqual(idsFirst);
    expect(new Set(idsFirst).size).toBe(3);
    // a worker that restarted: a new engine over the stored files of the same mission
    const restarted = engineOn(plan, directEngine({ [A]: (): Out => ({ rows: pageOf("fresh", 1, 20), next: null }) }, { redesign: true, planned: 3, primary: A, storeFiles: h.store }));
    const third = await restarted.run();
    expect(restarted.calls).toHaveLength(0);
    expect(idsOf(third.items.acceptedRows("posts") as Array<Record<string, unknown>>)).toEqual(idsFirst);
  });

  it("the run does not change the plan's money: the stored price, reserve and planned rows are the same after the run", async () => {
    const plan = edit(priced(pinned(), 10), 3);
    const money = JSON.stringify({ price: plan.price, planned: plan.stages[0].planned_rows, quantity: plan.quantity });
    const h = engineOn(plan);
    await h.run();
    expect(JSON.stringify({ price: plan.price, planned: plan.stages[0].planned_rows, quantity: plan.quantity })).toBe(money);
  });
});

describe("pinnedSubsetOf: one rule for every platform's parent stage", () => {
  const stageOf = (key: string, rows: Array<Record<string, unknown>>, planned: number, spares?: Array<Record<string, unknown>>) => ({ key, planned_rows: planned, pinned_rows: rows, ...(spares ? { spare_rows: spares } : {}) } as never);
  it.each(["posts", "videos", "tweets"])("%s: equal count is the whole list, as before; fewer approved is the first rows in order; more approved is null (a fresh read)", (key) => {
    expect(pinnedSubsetOf(stageOf(key, pinned(), 10))!.rows).toHaveLength(10);
    expect(idsOf(pinnedSubsetOf(stageOf(key, pinned(), 4))!.rows)).toEqual(["fb-1", "fb-2", "fb-3", "fb-4"]);
    expect(pinnedSubsetOf(stageOf(key, pinned(), 11))).toBeNull();
    expect(pinnedSubsetOf(stageOf(key, [], 3))).toBeNull();
    expect(pinnedSubsetOf({ key, planned_rows: 3 } as never)).toBeNull();
  });
  it("a parent stage with spare parents: the approved posts first, then the posts the customer dropped (in rank order), then the original spares, so a parent with no comments is replaced by the next-ranked post as before", () => {
    const spares = [{ id: "sp-1" }, { id: "sp-2" }];
    const s = pinnedSubsetOf(stageOf("videos", pinned(), 2, spares))!;
    expect(idsOf(s.rows)).toEqual(["fb-1", "fb-2"]);
    expect(idsOf(s.spares)).toEqual([...pinned().slice(2).map((r) => String(r.id)), "sp-1", "sp-2"]);
    // a stage that never had spares gets none: the dropped posts are not delivered and not kept
    expect(pinnedSubsetOf(stageOf("videos", pinned(), 2))!.spares).toEqual([]);
  });
});

describe("the methodology's relevance totals after the edit", () => {
  it("10 -> 3: the delivered file says 3 about the topic and 0 hashtag-only, from the three pinned posts' own marks, and nothing is unavailable", async () => {
    const plan = edit(priced(pinned(), 10), 3);
    const h = engineOn(plan);
    const { items } = await h.run();
    const rows = items.acceptedRows("posts") as Array<Record<string, unknown>>;
    const record: StageRecord = { found: 3, duplicates: 0, accepted: 3, excluded: 0, pending: 0, unchecked: 0, acceptedByRule: 3, acceptedByModel: 0, excludedByReason: {}, stop: "target_reached" };
    const facts: MissionFacts = { requestText: "عايز ١٠ منشورات عامة من فيسبوك عن الذكاء الاصطناعي", deliveredAt: new Date("2026-11-04T18:18:00Z"), stages: { posts: record }, reviewStop: null };
    const m = buildMethodology({ plan, layouts: [], rowsByStage: { posts: rows }, facts });
    const item = m.items.find((i) => i.label === "صلة النتائج بالموضوع")!;
    expect(item.values.slice(0, 2)).toEqual(["النص يتحدث عن الموضوع: ٣ منشورات", "الموضوع مذكور في الوسوم فقط: ٠ منشورًا"]);
    expect(item.values.join(" ")).not.toContain("غير متاح");
    // the real workbook: the same totals, three rows, the mark column filled
    const xlsx = (await buildMissionFiles(plan, { posts: rows }, facts)).xlsx;
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
    expect(wb.worksheets[1].rowCount).toBe(4);
    const marks = [2, 3, 4].map((r) => String(wb.worksheets[1].getRow(r).getCell(3).value ?? ""));
    expect(marks).toEqual([ABOUT, ABOUT, ABOUT]);
  });

  it("10 -> 5: 3 about the topic and 2 hashtag-only (the first five pinned posts), the totals add up to the delivered five", async () => {
    const plan = edit(priced(pinned(), 10), 5);
    const { items } = await engineOn(plan).run();
    const rows = items.acceptedRows("posts") as Array<Record<string, unknown>>;
    const m = buildMethodology({ plan, layouts: [], rowsByStage: { posts: rows }, facts: { requestText: "x", deliveredAt: new Date("2026-11-04T18:18:00Z"), stages: {}, reviewStop: null } });
    expect(m.items.find((i) => i.label === "صلة النتائج بالموضوع")!.values.slice(0, 2)).toEqual(["النص يتحدث عن الموضوع: ٣ منشورات", "الموضوع مذكور في الوسوم فقط: منشورين"]);
  });
});

describe("this round touches no money file", () => {
  it("the engine file imports no pricing, ledger, settlement or gateway-cap module for the new rule", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("agent/src/engine/run.ts", "utf8");
    const at = src.indexOf("export function pinnedSubsetOf");
    expect(at).toBeGreaterThan(0);
    const body = src.slice(at, src.indexOf("\n}\n", at));
    expect(body).not.toMatch(/price|ledger|settle|charge|reserve|gateway|cap\b/i);
  });
});
