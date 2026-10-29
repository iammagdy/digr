import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay } from "./helpers/agentReplay";
import { callIds, planningFlow, tregResult, type Results } from "./helpers/agentFakeWorld";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";
import { readSnapshot } from "../agent/src/items/itemStore";
import type { TregCallOptions } from "../src/functions/shared/tregClient";

/**
 * TIME DEPTH (live: «هات ٢٠٠٠ تغريدة عن حرب إيران وإسرائيل آخر ٣ شهور» read 1,984 tweets in 108 pages, all of the last two days, then the source returned nothing and the stage ended «source_exhausted» with 176 delivered; «١٠٠٠ تغريدة عن الدوري المصري آخر شهر»
 * delivered 799). The source gives its results newest first and stops after a fixed depth. The engine now asks again with the end of the window moved back to the oldest day it has read, using the source's own «since:» and «until:» operators.
 *
 * The fake source below has the live source's shape: results newest first, the search text's since/until operators (until exclusive), 20 a page by cursor, and a fixed depth (60 results) per search.
 */
const ENDPOINT = "anyapi.x.search.posts";
const TOPIC = "محمد صلاح";
const DAY = 86_400_000;
const DEPTH = 60;
const PER_PAGE = 20;
const PER_DAY = 6;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const START = Date.now();

/** Every tweet of the last 100 days, newest first: six a day. */
const ALL = Array.from({ length: 100 }, (_, k) => Array.from({ length: PER_DAY }, (_, i) => ({ id: `19${String(k).padStart(3, "0")}${i}`, createdAt: new Date(START - k * DAY - i * 60_000 - 1000).toISOString() }))).flat();
const tweet = (t: { id: string; createdAt: string }) => ({ id: t.id, text: `${TOPIC} يسجل هدفًا في المباراة ${t.id}`, url: `https://x.example/u/status/${t.id}`, author: `user${Number(t.id.slice(-2)) % 40}`, createdAt: t.createdAt });

const searches: Array<{ since: string | null; until: string | null; cursor: string | null }> = [];
function source(o: TregCallOptions) {
  const p = o.params as Record<string, unknown>;
  const q = String(p.query ?? "");
  const since = /since:(\d{4}-\d{2}-\d{2})/.exec(q)?.[1] ?? null;
  const until = /until:(\d{4}-\d{2}-\d{2})/.exec(q)?.[1] ?? null;
  const cursor = typeof p.cursor === "string" ? p.cursor : null;
  searches.push({ since, until, cursor });
  const inWindow = ALL.filter((t) => (since === null || dayOf(Date.parse(t.createdAt)) >= since) && (until === null || dayOf(Date.parse(t.createdAt)) < until)).slice(0, DEPTH);
  const from = cursor ? Number(cursor.replace("cur_", "")) : 0;
  const items = inWindow.slice(from, from + PER_PAGE).map(tweet);
  const next = from + PER_PAGE < inWindow.length ? `cur_${from + PER_PAGE}` : null;
  return tregResult({ output: { data: { items, nextCursor: next } } }, 0.00075);
}

const sinceDay = dayOf(START - 90 * DAY);
const untilDay = dayOf(START + DAY);
const planning = () => planningFlow({
  progress: "أبحث عن أرخص مصدر مناسب للتغريدات", searchWords: ["tweets", "search"], platform: "x",
  sample: [{ endpoint: ENDPOINT, params: { query: `${TOPIC} since:${sinceDay} until:${untilDay}`, limit: PER_PAGE }, why: "the cheaper sources return no author or link fields in their catalog description" }],
  sampleCode: "return inputs.call_0001.output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author, date: t.createdAt }))",
  plan: (res: Results) => ({
    summary_ar: "ستحصل على ١٥٠ تغريدة عن محمد صلاح من آخر ٣ شهور مع نص كل تغريدة ورابطها.",
    stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: ENDPOINT, expected_rows: 150, parent_key: null, deliver: true,
      columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "date", title_ar: "التاريخ والوقت" }],
      filters: [{ kind: "period", days: 90 }],
      sample_rows: [0, 1, 2].map((n) => ({ id: tweet(ALL[n]).id, text: tweet(ALL[n]).text, url: tweet(ALL[n]).url, author: tweet(ALL[n]).author, date: ALL[n].createdAt })), measured_by: [callIds(res)[0]], relevance: aboutWords([TOPIC]), yield_from: firstOutputId(res) }],
  }),
});

describe("the source stops after its depth: the engine walks back through the requested period in date windows", () => {
  it("150 tweets of the last 90 days, a source that gives 60 per search: three windows, each ending on the oldest day read, no tweet twice, every delivered tweet inside the period, the whole 150 delivered and charged by the file", async () => {
    searches.length = 0;
    const r = await replay({ request: "هات ١٥٠ تغريدة عن محمد صلاح آخر ٣ شهور", planning: planning(), execution: () => [], answers: Array.from({ length: 60 }, () => source) });
    expect(r.executionDriver.results).toEqual([]);
    // the recipe carries the source's own date window (from the catalog)
    expect(r.plannedPlan.stages[0].engine?.window).toEqual({ kind: "query_operators", param: "query" });
    assertReplayInvariants(r, { expectDelivered: 150 });
    // the windows: every search after the first pages of a window carries a smaller «until» than the window before
    const untils = [...new Set(searches.slice(1).map((s) => s.until))];
    expect(untils.length).toBeGreaterThanOrEqual(3);
    expect(untils.filter((u): u is string => u !== null)).toEqual([...untils].filter((u): u is string => u !== null).sort().reverse());
    // every window keeps the period's first day
    expect(searches.slice(1).every((s) => s.since === sinceDay)).toBe(true);
    const snap = await readSnapshot(r.store, r.missionId);
    const c = snap.counts("tweets");
    expect(c.accepted).toBe(150);
    expect(snap.stage("tweets").stop).toBe("target_reached");
    // the file: 150 tweets, no duplicate id, the oldest of them 24 days back (six a day), all of them inside the 90 days
    const wb = await readWorkbook(r);
    const sheet = wb.getWorksheet("التغريدات")!;
    expect(sheet.rowCount).toBe(151);
    const ids = new Set<string>();
    sheet.eachRow((row, n) => { if (n > 1) ids.add(String(row.getCell(row.cellCount).value)); });
    expect(ids.size).toBe(150);
    expect(r.mission.delivered_units).toBe(150);
  });

  it("a period shorter than the request needs: the walk ends at the first day of the period and the shortfall is honest (30 tweets of the last 5 days asked for 150)", async () => {
    searches.length = 0;
    // the same plan with a five-day period: only 30 tweets exist inside it
    const r = await replay({ request: "هات ١٥٠ تغريدة عن محمد صلاح آخر ٥ أيام", planning: replayPlanWithDays(5), execution: () => [], answers: Array.from({ length: 60 }, () => source) });
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.counts("tweets").accepted).toBe(5 * PER_DAY);
    const oldest = Math.min(...(snap.acceptedRows("tweets").map((x) => Date.parse(String(x.date)))));
    expect(oldest).toBeGreaterThanOrEqual(START - 5 * DAY - DAY);
    expect(snap.stage("tweets").stop).toBe("source_exhausted");
    expect(r.mission.status).toBe("completed");
    expect(r.mission.delivered_units).toBe(5 * PER_DAY);
  });
});

function replayPlanWithDays(days: number) {
  return planningFlow({
    progress: "أبحث عن أرخص مصدر مناسب للتغريدات", searchWords: ["tweets", "search"], platform: "x",
    sample: [{ endpoint: ENDPOINT, params: { query: `${TOPIC} since:${dayOf(START - days * DAY)} until:${untilDay}`, limit: PER_PAGE }, why: "the cheaper sources return no author or link fields in their catalog description" }],
    sampleCode: "return inputs.call_0001.output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author, date: t.createdAt }))",
    plan: (res: Results) => ({
      summary_ar: `ستحصل على ١٥٠ تغريدة عن محمد صلاح من آخر ${days} أيام مع نص كل تغريدة ورابطها.`,
      stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: ENDPOINT, expected_rows: 150, parent_key: null, deliver: true,
        columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "date", title_ar: "التاريخ والوقت" }],
        filters: [{ kind: "period", days }],
        sample_rows: [0, 1, 2].map((n) => ({ id: tweet(ALL[n]).id, text: tweet(ALL[n]).text, url: tweet(ALL[n]).url, author: tweet(ALL[n]).author, date: ALL[n].createdAt })), measured_by: [callIds(res)[0]], relevance: aboutWords([TOPIC]), yield_from: firstOutputId(res) }],
    }),
  });
}
