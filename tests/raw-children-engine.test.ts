import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay, type ReplayResult } from "./helpers/agentReplay";
import { callIds, tregResult, type Results } from "./helpers/agentFakeWorld";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";
import { readSnapshot } from "../agent/src/items/itemStore";
import type { FakeStep } from "../agent/src/fakeDriver";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { NOT_ADMIN, USER_ID, fakeRecorder } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { planningBudgetFacts } from "../src/lib/agentMission/planningBudget";
import { platformCostNotesAr } from "../src/lib/agentMission/platformNotes";
import { GIVE_UP_REFUSALS_MAX } from "../agent/src/tools";

/**
 * FIX MISSION 5 on the engine: four mission types with a parent and its children (TikTok videos and comments, Google Maps restaurants and reviews, companies and employees, Facebook posts and comments). The parents are chosen by the topic, the language
 * and the place of the request; the children are delivered AS THE SOURCE GIVES THEM. The model planned (a fake transcript against fake provider answers); once approved, code carried the plan out with no model session.
 */
const why = "the cheaper sources return no author or link fields in their catalog description";
const pad = (n: number, w = 6) => String(n).padStart(w, "0");
const planFlow = (o: { progress: string; words: string[]; platform?: string; calls: Array<{ endpoint: string; params: Record<string, unknown>; code: string }>; plan: (res: Results) => unknown }): FakeStep[] => [
  { tool: "report_progress", args: { message_ar: o.progress, counts: { sources: 3 } } },
  { tool: "catalog_search", args: { words: o.words, ...(o.platform ? { platform: o.platform } : {}), limit: 5 } },
  ...o.calls.flatMap((c, i): FakeStep[] => [
    { tool: "describe_endpoint", args: { id: c.endpoint } },
    { tool: "treg_call", args: { endpoint_id: c.endpoint, params: c.params, why } },
    { tool: "run_code", args: (r: Results) => ({ code: c.code, files: [callIds(r)[i]] }) },
  ]),
  { tool: "propose_plan", args: (r: Results) => o.plan(r) as Record<string, unknown> },
];

/** The ten comments of one parent as a real source gives them: Arabic, English, off the topic, an advert, the same words by two people, an emoji, a handle, and the same id twice. */
const COMMENT_TEXTS = [
  "تعليق عن الموضوع نفسه رقم ١", // 0 on topic
  "Great one!! loved it", // 1 English
  "عرض خاص تواصل معنا على واتساب للتسجيل", // 2 an advert
  "تعليق عن الموضوع نفسه رقم ١", // 3 the SAME words as 0, another person
  "👍", // 4 only an emoji
  "@someone شكرا جدا", // 5 starts with a handle
  "هذا كلام ما لا علاقة له بشيء إطلاقا", // 6 off the topic
  "Totally agree with this", // 7 English
  "ممتاز", // 8 one word
];
/** 9 distinct ids; the ten rows of the page repeat the id of the first once. */
const commentRows = (parent: string) => [...COMMENT_TEXTS.map((text, i) => ({ id: `${parent}-k${i}`, text, author: i === 3 ? "منى" : `قارئ ${i}` })), { id: `${parent}-k0`, text: COMMENT_TEXTS[0], author: "قارئ 0" }];
const DISTINCT_PER_PARENT = COMMENT_TEXTS.length;

/** What every raw-children mission must show once it has ended: the children are exactly what the source gave, nothing filtered, nothing merged but the same id. */
async function assertRawChildren(r: ReplayResult, o: { childKey: string; childSheet: string; parents: number; childSheetNoun?: string }) {
  const snap = await readSnapshot(r.store, r.missionId);
  const c = snap.counts(o.childKey);
  // every distinct item of every parent is delivered: English, advert, off the topic, an emoji, a handle, one word, the same words twice
  expect(c.accepted).toBe(o.parents * DISTINCT_PER_PARENT);
  expect(c.excluded).toBe(0);
  expect(Object.keys(c.excludedByReason)).toEqual([]);
  // only the SAME ITEM ID is one item: the repeated row of each page
  expect(c.duplicates).toBe(o.parents);
  const wb = await readWorkbook(r);
  const sheet = wb.getWorksheet(o.childSheet)!;
  const headers = (sheet.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
  const textColumn = headers.findIndex((h) => /^نص (التعليق|التقييم)$/.test(h));
  expect(textColumn).toBeGreaterThan(0);
  const texts: string[] = [];
  sheet.eachRow((row, n) => { if (n > 1) texts.push(String(row.getCell(textColumn).value)); });
  expect(texts).toHaveLength(o.parents * DISTINCT_PER_PARENT);
  for (const t of COMMENT_TEXTS) expect(texts.filter((x) => x === t).length, t).toBe(t === COMMENT_TEXTS[0] ? o.parents * 2 : o.parents);
  expect(texts.filter((t) => /^Great one/.test(t))).toHaveLength(o.parents);
  expect(texts.filter((t) => t === "👍")).toHaveLength(o.parents);
  // in the source's order within each parent
  expect(texts.slice(0, DISTINCT_PER_PARENT)).toEqual(COMMENT_TEXTS);
  // the card said so, in its own words
  expect(r.planView.notesAr.some((n) => /كما هي على كل .*دون تصفية/.test(n))).toBe(true);
}

describe("TikTok videos chosen by the topic, their comments raw", () => {
  const VIDEOS = "crawl4ai.tiktok.search.videos";
  const COMMENTS = "crawl4ai.tiktok.video.comments";
  const TOPIC = "الدوري المصري";
  const vid = (i: number) => `tv${pad(i)}`;
  const url = (i: number) => `https://tt.example/@creator${i % 7}/video/${vid(i)}`;
  // the page the source gives: 6 videos about the league and 2 about cooking, in this order
  const video = (i: number, onTopic: boolean) => ({ post_id: vid(i), url: url(i), description: onTopic ? `${TOPIC} فيديو ${i}` : `وصفة الكشري طريقة سهلة ${i}`, author: `creator${i % 7}`, stats: { views: 1000 + i, likes: 50 + i, comments: 20, shares: 3 }, created_at: "2026-10-19T09:00:00Z" });
  const page = { rows: [video(0, false), ...[1, 2, 3].map((i) => video(i, true)), video(4, false), ...[5, 6, 7].map((i) => video(i, true))] };
  const onTopic = [1, 2, 3, 5, 6, 7];
  const commentsPage = (parent: string) => ({ rows: commentRows(parent).map((c) => ({ comment_id: c.id, post_id: parent, text: c.text, author: c.author, likes: 0, created_at: "2026-10-20T09:00:00Z" })) });

  it("6 videos about the league (two about cooking left out), every comment of each delivered as it is: the English, the advert, the emoji, the same words twice", async () => {
    const r = await replay({
      request: "عايز ٦ فيديوهات تيك توك عن الدوري المصري مع تعليقات كل فيديو",
      planning: planFlow({
        progress: "أجرّب مصدر الفيديوهات ومصدر تعليقاتها", words: ["tiktok", "videos"], platform: "tiktok",
        calls: [
          { endpoint: VIDEOS, params: { query: TOPIC, limit: 8 }, code: "return inputs.call_0001.rows.map(v => ({ id: v.post_id, text: v.description, url: v.url, views: v.stats.views, likes: v.stats.likes, comments_count: v.stats.comments, shares: v.stats.shares, date: v.created_at }))" },
          { endpoint: COMMENTS, params: { post: url(1) }, code: "return inputs.call_0002.rows.map(c => ({ id: c.comment_id, text: c.text, author: c.author, likes: c.likes, date: c.created_at }))" },
        ],
        plan: (res) => ({
          summary_ar: "ستحصل على فيديوهات تيك توك عن الدوري المصري وتعليقات كل فيديو.",
          stages: [
            { key: "videos", title_ar: "الفيديوهات", endpoint_id: VIDEOS, expected_rows: 6, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "وصف الفيديو" }, { key: "url", title_ar: "رابط الفيديو" }, { key: "views", title_ar: "المشاهدات" }, { key: "likes", title_ar: "الإعجابات" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "shares", title_ar: "المشاركات" }, { key: "date", title_ar: "التاريخ والوقت" }],
              sample_rows: [{ id: vid(1), text: `${TOPIC} فيديو 1`, url: url(1), views: 1001, likes: 51, comments_count: 20, shares: 3, date: "2026-10-19T09:00:00Z" }], measured_by: [callIds(res)[0]], relevance: aboutWords(["الدوري المصري"]), yield_from: firstOutputId(res) },
            // the model asked for a topic rule and a language filter on the children too: neither is applied
            { key: "comments", title_ar: "تعليقات كل فيديو", endpoint_id: COMMENTS, expected_rows: 6 * DISTINCT_PER_PARENT, parent_key: "videos", per_parent_rows: DISTINCT_PER_PARENT, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "كاتب التعليق" }, { key: "likes", title_ar: "الإعجابات" }, { key: "date", title_ar: "التاريخ والوقت" }],
              sample_rows: [{ id: `${vid(1)}-k0`, text: COMMENT_TEXTS[0], author: "قارئ 0", likes: 0, date: "2026-10-20T09:00:00Z" }], measured_by: [callIds(res)[1]], relevance: aboutWords(["الدوري"]), filters: [{ kind: "language", lang: "ar" }] },
          ],
        }),
      }),
      execution: () => [],
      answers: [tregResult(page, 0.0005), tregResult(commentsPage(vid(1)), 0.0005), tregResult(page, 0.0005), ...onTopic.map((i) => tregResult(commentsPage(vid(i)), 0.0005))],
    });
    assertReplayInvariants(r, { expectDelivered: 6 + 6 * DISTINCT_PER_PARENT });
    // the parents were CHOSEN: the cooking videos are left out by the topic rule, with their reason
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.counts("videos")).toMatchObject({ accepted: 6, excluded: 2 });
    expect(snap.counts("videos").excludedByReason.no_term).toBe(2);
    // the children are not: no rule, no language filter, on the plan the engine carried out
    expect(r.plannedPlan.stages[1].relevance).toBeUndefined();
    expect(r.plannedPlan.stages[1].filters?.some((f) => f.kind === "language") ?? false).toBe(false);
    expect(r.executionDriver.results).toEqual([]);
    await assertRawChildren(r, { childKey: "comments", childSheet: "تعليقات كل فيديو", parents: 6 });
    // the card's title for the child says what it is and on what
    expect(r.planView.stages[1].titleAr).toContain("فيديو");
  });
});

describe("Google Maps restaurants in a city, their reviews raw", () => {
  const SEARCH = "crawl4ai.google.serp.maps";
  const REVIEWS = "litescrape.google.maps.reviews";
  const place = (id: string, name: string, address: string) => ({ name, place_id: id, address, phone: "+20227945000", category: "مطعم", cid: id });
  // the page: a restaurant in Alexandria, a barber in Cairo, and four restaurants in Cairo
  const searchPage = { rows: [place("ChIJa0001", "مطعم البحر الإسكندراني", "كورنيش الإسكندرية"), place("ChIJb0002", "صالون أحمد للحلاقة", "شارع التحرير، القاهرة"), ...[1, 2, 3, 4].map((i) => place(`ChIJc000${i}`, `مطعم أبو طارق ${i}`, `شارع التحرير ${i}، القاهرة`))] };
  const reviewsPage = (parent: string) => ({ reviews: commentRows(parent).map((c) => ({ review_id: c.id, rating: 4, user: { name: c.author }, snippet: c.text, iso_date: "2026-10-10T12:00:00Z", likes: 0 })), pagination: null });

  it("4 restaurants of Cairo (the one of Alexandria and the barber left out), every review of each as the source gives it", async () => {
    const r = await replay({
      request: "عايز ٤ مطاعم في القاهرة مع تقييمات كل مكان من خرائط جوجل",
      planning: planFlow({
        progress: "أبحث عن المطاعم ثم أجرّب مصدر التقييمات", words: ["google", "maps"], platform: "google",
        calls: [
          { endpoint: SEARCH, params: { query: "مطاعم القاهرة", limit: 6 }, code: "return inputs.call_0001.rows.map(p => ({ id: p.place_id, text: p.name, address: p.address, phone: p.phone, category: p.category }))" },
          { endpoint: REVIEWS, params: { place_id: "ChIJc0001", num: 10 }, code: "return inputs.call_0002.reviews.map(v => ({ id: v.review_id, text: v.snippet, rating: v.rating, writer: v.user.name, date: v.iso_date, likes: v.likes }))" },
        ],
        plan: (res) => ({
          summary_ar: "ستحصل على مطاعم من القاهرة وتقييمات كل مكان.",
          stages: [
            { key: "places", title_ar: "المطاعم", endpoint_id: SEARCH, expected_rows: 4, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "اسم المطعم" }, { key: "address", title_ar: "العنوان" }, { key: "phone", title_ar: "رقم الهاتف" }],
              sample_rows: [{ id: "ChIJc0001", text: "مطعم أبو طارق 1", address: "شارع التحرير 1، القاهرة", phone: "+20227945000" }], measured_by: [callIds(res)[0]], relevance: aboutWords(["مطعم"]), yield_from: firstOutputId(res) },
            { key: "reviews", title_ar: "التقييمات", endpoint_id: REVIEWS, expected_rows: 4 * DISTINCT_PER_PARENT, parent_key: "places", per_parent_rows: DISTINCT_PER_PARENT, deliver: true, columns: [{ key: "text", title_ar: "نص التقييم" }, { key: "rating", title_ar: "الدرجة" }, { key: "writer", title_ar: "الكاتب" }, { key: "date", title_ar: "التاريخ" }, { key: "likes", title_ar: "الإعجابات" }],
              sample_rows: [{ id: "ChIJc0001-k0", text: COMMENT_TEXTS[0], rating: 4, writer: "قارئ 0", date: "2026-10-10T12:00:00Z", likes: 0 }], measured_by: [callIds(res)[1]] },
          ],
        }),
      }),
      execution: () => [],
      answers: [tregResult(searchPage, 0.00015), tregResult(reviewsPage("ChIJc0001"), 0.00015), tregResult(searchPage, 0.00015), ...[1, 2, 3, 4].map((i) => tregResult(reviewsPage(`ChIJc000${i}`), 0.00015))],
    });
    assertReplayInvariants(r, { expectDelivered: 4 + 4 * DISTINCT_PER_PARENT });
    const snap = await readSnapshot(r.store, r.missionId);
    // THE PLACE IS ENFORCED on the places (their own address says the city): Alexandria is not Cairo, and the barber is not a restaurant
    expect(r.plannedPlan.stages[0].filters?.find((f) => f.kind === "place")).toMatchObject({ places: ["EG:cairo"], values: ["القاهرة"] });
    expect(snap.counts("places")).toMatchObject({ accepted: 4, excluded: 2 });
    expect(snap.counts("places").excludedByReason.filter_place).toBe(1);
    expect(snap.counts("places").excludedByReason.no_term).toBe(1);
    expect(r.planView.assumptionsAr).toContain("في: القاهرة.");
    await assertRawChildren(r, { childKey: "reviews", childSheet: "التقييمات", parents: 4 });
  });
});

describe("companies of a sector in a country, their employees raw: another country, no evidence, an exhibition and another trade are not delivered", () => {
  const COMPANIES = "aiark.companies.search";
  const EMPLOYEES = "aviato.companies.employees";
  const co = (id: string, name: string, description: string, country: string | null, n: number) => ({ id, name, description, domain: `company${n}.example`, industry: [], employee_count: 100 + n, location: country === null ? {} : { country } });
  // the live run's findings, in the order a source gives them: a Luxembourg company, one with no place at all, a sports company in Egypt, an exhibition in Egypt, then three real contractors
  const page = { content: [
    co("co9", "Yourwebsite", "medicare and construction services", "Luxembourg", 9),
    co("co8", "شركة المقاولات الحديثة", "مقاولات عامة", null, 8),
    co("co7", "Egytic Sports", "sports equipment and clubs", "مصر", 7),
    co("co6", "Big 5 Construct Egypt", "the international exhibition for the construction industry", "مصر", 6),
    co("co1", "النيل للمقاولات العامة", "مقاولات وإنشاءات", "مصر", 1),
    co("co2", "دلتا للمقاولات", "شركة مقاولات", "Egypt", 2),
    co("co3", "Orascom Construction", "contracting and construction", "Egypt", 3),
  ], totalElements: 7, number: 0, size: 7, last: true };
  const employees = (id: string) => ({ employees: [0, 1].map((i) => ({ personID: `${id}-p${i + 1}`, companyID: id, positionList: [{ title: i === 0 ? "مدير المشتريات" : "مدير العمليات" }], person: { fullName: `موظف ${i === 0 ? "أحمد" : "منى"}`, URLs: { linkedin: `https://www.linkedin.com/in/${id}-p${i + 1}` } } })) });
  /** The model check: a company is accepted when its words say it is a contractor and not an event. */
  const reviewCall = async ({ user }: { user: string }) => {
    const rows = [...user.matchAll(/^\d+\.\s(.*)$/gm)].map((m) => m[1]);
    return { text: JSON.stringify(rows.map((t) => (/مقاولات|contracting|construction industry|construction services/i.test(t) && !/exhibition|معرض/i.test(t) ? 1 : 0))), usage: { input_tokens: 500, output_tokens: 20 } };
  };

  it("3 contractors of Egypt are delivered with their employees; the Luxembourg company, the one with no place, the sports company and the exhibition are not", async () => {
    const r = await replay({
      request: "عايز ٣ شركات مقاولات في مصر وموظفين كل شركة",
      deps: (base) => ({ ...base, reviewCall: reviewCall as never }),
      planning: planFlow({
        progress: "أبحث عن شركات المقاولات ثم موظفيها", words: ["companies", "search"],
        calls: [
          { endpoint: COMPANIES, params: { page: 0, size: 7, account: "مقاولات مصر" }, code: "return inputs.call_0001.content.map(c => ({ id: c.id, text: c.name + ' - ' + c.description, url: c.domain, country: c.location.country || '' }))" },
          { endpoint: EMPLOYEES, params: { website: "company1.example", page: 0, perPage: 2 }, code: "return inputs.call_0002.employees.map(e => ({ id: e.personID, text: e.person.fullName, title: e.positionList[0].title }))" },
        ],
        plan: (res) => ({
          summary_ar: "ستحصل على شركات مقاولات في مصر وموظفين من كل شركة.",
          stages: [
            { key: "companies", title_ar: "الشركات", endpoint_id: COMPANIES, expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "الشركة ووصفها" }, { key: "url", title_ar: "الموقع" }, { key: "country", title_ar: "الدولة" }],
              sample_rows: [{ id: "co1", text: "النيل للمقاولات العامة - مقاولات وإنشاءات", url: "company1.example", country: "مصر" }], measured_by: [callIds(res)[0]] },
            { key: "employees", title_ar: "موظفو كل شركة", endpoint_id: EMPLOYEES, expected_rows: 6, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: [{ key: "text", title_ar: "اسم الموظف" }, { key: "title", title_ar: "المسمى الوظيفي" }],
              sample_rows: [{ id: "co1-p1", text: "موظف أحمد", title: "مدير المشتريات" }], measured_by: [callIds(res)[1]] },
          ],
        }),
      }),
      execution: () => [],
      answers: [tregResult(page, 0.0005267), tregResult(employees("co1"), 0.005), tregResult(page, 0.0005267), ...["co1", "co2", "co3"].map((id) => tregResult(employees(id), 0.005))],
    });
    assertReplayInvariants(r, { expectDelivered: 3 + 6 });
    const snap = await readSnapshot(r.store, r.missionId);
    const c = snap.counts("companies");
    expect(c.accepted).toBe(3);
    // the place: the Luxembourg company and the company with no evidence of any place are not delivered
    expect(c.excludedByReason.filter_place).toBe(2);
    // the sector: the sports company and the exhibition went to the model check and were refused there; they were never delivered straight
    expect(c.excludedByReason.review_no).toBe(2);
    expect(c.acceptedByModel + c.acceptedByRule).toBe(3);
    const wb = await readWorkbook(r);
    const names: string[] = [];
    wb.getWorksheet("الشركات")!.eachRow((row, n) => { if (n > 1) names.push(String(row.getCell(1).value)); });
    expect(names.join(" | ")).not.toMatch(/Yourwebsite|Egytic|Big 5|الحديثة/);
    expect(names).toHaveLength(3);
    // the card said so: the place is a line of the card, and the children are raw
    expect(r.planView.assumptionsAr).toContain("في: مصر.");
    expect(r.planView.notesAr).toContain("تُجمع الموظفون كما هي على كل شركة، دون تصفية.");
    expect(wb.getWorksheet("موظفو كل شركة")!.rowCount - 1).toBe(6);
  });

  it("the same request with the check unreachable delivers none of the doubtful ones (never straight to delivery)", async () => {
    const r = await replay({
      request: "عايز ٣ شركات مقاولات في مصر",
      planning: planFlow({
        progress: "أبحث عن شركات المقاولات", words: ["companies", "search"],
        calls: [{ endpoint: COMPANIES, params: { page: 0, size: 7, account: "مقاولات مصر" }, code: "return inputs.call_0001.content.map(c => ({ id: c.id, text: c.name + ' - ' + c.description, url: c.domain, country: c.location.country || '' }))" }],
        plan: (res) => ({
          summary_ar: "ستحصل على شركات مقاولات في مصر.",
          stages: [{ key: "companies", title_ar: "الشركات", endpoint_id: COMPANIES, expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "الشركة ووصفها" }, { key: "url", title_ar: "الموقع" }, { key: "country", title_ar: "الدولة" }], sample_rows: [{ id: "co1", text: "النيل للمقاولات العامة - مقاولات وإنشاءات", url: "company1.example", country: "مصر" }], measured_by: [callIds(res)[0]] }],
        }),
      }),
      execution: () => [],
      answers: [tregResult(page, 0.0005267), tregResult(page, 0.0005267)],
    });
    const snap = await readSnapshot(r.store, r.missionId);
    const names = snap.acceptedRows("companies").map((x) => String(x.text));
    expect(names.some((t) => /Egytic|Big 5|Yourwebsite|الحديثة/.test(t))).toBe(false);
    // the two contractors that say so in Arabic are accepted by rule; the three the rule cannot place in the sector (the sports company, the exhibition and an English-named contractor) wait for the check, and are not delivered without it
    expect(names).toHaveLength(2);
    expect(snap.counts("companies").excludedByReason.not_reviewed).toBe(3);
  });
});

describe("Facebook: a dear platform still reaches a card, with the real price and one honest sentence", () => {
  const POSTS = "justoneapi.x.facebook-search-post-v1";
  const COMMENTS = "anyapi.facebook.post_comments";
  const TOPIC = "غلاء الأسعار";
  const postsPage = (offset: number, n: number, next: string | null) => ({ code: 0, data: { results: Array.from({ length: n }, (_, i) => ({ post_id: `fp${pad(offset + i)}`, type: "post", url: `https://fb.example/posts/fp${pad(offset + i)}`, message: `${TOPIC} في مصر منشور ${offset + i}`, timestamp: 1785202291, comments_count: 40 + i, reactions_count: 100 + i, author: { name: `صفحة ${(offset + i) % 5}` } })), cursor: next } });
  const commentsFor = (postId: string) => ({ output: { data: { comments: commentRows(postId).map((c) => ({ id: c.id, text: c.text, author: c.author, createdUtc: "2026-10-21T10:00:00Z" })) } } });

  it("5 posts about the price rise and the comments of each: the card carries the price, the child rule and the cost sentence; the comments are raw", async () => {
    const r = await replay({
      request: "هات ٥ بوستات فيسبوك عن غلاء الأسعار في مصر، ومع كل بوست ١٠ تعليقات",
      planning: planFlow({
        progress: "أجرّب مصدر المنشورات ومصدر التعليقات", words: ["facebook", "posts", "search"], platform: "facebook",
        calls: [
          { endpoint: POSTS, params: { keyword: TOPIC }, code: "return inputs.call_0001.data.results.map(p => ({ id: p.post_id, text: p.message, url: p.url, author: p.author.name, date: p.timestamp, comments_count: p.comments_count, likes: p.reactions_count }))" },
          { endpoint: COMMENTS, params: { url: "https://fb.example/posts/fp000000" }, code: "return inputs.call_0002.output.data.comments.map(c => ({ id: c.id, text: c.text, author: c.author, date: c.createdUtc }))" },
        ],
        plan: (res) => ({
          summary_ar: "ستحصل على بوستات فيسبوك عن غلاء الأسعار وتعليقات كل بوست.",
          stages: [
            { key: "posts", title_ar: "المنشورات", endpoint_id: POSTS, expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "url", title_ar: "رابط المنشور" }, { key: "author", title_ar: "الصفحة" }, { key: "date", title_ar: "التاريخ والوقت" }, { key: "comments_count", title_ar: "عدد التعليقات" }, { key: "likes", title_ar: "الإعجابات" }],
              sample_rows: [{ id: "fp000000", text: `${TOPIC} في مصر منشور 0`, url: "https://fb.example/posts/fp000000", author: "صفحة 0", date: 1785202291, comments_count: 40, likes: 100 }], measured_by: [callIds(res)[0]], relevance: aboutWords(["غلاء الأسعار"]), yield_from: firstOutputId(res) },
            { key: "comments", title_ar: "تعليقات كل بوست", endpoint_id: COMMENTS, expected_rows: 5 * DISTINCT_PER_PARENT, parent_key: "posts", per_parent_rows: DISTINCT_PER_PARENT, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "كاتب التعليق" }, { key: "date", title_ar: "التاريخ والوقت" }],
              sample_rows: [{ id: "fp000000-k0", text: COMMENT_TEXTS[0], author: "قارئ 0", date: "2026-10-21T10:00:00Z" }], measured_by: [callIds(res)[1]] },
          ],
        }),
      }),
      execution: () => [],
      answers: [tregResult(postsPage(0, 5, "cur_5"), 0.02952), tregResult(commentsFor("fp000000"), 0.002), tregResult(postsPage(0, 5, "cur_5"), 0.02952), ...Array.from({ length: 5 }, (_, i) => tregResult(commentsFor(`fp${pad(i)}`), 0.002))],
    });
    // the CARD (read before approval): the real price, the child rule and the honest sentence about the platform
    const cost = platformCostNotesAr([{ endpoint_id: POSTS }])[0];
    expect(r.planView.notesAr).toContain(cost);
    expect(r.planView.notesAr).toContain("تُجمع التعليقات كما هي على كل منشور، دون تصفية.");
    expect(r.plannedPlan.price.unitPricePoints).toBeGreaterThan(5);
    expect(r.plannedPlan.price.reservePoints).toBeGreaterThan(0);
    expect(cost).not.toMatch(/justone|anyapi|scrape|[A-Za-z]{2,}|[0-9]/);
    // delivered: the 5 posts and all the distinct comments of each, as they are
    assertReplayInvariants(r, { expectDelivered: 5 + 5 * DISTINCT_PER_PARENT });
    await assertRawChildren(r, { childKey: "comments", childSheet: "تعليقات كل بوست", parents: 5 });
    expect(r.mission.charged_points).toBe(Math.ceil(r.mission.delivered_units! * r.plannedPlan.price.unitPricePoints));
  });
});

describe("the planning budget of a dear platform: sized by code from the sources' prices, a hard cap", () => {
  const catalog = loadTregCatalog();
  const facts = (request: string) => planningBudgetFacts(request, { catalog, access: NOT_ADMIN, stats: new Map(), now: Date.parse("2026-10-29T12:00:00Z") });

  it("Facebook posts and their comments get more than the flat budget, and not more than the cap; a cheap platform keeps its own", () => {
    const fb = facts("هات ٥ بوستات فيسبوك عن غلاء الأسعار في مصر، ومع كل بوست ١٠ تعليقات");
    expect(fb.baseUsd).toBe(0.10);
    expect(fb.scaled).toBe(true);
    expect(fb.budgetUsd).toBeGreaterThan(fb.baseUsd);
    expect(fb.budgetUsd).toBeLessThanOrEqual(fb.capUsd);
    expect(fb.stages.map((s) => s.role)).toEqual(["parent", "child"]);
    expect(fb.stages[0].sourceId).toBe("justoneapi.x.facebook-search-post-v1");
    // one minimal sample of each stage is always affordable: three calls of the post source and two of the comments source, times the margin, plus the slack
    expect(fb.budgetUsd).toBeGreaterThanOrEqual(1.25 * (3 * fb.stages[0].callUsd + 2 * fb.stages[1].callUsd));
    const x = facts("هات ٥٠ تغريدة عن منتخب مصر");
    expect(x).toMatchObject({ baseUsd: 0.05, budgetUsd: 0.05, scaled: false });
    const tt = facts("هات ١٠ فيديو تيك توك عن الدوري ومع كل فيديو ٥٠ تعليق");
    expect(tt).toMatchObject({ baseUsd: 0.10, budgetUsd: 0.10, scaled: false });
    // the hard cap never moves, whatever the sources cost
    expect(fb.capUsd).toBe(0.20);
  });

  it("the real planning: three searches of the dear source are not refused by the budget; the comments stage is sampled after them", async () => {
    const store = createMemoryStore();
    store.missions.set("msn_f", newMission({ id: "msn_f", user_id: USER_ID, status: "planning", request_text: "هات ٥ بوستات فيسبوك عن غلاء الأسعار في مصر، ومع كل بوست ١٠ تعليقات" }));
    const rec = fakeRecorder();
    const answers = [0, 1].map((i) => tregResult({ code: 0, data: { results: [{ post_id: `fp${i}`, url: `https://fb.example/posts/fp${i}`, message: "غلاء الأسعار", timestamp: 1785202291 }] } }, 0.02952));
    const comments = tregResult({ output: { data: { comments: [{ id: "c1", text: "تعليق", author: "a", createdUtc: "2026-10-21T10:00:00Z" }] } } }, 0.002);
    const queue = [...answers, comments];
    const call = async () => { const n = queue.shift(); if (!n) throw new Error("no fake answer left"); return n; };
    const driver = createFakeDriver([
      { tool: "catalog_search", args: { words: ["facebook", "posts", "search"], platform: "facebook", limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: "justoneapi.x.facebook-search-post-v1", params: { keyword: "غلاء الأسعار" } } },
      { tool: "treg_call", args: { endpoint_id: "justoneapi.x.facebook-search-post-v1", params: { keyword: "غلاء الأسعار في مصر" } } },
      { tool: "treg_call", args: { endpoint_id: "anyapi.facebook.post_comments", params: { url: "https://fb.example/posts/fp0" }, why: "the cheaper sources return no author or link fields in their catalog description" } },
    ], { stopAfterTerminal: false });
    const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
    await runPlanning(deps, store.missions.get("msn_f")!);
    const results = driver.results.filter((x) => x.tool === "treg_call").map((x) => (x.result as { ok?: boolean; refused?: string }));
    expect(results.map((x) => x.ok === true ? "ok" : x.refused)).toEqual(["ok", "ok", "ok"]);
    // 2 x 0.02952 + 0.002 = 0.06104 USD, under the scaled budget; the old flat budget (0.10 less the 0.03 kept) would have refused nothing here either, but a third search would have
    const spent = (await store.listCalls("msn_f")).reduce((n, c) => n + Number(c.cost_usd ?? 0), 0);
    expect(spent).toBeCloseTo(0.06104, 5);
  });

  it("planning that holds real rows is sent back twice before it may end without a card, and is never stuck", async () => {
    expect(GIVE_UP_REFUSALS_MAX).toBe(2);
    const store = createMemoryStore();
    store.missions.set("msn_g", newMission({ id: "msn_g", user_id: USER_ID, status: "planning", request_text: "هات ٥ بوستات فيسبوك عن غلاء الأسعار في مصر، ومع كل بوست ١٠ تعليقات" }));
    const rec = fakeRecorder();
    const queue = [tregResult({ code: 0, data: { results: [{ post_id: "fp0", url: "https://fb.example/posts/fp0", message: "إعلان", timestamp: 1785202291 }] } }, 0.02952)];
    const call = async () => { const n = queue.shift(); if (!n) throw new Error("no fake answer left"); return n; };
    const giveUp = (): FakeStep => ({ tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "لا أستطيع خدمة هذا الطلب." } });
    const driver = createFakeDriver([
      { tool: "catalog_search", args: { words: ["facebook", "posts", "search"], platform: "facebook", limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: "justoneapi.x.facebook-search-post-v1", params: { keyword: "غلاء الأسعار" } } },
      giveUp(), giveUp(), giveUp(),
    ]);
    const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
    await runPlanning(deps, store.missions.get("msn_g")!);
    const finishes = driver.results.filter((x) => x.tool === "finish").map((x) => x.result as { ok?: boolean; error?: string });
    expect(finishes.map((x) => x.ok === true)).toEqual([false, false, true]);
    expect(finishes[0].error).toContain("do not end without a plan");
    expect(store.missions.get("msn_g")!.status).toBe("unserved");
  });
});

