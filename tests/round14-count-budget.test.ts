import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { readRunState, updateRunState } from "../agent/src/runState";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { AGENT_MAX_QUESTIONS, BUDGET_QUESTION_AR, COUNT_OPTIONS_AR, PER_PARENT_OPTIONS_AR, budgetOfWords, choiceAnswerOf, questionNeeded } from "../src/lib/agentMission/foundation/countChoice";
import { fitToBudget } from "../src/lib/agentMission/foundation/budgetFit";
import type { CompileResult } from "../src/lib/agentMission/foundation/compilePlan";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { NO_ABOUT_OPTIONS_AR } from "../src/lib/agentMission/foundation/topicChoice";
import { catalog } from "./helpers/missionReplay";
import { replayGateway } from "./helpers/replayGateway";

/**
 * ROUND 14, PART B: THE COUNT QUESTION AND THE BUDGET CEILING. A request with no number of videos, posts or tweets is asked «تحب كام؟» before anything is read; comments asked with no number per parent are asked once; a budget in points is a hard ceiling on the hold,
 * the compiler builds the largest version that fits, priced by the price function, and the card says what the budget holds. At most three cards in all. A request that already has a count and no budget behaves exactly as today.
 */
const NOW = Date.parse("2026-11-02T11:36:00Z");
const M12 = "msn_5851abc92a1e6645a9cd";
const BASE_REQUEST = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم";
const NO_COUNT = "هات فيديوهات تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات مع تعليقاتها";
const ask = (text: string) => buildAsk(text, null, NOW);

describe("the words: a budget in points, the answers, and which question is needed", () => {
  it("a budget is said with points: «بميزانية ٣٠٠٠ نقطة», «ميزانيتي ٣٠٠٠ نقطة», «بحد أقصى ٥٠٠٠ نقطة», «لا تتجاوز ٢٠٠٠ نقطة»; a number with no «نقطة» is not a budget", () => {
    expect(budgetOfWords("هات فيديوهات تيك توك عن القهوة بميزانية ٣٠٠٠ نقطة")).toBe(3000);
    expect(budgetOfWords("ميزانيتي 4500 نقطة")).toBe(4500);
    expect(budgetOfWords("هات ١٠٠ تغريدة بحد أقصى ٥٠٠٠ نقطة")).toBe(5000);
    expect(budgetOfWords("لا تتجاوز ٢٠٠٠ نقطة")).toBe(2000);
    expect(budgetOfWords("هات ٣٠٠٠ تعليق")).toBeNull();
    expect(budgetOfWords("هات ٥٠ فيديو")).toBeNull();
  });
  it("the three ready answers, a typed count, «حدد ميزانية بالنقاط», a typed budget, «كل التعليقات» and a typed number per parent", () => {
    expect(choiceAnswerOf("٥٠", "count")).toEqual({ kind: "count", n: 50 });
    expect(choiceAnswerOf("١٠٠", "count")).toEqual({ kind: "count", n: 100 });
    expect(choiceAnswerOf("٧", "count")).toEqual({ kind: "count", n: 7 });
    expect(choiceAnswerOf(COUNT_OPTIONS_AR.budget, "count")).toEqual({ kind: "ask_budget" });
    expect(choiceAnswerOf("٣٠٠٠", "budget")).toEqual({ kind: "budget", points: 3000 });
    expect(choiceAnswerOf("٣٠٠٠ نقطة", "budget")).toEqual({ kind: "budget", points: 3000 });
    expect(choiceAnswerOf(PER_PARENT_OPTIONS_AR.all, "per_parent")).toEqual({ kind: "per_parent", n: "all" });
    expect(choiceAnswerOf("٢٥", "per_parent")).toEqual({ kind: "per_parent", n: 25 });
    expect(choiceAnswerOf("كلام آخر", "count")).toBeNull();
    expect(choiceAnswerOf("٥٠", null)).toBeNull();
  });
  it("no count: «تحب كام» with the four choices; a count (the request's, a choice, or a budget) leaves it out", () => {
    const q = questionNeeded(ask(NO_COUNT), {}, 0)!;
    expect(q.why).toBe("count");
    expect(q.question).toContain("تحب كام");
    expect(q.options).toEqual(["١٠", "٥٠", "١٠٠", "حدد ميزانية بالنقاط"]);
    expect(questionNeeded(ask(BASE_REQUEST), {}, 0)).toBeNull();
    expect(questionNeeded(ask(NO_COUNT), { count: 10 }, 0)?.why).not.toBe("count");
    expect(questionNeeded(ask(`${NO_COUNT} بميزانية ٣٠٠٠ نقطة`), { budget: 3000 }, 0)).toBeNull();
  });
  it("comments asked with no number per parent and not «all of them»: asked once; «كل التعليقات» in the request, or a number per parent, is the answer already", () => {
    const withCount = "هات ٥ فيديوهات تيك توك عن الذكاء الاصطناعي من مصر مع تعليقاتها";
    expect(questionNeeded(ask(withCount), {}, 0)?.why).toBe("per_parent");
    expect(questionNeeded(ask(withCount), { perParent: "all" }, 0)).toBeNull();
    expect(questionNeeded(ask("هات ٥ فيديوهات تيك توك عن الذكاء الاصطناعي من مصر مع ٢٠ تعليق من كل فيديو"), {}, 0)).toBeNull();
    expect(questionNeeded(ask("هات ٥ فيديوهات تيك توك عن الذكاء الاصطناعي من مصر مع كل التعليقات"), {}, 0)).toBeNull();
  });
  it("at most three question cards in all: the fourth is not asked", () => {
    expect(AGENT_MAX_QUESTIONS).toBe(3);
    expect(questionNeeded(ask(NO_COUNT), {}, 2)?.why).toBe("count");
    expect(questionNeeded(ask(NO_COUNT), {}, 3)).toBeNull();
  });
  it("every sentence passes checkCustomerText (Arabic, no provider, no price in dollars)", () => {
    const q = questionNeeded(ask(NO_COUNT), {}, 0)!;
    for (const t of [q.question, BUDGET_QUESTION_AR, ...q.options]) expect(checkCustomerText(t, { maxChars: 400 }).issues, t).toEqual([]);
  });
});

describe("the run note keeps the choices across questions (each answer replaces `answer_text`)", () => {
  it("count, comments per parent, budget, the pending question and the number of cards survive a re-read", async () => {
    const store = createMemoryStore();
    await updateRunState(store, "msn_r14_note", (r) => ({ ...r, choices: { count: 50, perParent: "all", budget: 3000 }, pending: "per_parent", questionsAsked: 2 }));
    const s = await readRunState(store, "msn_r14_note");
    expect(s.choices).toEqual({ count: 50, perParent: "all", budget: 3000 });
    expect(s.pending).toBe("per_parent");
    expect(s.questionsAsked).toBe(2);
  });
});

describe("the planner: the question comes BEFORE any read, and the budget is a ceiling (TikTok M12, the stored pages)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(NOW)); });
  afterAll(() => { vi.useRealTimers(); });
  const run = async (request: string, o: { askCount?: boolean; choices?: Record<string, unknown>; answer?: string } = {}) => {
    const store = createMemoryStore();
    const { gateway, stats } = replayGateway(M12, catalog, store, "msn_r14_cb");
    const out = await planByCompiler({ mission: { id: "msn_r14_cb", request_text: request, answer_text: o.answer ?? NO_ABOUT_OPTIONS_AR.useAsIs, created_at: "2026-11-02T11:35:00Z" }, gateway, store, catalog, nowMs: NOW, ...(o.askCount !== undefined ? { askCount: o.askCount } : {}), ...(o.choices ? { choices: o.choices as never } : {}) });
    return { out, stats };
  };
  it("no count: «تحب كام؟» is returned and NOTHING was read (no call, no cost)", async () => {
    const { out, stats } = await run(NO_COUNT, { askCount: true });
    if (out.kind !== "question") throw new Error(`expected a question, got ${out.kind}`);
    expect(out.why).toBe("count");
    expect(out.reads).toEqual({ pool: 0, exposure: 0 });
    expect(stats.served).toEqual([]);
    expect(stats.unserved).toEqual([]);
  });
  it("a request that has its count behaves exactly as today: the same plan, with and without the question switched on", async () => {
    const a = await run(BASE_REQUEST, { askCount: true });
    const b = await run(BASE_REQUEST);
    if (a.out.kind !== "plan" || b.out.kind !== "plan") throw new Error("expected plans");
    expect(JSON.stringify(a.out.plan)).toBe(JSON.stringify(b.out.plan));
  });
  it("a planning that does not switch the question on (a test, a tool) never asks: today's behaviour", async () => {
    const { out } = await run(NO_COUNT);
    expect(out.kind).not.toBe("question");
  });
  it("a budget is a hard ceiling: the version built has a hold at most the budget, the card says what it holds, and one more comment per parent would not fit", async () => {
    const full = await run(BASE_REQUEST);
    if (full.out.kind !== "plan") throw new Error("expected a plan");
    const fullHold = full.out.plan.price.reservePoints;
    const budget = Math.max(200, Math.floor(fullHold * 0.6));
    expect(budget).toBeLessThan(fullHold);
    const { out } = await run(`${BASE_REQUEST} بميزانية ${budget} نقطة`);
    if (out.kind !== "plan") throw new Error(`expected a plan, got ${out.kind}`);
    expect(out.plan.price.reservePoints).toBeLessThanOrEqual(budget);
    const card = out.plan.notes_ar!.find((n) => n.startsWith("ميزانيتك"))!;
    expect(card).toContain("تكفي تقريبًا لـ");
    expect(card).toContain("تعليق من كل فيديو");
    expect(card).toContain("ولا يتجاوز ميزانيتك");
    expect(checkCustomerText(card, { maxChars: 600 }).issues).toEqual([]);
    expect(out.ask.commentsPerParent).toBeLessThan(20);
    // the next comment per parent does not fit: the same plan asked for one more comment is above the budget
    const more = await run(`${BASE_REQUEST.replace("٢٠ تعليق", `${(out.ask.commentsPerParent ?? 1) + 1} تعليق`)}`);
    if (more.out.kind !== "plan") throw new Error("expected a plan");
    expect(more.out.plan.price.reservePoints).toBeGreaterThan(budget);
  });
  it("a budget that holds the whole request leaves the plan as it was, with the card line", async () => {
    const full = await run(BASE_REQUEST);
    if (full.out.kind !== "plan") throw new Error("expected a plan");
    const { out } = await run(`${BASE_REQUEST} بميزانية ${full.out.plan.price.reservePoints + 100} نقطة`);
    if (out.kind !== "plan") throw new Error("expected a plan");
    expect(out.plan.price.reservePoints).toBe(full.out.plan.price.reservePoints);
    expect(out.plan.notes_ar![0]).toContain("ميزانيتك");
  });
  it("a budget below the smallest version (one post, one comment) makes no plan, and says why (the minimum order)", async () => {
    const { out } = await run(`${BASE_REQUEST} بميزانية ٥٠ نقطة`);
    expect(out.kind).toBe("cannot");
    expect((out as { reason: string }).reason).toBe("budget_too_small");
  });
});

describe("fitToBudget finds the LARGEST version (a synthetic compiler with a known price)", () => {
  // hold = 10 + 3 x parents x comments per parent; the ask is 4 parents with every comment (capped at 100 here)
  const compileWith = (a: ReturnType<typeof ask>): CompileResult => {
    const parents = a.count ?? 4;
    const per = a.commentsPerParent ?? 100;
    return { ok: true, plan: { summary_ar: "x", stages: [{ key: "p", deliver: true, parent_key: null, planned_rows: parents }], price: { reservePoints: 10 + 3 * parents * per }, notes_ar: [] } } as unknown as CompileResult;
  };
  const base = { ...ask(NO_COUNT), count: 4, commentsPerParent: null, comments: "all" as const };
  it("the asked version fits: it is kept; one that does not fit gets the most comments per parent that fit (binary search), never above the budget", () => {
    const big = fitToBudget(compileWith, base, 100_000, 4, "فيديو");
    expect(big.ok && big.hold).toBe(10 + 3 * 4 * 100);
    const r = fitToBudget(compileWith, base, 500, 4, "فيديو");
    if (!r.ok) throw new Error("expected a fit");
    expect(r.parents).toBe(4);
    expect(r.commentsPerParent).toBe(40);          // 10 + 3 x 4 x 40 = 490 <= 500; x 41 = 502 > 500
    expect(r.hold).toBeLessThanOrEqual(500);
    expect(10 + 3 * 4 * 41).toBeGreaterThan(500);
  });
  it("when even one comment per parent does not fit, fewer parents are tried; below one parent and one comment there is none", () => {
    const small = fitToBudget(compileWith, base, 25, 4, "فيديو");
    if (!small.ok) throw new Error("expected a fit");
    // the asked number of parents is kept while one comment each fits (10 + 3 x 4 x 1 = 22 <= 25); only then are parents dropped
    expect(small.parents).toBe(4);
    expect(small.commentsPerParent).toBe(1);
    const fewer = fitToBudget(compileWith, base, 17, 4, "فيديو");
    if (!fewer.ok) throw new Error("expected a fit");
    expect([fewer.parents, fewer.commentsPerParent]).toEqual([2, 1]);   // 10 + 3 x 2 x 1 = 16 <= 17; three parents = 19 > 17
    const none = fitToBudget(compileWith, base, 12, 4, "فيديو");
    expect(none).toMatchObject({ ok: false, reason: "budget_too_small" });
  });
});
