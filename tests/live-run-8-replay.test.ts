import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay } from "./helpers/agentReplay";
import { callIds, tregResult, type Results } from "./helpers/agentFakeWorld";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";
import { readSnapshot } from "../agent/src/items/itemStore";
import type { FakeStep } from "../agent/src/fakeDriver";
import { deliveryConsistencyIssues } from "../src/lib/agentMission/plan";
import { requestedStageIndexes } from "../src/lib/agentMission/quantity";
import { priceMissionByCode, settlementCharge } from "../src/lib/agentMission/price";
import { stagesView } from "../src/lib/agentMission/customerView";

/**
 * REPLAY OF THE LIVE RETEST OF 2026-10-29 19:55-20:07 CAIRO (after #294, test account; `missions.plan` read with SELECT). In both live plans the model kept the CHILD stage as an intermediate stage («deliver: false»): the comments of the
 * five videos, the people of the three companies. The customer paid 200 for a file without them.
 *
 * WHY THE #294 REPLAYS PASSED WHILE THE LIVE RUN FAILED: their fake model marked the comments stage `deliver: true` (tests/live-run-7-replay.test.ts), the one thing the real model did not do, and #294 only forced the stage that
 * holds the counted noun (the parents). The fake models below do what the real one did: the child stage is `deliver: false`.
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
const columnsOf = (...c: Array<[string, string]>) => c.map(([key, title_ar]) => ({ key, title_ar }));

describe("TikTok «هات ٥ فيديوهات ... ومن كل فيديو ١٠ تعليقات»: the comments stage the model kept as intermediate is delivered (live: 5 videos only, 36 comments collected and not delivered, charged 200)", () => {
  const VIDEOS = "crawl4ai.tiktok.search.videos";
  const COMMENTS = "crawl4ai.tiktok.video.comments";
  const vid = (i: number) => `tv${pad(i)}`;
  const url = (i: number) => `https://tt.example/@creator${i % 7}/video/${vid(i)}`;
  const video = (i: number) => ({ post_id: vid(i), url: url(i), description: `منتخب مصر في المباراة رقم ${i}`, author: `creator${i % 7}`, stats: { views: 1000 + i, likes: 50 + i, comments: 40, shares: 3 }, created_at: "2026-10-27T09:00:00Z" });
  const page = { rows: Array.from({ length: 8 }, (_, i) => video(i)) };
  /** `n` comments of a video, as the source gives them. */
  const commentsPage = (parent: string, n = 10) => ({ rows: Array.from({ length: n }, (_, i) => ({ comment_id: `${parent}-c${i}`, post_id: parent, text: `تعليق رقم ${i} على الفيديو ${parent}`, author: `قارئ ${i}`, likes: 0, created_at: "2026-10-28T09:00:00Z" })) });
  const request = "هات ٥ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات";
  /** The model's plan as the live one was: `commentsDeliver` false (and the videos as the live model left them), the comments rows as the model wrote them. */
  async function run(o: { videosDeliver?: boolean; commentsRows?: number; commentsPerVideo?: number[] } = {}) {
    const per = o.commentsPerVideo ?? [10, 10, 10, 10, 10];
    return replay({
      request,
      planning: planFlow({
        progress: "أجرّب مصدر الفيديوهات ومصدر تعليقاتها", words: ["tiktok", "videos"], platform: "tiktok",
        calls: [
          { endpoint: VIDEOS, params: { query: "منتخب مصر", limit: 20 }, code: "return inputs.call_0001.rows.map(v => ({ id: v.post_id, text: v.description, url: v.url, author: v.author, views: v.stats.views, likes: v.stats.likes, comments_count: v.stats.comments, shares: v.stats.shares, date: v.created_at }))" },
          { endpoint: COMMENTS, params: { post: url(0), limit: 10 }, code: "return inputs.call_0002.rows.map(c => ({ id: c.comment_id, text: c.text, author: c.author, likes: c.likes, date: c.created_at }))" },
        ],
        plan: (res) => ({
          summary_ar: "ستحصل على فيديوهات تيك توك عن منتخب مصر، ومع كل فيديو أول تعليقاته كما يعرضها تيك توك.",
          stages: [
            { key: "videos", title_ar: "فيديوهات تيك توك عن منتخب مصر", endpoint_id: VIDEOS, expected_rows: 5, parent_key: null, deliver: o.videosDeliver ?? true, columns: columnsOf(["text", "وصف الفيديو"], ["author", "الناشر"], ["date", "تاريخ النشر"], ["views", "المشاهدات"], ["likes", "الإعجابات"], ["comments_count", "عدد التعليقات"], ["shares", "المشاركات"], ["url", "رابط الفيديو"]),
              sample_rows: [{ id: vid(0), text: "منتخب مصر في المباراة رقم 0", author: "creator0", date: "2026-10-27T09:00:00Z", views: 1000, likes: 50, comments_count: 40, shares: 3, url: url(0) }], measured_by: [callIds(res)[0]], relevance: aboutWords(["منتخب مصر"]), yield_from: firstOutputId(res) },
            // THE LIVE PLAN: the comments are an intermediate stage («تُستخدم في المرحلة التالية») although there is no next stage
            { key: "comments", title_ar: "تعليقات على الفيديوهات المختارة", endpoint_id: COMMENTS, expected_rows: o.commentsRows ?? 50, parent_key: "videos", per_parent_rows: 10, deliver: false, columns: columnsOf(["text", "نص التعليق"], ["author", "الكاتب"], ["likes", "الإعجابات"], ["date", "التاريخ"]),
              sample_rows: [{ id: `${vid(0)}-c1`, text: `تعليق رقم 1 على الفيديو ${vid(0)}`, author: "قارئ 1", likes: 0, date: "2026-10-28T09:00:00Z" }], measured_by: [callIds(res)[1]] },
          ],
        }),
      }),
      execution: () => [],
      answers: [tregResult(page, 0.0005), tregResult(commentsPage(vid(0)), 0.0005), tregResult(page, 0.0005), ...per.flatMap((n, i) => [tregResult(commentsPage(vid(i), n), 0.0005), ...(n < 10 ? [tregResult({ rows: [] }, 0.0005)] : [])])],
    });
  }

  it("the card: the comments stage is delivered by code, the card total is 5 videos + 50 comments, and the headline's counts agree with the delivered stages", async () => {
    const r = await run();
    expect(r.plannedPlan.stages.map((s) => [s.key, s.deliver, s.planned_rows])).toEqual([["videos", true, 5], ["comments", true, 50]]);
    expect(r.plannedPlan.stages[1].per_parent_rows).toBe(10);
    expect(r.planView.stages.map((s) => [s.deliver, s.rows])).toEqual([[true, 5], [true, 50]]);
    expect(r.planView.stages.every((s) => s.noteAr === null)).toBe(true);
    expect(r.planView.totalRows).toBe(55);
    expect(r.plannedPlan.price.deliveredRows).toBe(55);
    // the card's total, the price's delivered rows and the delivered stages are one number
    expect(r.planView.totalRows).toBe(stagesView({ stages: r.plannedPlan.stages }).total);
    expect(JSON.stringify(r.planView)).not.toContain("مرحلة وسيطة");
    expect(JSON.stringify(r.planView)).not.toContain("تُستخدم في المرحلة التالية");
  });

  it("a plan where the model ALSO left the videos as an intermediate stage: both are delivered", async () => {
    const r = await run({ videosDeliver: false });
    expect(r.plannedPlan.stages.map((s) => s.deliver)).toEqual([true, true]);
    expect(r.plannedPlan.quantity).toMatchObject({ requested: 5, target: 5, stage_key: "videos" });
  });

  it("the number the model wrote for the comments does not matter: the target is 5 videos x 10 (the model wrote 5)", async () => {
    const r = await run({ commentsRows: 5 });
    expect(r.plannedPlan.stages.map((s) => [s.deliver, s.planned_rows])).toEqual([[true, 5], [true, 50]]);
  });

  it("delivered: the videos and the comments, each in its own sheet; 10 comments from each video; the summary sheet has no intermediate stage", async () => {
    const r = await run();
    assertReplayInvariants(r, { expectDelivered: 55 });
    const snap = await readSnapshot(r.store, r.missionId);
    const children = snap.acceptedRows("comments");
    expect(snap.acceptedRows("videos").map((p) => children.filter((c) => String(c.parent_id) === String(p.id)).length)).toEqual([10, 10, 10, 10, 10]);
    const wb = await readWorkbook(r);
    expect(wb.getWorksheet("فيديوهات تيك توك عن منتخب مصر")!.rowCount).toBe(6);
    expect(wb.worksheets).toHaveLength(3);
    expect(wb.worksheets[2].rowCount).toBe(51);
    const summary = JSON.stringify(wb.worksheets[0].getSheetValues());
    expect(summary).not.toContain("لم تُسلَّم (مرحلة وسيطة)");
  });

  it("the source gives fewer comments than 10 per video (36 in all, as live): the 36 are delivered and charged by the one unit price, ceil once, never above the reserve", async () => {
    const r = await run({ commentsPerVideo: [10, 6, 10, 10, 0] });
    assertReplayInvariants(r, { expectDelivered: 5 + 36, expectStatus: "partial" });
    const unit = r.plannedPlan.price.unitPricePoints;
    expect(r.mission.charged_points).toBe(settlementCharge({ deliveredUnits: 41, unitPricePoints: unit, reservedPoints: r.plannedPlan.price.reservePoints }).chargedPoints);
    expect(Number(r.mission.charged_points)).toBeLessThanOrEqual(r.plannedPlan.price.reservePoints);
    expect(Number(r.mission.charged_points)).toBeLessThan(r.plannedPlan.price.maxChargePoints);
  });

  it("the arithmetic of the live plan with the comments delivered (stored stage costs): the card price stays the minimum 200; 41 delivered cost 150; the old plan charged 200 for 5", () => {
    const before = priceMissionByCode([{ rows: 5, costPerRowUsd: 0.00003, deliver: true, yield: 0.7 }, { rows: 50, costPerRowUsd: 0.00005, deliver: false }]);
    const after = priceMissionByCode([{ rows: 5, costPerRowUsd: 0.00003, deliver: true, yield: 0.7 }, { rows: 50, costPerRowUsd: 0.00005, deliver: true }]);
    expect([before.deliveredRows, before.unitPricePoints, before.maxChargePoints]).toEqual([5, 40, 200]);
    expect([after.deliveredRows, after.unitPricePoints, after.reservePoints, after.maxChargePoints]).toEqual([55, 3.636363, 200, 200]);
    const charge = (d: number) => settlementCharge({ deliveredUnits: d, unitPricePoints: after.unitPricePoints, reservedPoints: after.reservePoints }).chargedPoints;
    expect([charge(55), charge(41), charge(5), charge(0)]).toEqual([200, 150, 19, 0]);
  });
});

describe("Companies «عايز ٣ شركات مقاولات في مصر، ومن كل شركة اتنين من المديرين»: the people stage the model kept as intermediate is delivered; managers first by title", () => {
  const COMPANIES = "tomba.companies.search.reveal";
  const PEOPLE = "aviato.companies.employees";
  const co = (name: string, site: string, city: string, description = "") => ({ id: site, name, website_url: site, country: "EG", city, company_size: "51-200", industry: "Construction", description });
  const companies = { companies: [
    co("Orascom Construction", "orascom.com", "Cairo", "Engineering and construction"),
    co("The Arab Contractors", "arabcont.example.com", "Cairo", "Contracting company"),
    co("Hassan Allam Contracting", "hassanallam.example.com", "Giza", "Contractors"),
    co("Nile Contracting Group", "nilegroup.example.com", "Giza", "Contractors"),
  ] };
  /** The people of a company as a source lists them: the manager is NOT first. */
  const person = (site: string, i: number, title: string) => ({ id: `${site}-p${i}`, full_name: `شخص ${site} ${i}`, job_title: title, profile_url: `https://linkedin.example/in/${site}-${i}` });
  const peopleOf = (site: string, titles: string[]) => ({ rows: titles.map((t, i) => person(site, i, t)) });
  const request = "عايز ٣ شركات مقاولات في مصر، ومن كل شركة اتنين من المديرين";
  const columns = columnsOf(["name", "اسم الشركة"], ["city", "المدينة"], ["country", "الدولة"], ["website", "الموقع الإلكتروني"], ["description", "نبذة عن الشركة"]);
  const pcolumns = columnsOf(["name", "الاسم"], ["title", "المسمى الوظيفي"], ["link", "رابط الملف المهني"]);
  async function run(titles: string[][]) {
    return replay({
      request,
      planning: planFlow({
        progress: "أبحث عن شركات المقاولات ومديريها", words: ["companies", "search"],
        calls: [
          { endpoint: COMPANIES, params: { query: "construction", page: 1 }, code: "return inputs.call_0001.companies.map(c => ({ id: c.id, name: c.name, website: 'https://' + c.website_url, country: c.country, city: c.city || '', description: c.description }))" },
          { endpoint: PEOPLE, params: { website: "https://orascom.com", perPage: 10, page: 1 }, code: "return inputs.call_0002.rows.map(p => ({ id: p.id, name: p.full_name, title: p.job_title, link: p.profile_url }))" },
        ],
        plan: (res) => ({
          summary_ar: "ستحصل على شركات مقاولات مصرية مع بياناتها الأساسية، ومن كل شركة شخصان من موظفيها مع مسمياتهم الوظيفية.",
          // THE LIVE PLAN: the people are an intermediate stage; the model's own line about the managers stays
          assumptions_ar: ["المديرون: مصدر الموظفين لا يختار المديرين وحدهم، فيُعرض لكل شركة شخصان من موظفيها مع مسمياتهم الوظيفية ليتضح من هم المديرون"],
          stages: [
            { key: "companies", title_ar: "شركات مقاولات مصرية", endpoint_id: COMPANIES, expected_rows: 3, parent_key: null, deliver: true, columns,
              sample_rows: [{ id: "orascom.com", name: "Orascom Construction", website: "https://orascom.com", country: "EG", city: "Cairo", description: "Engineering and construction" }], measured_by: [callIds(res)[0], firstOutputId(res)] },
            { key: "people", title_ar: "موظفون من كل شركة مقاولات (مع مسمياتهم الوظيفية)", endpoint_id: PEOPLE, expected_rows: 6, parent_key: "companies", per_parent_rows: 2, deliver: false, columns: pcolumns,
              sample_rows: [{ id: "orascom.com-p0", name: "شخص orascom.com 0", title: "Project Engineer", link: "https://linkedin.example/in/orascom.com-0" }], measured_by: [callIds(res)[1]] },
          ],
        }),
      }),
      execution: () => [],
      answers: [tregResult(companies, 0.0005), tregResult(peopleOf("orascom.com", ["Project Engineer", "Site Manager", "Director of Projects"]), 0.0005), tregResult(companies, 0.0005), ...titles.flatMap((t, i) => [tregResult(peopleOf(["orascom.com", "arabcont.example.com", "hassanallam.example.com"][i], t), 0.0005), ...(t.length < 2 ? [tregResult({ rows: [] }, 0.0005)] : [])])],
    });
  }
  const titles = [["Project Engineer", "Site Manager", "Director of Projects"], ["Accountant", "Employee", "General Manager"], ["Civil Engineer", "Architect", "Safety Officer"]];

  it("the card: the people stage is delivered by code; the total is 3 companies + 6 people, one line says managers are preferred and fewer may match; no «موظفون» promise of a manager the source cannot name", async () => {
    const r = await run(titles);
    expect(r.plannedPlan.stages.map((s) => [s.key, s.deliver, s.planned_rows])).toEqual([["companies", true, 3], ["people", true, 6]]);
    expect(r.plannedPlan.stages[1].role_preference).toEqual({ role: "manager" });
    expect(r.planView.stages.map((s) => [s.deliver, s.rows])).toEqual([[true, 3], [true, 6]]);
    expect(r.planView.totalRows).toBe(9);
    expect(r.plannedPlan.price.deliveredRows).toBe(9);
    expect(JSON.stringify(r.planView)).not.toContain("مرحلة وسيطة");
    const line = r.planView.notesAr.find((n) => n.startsWith("نفضّل"));
    expect(line).toBeTruthy();
    expect(line).toMatch(/مديرون/);
    expect(line).toMatch(/أقل|يكتمل العدد/);
    expect(line).not.toMatch(/صف|سجل|[A-Za-z]/);
  });

  it("delivered: three companies and two people each in their own sheet; the managers come first, by title, and a company with no manager in the source still gets its two people, titles as the source wrote them", async () => {
    const r = await run(titles);
    assertReplayInvariants(r, { expectDelivered: 9 });
    const snap = await readSnapshot(r.store, r.missionId);
    const byCompany = (site: string) => snap.acceptedRows("people").filter((p) => String(p.id).startsWith(site)).map((p) => String(p.title));
    // the source listed an engineer first: the manager and the director are taken
    expect(byCompany("orascom.com")).toEqual(["Site Manager", "Director of Projects"]);
    // a manager listed last, a generic «Employee» before an accountant: the general manager first, then the unclear title (never invented)
    expect(byCompany("arabcont.example.com")).toEqual(["General Manager", "Employee"]);
    // no manager at all: the first two as the source gave them
    expect(byCompany("hassanallam.example.com")).toEqual(["Civil Engineer", "Architect"]);
    const wb = await readWorkbook(r);
    // summary sheet, companies, people: the people have their own sheet (6 rows and a header)
    expect(wb.worksheets).toHaveLength(3);
    expect(wb.worksheets[2].rowCount).toBe(7);
    expect(JSON.stringify(wb.worksheets[0].getSheetValues())).not.toContain("لم تُسلَّم (مرحلة وسيطة)");
  });

  it("the source gave 4 of 6 people (live): 7 delivered, charged by the one unit price, never above the reserve", async () => {
    const r = await run([titles[0], ["General Manager"], ["Civil Engineer", "Architect"]]);
    assertReplayInvariants(r, { expectDelivered: 3 + 5, expectStatus: "partial" });
    expect(Number(r.mission.charged_points)).toBeLessThanOrEqual(r.plannedPlan.price.reservePoints);
  });

  it("the arithmetic of the live plan with the people delivered (stored stage costs): the card price stays 200; 7 delivered cost 156", () => {
    const before = priceMissionByCode([{ rows: 3, costPerRowUsd: 0.00000356, deliver: true, yield: 1 }, { rows: 6, costPerRowUsd: 0.00008333333333333333, deliver: false }]);
    const after = priceMissionByCode([{ rows: 3, costPerRowUsd: 0.00000356, deliver: true, yield: 1 }, { rows: 6, costPerRowUsd: 0.00008333333333333333, deliver: true }]);
    expect([before.deliveredRows, before.unitPricePoints, before.maxChargePoints]).toEqual([3, 66.666666, 200]);
    expect([after.deliveredRows, after.unitPricePoints, after.reservePoints, after.maxChargePoints]).toEqual([9, 22.222222, 200, 200]);
    const charge = (d: number) => settlementCharge({ deliveredUnits: d, unitPricePoints: after.unitPricePoints, reservedPoints: after.reservePoints }).chargedPoints;
    expect([charge(9), charge(7), charge(3), charge(0)]).toEqual([200, 156, 67, 0]);
  });
});

describe("the plan check, for every platform and item type (pure)", () => {
  const stage = (key: string, title_ar: string, deliver: boolean, planned_rows = 5) => ({ key, title_ar, deliver, planned_rows });
  const ref = (titles: Array<[string, string | null]>) => titles.map(([title_ar, parent_key], index) => ({ index, title_ar, parent_key }));
  const cases: Array<[string, string, Array<[string, string | null]>, number[]]> = [
    ["TikTok", "هات ٥ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات", [["فيديوهات تيك توك", null], ["تعليقات على الفيديوهات", "videos"]], [0, 1]],
    ["Facebook, «ومع كل»", "هات ٥ بوستات عن غلاء الأسعار ومع كل بوست ١٠ تعليقات", [["منشورات فيسبوك", null], ["تعليقات كل منشور", "posts"]], [0, 1]],
    ["X, «لكل»", "هات ٢٠ تغريدة عن الدوري، و٥ ردود لكل تغريدة", [["تغريدات عن الدوري", null], ["الردود", "tweets"]], [0, 1]],
    ["YouTube", "عايز ٣ فيديوهات من قناة أون سبورت ومن كل فيديو ٢٠ تعليق", [["فيديوهات القناة", null], ["تعليقات الفيديوهات", "videos"]], [0, 1]],
    ["Maps, reviews", "هات ٤ مطاعم كشري في القاهرة، ولكل مطعم ١٠ مراجعات", [["مطاعم كشري", null], ["تقييمات كل مكان", "places"]], [0, 1]],
    ["companies, people", "عايز ٣ شركات مقاولات في مصر، ومن كل شركة اتنين من المديرين", [["شركات مقاولات مصرية", null], ["موظفون من كل شركة", "companies"]], [0, 1]],
    ["number after the noun", "هات ٥ فيديوهات، تعليقات كل فيديو ١٠", [["فيديوهات", null], ["تعليقات كل فيديو", "videos"]], [0, 1]],
    ["children only (the parents are not counted)", "هات تعليقات فيديوهات منتخب مصر، من كل فيديو ١٠ تعليقات", [["فيديوهات", null], ["تعليقات", "videos"]], [1]],
    ["nothing per parent: the parent stage feeds only", "هات ٥٠ تعليق على فيديوهات منتخب مصر", [["فيديوهات", null], ["تعليقات", "videos"]], [1]],
  ];
  for (const [name, text, stages, wanted] of cases) {
    it(`${name}: the stages whose items were asked for are ${JSON.stringify(wanted)}`, () => {
      expect([...requestedStageIndexes(text, ref(stages))].sort()).toEqual(wanted);
    });
  }

  it("a plan where a requested stage is intermediate is refused with the stage named; a plan that delivers it passes", () => {
    const wanted = new Set([0, 1]);
    const bad = deliveryConsistencyIssues([stage("videos", "فيديوهات", true), stage("comments", "تعليقات", false, 50)], "ستحصل على فيديوهات.", wanted);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("comments");
    expect(deliveryConsistencyIssues([stage("videos", "فيديوهات", true), stage("comments", "تعليقات", true, 50)], "ستحصل على فيديوهات.", wanted)).toEqual([]);
  });

  it("the headline may not promise a count that only an intermediate stage has (50 comments the file does not hold)", () => {
    const stages = [stage("videos", "فيديوهات", true), stage("comments", "تعليقات", false, 50)];
    expect(deliveryConsistencyIssues(stages, "ستحصل على ٥ فيديوهات و٥٠ تعليقًا.", new Set())).toHaveLength(1);
    expect(deliveryConsistencyIssues(stages, "ستحصل على ٥ فيديوهات.", new Set())).toEqual([]);
    expect(deliveryConsistencyIssues([stage("videos", "فيديوهات", true), stage("comments", "تعليقات", true, 50)], "ستحصل على ٥ فيديوهات و٥٠ تعليقًا.", new Set())).toEqual([]);
  });
});
