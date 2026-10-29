import { afterEach, describe, expect, it, vi } from "vitest";
import { assertReplayInvariants, readWorkbook, replay } from "./helpers/agentReplay";
import { callIds, planningFlow, type Results } from "./helpers/agentFakeWorld";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";
import { ENDPOINT, PER_PAGE, TOPIC, pad, pages } from "./helpers/engineXScenario";
import { AGENT_MAX_DELIVERED_ROWS } from "../src/lib/agentMission/constants";

/**
 * LARGE MISSIONS REACH A CARD. Live run of 2026-10-29: «هات ١٠٠٠ تغريدة عن الدوري المصري» was refused before any card with «تعذّر تجهيز خطة لطلبك بسبب حد من جانبنا». The evidence (mission_events, mission_calls, agent_worker_heartbeat) says the
 * refusal was a DEPLOY of the worker, not a size limit (see tests/restart-requeue.test.ts); these tests prove the other half: there is NO limit in the planning, the price or the engine that stops 1,000 to 5,000 items, a plan of that size is accepted
 * with the customer's own number as the target, priced by code under the 25,000-point hold cap, and carried out in full.
 */
afterEach(() => { vi.unstubAllEnvs(); });

/** The X scenario of the engine tests, with a summary that states no count (the card states it) and the model's own estimate far below what the customer asked for. */
const planning = () => planningFlow({
  progress: "أبحث عن أرخص مصدر مناسب للتغريدات",
  searchWords: ["tweets", "search"], platform: "x",
  sample: [{ endpoint: ENDPOINT, params: { query: TOPIC, limit: PER_PAGE }, why: "the cheaper sources return no author or link fields in their catalog description" }],
  sampleCode: "return inputs.call_0001.output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author, date: t.createdAt }))",
  plan: (res: Results) => ({
    summary_ar: "ستحصل على تغريدات عن محمد صلاح مع نص كل تغريدة ورابطها.",
    stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: ENDPOINT, expected_rows: 300, parent_key: null, deliver: true,
      columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "date", title_ar: "التاريخ والوقت" }],
      sample_rows: [0, 1, 2].map((n) => ({ id: `18${pad(n)}`, text: `${TOPIC} يسجل هدفًا رقم ${n} في المباراة`, url: `https://x.example/u/status/18${pad(n)}`, author: `user${n}`, date: "2026-10-20T10:00:00Z" })), measured_by: [callIds(res)[0]], relevance: aboutWords([TOPIC]), yield_from: firstOutputId(res) }],
  }),
});

describe("a 1,000-tweet request reaches a card and is delivered in full", () => {
  it("the card carries 1,000 as its one number, the price is computed by code under the hold cap, and the file, the count and the charge agree", async () => {
    const r = await replay({ request: "هات ١٠٠٠ تغريدة عن محمد صلاح", planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(70)] });
    // the card (read before approval): the customer's number, not the model's estimate of 300
    expect(r.plannedPlan.stages[0].planned_rows).toBe(1000);
    expect(r.plannedPlan.quantity).toMatchObject({ requested: 1000, target: 1000, stage_key: "tweets" });
    expect(r.planView.stages[0]).toMatchObject({ rows: 1000 });
    expect(r.planView.totalRows).toBe(1000);
    expect(r.planView.priceLineAr).toMatch(/نقطة/);
    expect(r.plannedPlan.price.reservePoints).toBeGreaterThan(200);
    expect(r.plannedPlan.price.reservePoints).toBeLessThan(600);
    assertReplayInvariants(r, { expectDelivered: 1000 });
    expect((await readWorkbook(r)).getWorksheet("التغريدات")!.rowCount).toBe(1001);
    expect(r.finalView.resultLinesAr[0]).toBe("تم تسليم ١٬٠٠٠ من ١٬٠٠٠ تغريدة.");
  }, 120_000);

  it("5,000 tweets (the volume limit) reach a card under the 25,000-point cap and are delivered in full", async () => {
    vi.stubEnv("JOB_MAX_POINTS_CAP", "");
    expect(AGENT_MAX_DELIVERED_ROWS).toBe(5000);
    const r = await replay({ request: "هات ٥٠٠٠ تغريدة عن محمد صلاح", planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(330)] });
    expect(r.plannedPlan.stages[0].planned_rows).toBe(5000);
    expect(r.planView.totalRows).toBe(5000);
    expect(r.plannedPlan.price.reservePoints).toBeGreaterThan(600);
    expect(r.plannedPlan.price.reservePoints).toBeLessThanOrEqual(25_000);
    assertReplayInvariants(r, { expectDelivered: 5000 });
  }, 240_000);
});
