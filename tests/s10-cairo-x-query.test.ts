import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { buildToolInput } from "../src/lib/agentMission/toolInput";
import { firstWindowEndDay, windowParams } from "../src/lib/agentMission/dateWindow";
import { cairoDayEndExclusiveMs, cairoDayStartMs } from "../src/lib/agentMission/cairoTime";
import { assertReplayInvariants, replay } from "./helpers/agentReplay";
import { callIds, planningFlow, tregResult, type Results } from "./helpers/agentFakeWorld";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";
import { flagsOn } from "./helpers/s4World";
import type { TregCallOptions } from "../src/functions/shared/tregClient";

/**
 * S10, the live test of 2026-11-02 ~15:04 Cairo (docs/S1-LIVE-FINDINGS.md, S10): «هات ٢٠ تغريدة على X فيها "العاصمة الإدارية" بالعربي في شهر أكتوبر ٢٠٢٦، مع الردود.». 20 of 20, all Arabic, money correct; but one tweet was 2026-11-01 00:14 Cairo (22:14 UTC on the 31st), marked «ضمن الفترة المطلوبة: لا».
 * The stored query was `"العاصمة الإدارية" lang:ar since:2026-10-01 until:2026-10-31`: the model's OWN date operators (day only, UTC midnight) were kept, because the code added its Cairo boundaries only when the query had none (#332 tested a query without any).
 * Owner rule: the X search query carries Cairo-day boundaries converted to UTC with the right offset for each date (Egypt's summer time ended on 2026-10-29), in both `since:` and `until:`; the customer's period is the authority, the model's operators are replaced. The walk back through date windows (a source that stops after its depth)
 * uses the same boundaries, never UTC midnight.
 */
const catalog = loadTregCatalog();
const NOW = Date.parse("2026-11-02T13:04:00Z");
const MODEL_QUERY = '"العاصمة الإدارية" lang:ar since:2026-10-01 until:2026-10-31';
const stampMs = (stamp: string): number => Date.parse(stamp.replace(/^(\d{4}-\d{2}-\d{2})_(\d{2}:\d{2}:\d{2})_UTC$/, "$1T$2Z"));
const opOf = (q: string, name: "since" | "until"): string[] => [...q.matchAll(new RegExp(`(?:^|\\s)${name}:(\\S+)`, "g"))].map((m) => m[1]);
const built = (endpoint: string, base: Record<string, unknown>) => buildToolInput(catalog.byId.get(endpoint)!, { period: { from: "2026-10-01", to: "2026-10-31" }, language: "ar", sort: "latest", count: 20, nowMs: NOW }, base);
const CAIRO_TWEETS = { firstMinuteOfOctober: "2026-10-01T00:00:00+03:00", lastMinuteOfOctober: "2026-10-31T23:59:00+02:00", liveBug: "2026-11-01T00:14:00+02:00", justBefore: "2026-09-30T23:59:00+03:00" };

describe("the model's own date operators are replaced by the customer's Cairo days", () => {
  for (const endpoint of ["anyapi.x.search.posts", "crawl4ai.x.search.posts"]) {
    it(`${endpoint}: the live query (since:2026-10-01 until:2026-10-31, day only) becomes since 2026-10-01 00:00 Cairo and until 2026-11-01 00:00 Cairo, in UTC with the right offset, once each`, () => {
      const r = built(endpoint, endpoint === "anyapi.x.search.posts" ? { query: MODEL_QUERY, limit: 20, queryType: "Latest" } : { query: MODEL_QUERY, limit: 20 });
      expect(r.ok).toBe(true);
      const q = String(r.params.query);
      expect(opOf(q, "since")).toEqual(["2026-09-30_21:00:00_UTC"]);
      expect(opOf(q, "until")).toEqual(["2026-10-31_22:00:00_UTC"]);
      expect(q.match(/lang:ar/g)?.length).toBe(1);
      expect(q).toContain('"العاصمة الإدارية"');
      expect(q).not.toMatch(/until:2026-10-31(\s|$)/);
    });
  }
  it("the live tweet of 2026-11-01 00:14 Cairo is outside the query window; the first and the last minute of October in Cairo are inside", () => {
    const q = String(built("anyapi.x.search.posts", { query: MODEL_QUERY, limit: 20 }).params.query);
    const since = stampMs(opOf(q, "since")[0]);
    const until = stampMs(opOf(q, "until")[0]);
    expect(until).toBe(cairoDayStartMs("2026-11-01"));
    const inside = (at: string): boolean => Date.parse(at) >= since && Date.parse(at) < until;
    expect(inside(CAIRO_TWEETS.liveBug)).toBe(false);
    expect(inside(CAIRO_TWEETS.firstMinuteOfOctober)).toBe(true);
    expect(inside(CAIRO_TWEETS.lastMinuteOfOctober)).toBe(true);
    expect(inside(CAIRO_TWEETS.justBefore)).toBe(false);
  });
  it("the model's boundary one day too late (until the day AFTER) is replaced as well; the offset follows the date: a summer range ends at +3, a winter one at +2", () => {
    const late = String(built("anyapi.x.search.posts", { query: '"x" since:2026-10-01 until:2026-11-01', limit: 20 }).params.query);
    expect(opOf(late, "until")).toEqual(["2026-10-31_22:00:00_UTC"]);
    const summer = buildToolInput(catalog.byId.get("anyapi.x.search.posts")!, { period: { from: "2026-07-10", to: "2026-07-20" }, nowMs: NOW }, { query: '"x" since:2026-07-10 until:2026-07-20' });
    expect(opOf(String(summer.params.query), "since")).toEqual(["2026-07-09_21:00:00_UTC"]);
    expect(opOf(String(summer.params.query), "until")).toEqual(["2026-07-20_21:00:00_UTC"]);
    const winter = buildToolInput(catalog.byId.get("anyapi.x.search.posts")!, { period: { from: "2026-12-01", to: "2026-12-31" }, nowMs: NOW }, { query: '"x"' });
    expect(opOf(String(winter.params.query), "since")).toEqual(["2026-11-30_22:00:00_UTC"]);
    expect(opOf(String(winter.params.query), "until")).toEqual(["2026-12-31_22:00:00_UTC"]);
  });
  it("a query with no operators of its own still gets the Cairo boundaries (#332) and a request with no period leaves the model's operators alone", () => {
    const plain = String(built("anyapi.x.search.posts", { query: "العاصمة الإدارية", limit: 20 }).params.query);
    expect(opOf(plain, "since")).toEqual(["2026-09-30_21:00:00_UTC"]);
    const none = buildToolInput(catalog.byId.get("anyapi.x.search.posts")!, { nowMs: NOW }, { query: MODEL_QUERY, limit: 20 });
    expect(String(none.params.query)).toBe(MODEL_QUERY);
  });
});

describe("the walk back through date windows keeps the Cairo boundaries", () => {
  const op = { kind: "query_operators", param: "query" } as const;
  const bounds = { startMs: cairoDayStartMs("2026-10-01"), endExclusiveMs: cairoDayEndExclusiveMs("2026-10-31") };
  it("a window that ends on the last UTC day of the period is capped at the period's end (2026-10-31 22:00 UTC), not at UTC midnight 2026-11-01; its start is the exact Cairo start", () => {
    const q = String(windowParams(op, { query: '"x" lang:ar since:2026-09-30_21:00:00_UTC until:2026-10-31_22:00:00_UTC' }, "2026-09-30", "2026-10-31", bounds).query);
    expect(opOf(q, "since")).toEqual(["2026-09-30_21:00:00_UTC"]);
    expect(opOf(q, "until")).toEqual(["2026-10-31_22:00:00_UTC"]);
    expect(q).not.toContain("2026-11-01");
  });
  it("a window that ends mid-period goes to the next UTC midnight (the paging step), and never past the period's end", () => {
    const q = String(windowParams(op, { query: '"x"' }, "2026-09-30", "2026-10-20", bounds).query);
    expect(opOf(q, "since")).toEqual(["2026-09-30_21:00:00_UTC"]);
    expect(opOf(q, "until")).toEqual(["2026-10-21_00:00:00_UTC"]);
  });
  it("a source that takes ISO moments gets the exact Cairo start and the capped end; one that takes only days gets the covering UTC days, never past the last covering day", () => {
    const iso = windowParams({ kind: "range_params", from: "publishedAfter", to: "publishedBefore", format: "iso" }, {}, "2026-09-30", "2026-10-31", bounds);
    expect(iso).toEqual({ publishedAfter: "2026-09-30T21:00:00Z", publishedBefore: "2026-10-31T21:59:59Z" });
    const days = windowParams({ kind: "range_params", from: "startDate", to: "endDate", format: "date" }, {}, "2026-09-30", "2026-11-03", bounds);
    expect(days).toEqual({ startDate: "2026-09-30", endDate: "2026-10-31" });
  });
  it("without period bounds the windows are what they were (days only)", () => {
    expect(windowParams(op, { query: '"x"' }, "2026-07-29", "2026-10-27")).toEqual({ query: '"x" since:2026-07-29 until:2026-10-28' });
  });
  it("the first window's end day is read from a moment stamp too: the day that holds the last covered second; a day-only until stays «the day before»", () => {
    expect(firstWindowEndDay(op, { query: '"x" until:2026-10-31_22:00:00_UTC' }, NOW)).toBe("2026-10-31");
    expect(firstWindowEndDay(op, { query: '"x" until:2026-10-31_00:00:00_UTC' }, NOW)).toBe("2026-10-30");
    expect(firstWindowEndDay(op, { query: '"x" until:2026-10-31' }, NOW)).toBe("2026-10-30");
  });
});

/** The live mission's shape: the model samples the X search with ITS OWN operators (day only, UTC), the plan's period is October in Cairo days, and the source answers by the operators it is sent. */
const ENDPOINT = "anyapi.x.search.posts";
const TOPIC = "العاصمة الإدارية";
const seen: string[] = [];
const tweet = (i: number, at: string) => ({ id: `19${String(i).padStart(5, "0")}`, text: `${TOPIC} مشروع جديد رقم ${i} في المدينة`, url: `https://x.example/u/status/19${String(i).padStart(5, "0")}`, author: `user${i}`, createdAt: new Date(Date.parse(at)).toISOString() });
const TWEETS = [...Array.from({ length: 20 }, (_, i) => tweet(i, `2026-10-${String(30 - Math.floor(i / 2)).padStart(2, "0")}T1${i % 10}:00:00+03:00`)), tweet(99, CAIRO_TWEETS.liveBug)];
function source(o: TregCallOptions) {
  const q = String((o.params as Record<string, unknown>).query ?? "");
  seen.push(q);
  const since = opOf(q, "since")[0];
  const until = opOf(q, "until")[0];
  const at = (s: string | undefined, end: boolean): number => (s === undefined ? (end ? Number.POSITIVE_INFINITY : 0) : /_UTC$/.test(s) ? stampMs(s) : Date.parse(`${s}T00:00:00Z`));
  const items = [...TWEETS].filter((t) => Date.parse(t.createdAt) >= at(since, false) && Date.parse(t.createdAt) < at(until, true)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return tregResult({ output: { data: { items, nextCursor: null } } }, 0.00075);
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

describe("the exact request end to end: the model sampled its own day-only operators", () => {
  it("the stored query and every query sent to the source carry the Cairo boundaries; the tweet of 2026-11-01 00:14 Cairo is never asked for", async () => {
    seen.length = 0;
    const r = await replay({ request: 'هات ٢٠ تغريدة على X فيها "العاصمة الإدارية" بالعربي في شهر أكتوبر ٢٠٢٦، مع الردود.', planning: planning(), execution: () => [], deps: flagsOn as never, answers: Array.from({ length: 30 }, () => source) });
    const stage = r.plannedPlan.stages[0];
    const stored = String(stage.engine?.params.query);
    expect(stage.engine?.built_by).toBe("code");
    expect(opOf(stored, "since")).toEqual(["2026-09-30_21:00:00_UTC"]);
    expect(opOf(stored, "until")).toEqual(["2026-10-31_22:00:00_UTC"]);
    // the calls of the execution carry the stored boundaries (the planning sample was the model's own query)
    const executed = seen.slice(1);
    expect(executed.length).toBeGreaterThan(0);
    for (const q of executed) { expect(opOf(q, "since")).toEqual(["2026-09-30_21:00:00_UTC"]); expect(opOf(q, "until")).toEqual(["2026-10-31_22:00:00_UTC"]); }
    // so the source never returned the live tweet, and none of the delivered tweets is outside October in Cairo
    const snapshotText = JSON.stringify(r.mission.summary_ar ?? "");
    expect(snapshotText).not.toContain("خارج");
    assertReplayInvariants(r, { expectDelivered: 20 });
  });
});
