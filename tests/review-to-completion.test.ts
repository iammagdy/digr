import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import { createReviewer, type ReviewCall } from "../agent/src/review";
import { shortfallClauseAr, stageTruthBodyAr } from "../agent/src/finalize";
import { AGENT_REVIEW_ROW_ESTIMATE_USD } from "../src/lib/agentMission/constants";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import type { RelevanceSpec } from "../src/lib/agentMission/relevance";

/**
 * AUDIT 2026-11 PR 2, item 1 (G13): THE REVIEW GOES ON UNTIL THE REQUESTED COUNT IS REACHED OR THE CEILING IS HIT, and the closing sentence says only what was recorded.
 * Audit evidence: 11 of 104 results said the review reached its limit (6 «بلغت حدّها المسموح»), one of them (msn_24d0cf1d…) with 5 requested, 2 delivered and a recorded review spend of 0.0000.
 * Found in the code: (a) one ingest pass reviewed a single slice of the waiting items and left the rest for a later round; (b) the sentence «بلغت حدّها المسموح» was said for ANY waiting item whose review had no recorded stop at all («failed» was the only other case); (c) a stop was recorded without
 * saying why (spent, budget, ceiling, the worst case of the call that did not fit).
 */
const MISSION = "msn_rv";
const SPEC: RelevanceSpec = { subject_ar: "اللاعب", terms: ["صلاح"], context_terms: ["هدف"], text_columns: ["text"], min_own_words: 0 };
const stage = (over: Partial<PricedStage> = {}): PricedStage => ({ key: "tweets", title_ar: "التغريدات", endpoint_id: "e", expected_rows: 5, planned_rows: 5, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [], measured_by: [], measured_from_calls: [], filters: [], relevance: SPEC, ...over } as unknown as PricedStage);
const planOf = (s: PricedStage): PricedPlan => ({ summary_ar: "x", stages: [s], price: { deliveredRows: s.planned_rows } } as unknown as PricedPlan);
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `u${i}`, text: `أعتقد أن صلاح لاعب مختلف رقم ${i}` }));
const deps = (items: ItemStore, plan: PricedPlan, reviewer: ReturnType<typeof createReviewer>) => ({ items, plan, reviewer, addEvent: async () => {} });
/** The model approves one row in fifteen (by the row's number). */
const oneInFifteen: ReviewCall = async ({ user }) => {
  const nums = [...user.matchAll(/^\d+\.\s.*رقم (\d+)/gm)].map((m) => Number(m[1]));
  return { text: JSON.stringify(nums.map((n) => (n % 15 === 0 ? 1 : 0))), usage: { input_tokens: 100, output_tokens: 10 } };
};

describe("the review of one pass goes on, batch after batch, until the room is filled", () => {
  it("5 requested, 100 waiting, the model approves 1 in 15: ONE ingest pass delivers 5 (before: the first slice of 40 gave 3 and 60 stayed waiting)", async () => {
    const store = createMemoryStore();
    const items = await ItemStore.open(store, MISSION);
    const s = stage();
    const plan = planOf(s);
    const reviewer = createReviewer({ call: oneInFifteen, store, missionId: MISSION, requestText: "صلاح", budgetUsd: 1, ceilingUsd: 1 });
    await ingestRows(deps(items, plan, reviewer), s, rows(100));
    expect(items.counts("tweets").accepted).toBe(5);
    expect((await reviewer.state()).stop).toBeNull();
  });
});

describe("a stop is logged with what set it", () => {
  it("the ceiling stop says spent, budget, ceiling and the worst case of the call that did not fit", async () => {
    const store = createMemoryStore();
    const lines: string[] = [];
    const reviewer = createReviewer({ call: oneInFifteen, store, missionId: MISSION, requestText: "صلاح", budgetUsd: 0.00001, ceilingUsd: 0.00005, log: (l) => lines.push(l) });
    await reviewer.review({ subject: "اللاعب", rows: rows(60).map((r) => ({ id: r.id, text: r.text })) });
    expect((await reviewer.state()).stop).toBe("budget");
    const line = lines.find((l) => l.startsWith("review_stop"));
    expect(line).toBeTruthy();
    expect(line).toMatch(/reason=budget/);
    for (const k of ["spent=", "budget=", "ceiling=", "worst="]) expect(line).toContain(k);
  });
  it("a model that could not be reached logs reason=failed with the failed calls", async () => {
    const store = createMemoryStore();
    const lines: string[] = [];
    const reviewer = createReviewer({ call: async () => null, store, missionId: MISSION, requestText: "صلاح", budgetUsd: 1, ceilingUsd: 1, log: (l) => lines.push(l) });
    await reviewer.review({ subject: "اللاعب", rows: rows(5).map((r) => ({ id: r.id, text: r.text })) });
    expect(lines.find((l) => l.startsWith("review_stop"))).toMatch(/reason=failed.*failed_calls=\d+/);
  });
});

describe("the closing sentence is built from the RECORDED stop only", () => {
  it("waiting items and a recorded budget stop: the limit sentence; a recorded failure: the unreachable sentence", () => {
    expect(shortfallClauseAr("source_exhausted", { pending: 3, stop: "budget" })).toContain("بلغت حدّها المسموح");
    expect(shortfallClauseAr("source_exhausted", { pending: 3, stop: "failed" })).toContain("تعذّر الوصول إليها");
  });
  it("waiting items with NO recorded stop never claim a limit (nothing recorded says the review reached one)", () => {
    const clause = shortfallClauseAr("source_exhausted", { pending: 3, stop: null });
    expect(clause).not.toContain("بلغت حدّها");
    expect(clause).not.toContain("تعذّر الوصول");
    const body = stageTruthBodyAr({ found: 20, duplicates: 0, delivered: 2, excludedByReason: { no_verified_contact: 3 }, pending: 4, reviewStop: null, stop: "source_exhausted", people: false });
    expect(body ?? "").not.toContain("بلغت حدّها");
  });
});

describe("the review's price per row is the measured one", () => {
  it("measured live (msn_ecca2a0d…: 2 calls, 5,019 input and 150 output tokens for 50 rows = 0.000577 USD): about 0.0000115 a row; the estimate is that with a margin, not 0.00004", () => {
    expect(AGENT_REVIEW_ROW_ESTIMATE_USD).toBeGreaterThanOrEqual(0.0000115);
    expect(AGENT_REVIEW_ROW_ESTIMATE_USD).toBeLessThanOrEqual(0.00002);
  });
});
