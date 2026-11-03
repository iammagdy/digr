import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { runEngine } from "../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { buildMissionFiles } from "../agent/src/workbook";
import { alternativeRoutesOf, missionFactsOf, routesOfFacts } from "../agent/src/methodology";
import { checkDeliveryContract, alternativeRoutesAr, alternativesGapLineAr, expectedCommentsOf, type ContractInput } from "../src/lib/agentMission/foundation/deliveryContract";
import { reportedPlan, withPromiseCaps } from "../src/lib/agentMission/repliesCard";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import { CHILD_COLUMNS } from "../src/lib/agentMission/foundation/toolCards";
import { cellsOf } from "./helpers/round11Worlds";

/**
 * ROUND 16, PART 3: WHEN ALL THE ALTERNATIVES ARE EXHAUSTED, the gap line per parent says the expected count, the unique comments delivered, the gap, and that the main route and N alternative routes were tried, in white-label words, FROM THE PERSISTED EXECUTION EVIDENCE ONLY
 * (the streams the item store wrote). Delivery contract R2 requires that statement when a real shortfall happened after alternatives were tried. SYNTHETIC deliveries: the pages are made up; the wording and the rule are what is tested.
 */
const col = (key: string, title_ar: string) => ({ key, title_ar });
const stage = (o: Record<string, unknown>): PricedStage => ({ endpoint_id: "e", parent_key: null, deliver: true, sample_rows: [], measured_by: [], columns: [col("text", "نص")], ...o }) as unknown as PricedStage;
const PROVIDERS = /anyapi|scrapecreators|tikhub|crawl4ai|justoneapi|youtube\.youtube|endpoint|api\b|usd|\$|openai|anthropic|claude|gemini/i;

describe("the wording", () => {
  it("N alternative routes, in Arabic words and Arabic-Indic digits", () => {
    expect(alternativeRoutesAr(1)).toBe("مسارًا بديلًا واحدًا");
    expect(alternativeRoutesAr(2)).toBe("مسارين بديلين");
    expect(alternativeRoutesAr(3)).toBe("٣ مسارات بديلة");
  });
  it("the line names the expected count, the unique delivered, the gap, the main route and the alternatives tried; no provider, no endpoint, no price", () => {
    const line = alternativesGapLineAr({ parentNoun: "منشور", n: 2, expected: 54, delivered: 34, alternatives: 1 });
    expect(line).toBe("المنشور رقم ٢: المتوقع ٥٤ تعليقًا، وسُلّم ٣٤ تعليقًا فريدًا، والفرق ٢٠؛ جرّبنا المسار الرئيسي ومسارًا بديلًا واحدًا للمنصة نفسها، ولم يعطِ أيٌّ منها الباقي.");
    expect(line).not.toMatch(PROVIDERS);
    expect(line).not.toMatch(/[0-9]/);
    expect(line).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
  it("the expectation is one rule: the parent's counter (never above the number asked per parent), else the number asked; an open stage has none", () => {
    expect(expectedCommentsOf({ per_parent_rows: 30 }, { comments: 54 })).toBe(30);
    expect(expectedCommentsOf({ per_parent_rows: 30 }, { comments: 20 })).toBe(20);
    expect(expectedCommentsOf({ per_parent_rows: 30 }, {})).toBe(30);
    expect(expectedCommentsOf({ children_cap_per_parent: 100 }, {})).toBeNull();
  });
});

describe("R2 requires the statement when a shortfall happened after alternatives were tried", () => {
  const posts = stage({ key: "posts", title_ar: "المنشورات", expected_rows: 2, planned_rows: 2 });
  const comments = stage({ key: "comments", title_ar: "التعليقات", expected_rows: 60, planned_rows: 60, parent_key: "posts", per_parent_rows: 30 });
  const plan = { summary_ar: "x", stages: [posts, comments], price: { deliveredRows: 62 } } as unknown as PricedPlan;
  const rowsByStage = { posts: [{ id: "p0", comments: 30 }, { id: "p1", comments: 30 }], comments: [...Array.from({ length: 18 }, (_, i) => ({ id: `a${i}`, parent_id: "p0" })), ...Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, parent_id: "p1" }))] };
  const input = (over: Partial<ContractInput> = {}): ContractInput => ({ plan, rowsByStage, sheets: [], limitLines: [], numbers: { card: null, file: null, chat: null, notice: null, orders: null, fileDelivered: null, deliveredRows: 50 }, now: Date.UTC(2026, 10, 3), ...over });
  // the per-parent lines only (the stage-level «سُلّم X من Y» line is its own rule, not under test here)
  const r2 = (c: ContractInput) => checkDeliveryContract(c).filter((v) => v.rule === "R2" && v.rowId !== null);

  it("without routes (no alternative ever answered) the plain gap line is what R2 asks for, as before", () => {
    const v = r2(input());
    expect(v.map((x) => x.rowId)).toContain("p0");
    expect(v.find((x) => x.rowId === "p0")!.fix).toMatchObject({ kind: "limit_line" });
    expect((v.find((x) => x.rowId === "p0")!.fix as { text: string }).text).not.toContain("المسار الرئيسي");
  });
  it("with one alternative route recorded for the short parent, a plain gap line is NOT enough: R2 asks for the statement and completes it with the exact words", () => {
    const plain = "المنشور رقم ١: المتوقع ٣٠، وسُلّم ١٨؛ والفرق لم يعطِه المصدر";
    const v = r2(input({ routes: { comments: { p0: 1 } }, limitLines: [plain] }));
    expect(v).toHaveLength(1);
    expect(v[0].rowId).toBe("p0");
    const fix = v[0].fix as { kind: string; text: string };
    expect(fix.text).toBe(alternativesGapLineAr({ parentNoun: "منشور", n: 1, expected: 30, delivered: 18, alternatives: 1 }));
    expect(fix.text).not.toMatch(PROVIDERS);
  });
  it("with the statement present, R2 is satisfied; a parent that was filled needs none", () => {
    const line = alternativesGapLineAr({ parentNoun: "منشور", n: 1, expected: 30, delivered: 18, alternatives: 1 });
    expect(r2(input({ routes: { comments: { p0: 1 } }, limitLines: [line] }))).toEqual([]);
  });
  it("a statement for another number of routes, or without the main route, does not satisfy it", () => {
    const two = alternativesGapLineAr({ parentNoun: "منشور", n: 1, expected: 30, delivered: 18, alternatives: 2 });
    expect(r2(input({ routes: { comments: { p0: 1 } }, limitLines: [two] })).length).toBe(1);
    expect(r2(input({ routes: { comments: { p0: 1 } }, limitLines: ["المنشور رقم ١: المتوقع ٣٠، وسُلّم ١٨ تعليقًا فريدًا؛ جرّبنا مسارًا بديلًا واحدًا"] })).length).toBe(1);
  });
});

describe("end to end, from the engine's own persisted streams to the delivered file (SYNTHETIC sources)", () => {
  const NOW = Date.parse("2026-11-03T12:00:00Z");
  const MAIN = "syn.main";
  const ALT = "syn.alt";
  const MAP = { map_code: "return inputs.page", map_file_id: "page" };
  const comment = (p: string, i: number) => ({ id: `${p}${i}`, text: `تعليق ${p}${i}`, author: "كاتب", posted_at: "2026-11-02T10:00:00.000Z", likes: 0, replies_count: null, language: "ar" });
  const batch = (p: string, n: number) => Array.from({ length: n }, (_, i) => comment(p, i + 1));
  const parents = [{ id: "p0", text: "منشور ١", link: "https://example.test/p0", comments: 30 }, { id: "p1", text: "منشور ٢", link: "https://example.test/p1", comments: 30 }];
  const plan = {
    summary_ar: "x",
    stages: [
      { key: "posts", title_ar: "المنشورات", endpoint_id: "syn.parents", expected_rows: 2, planned_rows: 2, parent_key: null, deliver: true, columns: [col("text", "النص"), col("link", "الرابط"), col("comments", "عدد التعليقات")], sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0, yield_share: 1, review_share: 0, pinned_rows: parents, engine: { endpoint_id: "syn.parents", params: {}, cursor_param: null, ...MAP, parent_binding: null, built_by: "code" } },
      { key: "comments", title_ar: "التعليقات", endpoint_id: MAIN, expected_rows: 60, planned_rows: 60, parent_key: "posts", per_parent_rows: 30, deliver: true, columns: CHILD_COLUMNS.map((c) => ({ ...c })), sample_rows: [], measured_by: [], measured_cost_per_row_usd: 0.0003, yield_share: 1, review_share: 0, parent_pins: ["p0", "p1"],
        engine: { endpoint_id: MAIN, params: {}, cursor_param: "cursor", ...MAP, parent_binding: { param: "url", from: "link" }, built_by: "code", alternatives: [{ endpoint_id: ALT, params: {}, cursor_param: "after", ...MAP, parent_binding: { param: "post", from: "link" } }] } },
    ],
    price: { deliveredRows: 62 },
    compiled: { by: "compiler", platform: "instagram", promises: {}, conditions: { named: false, period: false, language: false, country: false, topic: false } },
  } as unknown as PricedPlan;

  async function run(handlers: Record<string, (p: Record<string, unknown>) => Array<Record<string, unknown>>>) {
    const store = createMemoryStore();
    let seq = 0;
    const gateway = { async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const rows = handlers[String(input.endpoint_id)]((input.params ?? {}) as Record<string, unknown>);
      const callId = `call_${String((seq += 1)).padStart(4, "0")}`;
      await store.putFile("msn_gap", RAW_PATH(callId), JSON.stringify(rows), "application/json");
      return { ok: true as const, call_id: callId, http_status: 200, rows_in_page: rows.length, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "" };
    } } as unknown as Gateway;
    const items = await ItemStore.open(store, "msn_gap");
    await runEngine({ items, store, plan, missionId: "msn_gap", gateway, sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }), addEvent: async () => undefined, now: () => NOW, deadlineMs: NOW + 3_600_000, sleep: async () => undefined, redesignStages: new Set(["posts", "comments"]) });
    const snap = items.snapshotOfMemory();
    const rowsByStage: Record<string, Array<Record<string, unknown>>> = { posts: snap.acceptedRows("posts"), comments: snap.acceptedRows("comments", 60) };
    const facts = missionFactsOf({ requestText: "x", plan, snap, reviewStop: null, deliveredAt: new Date(NOW) });
    const judged = reportedPlan(withPromiseCaps(plan), { posts: rowsByStage.posts.length, comments: rowsByStage.comments.length });
    const built = await buildMissionFiles(judged, rowsByStage, facts, undefined, { approvedPlan: plan, now: NOW, completeContract: false });
    return { snap, facts, built, rowsByStage };
  }
  const allCells = async (xlsx: Buffer): Promise<string[]> => Object.values(await cellsOf(xlsx)).flat(2);

  it("p0: the main route gave 12, the alternative 6 more (5 of its 11 repeated): 18 unique of 30. The file says so for p0 only, with the numbers; R2 finds nothing missing even with no completion", async () => {
    const { facts, built, rowsByStage, snap } = await run({
      [MAIN]: (p) => (String(p.url).endsWith("p0") ? batch("m", 12) : batch("n", 30)),
      [ALT]: () => [...batch("m", 5), ...batch("a", 6)],
    });
    expect(rowsByStage.comments.filter((r) => r.parent_id === "p0")).toHaveLength(18);
    // the persisted evidence: one alternative route answered, for p0 only
    expect(alternativeRoutesOf(snap.stage("comments").streams)).toEqual({ p0: 1 });
    expect(routesOfFacts(facts)).toEqual({ comments: { p0: 1 } });
    const cells = (await allCells(built.xlsx)).join("\n");
    expect(cells).toContain(alternativesGapLineAr({ parentNoun: "منشور", n: 1, expected: 30, delivered: 18, alternatives: 1 }));
    expect(cells).not.toMatch(/المنشور رقم ٢: المتوقع/);
    expect(built.contract.violations.filter((v) => v.rule === "R2")).toEqual([]);
    expect(cells).not.toMatch(PROVIDERS);
  });
  it("an alternative that was called and gave nothing still counts as tried (a call was made and recorded); one that was never called is not claimed", async () => {
    const empty = await run({ [MAIN]: (p) => (String(p.url).endsWith("p0") ? batch("m", 12) : batch("n", 30)), [ALT]: () => [] });
    expect(routesOfFacts(empty.facts)).toEqual({ comments: { p0: 1 } });
    expect((await allCells(empty.built.xlsx)).join("\n")).toContain(alternativesGapLineAr({ parentNoun: "منشور", n: 1, expected: 30, delivered: 12, alternatives: 1 }));
    const full = await run({ [MAIN]: (p) => batch(String(p.url).endsWith("p0") ? "x" : "y", 30), [ALT]: () => { throw new Error("the alternative must not be called"); } });
    expect(routesOfFacts(full.facts)).toEqual({});
    expect((await allCells(full.built.xlsx)).join("\n")).not.toContain("المسار الرئيسي");
  });
});
