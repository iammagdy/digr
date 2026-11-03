import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { rankedPoolOf } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { NAMED_SHORTFALL_OPTIONS_AR } from "../src/lib/agentMission/foundation/namedShortfall";
import { replayGateway } from "./helpers/replayGateway";
import { readFileSync } from "node:fs";

/**
 * LIVE ROUND 11 (3 Nov 2026), Facebook `msn_9d196025e7929324983a`: «آخر ٣ شهور» (3 Aug to 3 Nov, Cairo days), the tester chose «fill from other pages», and the plan chose a post dated 2026-01-19 (1,823 comments: the post that made the hold 26,653).
 * THE REAL PAGES (the owner's admin ZIP, anonymised): the fill search (`anyapi.facebook.search_posts`, call 3) WAS sent `startDate 2026-08-03` and `endDate 2026-11-03` (the call log), and answered 20 posts of which 2 are outside the period (2026-01-19 and 2025-10-02):
 * the source takes the dates as a request and does not keep to them, so the period has to be checked on the rows, as a rule of the choice: every chosen parent and every spare is inside the period (Cairo days, inclusive) whatever search read it.
 */
const catalog = loadTregCatalog();
const M = "msn_9d196025e7929324983a";
const REQUEST = "هات منشورات عن الذكاء الاصطناعي من صفحة قناة العربية على فيسبوك آخر ٣ شهور، ٣ منشورات، مع كل التعليقات والردود.";
const FBS = "justoneapi.x.facebook-search-post-v1";
const FILL = "anyapi.facebook.search_posts";
const CREATED = "2026-11-03T12:05:32Z";
const NOW = Date.parse("2026-11-03T13:32:00Z");
const page = (call: string) => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M}/raw/${call}.json`, import.meta.url), "utf8"));

async function plan(over: { answer?: string } = {}) {
  const store = createMemoryStore();
  const { gateway, stats } = replayGateway(M, catalog, store, "msn_r12_fb", {
    only: { [FBS]: ["keyword", "startDate", "endDate"], [FILL]: ["query", "startDate", "endDate"] },
    borrow: [{ endpointId: FBS, fromMission: M, call: "call_0002", when: (p) => p.cursor !== undefined }],
  });
  const out = await planByCompiler({ mission: { id: "msn_r12_fb", request_text: REQUEST, answer_text: over.answer ?? NAMED_SHORTFALL_OPTIONS_AR.fill, created_at: CREATED }, gateway, store, catalog, nowMs: NOW, catalogOnly: true });
  return { out, stats };
}
const ask = buildAsk(REQUEST, NAMED_SHORTFALL_OPTIONS_AR.fill, Date.parse(CREATED));
const inside = (iso: unknown): boolean => { const t = Date.parse(String(iso)); return Number.isFinite(t) && t >= ask.period!.startMs && t < ask.period!.endExclusiveMs; };

describe("the real pages of the live mission", () => {
  it("the period is 3 Aug to 3 Nov in Cairo days; the fill search carried it; and the source still answered posts outside it (so the rows must be checked)", async () => {
    expect(ask.period).toMatchObject({ from: "2026-08-03", to: "2026-11-03" });
    const { stats } = await plan();
    const reads = stats.served.filter((s) => s.endpointId === FBS || s.endpointId === FILL);
    expect(reads.map((r) => r.endpointId)).toEqual([FBS, FBS, FILL]);
    for (const r of reads) expect(r.params, r.endpointId).toMatchObject({ startDate: "2026-08-03", endDate: "2026-11-03" });
    const fill = page("call_0003").output.data.items as Array<{ createdUtc: number }>;
    expect(fill.filter((x) => !inside(new Date(x.createdUtc * 1000).toISOString()))).toHaveLength(2);
  }, 60_000);
});

describe("when the Ask has a period, every chosen parent and every spare is inside it", () => {
  it("the plan of the live request (fill answer): no chosen post and no spare is outside 3 Aug to 3 Nov, and the 1,823-comment post of 2026-01-19 is not chosen", async () => {
    const { out } = await plan();
    if (out.kind !== "plan") throw new Error(`no plan: ${out.kind}`);
    const parents = out.plan.stages[0];
    const rows = [...((parents.pinned_rows ?? []) as Array<Record<string, unknown>>), ...((parents.spare_rows ?? []) as Array<Record<string, unknown>>)];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) expect(inside(r.posted_at), `${r.id} ${r.posted_at}`).toBe(true);
    expect(rows.map((r) => String(r.id))).not.toContain("122160334562832818");
    expect(out.plan.price.reservePoints).toBeLessThan(25_000);
  }, 60_000);

  it("the card says how many posts it read outside the period and left out (a count, never a post)", async () => {
    const { out } = await plan();
    if (out.kind !== "plan") throw new Error(`no plan: ${out.kind}`);
    const line = (out.plan.notes_ar ?? []).find((x) => x.includes("خارج الفترة"));
    expect(line, (out.plan.notes_ar ?? []).join("\n")).toBeDefined();
    expect(line).toContain("٢٠٢٦-٠٨-٠٣");
    expect(line).toContain("٢٠٢٦-١١-٠٣");
    expect(line).not.toMatch(/[0-9]/);
  }, 60_000);

  it("the pool itself (what the exposure check and the choice both read) holds no row outside the period; a row with no date is not proven inside and is left out too", () => {
    const poolCard = cardOf(FBS)!;
    const fillCard = cardOf(FILL)!;
    const pages = [{ page: page("call_0001") }, { page: page("call_0002") }, { page: page("call_0003"), card: fillCard }];
    const pool = rankedPoolOf({ ask, poolCard, pages });
    expect(pool.length).toBeGreaterThan(10);
    for (const r of pool) expect(inside(r.posted_at), `${r.id} ${r.posted_at}`).toBe(true);
    const undated = { output: { data: { items: [{ id: "u1", text: "x", createdUtc: null, commentCount: 5000, authorName: "a", authorUrl: "u", url: "https://www.facebook.com/x" }] } } };
    expect(rankedPoolOf({ ask, poolCard: fillCard, pages: [{ page: undated }] })).toHaveLength(0);
  });

  it("an Ask with no period keeps every row (nothing is dropped by this rule)", () => {
    const noPeriod = buildAsk("هات منشورات عن الذكاء الاصطناعي من صفحة قناة العربية على فيسبوك، ٣ منشورات", null, Date.parse(CREATED));
    expect(noPeriod.period).toBeNull();
    const pool = rankedPoolOf({ ask: noPeriod, poolCard: cardOf(FILL)!, pages: [{ page: page("call_0003") }] });
    expect(pool).toHaveLength(new Set((page("call_0003").output.data.items as Array<{ id: string }>).map((x) => x.id)).size);
    expect(pool.some((r) => String(r.posted_at).startsWith("2026-01-19"))).toBe(true);
  });
});

describe("the rule is for Facebook, Instagram and YouTube; TikTok and X keep what they do", () => {
  const rows = (iso: string[]) => ({ data: { results: iso.map((t, i) => ({ post_id: `p${i}`, url: `https://www.facebook.com/p/${i}`, message: "m", author: { id: "7", name: "n", url: "u" }, timestamp: Math.floor(Date.parse(t) / 1000), comments_count: 10 - i })) } });
  it("Facebook drops the outside rows, in the same call a TikTok or X pool keeps them (their search takes the period itself and the file marks it)", () => {
    const fb = rankedPoolOf({ ask, poolCard: cardOf(FBS)!, pages: [{ page: rows(["2026-10-01T10:00:00Z", "2026-01-19T10:00:00Z"]) }] });
    expect(fb.map((r) => r.id)).toEqual(["p0"]);
    const x = buildAsk("هات ٢٠ تغريدة على X فيها «العاصمة الإدارية» بالعربي في شهر أكتوبر ٢٠٢٦", null, Date.parse(CREATED));
    expect(x.period).not.toBeNull();
    const tweet = (t: string, i: number) => ({ id: `t${i}`, text: "العاصمة الإدارية", created_at: t, replies_count: 0 });
    const xPage = { output: { data: { items: [tweet("2026-10-05T10:00:00.000Z", 1), tweet("2026-01-05T10:00:00.000Z", 2)] } } };
    const kept = rankedPoolOf({ ask: x, poolCard: cardOf("anyapi.x.search.posts")!, pages: [{ page: xPage }] });
    expect(kept.length).toBe(2);
  });
});

describe("Instagram: the real listing of M16 (12 posts of 2 Nov 2026) against a period", () => {
  const listing = JSON.parse(readFileSync(new URL("./fixtures/live/missions/msn_e3e7632e2fb2d42f9c19/raw/call_0002.json", import.meta.url), "utf8"));
  const at = Date.parse("2026-11-03T12:07:46Z");
  const pool = (request: string) => rankedPoolOf({ ask: buildAsk(request, null, at), poolCard: cardOf("scrapecreators.instagram.user.posts")!, pages: [{ page: listing }] });
  it("a period that holds the posts keeps all 12; a period that does not (October) leaves none, so no post outside it can be chosen", () => {
    expect(pool("هات منشورين من حساب الحدث على إنستجرام (alhadath) آخر ٣ أيام")).toHaveLength(12);
    expect(pool("هات منشورين من حساب الحدث على إنستجرام (alhadath) في شهر أكتوبر ٢٠٢٦")).toHaveLength(0);
  });
});
