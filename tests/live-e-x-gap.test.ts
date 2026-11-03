import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import { threadCounterLinesOfPlan } from "../agent/src/threadCounters";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { compilePlan, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * LIVE ROUND 7 (3 Nov 2026, msn_9fa5ba384c05a25247e1: «هات ٢٠ تغريدة على X فيها «العاصمة الإدارية» ... مع الردود»; 20 tweets, 25 replies delivered, 33 promised by the platform's counters).
 * The file's «حدود هذا التسليم» told the tweets' period coverage and NOTHING about the replies gap. TikTok says it per video; X must say it per TWEET, the same way: the reply counter of the delivered tweet against the replies delivered.
 *
 * THE NUMBERS ARE REAL (read-only SELECTs on the mission's stored plan and calls): the five tweets that have replies carry the platform counters 23, 5, 3, 1, 1 (the other 15 carry 0) and the replies read for them were 16, 4, 1, 2, 2 (mission_calls.rows_returned of the five
 * replies calls; 25 in all). The ids and texts of the test are the anonymised M14 page's (the pool page of the same search), not the live ones.
 */
const catalog = loadTregCatalog();
void catalog;
const M14 = "msn_b060d3347ed7660f972e";
const AT = Date.parse("2026-11-03T08:31:29Z");
const REQUEST = "هات ٢٠ تغريدة على X فيها «العاصمة الإدارية» بالعربي في شهر أكتوبر ٢٠٢٦، مع الردود";
const page = JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M14}/raw/call_0003.json`, import.meta.url), "utf8"));
const searchCard = cardOf("anyapi.x.search.posts")!;
const LIVE_COUNTERS = [23, 5, 3, 1, 1];
const LIVE_DELIVERED = [16, 4, 1, 2, 2];

function liveShape() {
  const ask = buildAsk(REQUEST, null, AT);
  const r = compilePlan({ ask, pool: { card: searchCard, params: parentInputs(searchCard, ask), pages: [{ callId: "call_0001", page }] }, exposure: () => undefined, capabilityOf: (id) => catalog.byId.get(id)?.capability ?? null, catalogOnly: true });
  if (!r.ok) throw new Error(r.reason);
  const chosen = mapPage(searchCard, page).filter((t) => r.chosen.includes(String(t.id)));
  const tweets = chosen.slice(0, 20).map((t, i): Record<string, any> => ({ ...t, replies_count: LIVE_COUNTERS[i] ?? 0, __marks: { reply: false, repost: false, lang: "ar", inPeriod: true, named: null } }));
  const replies = tweets.flatMap((t, i) => Array.from({ length: LIVE_DELIVERED[i] ?? 0 }, (_, k) => ({ id: `r_${i}_${k}`, parent_id: String(t.id), text: `نص ${k}`, author: "a", posted_at: "2026-10-05T10:00:00.000Z", likes: 0, replies_count: 0, language: "" })));
  return { plan: r.plan as PricedPlan, tweets, replies };
}

const nounsOf = (title: string | undefined): string | null => (/تغريد/.test(title ?? "") ? "تغريدة" : /رد/.test(title ?? "") ? "رد" : null);

describe("round 7, item 3: the X replies gap is stated per tweet, from the tweet's reply counter against the replies delivered", () => {
  it("the live shape: 20 tweets, replies 16 + 4 + 1 + 2 + 2 = 25, counters 23 + 5 + 3 + 1 + 1 = 33", () => {
    const { tweets, replies } = liveShape();
    expect(tweets).toHaveLength(20);
    expect(replies).toHaveLength(25);
    expect(tweets.reduce((n, t) => n + Number(t.replies_count), 0)).toBe(33);
  });

  it("the limit lines name each tweet that gave fewer replies than its counter, with both numbers, and the source as the one who did not give the rest", () => {
    const { plan, tweets, replies } = liveShape();
    const { limitLines } = threadCounterLinesOfPlan(plan, { tweets, replies }, nounsOf);
    expect(limitLines).toEqual([
      "التغريدة رقم ١: ردودها بحسب عدّاد المنصة ٢٣ ردًا وسُلّم منها ١٦ ردًا؛ والفرق لم يعطِه المصدر",
      "التغريدة رقم ٢: ردودها بحسب عدّاد المنصة ٥ ردود وسُلّم منها ٤ ردود؛ والفرق لم يعطِه المصدر",
      "التغريدة رقم ٣: ردودها بحسب عدّاد المنصة ٣ ردود وسُلّم منها رد واحد؛ والفرق لم يعطِه المصدر",
    ]);
  });

  it("a tweet that gave MORE replies than its counter is not called a gap, but its two numbers are told (the counter lines)", () => {
    const { plan, tweets, replies } = liveShape();
    const { counterLines, limitLines } = threadCounterLinesOfPlan(plan, { tweets, replies }, nounsOf);
    expect(counterLines).toContain("التغريدة رقم ٤: ردودها بحسب عدّاد المنصة رد واحد وسُلّم منها ردان");
    expect(counterLines).toContain("التغريدة رقم ٥: ردودها بحسب عدّاد المنصة رد واحد وسُلّم منها ردان");
    expect(limitLines.join("\n")).not.toMatch(/رقم ٤|رقم ٥/);
    // the 15 tweets with no counter and no reply are not listed (no noise)
    expect(counterLines).toHaveLength(5);
  });

  it("the file's «حدود هذا التسليم» carries the replies gap, next to the period line", async () => {
    const { plan, tweets, replies } = liveShape();
    const built = await buildMissionFiles(plan, { tweets, replies } as never);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.xlsx as unknown as ArrayBuffer);
    const text: string[] = [];
    wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => { const v = c.value; text.push(v === null || v === undefined ? "" : typeof v === "object" && "text" in v ? String((v as { text: unknown }).text) : String(v)); })));
    // the values of one item share a cell, one line each: the limits cell holds the gap lines (with «والفرق لم يعطِه المصدر») beside the period line
    const limits = text.find((t) => t.includes("والفرق لم يعطِه المصدر") && /غطّت النتائج/.test(t))!;
    expect(limits).toBeDefined();
    expect(limits.split("\n")).toContain("التغريدة رقم ١: ردودها بحسب عدّاد المنصة ٢٣ ردًا وسُلّم منها ١٦ ردًا؛ والفرق لم يعطِه المصدر");
    expect(limits.split("\n").filter((l) => /^التغريدة رقم/.test(l))).toHaveLength(3);
    // the counter lines stay in their own block: all five tweets, with both numbers
    expect(text.some((t) => t.split("\n").filter((l) => /^التغريدة رقم/.test(l)).length === 5)).toBe(true);
  });

  it("no replies were asked (no replies stage): the file has no such line, exactly as before", () => {
    const { plan, tweets } = liveShape();
    const noReplies = { ...plan, stages: plan.stages.filter((s) => s.key === "tweets") } as PricedPlan;
    const { counterLines, limitLines } = threadCounterLinesOfPlan(noReplies, { tweets }, nounsOf);
    expect(counterLines).toEqual([]);
    expect(limitLines).toEqual([]);
  });

  it("every reply delivered: the counters are met, so no limit line (a tweet with 0 replies and 0 counter is silent)", () => {
    const { plan, tweets } = liveShape();
    const met = tweets.map((t, i): Record<string, any> => ({ ...t, replies_count: i < 2 ? 1 : 0 }));
    const replies = [0, 1].map((i) => ({ id: `m_${i}`, parent_id: String(met[i].id), text: "x", author: "a", posted_at: "2026-10-05T10:00:00.000Z", likes: 0, replies_count: 0, language: "" }));
    const { limitLines } = threadCounterLinesOfPlan(plan, { tweets: met, replies }, nounsOf);
    expect(limitLines).toEqual([]);
  });
});
