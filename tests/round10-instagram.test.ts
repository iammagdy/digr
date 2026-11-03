import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler, type CompiledPlanning } from "../agent/src/compiled";
import { cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";
import { cairoMomentAr } from "../src/lib/agentMission/foundation/cairoText";
import { promisedRowsOf } from "../src/lib/agentMission/promisedTotal";
import { toArabicDigits } from "../src/lib/arabicDigits";
import { replayGateway } from "./helpers/replayGateway";

/**
 * LIVE ROUND 10 (3 Nov 2026), item 2: msn_fc40280193aab21b9201 («هات منشورين من حساب الحدث على إنستجرام (alhadath)»). The listing was read ONE page (12 posts, the call log: one call, 12 rows) because the second page was read only when the
 * request had a period; the two chosen posts (13:19 and 13:51 Cairo, counters 45 and 9) were the most commented of the LAST 12, i.e. of the last few hours of a news account. The gateway's two samples of a source (`GATEWAY_MAX_SAMPLES_PER_SOURCE`,
 * untouched) allow a second page: the pool is two pages (24 posts), and the card says before approval how many posts it chose from and what period they cover. The real pages are M16 call 2 (the first page, 12 posts, `next_max_id`) and, as the second
 * page (declared in the test, the README's precedent), M15 call 7: another real page of the same account's listing.
 */
const catalog = loadTregCatalog();
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };
const M16 = "msn_e3e7632e2fb2d42f9c19";
const M15 = "msn_afe9bb0b436670e35a3c";
const SCRAPE = "scrapecreators.instagram.user.posts";
const request = fixture.missions.find((m) => m.id === M16)!.request;
const rawPage = (mission: string, call: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${mission}/raw/${call}.json`, import.meta.url), "utf8"));

async function plan(over: { requestText?: string; created?: string; borrowSecond?: boolean } = {}) {
  const store = createMemoryStore();
  const target = "msn_r10_ig";
  const { gateway, stats } = replayGateway(M16, catalog, store, target, over.borrowSecond === false ? {} : { borrow: [{ endpointId: SCRAPE, fromMission: M15, call: "call_0007", when: (p) => p.next_max_id !== undefined }] });
  const created = over.created ?? "2026-11-03T12:07:46Z";
  const out = await planByCompiler({ mission: { id: target, request_text: over.requestText ?? request, answer_text: null, created_at: created }, gateway, store, catalog, nowMs: Date.parse(created) + 60_000 });
  return { out, stats };
}
const planOf = (out: CompiledPlanning) => { if (out.kind !== "plan") throw new Error(`no plan: ${out.kind}${"reason" in out ? ` ${out.reason}` : ""}`); return out; };

describe("2. the pool of an account listing is as deep as its pageable card allows (two pages), with no period in the request", () => {
  it("the listing is read twice (the first page, then the next by `next_max_id`) for a request with no period, and the chosen two are the most commented of the whole pool", async () => {
    const { out, stats } = await plan();
    const p = planOf(out);
    expect(p.reads.pool).toBe(2);
    expect(stats.served.filter((s) => s.endpointId === SCRAPE)).toHaveLength(2);
    expect(typeof stats.served.filter((s) => s.endpointId === SCRAPE)[1].params.next_max_id).toBe("string");
    const card = cardOf(SCRAPE)!;
    const union = new Map<string, Record<string, unknown>>();
    for (const page of [rawPage(M16, "call_0002"), rawPage(M15, "call_0007")]) for (const r of mapPage(card, page)) if (!union.has(String(r.id))) union.set(String(r.id), r);
    const best = [...union.values()].sort((a, b) => Number(b.comments) - Number(a.comments)).slice(0, 2).map((r) => String(r.id)).sort();
    expect((p.plan.stages[0].pinned_rows as Array<Record<string, unknown>>).map((r) => String(r.id)).sort()).toEqual(best);
  });

  it("the card says plainly «اخترنا الأكثر تعليقًا من آخر N منشورًا» with N the posts of the pool and the period they cover, in Cairo time", async () => {
    const p = planOf((await plan()).out);
    const card = cardOf(SCRAPE)!;
    const union = new Map<string, Record<string, unknown>>();
    for (const page of [rawPage(M16, "call_0002"), rawPage(M15, "call_0007")]) for (const r of mapPage(card, page)) if (!union.has(String(r.id))) union.set(String(r.id), r);
    const times = [...union.values()].map((r) => Date.parse(String(r.posted_at))).filter(Number.isFinite);
    const n = union.size;
    const line = (p.plan.notes_ar ?? []).find((x) => x.startsWith("اخترنا الأكثر تعليقًا"));
    expect(line, (p.plan.notes_ar ?? []).join("\n")).toBeDefined();
    expect(line).toContain(`اخترنا الأكثر تعليقًا من آخر ${toArabicDigits(n)} منشورًا`);
    expect(line).toContain(`من ${cairoMomentAr(Math.min(...times))} إلى ${cairoMomentAr(Math.max(...times))} بتوقيت القاهرة`);
    expect(line).not.toMatch(/[0-9]/);
  });

  it("with only one page answered the card still says it, with that page's N (never a number it did not read)", async () => {
    const { out } = await plan({ borrowSecond: false });
    const p = planOf(out);
    const line = (p.plan.notes_ar ?? []).find((x) => x.startsWith("اخترنا الأكثر تعليقًا"));
    expect(line).toContain("من آخر ١٢ منشورًا");
  });

  it("the newest asked for: the line is not said (nothing was chosen by comments)", async () => {
    const p = planOf((await plan({ requestText: "هات أحدث منشورين من حساب الحدث على إنستجرام (alhadath)، مع كل التعليقات والردود." })).out);
    expect((p.plan.notes_ar ?? []).some((x) => x.startsWith("اخترنا الأكثر تعليقًا"))).toBe(false);
  });
});

describe("the Cairo moment in words (dates in Cairo time)", () => {
  it("2026-11-03 11:19 UTC is 13:19 in Cairo; a moment in summer time keeps Cairo's own offset", () => {
    expect(cairoMomentAr(Date.parse("2026-11-03T11:19:34Z"))).toBe("٣ نوفمبر ٢٠٢٦ الساعة ١٣:١٩");
    expect(cairoMomentAr(Date.parse("2026-07-01T10:05:00Z"))).toBe("١ يوليو ٢٠٢٦ الساعة ١٣:٠٥");
  });
});

describe("2b. one promised number everywhere: the orders page says what the file and the chat say", () => {
  // the live record (SELECT on missions): the plan promised 2 + 54 + 3 = 59 at approval; the delivery was judged against the reply counters of the delivered comments (7), so the finished card, the file and the notice said «٤٣ من ٦٣»
  const stagesAtFinish = [{ key: "posts", expected_rows: 2, deliver: true }, { key: "comments", expected_rows: 54, deliver: true }, { key: "comments_replies", expected_rows: 7, deliver: true, replies_open: true }];
  it("a finished mission with judged replies is promised the judged total (63) on the orders page too, not the job's 59", () => {
    expect(promisedRowsOf(stagesAtFinish, 59)).toBe(63);
  });
  it("a mission planned the old way (no compiled plan) keeps the job's own number, whatever its replies stage says", () => {
    expect(promisedRowsOf(stagesAtFinish, 59, false)).toBe(59);
  });
  it("a mission with no open replies keeps the job's own number, and so does one with no stages", () => {
    expect(promisedRowsOf(stagesAtFinish.map((s) => ({ key: s.key, expected_rows: s.expected_rows, deliver: s.deliver })), 59)).toBe(59);
    expect(promisedRowsOf(undefined, 59)).toBe(59);
    expect(promisedRowsOf([], 0)).toBe(0);
  });
});
