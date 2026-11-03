import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { RAW_PATH } from "../agent/src/gateway";
import { buildMissionFiles } from "../agent/src/workbook";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { aboutQueryOf, noAboutChoiceOf, NO_ABOUT_OPTIONS_AR, topicRelationAr, TOPIC_RELATION_KEY } from "../src/lib/agentMission/foundation/topicChoice";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { checkCustomerText } from "../src/lib/agentMission/text";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * LIVE ROUND 7 (3 Nov 2026, msn_4e68812d396bd5db0a01 and msn_2dfcf9cc113dff442711 against msn_e32cd467fe6bbdfa943e), item 1.
 * EVIDENCE (read-only SELECTs on mission_calls and the plans): the three missions made the SAME search call (tikhub search, keyword «الذكاء الاصطناعي», region EG, sort_type 1, count 20). The two videos of round 7 and of the live run
 * of the morning are the same four videos (chosen + spare: 7650084504324902176, 7692547380482346263, 7677720677482335508, 7689504070012292360); the run of the night before (e32cd467) has four others, none of them in common. So the difference is
 * what the source returned for the identical request at another time (10 rows in round 7, 20 in that run), not our query, sort, region or page. When the pool has no video whose caption is about the topic, the plan now
 * reads ONE more page with a query built by code from the Ask (the topic with the words of talking about it) and ranks the union by the same rule; if the union still has none, a question card is shown BEFORE approval.
 *
 * THE DATA. The anonymiser replaces every caption, so the pages are the REAL anonymised page of the same search (M12 call_0007: 10 rows, the ids, counters, countries and languages are real) with made-up captions of the quoted structure; the
 * second page is the same real page with other ids. The comments page is the real anonymised page of M12 (call_0008). The source's answer to the SECOND query is NOT known: no real page of it exists (that is what the next live run shows).
 */
const catalog = loadTregCatalog();
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/msn_5851abc92a1e6645a9cd/raw/${name}.json`, import.meta.url), "utf8"));
const REAL_SEARCH = fixture("call_0007") as { data: { search_item_list: Array<{ aweme_info: Record<string, unknown> }> } };
const REAL_COMMENTS = fixture("call_0008");
const REQUEST = "عايز فيديوهين من تيك توك من مصر بالعربي عن الذكاء الاصطناعي، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم";
const HASHTAG_ONLY = "قصة كرتونية قصيرة #ai #كرتون #ذكاء_اصطناعي";
const ABOUT_BODY = "شرح مبسط عن الذكاء الاصطناعي وازاي بيشتغل #تقنية";

function searchPage(opts: { suffix: string; caption: (i: number) => string }): unknown {
  const copy = JSON.parse(JSON.stringify(REAL_SEARCH)) as typeof REAL_SEARCH;
  copy.data.search_item_list.forEach((it, i) => { it.aweme_info.aweme_id = `${String(it.aweme_info.aweme_id)}${opts.suffix}`; it.aweme_info.desc = opts.caption(i); });
  return copy;
}

/** A gateway that answers the search endpoint with the given pages in order, and any comments read with the real comments page; records every call. */
function stubGateway(pages: unknown[], opts: { refuseSecond?: boolean } = {}) {
  const store = createMemoryStore();
  const calls: Array<{ endpointId: string; params: Record<string, unknown> }> = [];
  let n = 0;
  let searches = 0;
  const gateway = {
    async tregCall(input: { endpoint_id?: unknown; params?: unknown }) {
      const endpointId = String(input.endpoint_id ?? "");
      const params = (input.params ?? {}) as Record<string, unknown>;
      calls.push({ endpointId, params });
      n += 1;
      const id = `call_${String(n).padStart(4, "0")}`;
      const isSearch = endpointId === "tikhub.tiktok.search.videos";
      if (isSearch) searches += 1;
      if (isSearch && searches === 2 && opts.refuseSecond) return { ok: false as const, call_id: id, refused: "repeat_sample", message: "refused" };
      const page = isSearch ? pages[Math.min(searches - 1, pages.length - 1)] : REAL_COMMENTS;
      await store.putFile("msn_r7", RAW_PATH(id), JSON.stringify(page), "application/json");
      const { reading } = buildShapeDigest(page, catalog.byId.get(endpointId)!);
      return { ok: true as const, call_id: id, http_status: 200, rows_in_page: reading.rows.length, has_more: null, next_cursor: null };
    },
  };
  return { store, gateway, calls };
}
const searchCalls = (c: Array<{ endpointId: string; params: Record<string, unknown> }>) => c.filter((x) => x.endpointId === "tikhub.tiktok.search.videos");
const plan = (g: ReturnType<typeof stubGateway>, answer: string | null = null, request = REQUEST) => planByCompiler({ mission: { id: "msn_r7", request_text: request, answer_text: answer, created_at: "2026-11-03T08:30:04Z" }, gateway: g.gateway as never, store: g.store, catalog, nowMs: Date.parse("2026-11-03T08:31:00Z") });

describe("round 7, item 1: no video of the pool is about the topic, so one more page is read with the topic and the words of talking about it", () => {
  it("the query is built by code from the Ask: the topic and the explainer words, the same region and sort", () => {
    const ask = buildAsk(REQUEST, null, Date.parse("2026-11-03T08:30:04Z"));
    expect(aboutQueryOf(ask)).toBe("الذكاء الاصطناعي شرح وأخبار");
    // made with: nothing to look for beyond the first query; no topic: none
    expect(aboutQueryOf(buildAsk("عايز فيديوهين من تيك توك معمول بالذكاء الاصطناعي", null, 0))).toBeNull();
    expect(aboutQueryOf(buildAsk("عايز فيديوهين من تيك توك من مصر", null, 0))).toBeNull();
  });

  it("the first page has only hashtag-only captions: a second search is made with the new keyword and everything else as before", async () => {
    const g = stubGateway([searchPage({ suffix: "", caption: () => HASHTAG_ONLY }), searchPage({ suffix: "1", caption: (i) => (i === 3 ? ABOUT_BODY : HASHTAG_ONLY) })]);
    const r = await plan(g);
    expect(searchCalls(g.calls)).toHaveLength(2);
    const [first, second] = searchCalls(g.calls).map((c) => c.params);
    expect(first.keyword).toBe("الذكاء الاصطناعي");
    expect(second.keyword).toBe("الذكاء الاصطناعي شرح وأخبار");
    expect({ ...second, keyword: null }).toEqual({ ...first, keyword: null });
    if (r.kind !== "plan") throw new Error(JSON.stringify(r));
    expect(r.reads.pool).toBe(2);
    // the union is ranked by the same rule: the video that is about the topic comes first, and the card does not claim the pool had none
    const videos = r.plan.stages.find((s) => s.key === "videos")!;
    expect(String(videos.pinned_rows![0].text)).toBe(ABOUT_BODY);
    expect((r.plan.notes_ar ?? []).join("\n")).not.toMatch(/لم نجد في ما قرأناه فيديو يتحدث نصه عن/);
  });

  it("the first page already has a video about the topic: no second search (exactly what it was)", async () => {
    const g = stubGateway([searchPage({ suffix: "", caption: (i) => (i === 3 ? ABOUT_BODY : HASHTAG_ONLY) })]);
    const r = await plan(g);
    expect(r.kind).toBe("plan");
    expect(searchCalls(g.calls)).toHaveLength(1);
  });

  it("«معمول بالذكاء الاصطناعي»: no second search and no question (the hashtag is what was asked)", async () => {
    const g = stubGateway([searchPage({ suffix: "", caption: () => HASHTAG_ONLY })]);
    const r = await plan(g, null, "عايز فيديوهين من تيك توك من مصر بالعربي معمول بالذكاء الاصطناعي، أكتر فيديوهات عليها تعليقات");
    expect(r.kind).toBe("plan");
    expect(searchCalls(g.calls)).toHaveLength(1);
  });
});

describe("round 7, item 1: the union still has no video about the topic: the question card before approval", () => {
  it("a question with the three choices, and no plan: nothing is held, nothing is priced", async () => {
    const g = stubGateway([searchPage({ suffix: "", caption: () => HASHTAG_ONLY }), searchPage({ suffix: "1", caption: () => HASHTAG_ONLY })]);
    const r = await plan(g);
    if (r.kind !== "question") throw new Error(`expected a question, got ${r.kind}`);
    expect(searchCalls(g.calls)).toHaveLength(2);
    expect(r.options).toEqual([NO_ABOUT_OPTIONS_AR.useAsIs, NO_ABOUT_OPTIONS_AR.change, NO_ABOUT_OPTIONS_AR.cancel]);
    expect(r.question).toMatch(/لم نجد في ما قرأناه فيديو يطابق طلبك ويتحدث نصه عن «الذكاء الاصطناعي»/);
    expect(r.question).toMatch(/الوسوم/);
    // Arabic only, Arabic-Indic digits, no provider, no endpoint, no USD, no emoji
    for (const t of [r.question, ...r.options]) { expect(checkCustomerText(t, { maxChars: 600 }).issues, t).toEqual([]); expect(t).not.toMatch(/[0-9]|anyapi|tikhub|usd|\$/i); }
  });

  it("the second search was refused (the cap): the question is still asked, from the first page", async () => {
    const g = stubGateway([searchPage({ suffix: "", caption: () => HASHTAG_ONLY })], { refuseSecond: true });
    const r = await plan(g);
    expect(r.kind).toBe("question");
    expect(searchCalls(g.calls)).toHaveLength(2);
  });

  it("the customer chose «use them as they are»: the plan is made, says so on the card, and marks every video's relation to the topic", async () => {
    const g = stubGateway([searchPage({ suffix: "", caption: () => HASHTAG_ONLY }), searchPage({ suffix: "1", caption: () => HASHTAG_ONLY })]);
    const r = await plan(g, NO_ABOUT_OPTIONS_AR.useAsIs);
    if (r.kind !== "plan") throw new Error(`expected a plan, got ${r.kind}`);
    expect((r.plan.notes_ar ?? []).join("\n")).toMatch(/لم نجد في ما قرأناه فيديو يتحدث نصه عن «الذكاء الاصطناعي»/);
    const videos = r.plan.stages.find((s) => s.key === "videos")!;
    expect(videos.columns.map((c) => c.title_ar)).toContain("علاقة النص بالموضوع");
    expect(videos.pinned_rows!.every((x) => x[TOPIC_RELATION_KEY] === topicRelationAr(1))).toBe(true);
    // the marked rows reach the file as a column of the videos sheet (nothing is removed)
    const rows = videos.pinned_rows!.map((x) => ({ ...x }));
    const built = await buildMissionFiles(r.plan as PricedPlan, { videos: rows, comments: [] } as never);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(built.xlsx as unknown as ArrayBuffer);
    const sheet = wb.worksheets.find((w) => (w.getRow(1).values as unknown[]).some((v) => v === "علاقة النص بالموضوع"))!;
    expect(sheet).toBeDefined();
    const col = (sheet.getRow(1).values as unknown[]).indexOf("علاقة النص بالموضوع");
    expect(String(sheet.getRow(2).getCell(col).value)).toBe("يذكر الموضوع في الوسوم فقط");
  });

  // CHANGED (live round 11, item 3): the column is on the parent sheet whenever the Ask has a topic, even when every chosen video is about it (it said nothing before, so «all about it» could not be told from «not checked»)
  it("a plan whose chosen videos are all about the topic still has the column, and every video says it talks about the topic", async () => {
    const g = stubGateway([searchPage({ suffix: "", caption: () => ABOUT_BODY })]);
    const r = await plan(g);
    if (r.kind !== "plan") throw new Error(r.kind);
    const videos = r.plan.stages.find((s) => s.key === "videos")!;
    expect(videos.columns.map((c) => c.title_ar)).toContain("علاقة النص بالموضوع");
    for (const row of (videos.pinned_rows ?? []) as Array<Record<string, unknown>>) expect(row.topic_relation).toBe("يتحدث نصه عن الموضوع");
  });
});

describe("round 7, item 1: the customer's answer", () => {
  it("is read by its exact words: use as is, change the request, cancel; any other text is an amendment of the request (none of the three)", () => {
    expect(noAboutChoiceOf(NO_ABOUT_OPTIONS_AR.useAsIs)).toBe("use");
    expect(noAboutChoiceOf(`  ${NO_ABOUT_OPTIONS_AR.change} `)).toBe("change");
    expect(noAboutChoiceOf(NO_ABOUT_OPTIONS_AR.cancel)).toBe("cancel");
    expect(noAboutChoiceOf("فيديوهات بتتكلم عن الذكاء الاصطناعي في التعليم")).toBeNull();
    expect(noAboutChoiceOf(null)).toBeNull();
  });
});

/**
 * THE REAL ROUND-7 PAGE (msn_4e68812d396bd5db0a01, call_0001, anonymised: ids, regions, languages and counters are real). Run on the REAL captions (kept in the scratch folder, not committed): of its 10 videos exactly ONE has the topic in its caption body, and it is a SAUDI video
 * (region SA); the nine Egyptian ones name the topic in hashtags only. The first version of the check «does the pool have a video about the topic» counted that Saudi video, so no second search and no question happened. A video that is not from the country the customer asked for ranks below
 * every video that is (the owner's order puts the country and the language before the topic), so it is not a video the plan can choose: only a video that meets the named source, the country and the language counts as «about».
 */
describe("round 7, item 1 on the real page: a video about the topic from another country is not an answer", () => {
  const R7 = JSON.parse(readFileSync(new URL("./fixtures/live/missions/msn_4e68812d396bd5db0a01/raw/call_0001.json", import.meta.url), "utf8")) as { data: { search_item_list: Array<{ aweme_info: Record<string, unknown> }> } };
  const real = R7.data.search_item_list.map((x) => ({ id: String(x.aweme_info.aweme_id), region: String(x.aweme_info.region) }));
  const saudi = real.find((r) => r.region === "SA")!;
  const page = (suffix: string, aboutId: string | null, caption: string = ABOUT_BODY): unknown => {
    const copy = JSON.parse(JSON.stringify(R7)) as typeof R7;
    for (const it of copy.data.search_item_list) {
      const id = String(it.aweme_info.aweme_id);
      it.aweme_info.aweme_id = `${id}${suffix}`;
      it.aweme_info.desc = id === aboutId ? caption : HASHTAG_ONLY;
    }
    return copy;
  };

  it("the real page has exactly one Saudi video and nine from other regions (the structure the test stands on)", () => {
    expect(real).toHaveLength(10);
    expect(saudi).toBeDefined();
    expect(real.filter((r) => r.region === "EG").length).toBeGreaterThanOrEqual(6);
  });

  it("the only video about the topic is Saudi: a second search is made (it is not an answer for a customer who asked for Egypt)", async () => {
    const egypt = real.find((r) => r.region === "EG")!;
    const g = stubGateway([page("", saudi.id), page("1", egypt.id)]);
    const r = await plan(g);
    expect(searchCalls(g.calls)).toHaveLength(2);
    if (r.kind !== "plan") throw new Error(r.kind);
    const videos = r.plan.stages.find((s) => s.key === "videos")!;
    expect(String(videos.pinned_rows![0].id)).toBe(`${egypt.id}1`);
    expect(String(videos.pinned_rows![0].text)).toBe(ABOUT_BODY);
  });

  it("the second page has no Egyptian video about the topic either: the question, whose words do not claim that no video at all talks about it", async () => {
    const g = stubGateway([page("", saudi.id), page("1", null)]);
    const r = await plan(g);
    if (r.kind !== "question") throw new Error(r.kind);
    expect(r.question).toMatch(/لم نجد في ما قرأناه فيديو يطابق طلبك ويتحدث نصه عن «الذكاء الاصطناعي»/);
  });
});
