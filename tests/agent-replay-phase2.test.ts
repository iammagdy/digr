import { describe, expect, it } from "vitest";
import { assertReplayInvariants, pagedAnswers, readWorkbook, replay } from "./helpers/agentReplay";
import { callIds, companiesPage, employeesPage, lastOutputId, planningFlow, tregResult, ttCommentsPage, xPage, type Results } from "./helpers/agentFakeWorld";
import { emailsOf, fakeContextDev, igFeed, linksOf, mapsPlace, mapsReviews, phonesOf, ttFeed } from "./helpers/fakeContextDev";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * PHASE 2 REPLAYS (zero provider calls: a fake Context.dev answering in the documented shapes, a fake TREG, a fake model). The page parsers through the ONE gateway tool, the contacts stage with
 * verified values only, hundreds of rows paged by code, and the files readable first. The Phase 1 replays still run in their own file.
 */
const WHY = "the catalog's cheaper sources carry no post fields in their description";
const run = (r: Results, tool: string) => r.filter((x) => x.tool === tool);
const lastRows = (r: Results) => (run(r, "run_code")[0].result.result as unknown[]).slice(0, 3);

describe("an Instagram hashtag mission through the page parser", () => {
  it("the parser's posts are the rows: planned from one real parse, the charge ESTIMATED when the answer reports none, delivered and settled", async () => {
    const web = fakeContextDev({ parse: (_p, url) => ({ data: igFeed("قهوة", 12) }) });
    const URL_ = "https://www.instagram.com/explore/tags/%D9%82%D9%87%D9%88%D8%A9/";
    const r = await replay({
      request: "هات بوستات إنستجرام عن هاشتاج قهوة",
      web,
      planning: [
        { tool: "report_progress", args: { message_ar: "أبحث عن أرخص مصدر لمنشورات الوسوم", counts: { sources: 3 } } },
        { tool: "catalog_search", args: { words: ["hashtag", "posts"], platform: "instagram", limit: 6 } },
        { tool: "describe_endpoint", args: { id: "contextdev.parse.instagram-feed" } },
        { tool: "parse_page", args: { parser: "instagram-feed", url: URL_, why: WHY } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs.call_0001.rows.slice(0, 3).map(p => ({ id: p.id, text: p.caption, url: p.url, likes: p.like_count }))", files: callIds(res).slice(0, 1) }) },
        { tool: "propose_plan", args: (res: Results) => ({
          summary_ar: "ستحصل على منشورات إنستجرام الأكثر ظهورًا تحت وسم قهوة مع نص كل منشور ورابطه وعدد إعجاباته.",
          stages: [{ key: "posts", title_ar: "المنشورات", endpoint_id: "contextdev.parse.instagram-feed", expected_rows: 12, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص المنشور" }, { key: "url", title_ar: "رابط المنشور" }, { key: "likes", title_ar: "الإعجابات" }], sample_rows: lastRows(res), measured_by: [callIds(res)[0]] }],
        }) },
      ],
      execution: () => [
        { tool: "parse_page", args: { parser: "instagram-feed", url: URL_ } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].rows.map(p => ({ id: p.id, text: p.caption, url: p.url, likes: p.like_count }))", files: callIds(res) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "posts", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت ١٢ منشورًا من وسم قهوة." } },
      ],
      answers: [],
    });
    expect(r.planView.stages.map((s) => [s.titleAr, s.rows])).toEqual([["المنشورات", 12]]);
    assertReplayInvariants(r, { expectDelivered: 12 });
    // two parser calls (planning + execution), each recorded at the documented base credit and marked as an estimate
    expect(web.requests).toHaveLength(2);
    expect(r.rec.rows).toHaveLength(2);
    expect(r.rec.rows.every((x) => x.provider === "contextdev" && x.capabilityId === "contextdev.parse")).toBe(true);
    expect(r.rec.rows.every((x) => Math.abs((x.committedUsd ?? 0) - 0.00254) < 1e-9)).toBe(true);
    expect(r.store.calls.every((c) => c.params_digest.cost_basis === "estimated")).toBe(true);
    // the dearer-than-cheapest choice was recorded for the admin
    expect(r.store.calls[0].params_digest._why).toBe(WHY);
    expect(r.mission.planning_treg_usd).toBeCloseTo(0.00254, 6);
    expect(r.call).not.toHaveBeenCalled();
  });
});

describe("a Google Maps reviews mission through the page parsers", () => {
  it("finds the named place, then reads up to 200 of its reviews (sort and limit), the place's name next to every review in the file", async () => {
    const web = fakeContextDev({ parse: (parser, _url, body) => (parser === "google-maps" ? { data: mapsPlace("مطعم أبو طارق"), credits: 1 } : { data: mapsReviews(body.parseParams.limit), credits: 1 }) });
    const SEARCH = "https://www.google.com/maps/search/%D9%85%D8%B7%D8%B9%D9%85+%D8%A3%D8%A8%D9%88+%D8%B7%D8%A7%D8%B1%D9%82+%D8%A7%D9%84%D9%82%D8%A7%D9%87%D8%B1%D8%A9/";
    const PLACE = "https://www.google.com/maps/place/?q=place_id:ChIJplace0001";
    const r = await replay({
      request: "عايز ٢٠٠ تقييم من خرائط جوجل لمطعم أبو طارق في القاهرة",
      web,
      planning: [
        { tool: "catalog_search", args: { words: ["maps", "reviews"], platform: "google_maps", limit: 6 } },
        { tool: "parse_page", args: { parser: "google-maps", url: SEARCH, why: WHY } },
        { tool: "parse_page", args: { parser: "google-maps-reviews", url: PLACE, sort: "newest", limit: 100, why: WHY } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs.call_0001.rows.slice(0, 1).map(p => ({ id: p.place_id, name: p.name, url: p.google_maps_url }))", files: callIds(res).slice(0, 1) }) },
        { tool: "propose_plan", args: (res: Results) => ({
          summary_ar: "ستحصل على ٢٠٠ تقييم من خرائط جوجل لمطعم أبو طارق بنص كل تقييم ودرجته وتاريخه.",
          stages: [
            { key: "place", title_ar: "المكان", endpoint_id: "contextdev.parse.google-maps", expected_rows: 1, parent_key: null, deliver: false, columns: [{ key: "name", title_ar: "اسم المكان" }, { key: "url", title_ar: "رابط المكان" }], sample_rows: lastRows(res).slice(0, 1), measured_by: [callIds(res)[0]] },
            { key: "reviews", title_ar: "التقييمات", endpoint_id: "contextdev.parse.google-maps-reviews", expected_rows: 200, parent_key: "place", per_parent_rows: 200, deliver: true, columns: [{ key: "text", title_ar: "نص التقييم" }, { key: "rating", title_ar: "الدرجة" }, { key: "date", title_ar: "التاريخ" }], sample_rows: [{ id: "rv0", text: "تجربة رقم 0 في المكان", rating: 1, date: "2026-09-20T12:00:00Z" }], measured_by: [callIds(res)[1]] },
          ],
        }) },
      ],
      execution: () => [
        { tool: "parse_page", args: { parser: "google-maps", url: SEARCH } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].rows.slice(0, 1).map(p => ({ id: p.place_id, name: p.name, url: p.google_maps_url }))", files: callIds(res) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "place", from_output: lastOutputId(res) }) },
        { tool: "parse_page", args: { parser: "google-maps-reviews", url: PLACE, sort: "newest", limit: 200 } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].rows.map(v => ({ id: v.id, parent_id: 'ChIJplace0001', text: v.snippet, rating: v.rating, date: v.isoDate }))", files: [callIds(res)[1]] }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "reviews", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّم ٢٠٠ تقييم للمكان المطلوب." } },
      ],
      answers: [],
    });
    expect(r.planView.totalRows).toBe(200);
    expect(r.planView.stages[0].noteAr).toContain("المرحلة التالية");
    assertReplayInvariants(r, { expectDelivered: 200 });
    expect(web.requests.map((x) => x.body.parseParams.parser)).toEqual(["google-maps", "google-maps-reviews", "google-maps", "google-maps-reviews"]);
    expect(web.requests[3].body.parseParams).toMatchObject({ sort: "newest", limit: 200 });
    // the file: the place's name comes first, then the review, the ids last
    const sheet = (await readWorkbook(r)).getWorksheet("التقييمات")!;
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(["اسم المكان", "رابط المكان", "نص التقييم", "الدرجة", "التاريخ", "المعرّف", "معرّف الأصل"]);
    expect(sheet.getRow(2).getCell(1).value).toBe("مطعم أبو طارق");
    expect(sheet.getRow(2).getCell(4).value).toBe(1);
    expect(sheet.rowCount).toBe(201);
  });
});

describe("a TikTok mission: videos from the parser, comments from the catalog (the parser gives only 20)", () => {
  it("search results by parser, ten comments per video from the catalog's comment source", async () => {
    const web = fakeContextDev({ parse: () => ({ data: ttFeed(12), credits: 1 }) });
    const FEED = "https://www.tiktok.com/search?q=%D8%A7%D9%84%D8%A3%D9%82%D8%B5%D8%B1";
    const vid = (i: number) => `7${String(i).padStart(6, "0")}`;
    const COMMENTS = "crawl4ai.tiktok.video.comments";
    const r = await replay({
      request: "عايز فيديوهات تيك توك عن الأقصر مع ١٠ تعليقات لكل فيديو",
      web,
      planning: [
        { tool: "catalog_search", args: { words: ["tiktok", "videos", "search"], platform: "tiktok", limit: 6 } },
        { tool: "parse_page", args: { parser: "tiktok-feed", url: FEED, why: WHY } },
        { tool: "treg_call", args: { endpoint_id: COMMENTS, params: { post: `https://www.tiktok.com/@creator0/video/${vid(0)}` }, why: WHY } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs.call_0001.rows.slice(0, 2).map(v => ({ id: v.id, text: v.caption, url: v.url, views: v.view_count }))", files: callIds(res).slice(0, 1) }) },
        { tool: "propose_plan", args: (res: Results) => ({
          summary_ar: "ستحصل على فيديوهات تيك توك عن الأقصر مع مشاهداتها وعشرة تعليقات لكل فيديو.",
          stages: [
            { key: "videos", title_ar: "الفيديوهات", endpoint_id: "contextdev.parse.tiktok-feed", expected_rows: 12, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "وصف الفيديو" }, { key: "url", title_ar: "رابط الفيديو" }, { key: "views", title_ar: "المشاهدات" }], sample_rows: lastRows(res).slice(0, 2), measured_by: [callIds(res)[0]] },
            { key: "comments", title_ar: "تعليقات كل فيديو", endpoint_id: COMMENTS, expected_rows: 120, parent_key: "videos", per_parent_rows: 10, deliver: true, columns: [{ key: "text", title_ar: "نص التعليق" }, { key: "author", title_ar: "كاتب التعليق" }], sample_rows: [{ id: `${vid(0)}-k00`, text: `تعليق 0 على الفيديو ${vid(0)}`, author: "viewer0" }], measured_by: [callIds(res)[1]] },
          ],
        }) },
      ],
      execution: () => [
        { tool: "parse_page", args: { parser: "tiktok-feed", url: FEED } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].rows.map(v => ({ id: v.id, text: v.caption, url: v.url, views: v.view_count }))", files: callIds(res) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "videos", from_output: lastOutputId(res) }) },
        ...Array.from({ length: 12 }, (_, i): FakeStep => ({ tool: "treg_call", args: { endpoint_id: COMMENTS, params: { post: `https://www.tiktok.com/@creator${i % 4}/video/${vid(i)}` }, why: WHY } })),
        { tool: "run_code", args: (res: Results) => ({ code: "const out = []; for (const k of Object.keys(inputs)) for (const c of inputs[k].rows) out.push({ id: c.comment_id, parent_id: c.post_id, text: c.text, author: c.author }); return out;", files: callIds(res).slice(1) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "comments", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت ١٢ فيديو مع عشرة تعليقات لكل فيديو." } },
      ],
      answers: [tregResult(ttCommentsPage(vid(0), 10), 0.0005), ...Array.from({ length: 12 }, (_, i) => tregResult(ttCommentsPage(vid(i), 10), 0.0005))],
    });
    expect(r.planView.totalRows).toBe(132);
    assertReplayInvariants(r, { expectDelivered: 132 });
    const sheet = (await readWorkbook(r)).getWorksheet("تعليقات كل فيديو")!;
    // the video's description and link next to each comment
    expect((sheet.getRow(1).values as unknown[]).slice(1, 5)).toEqual(["وصف الفيديو", "رابط الفيديو", "نص التعليق", "كاتب التعليق"]);
    expect(String(sheet.getRow(2).getCell(1).value)).toContain("رحلة إلى الأقصر");
  });
});

describe("a companies + employees + company contacts mission: the company's own site, then its contact page", () => {
  const COMPANIES = "aiark.companies.search";
  const EMPLOYEES = "aviato.companies.employees";
  const SITES = ["https://company1.example", "https://company2.example", "https://company3.example"];
  const EMAILS: Record<string, string[]> = { "company1.example": ["info@company1.example", "someone@gmail.com"], "company2.example": ["someone@gmail.com"], "company3.example": ["sales@company3.example"] };
  const PHONES: Record<string, string[]> = { "company1.example": ["+20227945000"], "company2.example": ["+20233445566"], "company3.example": [] };
  const world = () => fakeContextDev({
    parse: (parser, url) => {
      const host = new URL(url).hostname;
      if (parser === "links") return { data: linksOf([[`https://${host}/about`, "من نحن"], [`https://${host}/contact`, "اتصل بنا"]]), credits: 1 };
      if (parser === "emails") return { data: emailsOf(EMAILS[host] ?? []), credits: 1 };
      if (parser === "phone-numbers") return { data: phonesOf(PHONES[host] ?? []), credits: 1 };
      return { fail: { error_code: "NOT_FOUND" } };
    },
  });

  it("only verified contacts are delivered: the personal mailbox is left out, the company with no phone gets no phone row and is not charged for it (partial)", async () => {
    const web = world();
    const answers = [
      tregResult(companiesPage(3), 0.0005267), tregResult(employeesPage("co1", 2), 0.005),
      tregResult(companiesPage(3), 0.0005267), ...[1, 2, 3].map((c) => tregResult(employeesPage(`co${c}`, 2), 0.005)),
    ];
    const r = await replay({
      request: "عايز ٣ شركات كهروميكانيكا في مصر، وجوه كل شركة موظفين اتنين، وإيميل وموبايل كل شركة من موقعها",
      web, answers,
      planning: [
        { tool: "catalog_search", args: { words: ["companies", "search"], limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { page: 0, size: 3, account: "الكهروميكانيكا مصر" }, why: WHY } },
        { tool: "treg_call", args: { endpoint_id: EMPLOYEES, params: { website: "company1.example", page: 0, perPage: 2 }, why: WHY } },
        // the company's own site: its links, then the contact page's e-mails and phones
        { tool: "parse_page", args: { parser: "links", url: SITES[0], why: WHY } },
        { tool: "parse_page", args: { parser: "emails", url: `${SITES[0]}/contact`, why: WHY } },
        { tool: "parse_page", args: { parser: "phone-numbers", url: `${SITES[0]}/contact`, why: WHY } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs.call_0001.content.slice(0, 2).map(c => ({ id: c.id, text: c.name, url: c.domain }))", files: callIds(res).slice(0, 1) }) },
        { tool: "propose_plan", args: (res: Results) => ({
          summary_ar: "ستحصل على ثلاث شركات كهروميكانيكا في مصر وموظفين اثنين من كل شركة مع بريد كل شركة المهني وهاتفها من موقعها.",
          stages: [
            { key: "companies", title_ar: "الشركات", endpoint_id: COMPANIES, expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "اسم الشركة" }, { key: "url", title_ar: "الموقع" }], sample_rows: lastRows(res).slice(0, 2), measured_by: [callIds(res)[0]] },
            { key: "employees", title_ar: "موظفو كل شركة", endpoint_id: EMPLOYEES, expected_rows: 6, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: [{ key: "text", title_ar: "اسم الموظف" }, { key: "title", title_ar: "المسمى الوظيفي" }], sample_rows: [{ id: "co1-p1", text: "أحمد حسن", title: "مدير المشتريات" }], measured_by: [callIds(res)[1]] },
            { key: "emails", title_ar: "البريد المهني لكل شركة", endpoint_id: "contextdev.parse.emails", expected_rows: 3, parent_key: "companies", per_parent_rows: 1, deliver: true, columns: [{ key: "text", title_ar: "البريد المهني", kind: "work_email" }], sample_rows: [{ id: "info@company1.example", text: "info@company1.example" }], measured_by: [callIds(res)[3]] },
            { key: "phones", title_ar: "هاتف كل شركة", endpoint_id: "contextdev.parse.phone-numbers", expected_rows: 3, parent_key: "companies", per_parent_rows: 1, deliver: true, columns: [{ key: "text", title_ar: "رقم الهاتف", kind: "phone" }], sample_rows: [{ id: "+20227945000", text: "+20227945000" }], measured_by: [callIds(res)[4]] },
          ],
        }) },
      ],
      execution: () => [
        { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { page: 0, size: 3, account: "الكهروميكانيكا مصر" }, why: WHY } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].content.map(c => ({ id: c.id, text: c.name, url: c.domain }))", files: callIds(res) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "companies", from_output: lastOutputId(res) }) },
        ...[1, 2, 3].map((c): FakeStep => ({ tool: "treg_call", args: { endpoint_id: EMPLOYEES, params: { website: `company${c}.example`, page: 0, perPage: 2 }, why: WHY } })),
        { tool: "run_code", args: (res: Results) => ({ code: "const out = []; for (const page of Object.values(inputs)) for (const e of page.employees) out.push({ id: e.personID, parent_id: e.companyID, text: e.person.fullName, title: e.positionList[0].title }); return out;", files: callIds(res).slice(1) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "employees", from_output: lastOutputId(res) }) },
        // per company: its links (to find the contact page), then the e-mails and phones of that page
        ...SITES.flatMap((site): FakeStep[] => [
          { tool: "parse_page", args: { parser: "links", url: site, why: WHY } },
          { tool: "parse_page", args: { parser: "emails", url: `${site}/contact`, why: WHY } },
          { tool: "parse_page", args: { parser: "phone-numbers", url: `${site}/contact`, why: WHY } },
        ]),
        { tool: "run_code", args: (res: Results) => { const pages = res.filter((x) => (x.tool === "parse_page" || x.tool === "treg_call") && x.result.ok === true).map((x) => String(x.result.call_id)); const mine = pages.slice(4); // 3 companies x (links, emails, phones)
          return { code: "const ids = ['co1','co2','co3']; const keys = Object.keys(inputs); const out = []; ids.forEach((id, i) => { const emails = inputs[keys[i * 3 + 1]].rows.map(r => r.email); const first = emails[0]; if (first) out.push({ id: first, parent_id: id, text: first }); }); return out;", files: mine }; } },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "emails", from_output: lastOutputId(res) }) },
        { tool: "run_code", args: (res: Results) => { const pages = res.filter((x) => (x.tool === "parse_page" || x.tool === "treg_call") && x.result.ok === true).map((x) => String(x.result.call_id)); return { code: "const ids = ['co1','co2','co3']; const keys = Object.keys(inputs); const out = []; ids.forEach((id, i) => { const phones = inputs[keys[i * 3 + 2]].rows.map(r => r.phone); const first = phones[0]; if (first) out.push({ id: first, parent_id: id, text: first }); }); return out;", files: pages.slice(4) }; } },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "phones", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت ثلاث شركات وستة موظفين وبريدان مهنيان وهاتفان للشركات؛ البريد الشخصي لم يُعتمد، والشركة الثالثة لا هاتف لها في موقعها فلم يُحتسب عليك." } },
      ],
    });
    expect(r.planView.stages.map((s) => s.titleAr)).toEqual(["الشركات", "موظفو كل شركة", "البريد المهني لكل شركة", "هاتف كل شركة"]);
    expect(r.planView.totalRows).toBe(15);
    // verified only: 3 + 6 employees + e-mails of company 1 and 3 (the gmail box of company 2 is not a work e-mail) + phones of companies 1 and 2 = 13 of 15
    assertReplayInvariants(r, { expectDelivered: 13, expectStatus: "partial" });
    expect(r.finalView.phase).toBe("partial");
    const emails = JSON.parse((await r.store.getFile(r.missionId, "rows/emails.json"))!);
    expect(emails.map((e: any) => e.text)).toEqual(["info@company1.example", "sales@company3.example"]);
    const phones = JSON.parse((await r.store.getFile(r.missionId, "rows/phones.json"))!);
    expect(phones.map((e: any) => e.text)).toEqual(["+20227945000", "+20233445566"]);
    // the file: each contact row names its company first
    const wb = await readWorkbook(r);
    const sheet = wb.getWorksheet("البريد المهني لكل شركة")!;
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(["اسم الشركة", "البريد المهني", "المعرّف", "معرّف الأصل"]);
    expect(sheet.getRow(2).getCell(1).value).toBe("الشركة المصرية للكهروميكانيكا");
    // every parser call was a recorded, charged Context.dev call
    expect(r.rec.rows.filter((x) => x.provider === "contextdev")).toHaveLength(web.requests.length);
  });
});

describe("a 300-tweet mission paged by ONE tool call", () => {
  const ENDPOINT = "anyapi.x.search.posts";
  const TOPIC = "محمد صلاح بعد انتقاله لتركيا";
  it("collect_pages pages the source in code: the model needs a handful of turns, not fifteen", async () => {
    const answers = [tregResult(xPage(TOPIC, 0, 20, "cur_20"), 0.00075), ...pagedAnswers(300, 20, 0.00075, (o, n, next) => xPage(TOPIC, o, n, next), tregResult)];
    const r = await replay({
      request: "هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا",
      planning: planningFlow({
        progress: "أبحث عن أرخص مصدر مناسب للتغريدات", searchWords: ["tweets", "search"], platform: "x",
        sample: [{ endpoint: ENDPOINT, params: { query: TOPIC, limit: 20 }, why: WHY }],
        sampleCode: "return inputs.call_0001.output.data.items.slice(0, 3).map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author }))",
        plan: (res: Results) => ({
          summary_ar: "ستحصل على ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا مع نص كل تغريدة ورابطها.",
          stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: ENDPOINT, expected_rows: 300, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }], sample_rows: lastRows(res), measured_by: [callIds(res)[0]] }],
        }),
      }),
      execution: () => [
        { tool: "collect_pages", args: { endpoint_id: ENDPOINT, params: { query: TOPIC, limit: 20 }, target_rows: 300, why: WHY } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author }))", files: [String(run(res, "collect_pages")[0].result.output_id)] }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "tweets", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا." } },
      ],
      answers,
    });
    assertReplayInvariants(r, { expectDelivered: 300 });
    expect(r.executionDriver.results.map((x) => x.tool)).toEqual(["collect_pages", "run_code", "save_rows", "finish"]);
    expect(r.executionDriver.results[0].result).toMatchObject({ ok: true, pages: 15, unique_rows: 300, stopped_because: "target_reached" });
    expect(r.mission.charged_points).toBe(62);
    // the panel got the paging progress and the save
    expect(r.store.events.filter((e) => e.counts?.pages).length).toBe(15);
    expect(r.finalView.steps.map((s) => s.state)).toEqual(["done", "done"]);
  });
});
