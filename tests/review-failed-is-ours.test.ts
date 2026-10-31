import { describe, expect, it } from "vitest";
import { approvingReview, assertReplayInvariants, replay } from "./helpers/agentReplay";
import { callIds, tregResult, type Results } from "./helpers/agentFakeWorld";
import { aboutWords } from "./helpers/agentRelevance";
import { INTERNAL_FAILURE_AR } from "../agent/src/runMission";
import { AGENT_REVIEW_RETRY_DELAY_MS } from "../src/lib/agentMission/constants";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * LIVE INCIDENT 2026-10-31 15:48 (Cairo), mission «شركات مصريه»: 50 companies found, all 50 sent to the model review, the review answered six times and none of the answers was a usable 0/1 array, so all 50 stayed
 * pending, nothing was delivered, and the customer was told «لم نجد مصدرًا يخدم طلبك بدقة الآن» with no admin flag at all. A review that could not answer is OUR failure: status failed, the admin flag (with the first words of
 * the unusable answer), the existing internal-cause notice, the hold released whole. One delayed retry of the review runs before settling at zero.
 */
const COMPANIES = "aiark.companies.search";
/** the measured page names the sector; the pages of the run do not (an English or generic name): the rule cannot decide them, the model review must */
const page = (names: string[]) => ({ content: names.map((name, i) => ({ id: `co${i + 1}`, name, domain: `company${i + 1}.example`, location: { country: "مصر" } })) });
const SAMPLED = ["شركة كهروميكانيكا الأولى", "شركة كهروميكانيكا الثانية", "شركة كهروميكانيكا الثالثة"];
const PLAIN = ["شركة النور", "شركة الأمل", "شركة الفجر"];
const NAMES = { co1: SAMPLED[0], co2: SAMPLED[1] };
const why = "the cheaper sources return no author or link fields in their catalog description";

/** a single companies stage whose rule cannot decide the rows of the run (the sector word is in none of their names): every row goes to the model review */
const run = (reviewCall: unknown, extra: Record<string, unknown> = {}) => replay({
  request: "عايز ٣ شركات كهروميكانيكا في مصر",
  planning: [
    { tool: "report_progress", args: { message_ar: "أبحث عن مصدر الشركات", counts: { sources: 3 } } },
    { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
    { tool: "describe_endpoint", args: { id: COMPANIES } },
    { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { page: 0, size: 3, account: "الكهروميكانيكا مصر" }, why } },
    { tool: "run_code", args: (r: Results) => ({ code: "return inputs.call_0001.content.map(c => ({ id: c.id, text: c.name, url: c.domain, country: c.location.country }))", files: [callIds(r)[0]] }) },
    { tool: "propose_plan", args: (res: Results) => ({
      summary_ar: "ستحصل على ثلاث شركات كهروميكانيكا في مصر.",
      stages: [{ key: "companies", title_ar: "الشركات", endpoint_id: COMPANIES, expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "اسم الشركة" }, { key: "url", title_ar: "الموقع" }],
        sample_rows: [{ id: "co1", text: NAMES.co1, url: "company1.example" }, { id: "co2", text: NAMES.co2, url: "company2.example" }], measured_by: [callIds(res)[0]], yield_from: "out_0001",
        relevance: aboutWords(["كهروميكانيكا"], { entity: true, review: true }) }],
    }) } as FakeStep,
  ],
  execution: () => [],
  deps: (base) => ({ ...base, reviewCall: reviewCall as never, ...extra }),
  answers: [tregResult(page(SAMPLED), 0.0005267), ...Array.from({ length: 12 }, () => tregResult(page(PLAIN), 0.0005267))],
});

const unusable = async () => ({ text: "I can't decide from the names alone; could you tell me what is meant by electromechanical?", usage: { input_tokens: 400, output_tokens: 30 } });

describe("a review that could not answer is OUR failure, never «no source serves your request»", () => {
  it("every review answer unusable, nothing delivered: status failed, admin flag with the unusable words, the internal-cause notice, the hold released whole, nothing charged", async () => {
    const delays: number[] = [];
    const r = await run(unusable, { sleep: async (ms: number) => { delays.push(ms); } });
    expect(r.mission.status).toBe("failed");
    expect(r.mission.delivered_units).toBe(0);
    expect(r.mission.charged_points).toBe(0);
    expect(r.mission.error).toMatch(/^admin: review_failed/);
    expect(r.mission.error).toContain("could you tell me");
    expect(r.mission.summary_ar).toBe(INTERNAL_FAILURE_AR);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0].kind).toBe("failed");
    expect(r.notices[0].facts).toMatchObject({ delivered: 0, chargedPoints: 0, cause: "internal", hasJob: true });
    const flag = r.store.events.find((e) => e.counts && "adm_flag" in e.counts);
    expect(flag?.counts).toMatchObject({ adm_flag: 1 });
    expect((flag?.counts as any).adm_pending).toBeGreaterThan(0);
    // the money: reserved then released whole, no charge row, the balance unchanged
    expect(r.money.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
    expect(r.money.ledger.filter((l) => l.type === "release")).toHaveLength(1);
    expect(r.money.ledger.filter((l) => l.type === "charge")).toHaveLength(0);
    expect(r.money.balance()).toBe(r.initialBalance);
    // the customer is never told that no source serves the request
    const seen = JSON.stringify([r.finalView, r.mission.summary_ar]);
    expect(seen).not.toMatch(/لم نجد مصدرًا|لا يمكن تنفيذ|لم نجد ما يطابق/);
  });

  it("one DELAYED retry of the review runs before settling at zero, and a review that works then delivers", async () => {
    const delays: number[] = [];
    let slept = false;
    const flaky = async (input: { user: string }) => (slept ? approvingReview(input as never) : unusable());
    const r = await run(flaky, { sleep: async (ms: number) => { delays.push(ms); slept = true; } });
    expect(delays).toEqual([AGENT_REVIEW_RETRY_DELAY_MS]);
    expect(r.mission.status).toBe("completed");
    expect(r.mission.delivered_units).toBe(3);
    expect(r.mission.error).toBeNull();
    assertReplayInvariants(r, { expectDelivered: 3 });
  });

  it("a review that answers at once never waits", async () => {
    const delays: number[] = [];
    const r = await run(approvingReview, { sleep: async (ms: number) => { delays.push(ms); } });
    expect(delays).toEqual([]);
    expect(r.mission.status).toBe("completed");
  });

  it("the retry happens once per stage, not in a loop", async () => {
    const delays: number[] = [];
    await run(unusable, { sleep: async (ms: number) => { delays.push(ms); } });
    expect(delays.length).toBe(1);
  });
});
