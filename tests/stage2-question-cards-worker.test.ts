import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { readRunState, updateRunState } from "../agent/src/runState";
import { NO_ABOUT_OPTIONS_AR } from "../src/lib/agentMission/foundation/topicChoice";
import { topicRelationAnswerOf } from "../src/lib/agentMission/stage2/questionCards";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { replayGateway } from "./helpers/replayGateway";

/**
 * STAGE 2 S5 (docs/STAGE-2.md): with DIGER_STAGE2_QUESTION_CARDS on, the worker's questions before the plan come from the Stage 2 policy, ONE card at a time, in today's flow. The count and
 * comments cards are the same as today's; the new card is the topic relation. A budget answer gives a plan whose hold is at most the budget (stored real pages of M12, msn_5851abc92a1e6645a9cd).
 */
const catalog = loadTregCatalog();
const M12 = "msn_5851abc92a1e6645a9cd";
const NOW = Date.parse("2026-11-02T11:36:00Z");
const NO_COUNT = "هات فيديوهات تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم";
const refuseAll = { tregCall: async () => ({ ok: false as const, call_id: "call_9999", refused: "repeat_sample", message: "refused" }) };
const plan = (text: string, extra: Record<string, unknown> = {}, gateway: unknown = refuseAll, store = createMemoryStore()) =>
  planByCompiler({ mission: { id: "msn_s5", request_text: text, answer_text: null, created_at: "2026-11-02T11:35:00Z" }, gateway: gateway as never, store, catalog, nowMs: NOW, askCount: true, ...extra });

describe("the count card: the same as today, one at a time", () => {
  it("no count: «تحب كام فيديو؟» with ١٠، ٥٠، ١٠٠ and the budget option, identical to today's question", async () => {
    const today = await plan(NO_COUNT);
    const stage2 = await plan(NO_COUNT, { questionCards: true });
    if (stage2.kind !== "question" || today.kind !== "question") throw new Error("no question");
    expect(stage2.why).toBe("count");
    expect(stage2.question.startsWith("تحب كام فيديو؟")).toBe(true);
    expect(stage2.options).toEqual(["١٠", "٥٠", "١٠٠", "حدد ميزانية بالنقاط"]);
    expect([stage2.question, stage2.options]).toEqual([today.question, today.options]);
  });
  it("after three questions, none (the cap counts the questions already asked)", async () => {
    const r = await plan(NO_COUNT, { questionCards: true, questionsAsked: 3 });
    expect(r.kind === "question" && r.why === "count").toBe(false);
  });
});

describe("THE BUDGET IS A HARD CEILING: a budget answer gives a plan whose hold is at most the budget", () => {
  it("400 points chosen at the count card: the plan compiled on M12's stored pages holds at most 400", async () => {
    const store = createMemoryStore();
    const { gateway } = replayGateway(M12, catalog, store, "msn_s5_budget");
    const r = await planByCompiler({ mission: { id: "msn_s5_budget", request_text: NO_COUNT, answer_text: NO_ABOUT_OPTIONS_AR.useAsIs, created_at: "2026-11-02T11:35:00Z" }, gateway, store, catalog, nowMs: NOW, askCount: true, questionCards: true, choices: { budget: 400 }, answerIsChoice: true, questionsAsked: 2 });
    if (r.kind !== "plan") throw new Error(`${r.kind}${"reason" in r ? ` ${r.reason}` : ""}`);
    expect(r.plan.price.reservePoints).toBeLessThanOrEqual(400);
    expect(r.ask.edits.budget).toBe(400);
  });
});

describe("the topic-relation card (new)", () => {
  const AMBIGUOUS = "هات ١٠ فيديوهات تيك توك ذكاء اصطناعي";
  it("an ambiguous topic is asked, with two fixed options; today's flow (flag off) does not ask it", async () => {
    const r = await plan(AMBIGUOUS, { questionCards: true });
    if (r.kind !== "question") throw new Error(r.kind);
    expect(r.why).toBe("topic_relation");
    expect(r.options).toEqual(["محتوى يتكلم عن الموضوع", "محتوى معمول باستخدامه"]);
    expect(checkCustomerText(r.question).issues).toEqual([]);
    for (const o of r.options) expect(checkCustomerLabel(o).issues).toEqual([]);
    const today = await plan(AMBIGUOUS);
    expect(today.kind === "question" && today.why === "topic_relation").toBe(false);
  });
  it("the answer is read by its exact label, and the chosen relation is not asked again", async () => {
    expect(topicRelationAnswerOf("محتوى يتكلم عن الموضوع")).toBe("about");
    expect(topicRelationAnswerOf(" محتوى معمول باستخدامه ")).toBe("made_with");
    expect(topicRelationAnswerOf("شيء آخر")).toBeNull();
    const r = await plan(AMBIGUOUS, { questionCards: true, topicRelation: "about" });
    expect(r.kind === "question" && r.why === "topic_relation").toBe(false);
    expect(r.ask.topic.relation).toBe("about");
  });
});

describe("the run note keeps the topic card's state", () => {
  it("the pending card and the chosen relation survive a write and a read; anything else is dropped", async () => {
    const store = createMemoryStore();
    await updateRunState(store, "m", (r) => ({ ...r, stage2Pending: "topic_relation" }));
    expect((await readRunState(store, "m")).stage2Pending).toBe("topic_relation");
    await updateRunState(store, "m", (r) => { const { stage2Pending: _p, ...rest } = r; void _p; return { ...rest, topicRelation: "made_with" }; });
    const s = await readRunState(store, "m");
    expect([s.stage2Pending, s.topicRelation]).toEqual([undefined, "made_with"]);
    await store.putFile("m2", "run_state.json", JSON.stringify({ stage2Pending: "x", topicRelation: "y" }), "application/json");
    const bad = await readRunState(store, "m2");
    expect([bad.stage2Pending, bad.topicRelation]).toEqual([undefined, undefined]);
  });
  it("the worker uses the Stage 2 cards only when DIGER_STAGE2_QUESTION_CARDS is on for the account", () => {
    const src = readFileSync(new URL("../agent/src/runMission.ts", import.meta.url), "utf8");
    expect(src).toContain('const stage2Questions = compiledActive && stage2Enabled("DIGER_STAGE2_QUESTION_CARDS", redesign.isTest);');
    expect(src).toContain("...(stage2Questions ? { questionCards: true, ...(topicRelation ? { topicRelation } : {}) } : {})");
  });
});
