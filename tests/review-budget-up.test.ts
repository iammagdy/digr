import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chargeForUnits } from "../src/lib/recordPricing";
import { resetProviderKeyCache } from "../src/lib/server/providerKeys";
import { summarizeReviewSpendByDay } from "../src/lib/server/reviewSpendDaily";
import {
  callClaudeRowAdvisor, collectableRows, focusStemsOf, REVIEW_CALL_COST_ESTIMATE_USD, REVIEW_JOB_CEILING_USD, REVIEW_MIN_BUDGET_USD, REVIEW_PAGE_ROWS,
  REVIEW_SNIPPET_CHARS, reviewSocialRows, socialReviewCapUsd, SOCIAL_REVIEW_ROWS_PER_CALL, summarizeRowForReview, trimTextForReview, type RowAdvisorFn,
} from "../src/lib/server/rowReviewAdvisor";
import { reviewSocialPage } from "../src/lib/server/sampledReview";

const COST_PER_ROW = REVIEW_CALL_COST_ESTIMATE_USD / SOCIAL_REVIEW_ROWS_PER_CALL;
const fakeAdvisor = (): RowAdvisorFn => async (input) => ({
  verdicts: new Map(input.rows.map((row) => [row.index, { verdict: "match" as const, reasonAr: "x" }])),
  usage: { inputTokens: 0, outputTokens: 0, costUsd: COST_PER_ROW * input.rows.length, model: "fake", latencyMs: 0 },
  failure: null,
});

describe("the review budget: every row the job can collect, up to one ceiling", () => {
  it("the ceiling is one constant: 0.15 USD, and the one-call floor is unchanged", () => {
    expect(REVIEW_JOB_CEILING_USD).toBe(0.15);
    expect(REVIEW_MIN_BUDGET_USD).toBe(0.0083);
    expect(REVIEW_PAGE_ROWS).toBe(20);
  });

  it("the rows a job can collect are its page cap in full pages", () => {
    expect(collectableRows(10)).toBe(80);
    expect(collectableRows(30)).toBe(120);
    expect(collectableRows(300)).toBe(900);
    expect(collectableRows(0)).toBe(collectableRows(1));
  });

  it("a job small enough to review every collectable row is budgeted for exactly those rows, rounded down to a millionth", () => {
    for (const target of [10, 30, 100]) {
      const budget = socialReviewCapUsd(target, 0.11715);
      expect(budget).toBeLessThanOrEqual(collectableRows(target) * COST_PER_ROW + 1e-12);
      expect(budget).toBeGreaterThan(collectableRows(target) * COST_PER_ROW - 1e-6);
    }
    expect(socialReviewCapUsd(100, 0.11715)).toBe(0.0996);
  });

  it("a larger job is held at the ceiling, and the ceiling is the only place that sets it", () => {
    for (const target of [300, 500, 1000, 4000]) expect(socialReviewCapUsd(target, 0.11715)).toBe(REVIEW_JOB_CEILING_USD);
    expect(socialReviewCapUsd(300, 0.275)).toBe(REVIEW_JOB_CEILING_USD);
  });

  it("a job without a valid price has no review budget at all (fail closed)", () => {
    expect(socialReviewCapUsd(300, 0)).toBe(0);
    expect(socialReviewCapUsd(300, -1)).toBe(0);
    expect(socialReviewCapUsd(300, Number.NaN)).toBe(0);
  });

  it("the budget no longer depends on the price: the review may cost more than the job earns", () => {
    const revenueUsd = (chargeForUnits(300, 0.11715) * 0.1) / 55;
    expect(revenueUsd).toBeCloseTo(0.0654, 3);
    expect(socialReviewCapUsd(300, 0.11715)).toBeGreaterThan(revenueUsd * 2);
  });

  it("with the ceiling, a 900-row job whose rows all pass is reviewed up to the ceiling and the rows beyond it are NOT delivered (they go to the budget list)", async () => {
    const budget = socialReviewCapUsd(300, 0.11715);
    let spent = 0;
    let reviewed = 0;
    let byBudget = 0;
    for (let page = 0; page < 45; page += 1) {
      const rows = Array.from({ length: 20 }, (_, index) => ({ index, row: { text: `r${page}-${index}` } }));
      const outcome = await reviewSocialPage({ advisor: fakeAdvisor(), customerRequest: "x", kind: "social-x-posts", rows, budgetUsd: Math.max(0, budget - spent), callCostEstimateUsd: REVIEW_CALL_COST_ESTIMATE_USD });
      spent += outcome.costUsd;
      reviewed += outcome.verdicts.size;
      byBudget += outcome.unreviewedByBudget.length;
      for (const entry of rows) if (!outcome.verdicts.has(entry.index)) expect(outcome.unreviewed).toContain(entry.index);
      if (outcome.unreviewedByBudget.length > 0) break;
    }
    expect(spent).toBeLessThanOrEqual(REVIEW_JOB_CEILING_USD);
    expect(reviewed).toBe(Math.floor(REVIEW_JOB_CEILING_USD / COST_PER_ROW / 20) * 20);
    expect(byBudget).toBeGreaterThan(0);
  });

  it("fail closed is kept: a floor-sized budget still reviews one full call and not a second", async () => {
    const seen: number[] = [];
    const advisor: RowAdvisorFn = async (input) => { seen.push(input.rows.length); return fakeAdvisor()(input); };
    const rows = Array.from({ length: 50 }, (_, index) => ({ index, row: { text: `r${index}` } }));
    const outcome = await reviewSocialRows({ advisor, customerRequest: "x", kind: "social-x-posts", rows, budgetUsd: REVIEW_MIN_BUDGET_USD, callCostEstimateUsd: REVIEW_CALL_COST_ESTIMATE_USD });
    expect(seen).toEqual([25]);
    expect(outcome.verdicts.size).toBe(25);
    expect(outcome.unreviewedByCap.length).toBe(25);
  });
});

describe("the text sent per row is cut to 160 characters and keeps what the verdict rests on", () => {
  const request = "عايز تغريدات عن الأسعار في مصر\nالدولة المطلوبة: مصر";
  const filler = "كلام عادي لا علاقة له بأي شيء محدد ولا يذكر شيئاً مهماً أبداً ويستمر طويلاً ";
  const lateEvidence = `${filler.repeat(3)}ارتفعت الأسعار بشكل كبير في الأسواق هذا الأسبوع وهذا يؤثر على الجميع ${filler}`;

  it("the constant is 160 and the focus words come from the request (topic and country)", () => {
    expect(REVIEW_SNIPPET_CHARS).toBe(160);
    const focus = focusStemsOf(request);
    expect(focus.size).toBeGreaterThan(0);
    expect(trimTextForReview("سعر", focus).length).toBe(3);
  });

  it("a text of 160 characters or fewer is sent whole, and the whitespace is collapsed as before", () => {
    const short = "ارتفعت  الأسعار\nفي مصر";
    expect(trimTextForReview(short, focusStemsOf(request), REVIEW_SNIPPET_CHARS)).toBe("ارتفعت الأسعار في مصر");
  });

  it("a long text whose first 160 characters hold a word of the request is simply its first 160 characters", () => {
    const text = `الأسعار ${filler.repeat(6)}`;
    const cut = trimTextForReview(text, focusStemsOf(request), REVIEW_SNIPPET_CHARS);
    expect(cut).toBe(text.trim().replace(/\s+/g, " ").slice(0, REVIEW_SNIPPET_CHARS));
    expect(cut.length).toBe(REVIEW_SNIPPET_CHARS);
  });

  it("a long text whose request words all come after the cut keeps its start AND a window on the first of those words, within the 160", () => {
    const text = lateEvidence.trim().replace(/\s+/g, " ");
    expect(text.slice(0, REVIEW_SNIPPET_CHARS)).not.toContain("الأسعار");
    const cut = trimTextForReview(lateEvidence, focusStemsOf(request), REVIEW_SNIPPET_CHARS);
    expect(cut.length).toBeLessThanOrEqual(REVIEW_SNIPPET_CHARS);
    expect(cut.startsWith(text.slice(0, 90))).toBe(true);
    expect(cut).toContain("الأسعار");
    expect(cut).toContain(" … ");
  });

  it("the verdict is the same on the cut text as on the full text: the cut keeps the request's word wherever it was in the text", () => {
    const focus = focusStemsOf(request);
    const hasEvidence = (value: string) => value.split(/\s+/).some((word) => word.startsWith("الأسعار"));
    for (const position of [0, 40, 100, 159, 160, 200, 260, 330]) {
      const text = `${filler.repeat(6)}`.trim().replace(/\s+/g, " ");
      const words = text.split(" ");
      let at = 0;
      let index = 0;
      while (index < words.length && at + words[index].length < position) { at += words[index].length + 1; index += 1; }
      const full = [...words.slice(0, index), "الأسعار", ...words.slice(index)].join(" ");
      expect(hasEvidence(full)).toBe(true);
      expect(hasEvidence(trimTextForReview(full, focus, REVIEW_SNIPPET_CHARS)), `position ${position}`).toBe(true);
    }
  });

  it("a long text with no word of the request at all is just its first 160 characters (nothing to keep)", () => {
    const text = filler.repeat(6);
    expect(trimTextForReview(text, focusStemsOf(request), REVIEW_SNIPPET_CHARS)).toBe(text.trim().replace(/\s+/g, " ").slice(0, REVIEW_SNIPPET_CHARS));
  });

  it("without a request focus the cut is the plain head, and companies and people keep the old 220 characters", () => {
    const text = filler.repeat(6);
    expect(trimTextForReview(text, null, REVIEW_SNIPPET_CHARS).length).toBe(REVIEW_SNIPPET_CHARS);
    expect(summarizeRowForReview({ description: text }).description.length).toBe(220);
    expect(summarizeRowForReview({ text }, { limit: REVIEW_SNIPPET_CHARS, focus: focusStemsOf(request) }).text.length).toBe(REVIEW_SNIPPET_CHARS);
  });

  describe("what is actually sent to the model", () => {
    const originalFetch = globalThis.fetch;
    const saved = { key: process.env.ANTHROPIC_API_KEY, provider: process.env.LLM_PROVIDER, enabled: process.env.LLM_ENABLED, live: process.env.LLM_LIVE };
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
      delete process.env.LLM_PROVIDER; delete process.env.LLM_ENABLED; delete process.env.LLM_LIVE;
      resetProviderKeyCache();
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
      for (const [name, value] of [["ANTHROPIC_API_KEY", saved.key], ["LLM_PROVIDER", saved.provider], ["LLM_ENABLED", saved.enabled], ["LLM_LIVE", saved.live]] as const) {
        if (value === undefined) delete (process.env as any)[name]; else (process.env as any)[name] = value;
      }
      resetProviderKeyCache();
    });

    const promptFor = async (kind: string, field: string) => {
      const bodies: any[] = [];
      globalThis.fetch = vi.fn(async (_url: any, init: any) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: '{"reviews":[{"index":0,"verdict":"match"}]}' }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 20 } }) } as any;
      });
      await callClaudeRowAdvisor({ customerRequest: request, kind, rows: [{ index: 0, row: { [field]: lateEvidence } }] });
      return String(bodies[0].messages[0].content);
    };

    it("a post sent to the model is cut to 160 characters and still carries the word the verdict rests on", async () => {
      const prompt = await promptFor("social-x-posts", "text");
      expect(prompt).toContain("الأسعار");
      expect(prompt).not.toContain(lateEvidence.trim().replace(/\s+/g, " ").slice(0, 200));
      const sent = JSON.parse(prompt.split("\n").pop()!)[0].text as string;
      expect(sent.length).toBeLessThanOrEqual(REVIEW_SNIPPET_CHARS);
    });

    it("a company row is not cut to 160: it keeps the old 220", async () => {
      const prompt = await promptFor("companies", "description");
      const sent = JSON.parse(prompt.split("\n").pop()!)[0].description as string;
      expect(sent.length).toBe(220);
    });
  });
});

describe("the daily review spend read", () => {
  const now = new Date("2026-10-21T10:00:00Z");
  const rows = [
    { created_at: "2026-10-21T08:00:00Z", reason: "relevance_review", cost_usd: 0.00666 },
    { created_at: "2026-10-21T09:00:00Z", reason: "relevance_review", cost_usd: "0.0083" },
    { created_at: "2026-10-21T09:30:00Z", reason: "relevance_review_failed:bad_reply", cost_usd: 0.004 },
    { created_at: "2026-10-20T10:00:00Z", reason: "relevance_review", cost_usd: 0.01 },
    { created_at: "2026-10-21T09:00:00Z", reason: "understand", cost_usd: 5 },
    { created_at: "2026-10-01T09:00:00Z", reason: "relevance_review", cost_usd: 9 },
    { created_at: "not a date", reason: "relevance_review", cost_usd: 9 },
  ];

  it("sums only review calls by Cairo day, newest first, zero-filled, and ignores every other reason and day outside the window", () => {
    const summary = summarizeReviewSpendByDay(rows, { days: 3, now });
    expect(summary.timezone).toBe("Africa/Cairo");
    expect(summary.jobCeilingUsd).toBe(REVIEW_JOB_CEILING_USD);
    expect(summary.days).toEqual([
      { date: "2026-10-21", calls: 2, failedCalls: 1, usd: 0.01896 },
      { date: "2026-10-20", calls: 1, failedCalls: 0, usd: 0.01 },
      { date: "2026-10-19", calls: 0, failedCalls: 0, usd: 0 },
    ]);
    expect(summary.totalUsd).toBe(0.02896);
  });

  it("a call at 23:30 UTC belongs to the next Cairo day, and an empty read is all zeros", () => {
    const late = summarizeReviewSpendByDay([{ created_at: "2026-10-20T23:30:00Z", reason: "relevance_review", cost_usd: 0.1 }], { days: 2, now });
    expect(late.days[0]).toEqual({ date: "2026-10-21", calls: 1, failedCalls: 0, usd: 0.1 });
    expect(summarizeReviewSpendByDay([], { days: 2, now }).totalUsd).toBe(0);
  });
});

describe("the daily review spend route (read-only, admin only)", () => {
  // a FIXED clock (13:00 in Cairo, far from Cairo midnight and from the day the clocks change): the route reads «now» for its window, and the test used the real time, so it failed after 21:00 UTC
  const FIXED_NOW = "2026-10-20T10:00:00.000Z";
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(FIXED_NOW)); });
  afterEach(() => { vi.useRealTimers(); vi.resetModules(); vi.doUnmock("../src/lib/server/adminAuth"); vi.doUnmock("../src/lib/supabase/server"); });

  const load = async (auth: any, client: any) => {
    vi.doMock("../src/lib/server/adminAuth", () => ({ authenticateAdmin: async () => auth }));
    vi.doMock("../src/lib/supabase/server", () => ({ createAdminClient: () => client }));
    return (await import("../src/app/api/admin/review-spend/route")).GET;
  };
  const req = (query = "") => ({ nextUrl: new URL(`https://diger.tech/api/admin/review-spend${query}`) }) as any;

  it("without an admin it answers with the auth response and reads nothing", async () => {
    const from = vi.fn();
    const response = new Response("no", { status: 401 });
    const GET = await load({ ok: false, response }, { from });
    expect((await GET(req())).status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });

  it("an admin gets the summary; only select calls are made on llm_usage", async () => {
    const calls: string[] = [];
    const chain: any = {};
    for (const name of ["select", "like", "gte", "order"]) chain[name] = (...args: any[]) => { calls.push(name); return chain; };
    chain.range = async () => ({ data: [{ created_at: new Date(FIXED_NOW).toISOString(), reason: "relevance_review", cost_usd: 0.01 }], error: null });
    const from = vi.fn(() => chain);
    const GET = await load({ ok: true }, { from });
    const response = await GET(req("?days=2"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(from).toHaveBeenCalledWith("llm_usage");
    expect(calls).toEqual(["select", "like", "gte", "order"]);
    expect(body.days).toHaveLength(2);
    expect(body.days).toEqual([{ date: "2026-10-20", calls: 1, failedCalls: 0, usd: 0.01 }, { date: "2026-10-19", calls: 0, failedCalls: 0, usd: 0 }]);
    expect(body.totalUsd).toBe(0.01);
    expect(body.jobCeilingUsd).toBe(0.15);
  });

  it("a failed read answers 500 read_failed and nothing else", async () => {
    const chain: any = {};
    for (const name of ["select", "like", "gte", "order"]) chain[name] = () => chain;
    chain.range = async () => ({ data: null, error: { message: "boom" } });
    const GET = await load({ ok: true }, { from: () => chain });
    const response = await GET(req());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "read_failed" });
  });
});
