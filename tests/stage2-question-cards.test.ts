import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAsk, type Ask } from "../src/lib/agentMission/foundation/ask";
import { parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { compileAsk } from "../src/lib/agentMission/stage2/askCard";
import { MAX_QUESTION_CARDS, QUESTION_CODES, answerQuestionCard, questionCardsFor, type QuestionCard } from "../src/lib/agentMission/stage2/questionCards";

/**
 * STAGE 2 (docs/STAGE-2.md), THE QUESTION CARDS: at most three, ordered by importance, from the Ask's gaps (code only). The count question is «تحب كام؟» with one-tap choices and a budget
 * option; a budget answer becomes the hard ceiling of the hold (the compiler's own `fitToBudget`). Pages: the stored real pages of M12 (msn_5851abc92a1e6645a9cd).
 */
const catalog = loadTregCatalog();
const AT = Date.parse("2026-11-02T12:00:00Z");
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };
const request = (id: string) => fixture.missions.find((m) => m.id === id)!.request;
const page = (mission: string, call: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${mission}/raw/${call}.json`, import.meta.url), "utf8"));
const ask = (text: string): Ask => buildAsk(text, null, AT);
const codes = (cards: QuestionCard[]) => cards.map((c) => c.code);

describe("which questions, in which order", () => {
  it("a request with every gap gets the three most important ones only: the platform, the count, then the comments number", () => {
    const cards = questionCardsFor(ask("هات فيديوهات عن الذكاء الاصطناعي مع تعليقات"), { requestText: "هات فيديوهات عن الذكاء الاصطناعي مع تعليقات", alreadyAsked: 0 });
    expect(codes(cards)).toEqual(["platform", "count", "per_parent"]);
  });
  it("a recurring event with no year (YouTube) is asked right after the count, before the comments number", () => {
    const text = "هات فيديوهات على يوتيوب عن نهائي السوبر المصري مع تعليقات";
    expect(codes(questionCardsFor(ask(text), { requestText: text, alreadyAsked: 0 }))).toEqual(["count", "occurrence", "per_parent"]);
  });
  it("never more than three, and never more than the three a request may have in all (questions already asked count)", () => {
    const text = "هات فيديوهات عن الذكاء الاصطناعي مع تعليقات";
    for (let asked = 0; asked <= 4; asked += 1) {
      const cards = questionCardsFor(ask(text), { requestText: text, alreadyAsked: asked });
      expect(cards.length).toBeLessThanOrEqual(MAX_QUESTION_CARDS);
      expect(cards.length).toBeLessThanOrEqual(Math.max(0, 3 - asked));
    }
    expect(MAX_QUESTION_CARDS).toBe(3);
  });
  it("every stored request of the 20 missions gets at most three cards, and a request with a count, a number of comments and no event gets none", () => {
    for (const m of fixture.missions) expect(questionCardsFor(ask(m.request), { requestText: m.request, alreadyAsked: 0 }).length).toBeLessThanOrEqual(3);
    const full = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، و٢٠ تعليق من كل فيديو مع ردودهم";
    expect(questionCardsFor(ask(full), { requestText: full, alreadyAsked: 0 })).toEqual([]);
  });
  it("an ambiguous topic relation is asked (about it, or made with it)", () => {
    const text = "هات ١٠ فيديوهات تيك توك ذكاء اصطناعي";
    const a = ask(text);
    const withRelation: Ask = { ...a, topic: { text: a.topic.text ?? "ذكاء اصطناعي", relation: "ambiguous" } };
    expect(codes(questionCardsFor(withRelation, { requestText: text, alreadyAsked: 0 }))).toContain("topic_relation");
  });
  it("the codes are a fixed list", () => {
    expect([...QUESTION_CODES]).toEqual(["platform", "count", "occurrence", "topic_relation", "per_parent"]);
  });
});

describe("«تحب كام؟»: one-tap choices and a budget", () => {
  const text = "هات فيديوهات تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود";
  const count = () => questionCardsFor(ask(text), { requestText: text, alreadyAsked: 0 }).find((c) => c.code === "count")!;
  it("the card asks «تحب كام فيديو؟» with ١٠، ٥٠، ١٠٠ and a budget option, every word Arabic", () => {
    const c = count();
    expect(c.questionAr.startsWith("تحب كام فيديو؟")).toBe(true);
    expect(c.options.map((o) => o.labelAr)).toEqual(["١٠", "٥٠", "١٠٠", "حدد ميزانية بالنقاط"]);
    expect(c.options.map((o) => o.value)).toEqual(["10", "50", "100", "budget"]);
    expect(c.budgetInput).toBe(true);
    expect(checkCustomerText(c.questionAr).issues).toEqual([]);
    for (const o of c.options) expect(checkCustomerLabel(o.labelAr).issues).toEqual([]);
  });
  it("a tap on ٥٠ sets the count to 50", () => {
    const r = answerQuestionCard(ask(text), count(), { option: "50" }, { nowMs: AT });
    expect(r.ok && r.ask.count).toBe(50);
  });
  it("THE BUDGET IS A HARD CEILING: «حدد ميزانية» with 400 points becomes the Ask's budget, and the plan compiled from M12's stored pages holds at most 400", () => {
    const a = ask(text);
    const r = answerQuestionCard(a, count(), { option: "budget", budget: 400 }, { nowMs: AT });
    if (!r.ok) throw new Error(r.reason);
    expect(r.ask.edits.budget).toBe(400);
    expect(r.ask.count).toBeNull();
    const card = cardOf("tikhub.tiktok.search.videos")!;
    const comments = page("msn_5851abc92a1e6645a9cd", "call_0008");
    const base = { pool: { card, params: parentInputs(card, r.ask), pages: [{ callId: "call_0007", page: page("msn_5851abc92a1e6645a9cd", "call_0007") }] }, exposure: (id: string) => ({ callId: `x_${id}`, page: comments, failed: false }), capabilityOf: (id: string) => catalog.byId.get(id)?.capability ?? null };
    const plan = compileAsk(base, r.ask);
    if (plan.kind !== "plan") throw new Error(plan.kind);
    expect(plan.result.plan.price.reservePoints).toBeLessThanOrEqual(400);
    expect(plan.result.plan.notes_ar?.[0]).toContain("ولا يتجاوز ميزانيتك");
  });
  it("a budget option with no number, or a number that is not whole, is refused with a code", () => {
    expect(answerQuestionCard(ask(text), count(), { option: "budget" }, { nowMs: AT })).toEqual({ ok: false, reason: "not_whole_number" });
    expect(answerQuestionCard(ask(text), count(), { option: "budget", budget: 12.5 }, { nowMs: AT })).toEqual({ ok: false, reason: "not_whole_number" });
    expect(answerQuestionCard(ask(text), count(), { option: "7" }, { nowMs: AT })).toEqual({ ok: false, reason: "unknown_choice" });
  });
  it("«شيء آخر»: a typed number on the count card is the count", () => {
    const c = count();
    expect(c.other).toBe(true);
    const r = answerQuestionCard(ask(text), c, { other: "٣٠" }, { nowMs: AT });
    expect(r.ok && r.ask.count).toBe(30);
  });
});

describe("the other answers become Ask values by code", () => {
  it("the platform card sets the platform and its parent noun", () => {
    const text = "هات فيديوهات عن الذكاء الاصطناعي";
    const c = questionCardsFor(ask(text), { requestText: text, alreadyAsked: 0 }).find((x) => x.code === "platform")!;
    expect(c.options.map((o) => o.value)).toEqual(["tiktok", "x", "facebook", "instagram", "youtube"]);
    const r = answerQuestionCard(ask(text), c, { option: "youtube" }, { nowMs: AT });
    expect(r.ok && [r.ask.platform, r.ask.parentKind]).toEqual(["youtube", "videos"]);
  });
  it("the comments-number card: «كل التعليقات» or a number for each parent", () => {
    const text = "هات ١٠ فيديوهات تيك توك عن الذكاء الاصطناعي مع تعليقات";
    const c = questionCardsFor(ask(text), { requestText: text, alreadyAsked: 0 }).find((x) => x.code === "per_parent")!;
    const all = answerQuestionCard(ask(text), c, { option: "all" }, { nowMs: AT });
    expect(all.ok && [all.ask.comments, all.ask.commentsPerParent]).toEqual(["all", null]);
    const fifty = answerQuestionCard(ask(text), c, { option: "50" }, { nowMs: AT });
    expect(fifty.ok && [fifty.ask.comments, fifty.ask.commentsPerParent]).toEqual(["some", 50]);
  });
  it("the occurrence card keeps the customer's choice on the Ask (a year becomes that year's Cairo period)", () => {
    const text = "هات فيديوهات على يوتيوب عن نهائي السوبر المصري مع تعليقات";
    const c = questionCardsFor(ask(text), { requestText: text, alreadyAsked: 0 }).find((x) => x.code === "occurrence")!;
    const latest = answerQuestionCard(ask(text), c, { option: "latest" }, { nowMs: AT });
    expect(latest.ok && latest.ask.occurrence).toEqual({ kind: "latest" });
    const year = answerQuestionCard(ask(text), c, { option: "year", year: 2024 }, { nowMs: AT });
    expect(year.ok && [year.ask.occurrence, year.ask.period?.from, year.ask.period?.to]).toEqual([{ kind: "year", year: 2024 }, "2024-01-01", "2024-12-31"]);
  });
  it("every question and option of every card passes the customer-text rules", () => {
    const texts = ["هات فيديوهات عن الذكاء الاصطناعي مع تعليقات", "هات فيديوهات على يوتيوب عن نهائي السوبر المصري مع تعليقات", "هات منشورات فيسبوك عن الذكاء الاصطناعي مع تعليقات"];
    for (const t of texts) {
      const a = ask(t);
      for (const c of [...questionCardsFor(a, { requestText: t, alreadyAsked: 0 }), ...questionCardsFor({ ...a, topic: { text: "ذكاء اصطناعي", relation: "ambiguous" } }, { requestText: t, alreadyAsked: 1 })]) {
        expect(checkCustomerText(c.questionAr).issues, c.code).toEqual([]);
        for (const o of c.options) expect(checkCustomerLabel(o.labelAr).issues, `${c.code} ${o.value}`).toEqual([]);
      }
    }
  });
});
