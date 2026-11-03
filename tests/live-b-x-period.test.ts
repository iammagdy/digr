import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { cairoDayEndExclusiveMs, cairoDayStartMs } from "../src/lib/agentMission/cairoTime";
import { plainSearchAr } from "../src/lib/agentMission/plainSearchAr";
import { filterVerdict, type StageFilter } from "../src/lib/agentMission/filters";
import { markCellAr, markVerdict } from "../src/lib/agentMission/rawMarks";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { compilePlan, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { ItemStore } from "../agent/src/items/itemStore";
import { buildTools } from "../agent/src/tools";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import type { TregCallOptions } from "../src/functions/shared/tregClient";
import { assertReplayInvariants, replay } from "./helpers/agentReplay";
import { callIds, planningFlow, tregResult, type Results } from "./helpers/agentFakeWorld";
import { makeHarness } from "./helpers/agentHarness";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";

/**
 * LIVE FINDING B (3 Nov 2026, test account, msn_24fd8dc0470a2c990cc0): «هات ٢٠ تغريدة على X فيها «العاصمة الإدارية» بالعربي في شهر أكتوبر ٢٠٢٦، مع الردود».
 * X ran on the OLD path (the type flag was `test`, the platform had no key of its own; the second stage, the replies, had no recipe, so the model carried the mission out).
 * The stored recipe held the right Cairo moments, but the calls that RAN carried the model's own day-only `since:2026-10-01 until:2026-10-31 -filter:replies`; the source read
 * `until:2026-10-31` as the whole UTC day, so tweet 2116654976390795707 (2026-11-01 00:14:06 Cairo, 22:14:06 UTC on the 31st) came back, and the old period filter (UTC days:
 * «T23:59:59Z») accepted it. The methodology then read the UTC date of the stamps and said «من ٣٠ سبتمبر ٢٠٢٦» for a request that began on 1 October.
 * The #341 / S10 fix lives in buildToolInput and in the windows with bounds: it ran only for a stage built by code under a flag (tests/s10-cairo-x-query.test.ts, flagsOn).
 * Every test below runs with the flags OFF: the path the live mission took.
 */
interface Record_ {
  events: { pipe_new: number; fallback_stage: number };
  period_asked: { since_utc_ms: number; until_exclusive_utc_ms: number };
  stored_recipe_stage_1: { since_utc_ms: number; until_exclusive_utc_ms: number };
  executed_calls: Array<{ since_day_utc_ms: number; until_day_utc_ms: number }>;
  delivered_outside_period: { id: string; createdUtc: string };
}
const LIVE = JSON.parse(readFileSync(new URL("./fixtures/live/plans/msn_24fd8dc0470a2c990cc0.json", import.meta.url), "utf8")) as Record_;
const OUTSIDE = LIVE.delivered_outside_period;
const catalog = loadTregCatalog();

describe("B: the stored record of the live mission (read by SELECT, anonymised)", () => {
  it("the stored recipe was right: the Cairo moments of 1 October 00:00 and 1 November 00:00", () => {
    expect(LIVE.stored_recipe_stage_1.since_utc_ms).toBe(cairoDayStartMs("2026-10-01"));
    expect(LIVE.stored_recipe_stage_1.until_exclusive_utc_ms).toBe(cairoDayEndExclusiveMs("2026-10-31"));
    expect(LIVE.period_asked).toMatchObject({ since_utc_ms: cairoDayStartMs("2026-10-01"), until_exclusive_utc_ms: cairoDayEndExclusiveMs("2026-10-31") });
  });
  it("but the calls that ran were day-only (UTC midnight), and the mission ran on the old path with a named fallback at stage 2", () => {
    expect(LIVE.events).toMatchObject({ pipe_new: 0, fallback_stage: 2 });
    for (const c of LIVE.executed_calls) {
      expect(c.since_day_utc_ms).toBe(Date.UTC(2026, 9, 1));
      expect(c.until_day_utc_ms).toBe(Date.UTC(2026, 9, 31));
    }
  });
  it("the delivered tweet was posted at 2026-11-01 00:14 Cairo: outside October in Cairo, inside the UTC day the source and the old filter read", () => {
    const at = Date.parse(OUTSIDE.createdUtc);
    expect(at).toBeGreaterThanOrEqual(cairoDayEndExclusiveMs("2026-10-31"));
    expect(at).toBeLessThan(Date.UTC(2026, 10, 1));
    // the tweet's own id says the same (snowflake)
    expect(Number((BigInt(OUTSIDE.id) >> 22n) + 1288834974657n)).toBe(at);
  });
});

// ------------------------------------------------------------------------------------------------------------- the old path, end to end
const ENDPOINT = "anyapi.x.search.posts";
const TOPIC = "العاصمة الإدارية";
const MODEL_QUERY = '"العاصمة الإدارية" lang:ar since:2026-10-01 until:2026-10-31';
const stampMs = (stamp: string): number => Date.parse(stamp.replace(/^(\d{4}-\d{2}-\d{2})_(\d{2}:\d{2}:\d{2})_UTC$/, "$1T$2Z"));
const opOf = (q: string, name: "since" | "until"): string[] => [...q.matchAll(new RegExp(`(?:^|\\s)${name}:(\\S+)`, "g"))].map((m) => m[1]);
const tweet = (id: string, text: string, at: string) => ({ id, text, url: `https://x.example/u/status/${id}`, author: `user${id.slice(-2)}`, createdAt: new Date(Date.parse(at)).toISOString() });
const DAY = 86_400_000;
const TWEETS = [
  ...Array.from({ length: 18 }, (_, i) => tweet(`19${String(i).padStart(5, "0")}`, `${TOPIC} مشروع جديد رقم ${i} في المدينة`, `2026-10-${String(29 - Math.floor(i / 2)).padStart(2, "0")}T1${i % 10}:00:00+03:00`)),
  tweet("1900097", `${TOPIC} في آخر نصف ساعة من أكتوبر`, "2026-10-31T23:30:00+02:00"),
  tweet("1900098", `${TOPIC} في أول ساعتين من أكتوبر بتوقيت القاهرة`, "2026-10-01T01:30:00+03:00"),
  tweet("1900099", `${TOPIC} بعد منتصف ليلة أول نوفمبر بتوقيت القاهرة`, OUTSIDE.createdUtc),
];
const OUTSIDE_ID = "1900099";
const FIRST_HOURS_ID = "1900098";
const newestFirst = (items: typeof TWEETS) => [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

/** A source that answers by the operators it is sent, the way the LIVE source did: a stamp is the exact moment; a bare `since:` day starts at UTC midnight; a bare `until:` day includes that WHOLE UTC day (live: until:2026-10-31 returned a tweet of 22:14 UTC on the 31st). */
function honouringSource(seen: string[]) {
  return (o: TregCallOptions) => {
    const q = String((o.params as Record<string, unknown>).query ?? "");
    seen.push(q);
    const since = opOf(q, "since")[0];
    const until = opOf(q, "until")[0];
    const from = since === undefined ? 0 : /_UTC$/.test(since) ? stampMs(since) : Date.parse(`${since}T00:00:00Z`);
    const to = until === undefined ? Number.POSITIVE_INFINITY : /_UTC$/.test(until) ? stampMs(until) : Date.parse(`${until}T00:00:00Z`) + DAY;
    return tregResult({ output: { data: { items: newestFirst(TWEETS.filter((t) => Date.parse(t.createdAt) >= from && Date.parse(t.createdAt) < to)), nextCursor: null } } }, 0.00075);
  };
}
/** A source that ignores the operators (the period is then the filter's job alone). */
function ignoringSource(seen: string[]) {
  return (o: TregCallOptions) => {
    seen.push(String((o.params as Record<string, unknown>).query ?? ""));
    return tregResult({ output: { data: { items: newestFirst(TWEETS), nextCursor: null } } }, 0.00075);
  };
}
const planning = () => planningFlow({
  progress: "أبحث عن أرخص مصدر مناسب للتغريدات", searchWords: ["tweets", "search"], platform: "x",
  sample: [{ endpoint: ENDPOINT, params: { query: MODEL_QUERY, limit: 20 }, why: "the cheaper sources return no author or link fields in their catalog description" }],
  sampleCode: "return inputs.call_0001.output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author, date: t.createdAt }))",
  plan: (res: Results) => ({
    summary_ar: "ستحصل على ٢٠ تغريدة بالعربي عن العاصمة الإدارية في أكتوبر ٢٠٢٦.",
    stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: ENDPOINT, expected_rows: 20, parent_key: null, deliver: true,
      columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "date", title_ar: "التاريخ والوقت" }],
      filters: [{ kind: "language", lang: "ar" }, { kind: "period", from: "2026-10-01", to: "2026-10-31", field: "date" }],
      sample_rows: [0, 1, 2].map((n) => ({ id: TWEETS[n].id, text: TWEETS[n].text, url: TWEETS[n].url, author: TWEETS[n].author, date: TWEETS[n].createdAt })), measured_by: [callIds(res)[0]], relevance: aboutWords([TOPIC]), yield_from: firstOutputId(res) }],
  }),
});
const REQUEST = 'هات ٢٠ تغريدة على X فيها "العاصمة الإدارية" بالعربي في شهر أكتوبر ٢٠٢٦، مع الردود.';
async function oldPath(source: (seen: string[]) => (o: TregCallOptions) => ReturnType<typeof tregResult>) {
  const seen: string[] = [];
  // NO deps: every flag off, the path of the live mission
  const r = await replay({ request: REQUEST, planning: planning(), execution: () => [], answers: Array.from({ length: 30 }, () => source(seen)) });
  const items = await ItemStore.open(r.store, r.missionId);
  return { r, seen, executed: seen.slice(1), delivered: items.acceptedRows("tweets").map((x) => String(x.id)) };
}

describe("B, request: on the old path the request sent to the source covers exactly the asked Cairo days", () => {
  it("every query of the execution carries since 2026-10-01 00:00 Cairo and until 2026-11-01 00:00 Cairo, as UTC moments, once each", async () => {
    const { executed, r } = await oldPath(honouringSource);
    expect(r.plannedPlan.stages[0].engine?.built_by).toBeUndefined();
    expect(executed.length).toBeGreaterThan(0);
    for (const q of executed) {
      expect(opOf(q, "since")).toEqual(["2026-09-30_21:00:00_UTC"]);
      expect(opOf(q, "until")).toEqual(["2026-10-31_22:00:00_UTC"]);
      expect(q.match(/lang:ar/g)?.length).toBe(1);
    }
  });
  it("so the tweet of 2026-11-01 00:14 Cairo is not delivered, and the tweet of 01:30 on 1 October (before UTC midnight) is", async () => {
    const { delivered, r } = await oldPath(honouringSource);
    expect(delivered).not.toContain(OUTSIDE_ID);
    expect(delivered).toContain(FIRST_HOURS_ID);
    expect(delivered).toHaveLength(20);
    assertReplayInvariants(r, { expectDelivered: 20 });
  });
});

describe("B, filter: on the old path a delivered row outside the asked Cairo days is never accepted as inside it", () => {
  it("a source that ignores the operators: the period filter reads Cairo days (it read UTC days, so 2026-11-01 00:14 Cairo passed)", async () => {
    const { delivered } = await oldPath(ignoringSource);
    expect(delivered).not.toContain(OUTSIDE_ID);
    expect(delivered).toContain(FIRST_HOURS_ID);
    expect(delivered).toHaveLength(20);
  });
  it("the filter itself, with Cairo days, on the boundaries of October (summer time to 29 October, then UTC+2); the stored UTC reading stays available for callers that ask for it", () => {
    const period = [{ kind: "period", from: "2026-10-01", to: "2026-10-31", field: "date" }] as StageFilter[];
    const verdict = (at: string) => filterVerdict(period, { date: new Date(Date.parse(at)).toISOString() }, { textKey: null, now: 0, cairoDays: true });
    expect(filterVerdict(period, { date: "2026-11-01T00:14:06+02:00" }, { textKey: null, now: 0 })).toBeNull();
    expect(verdict("2026-10-01T00:00:00+03:00")).toBeNull();
    expect(verdict("2026-10-31T23:59:59+02:00")).toBeNull();
    expect(verdict("2026-09-30T23:59:59+03:00")).toBe("filter_period");
    expect(verdict("2026-11-01T00:14:06+02:00")).toBe("filter_period");
  });
});

describe("B, model-run path: the stage had no recipe, so the model's own calls reach the source", () => {
  const stage = (over: Partial<PricedStage>): PricedStage => ({ key: "tweets", title_ar: "التغريدات", endpoint_id: ENDPOINT, expected_rows: 20, planned_rows: 20, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص التغريدة" }], sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001, ...over }) as PricedStage;
  const plan = (): PricedPlan => ({ summary_ar: "ملخص", stages: [stage({ filters: [{ kind: "period", from: "2026-10-01", to: "2026-10-31", field: "date" }] as StageFilter[] }), stage({ key: "replies", title_ar: "الردود", parent_key: "tweets", filters: [{ kind: "period", days: 30, enabled: false }] as StageFilter[] })], price: { totalCostUsd: 0, deliveredRows: 20, costPerFinalRowUsd: 0.0001, unitPricePoints: 1, reservePoints: 400, maxChargePoints: 300, overCap: false } }) as unknown as PricedPlan;
  async function sent(params: Record<string, unknown>): Promise<string> {
    const h = makeHarness({ phase: "execution", responses: [tregResult({ output: { data: { items: [], nextCursor: null } } }, 0.00075)] });
    h.ctx.plan = plan();
    const tool = buildTools(h.ctx).find((t) => t.name === "treg_call")!;
    await tool.handler({ endpoint_id: ENDPOINT, params, why: "the cheapest search source is first" } as never);
    expect(h.call).toHaveBeenCalledTimes(1);
    return String((h.call.mock.calls[0][0] as TregCallOptions & { params: Record<string, unknown> }).params.query);
  }
  it("the model's day-only operators are replaced by the Cairo moments of the plan's period", async () => {
    const q = await sent({ query: `${MODEL_QUERY} -filter:replies`, limit: 20, queryType: "Latest" });
    expect(opOf(q, "since")).toEqual(["2026-09-30_21:00:00_UTC"]);
    expect(opOf(q, "until")).toEqual(["2026-10-31_22:00:00_UTC"]);
    expect(q).toContain("-filter:replies");
  });
  it("a search for the replies addressed to an account is not a search of the period: left as the model wrote it", async () => {
    const q = await sent({ query: "to:baladtv lang:ar since:2026-10-01 until:2026-11-01", limit: 20, queryType: "Latest" });
    expect(q).toBe("to:baladtv lang:ar since:2026-10-01 until:2026-11-01");
  });
});

describe("B, the methodology tells the Cairo days of the request, not the UTC date of a stamp", () => {
  it("since 2026-09-30 21:00 UTC is 1 October in Cairo; until 2026-10-31 22:00 UTC (exclusive) ends on 31 October", () => {
    const t = plainSearchAr('"العاصمة الإدارية" lang:ar -filter:replies since:2026-09-30_21:00:00_UTC until:2026-10-31_22:00:00_UTC').text;
    expect(t).toContain("من ١ أكتوبر ٢٠٢٦");
    expect(t).toContain("حتى ٣١ أكتوبر ٢٠٢٦");
    expect(t).not.toContain("٣٠ سبتمبر");
  });
  it("a winter range: until 2026-11-30 22:00 UTC is the end of 30 November in Cairo; days written without a moment keep their own date", () => {
    expect(plainSearchAr('"x" since:2026-10-31_22:00:00_UTC until:2026-11-30_22:00:00_UTC').text).toContain("من ١ نوفمبر ٢٠٢٦، حتى ٣٠ نوفمبر ٢٠٢٦");
    expect(plainSearchAr('"x" since:2026-10-24 until:2026-10-31').text).toContain("من ٢٤ أكتوبر ٢٠٢٦، حتى ٣١ أكتوبر ٢٠٢٦");
  });
});

// ------------------------------------------------------------------------------------------------------------- the compiled path
describe("B, compiled path: October in Cairo days, inclusive, and a row outside carries «ضمن الفترة المطلوبة» = لا", () => {
  const request = REQUEST;
  const created = Date.parse("2026-11-03T06:05:32Z");
  const ask = buildAsk(request, null, created);
  const card = cardOf(ENDPOINT)!;
  const realPage = JSON.parse(readFileSync(new URL("./fixtures/live/missions/msn_b060d3347ed7660f972e/raw/call_0001.json", import.meta.url), "utf8")) as unknown;

  it("the Ask holds the Cairo days 2026-10-01 to 2026-10-31 and their instants", () => {
    expect(ask.period).toMatchObject({ from: "2026-10-01", to: "2026-10-31", startMs: Date.UTC(2026, 8, 30, 21), endExclusiveMs: Date.UTC(2026, 9, 31, 22) });
  });
  it("the search inputs carry since 2026-09-30 21:00 UTC (1 October 00:00 Cairo, UTC+3) and until 2026-10-31 22:00 UTC (1 November 00:00 Cairo, UTC+2), once", () => {
    const q = String(parentInputs(card, ask).query);
    expect(opOf(q, "since")).toEqual(["2026-09-30_21:00:00_UTC"]);
    expect(opOf(q, "until")).toEqual(["2026-10-31_22:00:00_UTC"]);
  });
  it("the compiled stage carries the period as a typed filter over the Cairo days, and the rows outside it are MARKED «لا», never dropped", () => {
    const result = compilePlan({ ask, pool: { card, params: parentInputs(card, ask), pages: [{ callId: "call_0001", page: realPage }] }, exposure: () => undefined, capabilityOf: () => null });
    if (!result.ok) throw new Error(`no plan: ${result.reason}`);
    const period = (result.plan.stages[0].filters ?? []).find((f) => f.kind === "period")!;
    expect(period).toMatchObject({ from: "2026-10-01", to: "2026-10-31", field: "posted_at" });
    const filters = [period] as StageFilter[];
    const mark = (postedAt: string) => markCellAr("inPeriod", markVerdict(filters, { posted_at: postedAt }, { textKey: null, now: 0 }));
    expect(mark("2026-10-01T00:00:00+03:00")).toBe("نعم");
    expect(mark("2026-10-31T23:59:59+02:00")).toBe("نعم");
    expect(mark(OUTSIDE.createdUtc)).toBe("لا");
    expect(mark("2026-09-30T23:59:59+03:00")).toBe("لا");
  });
});
