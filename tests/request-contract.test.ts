import { describe, expect, it } from "vitest";
import { buildRequestContract, checkPlanAgainstContract, repairPlanByContract, contractSendBackIssues, CONTRACT_SEND_BACKS_MAX, type ContractPlan } from "../src/lib/agentMission/requestContract";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { perParentQuantities } from "../src/lib/agentMission/quantity";

/**
 * THE REQUEST CONTRACT (docs/ROOT-CAUSE.md, cause 1): what the customer asked is built ONCE by code from their words, and every plan is checked against it before it is stored. These are the five exact requests of the live rounds (the test
 * account, 2026-11-01 to 2026-11-02). RED FIRST: the module did not exist; before it, `perParentQuantities` returned nothing for «مع كل التعليقات والردود», so a plan with no comments stage was accepted (mission msn_adcfafabcdebc27ff803).
 */
const FB = "هات منشورات عن الذكاء الاصطناعي من صفحة قناة العربية على فيسبوك آخر ٣ شهور، منشورين، مع كل التعليقات والردود.";
const YT = "هات فيديوهين على يوتيوب عن نهائي السوبر المصري الأهلي والزمالك من القنوات الرسمية، مع كل التعليقات والردود.";
const TT = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، مع كل التعليقات والردود.";
const IG = "هات منشورين من حساب الحدث على إنستجرام (alhadath)، مع كل التعليقات والردود.";
const X = "هات ٢٠ تغريدة على X فيها \"العاصمة الإدارية\" بالعربي في شهر أكتوبر ٢٠٢٦، مع الردود.";

describe("the contract is built by code from the exact requests", () => {
  it("Facebook: page, topic, period, two posts, all comments and all replies", () => {
    const c = buildRequestContract(FB);
    expect(c).toMatchObject({ platform: "facebook", parentKind: "posts", count: 2, comments: "all", replies: "all", period: true, country: false, language: false });
    expect(c.topic).toBe("الذكاء الاصطناعي");
    expect(c.source).toMatchObject({ named: true, official: false });
    expect(c.source.text).toContain("العربية");
  });
  it("YouTube: official channels, the event as the topic, two videos", () => {
    const c = buildRequestContract(YT);
    expect(c).toMatchObject({ platform: "youtube", parentKind: "videos", count: 2, comments: "all", replies: "all" });
    expect(c.source).toMatchObject({ official: true });
    expect(c.topic).toContain("نهائي السوبر المصري");
  });
  it("TikTok: Arabic, Egypt, two videos", () => {
    const c = buildRequestContract(TT);
    expect(c).toMatchObject({ platform: "tiktok", parentKind: "videos", count: 2, comments: "all", replies: "all", language: true, country: true, period: false });
    expect(c.topic).toBe("الذكاء الاصطناعي");
  });
  it("Instagram: a named account in words and in brackets, two posts", () => {
    const c = buildRequestContract(IG);
    expect(c).toMatchObject({ platform: "instagram", parentKind: "posts", count: 2, comments: "all", replies: "all" });
    expect(c.source.named).toBe(true);
    expect(c.source.text).toMatch(/alhadath|الحدث/);
  });
  it("X: twenty tweets, a quoted topic, Arabic, a month; replies are not a stage (X has no replies source)", () => {
    const c = buildRequestContract(X);
    expect(c).toMatchObject({ platform: "x", parentKind: "tweets", count: 20, comments: "none", replies: "some", language: true, period: true });
    expect(c.topic).toBe("العاصمة الإدارية");
  });
  it("the old stage demand reads nothing from these words (the defect the contract closes)", () => {
    for (const r of [FB, YT, TT, IG]) expect(perParentQuantities(r)).toEqual([]);
  });
  it("one source of the platform when the words name several is the first named", () => {
    expect(buildRequestContract("هات ٥ فيديوهات من يوتيوب وتيك توك").platform).toBe("youtube");
  });
});

type St = ContractPlan["stages"][number];
const stage = (o: Partial<St> & Pick<St, "key" | "parent_key">): St => ({ deliver: true, endpoint_id: "x", planned_rows: 2, ...o });
const listing = (o: Partial<St> = {}): St => stage({ key: "videos", parent_key: null, endpoint_id: "crawl4ai.youtube.search.videos", engine: { params: { limit: 2, query: "نهائي السوبر المصري الأهلي الزمالك" }, gaps: [{ cls: "account", reason: "no_field" }] }, ...o });
const comments = (): St => stage({ key: "comments", parent_key: "videos", endpoint_id: "crawl4ai.youtube.video.comments", planned_rows: 200 });
const replies = (): St => stage({ key: "comments_replies", parent_key: "comments", replies_of: "comments", endpoint_id: "anyapi.youtube.comment_replies", planned_rows: 5 });

describe("the gate over a plan", () => {
  it("a plan with the listing only is missing the comments and the replies of a request that asked for both (msn_adcfafabcdebc27ff803)", () => {
    const v = checkPlanAgainstContract(buildRequestContract(YT), { stages: [listing()] });
    expect(v.missingStages).toEqual(["comments", "replies"]);
  });
  it("a plan with a comments stage and no replies stage and no word about replies is missing the replies only (msn_afe9bb0b436670e35a3c)", () => {
    const v = checkPlanAgainstContract(buildRequestContract(IG), { stages: [stage({ key: "posts", parent_key: null, endpoint_id: "scrapecreators.instagram.user.posts", engine: { params: { handle: "alhadath" }, source_listing: true } }), stage({ key: "comments", parent_key: "posts" })] });
    expect(v.missingStages).toEqual(["replies"]);
  });
  it("a complete plan has nothing missing", () => {
    const v = checkPlanAgainstContract(buildRequestContract(YT), { stages: [listing(), comments(), replies()] });
    expect(v.missingStages).toEqual([]);
  });
  it("a replies status the card already says (no source) counts as stated, but a summary that still promises replies is an overclaim", () => {
    const plan: ContractPlan = { summary_ar: "فيديوهان مع كل تعليقاتهما وردودها.", replies_status: "no_source", stages: [listing(), comments()] };
    const v = checkPlanAgainstContract(buildRequestContract(YT), plan);
    expect(v.missingStages).toEqual([]);
    expect(v.overclaims).toEqual(["replies"]);
  });
  it("X needs no comments or replies stage", () => {
    const v = checkPlanAgainstContract(buildRequestContract(X), { stages: [stage({ key: "tweets", parent_key: null, planned_rows: 20, endpoint_id: "anyapi.x.search.posts", engine: { params: { limit: 20, query: "\"العاصمة الإدارية\" lang:ar since:2026-10-01 until:2026-10-31", queryType: "Latest" } } })] });
    expect(v.missingStages).toEqual([]);
    expect(v.items.filter((i) => i.status === "missing")).toEqual([]);
  });
  it("a country in the words and in no tool field is not carried; with the field or a stated gap it is", () => {
    const base = (engine: St["engine"]): ContractPlan => ({ stages: [stage({ key: "videos", parent_key: null, endpoint_id: "anyapi.tiktok.search.videos", engine }), stage({ key: "comments", parent_key: "videos" }), replies()] });
    const c = buildRequestContract(TT);
    const country = (p: ContractPlan) => checkPlanAgainstContract(c, p).items.find((i) => i.what === "country")!.status;
    expect(country(base({ params: { query: "الذكاء الاصطناعي" } }))).toBe("missing");
    expect(country(base({ params: { query: "الذكاء الاصطناعي", region: "EG" } }))).toBe("carried");
    expect(country(base({ params: { query: "الذكاء الاصطناعي" }, gaps: [{ cls: "country", reason: "no_field" }] }))).toBe("stated");
  });
  it("the topic is carried by the search words, or stated; a page listing with no search words and no statement is missing (msn_6bb78c15d116268b0b9b)", () => {
    const c = buildRequestContract(FB);
    const plan = (params: Record<string, unknown>, gaps: Array<{ cls: "date"; reason: "no_field" }> = []): ContractPlan => ({ stages: [stage({ key: "posts", parent_key: null, endpoint_id: "anyapi.facebook.user.posts", engine: { params, gaps } }), stage({ key: "comments", parent_key: "posts" }), stage({ key: "r", parent_key: "comments", replies_of: "comments" })] });
    const topic = (p: ContractPlan) => checkPlanAgainstContract(c, p).items.find((i) => i.what === "topic")!.status;
    expect(topic(plan({ url: "https://www.facebook.com/AlArabiya" }))).toBe("missing");
    expect(topic(plan({ query: "الذكاء الاصطناعي", url: "https://www.facebook.com/AlArabiya" }))).toBe("carried");
    expect(checkPlanAgainstContract(c, plan({ url: "https://www.facebook.com/AlArabiya" }, [{ cls: "date", reason: "no_field" }])).items.find((i) => i.what === "period")!.status).toBe("stated");
  });
  it("the named page in the URL input is the source carried", () => {
    const v = checkPlanAgainstContract(buildRequestContract(FB), { stages: [stage({ key: "posts", parent_key: null, endpoint_id: "anyapi.facebook.user.posts", engine: { params: { url: "https://www.facebook.com/AlArabiya" } } })] });
    expect(v.items.find((i) => i.what === "source")!.status).toBe("carried");
  });
});

describe("the repair states what no tool carries, in plain Arabic, once", () => {
  const plan = (): ContractPlan => ({ summary_ar: "فيديوهات", stages: [listing()] });
  it("a missing comments stage and replies stage become steps NOT INCLUDED on the card, never silence", () => {
    const p = plan();
    const c = buildRequestContract(YT);
    const out = repairPlanByContract(c, p);
    expect(out.added).toEqual(expect.arrayContaining(["comments", "replies"]));
    expect(p.unserved_steps!.map((u) => u.what_ar).join(" ")).toMatch(/التعليقات/);
    expect(p.unserved_steps!.map((u) => u.what_ar).join(" ")).toMatch(/الردود/);
    expect(checkPlanAgainstContract(c, p).missingStages).toEqual([]);
  });
  it("every sentence passes the customer text check (Arabic only, no source names, no numbers)", () => {
    const p: ContractPlan = { stages: [stage({ key: "posts", parent_key: null, endpoint_id: "anyapi.facebook.user.posts", engine: { params: { url: "https://www.facebook.com/AlArabiya" } } })] };
    repairPlanByContract(buildRequestContract(FB), p);
    const lines = [...(p.notes_ar ?? []), ...(p.unserved_steps ?? []).flatMap((u) => [u.what_ar, u.reason_ar])];
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(checkCustomerText(l).issues, l).toEqual([]);
    for (const l of lines) expect(l).not.toMatch(/[A-Za-z0-9]/);
  });
  it("is idempotent: a second repair adds nothing", () => {
    const p = plan();
    const c = buildRequestContract(YT);
    repairPlanByContract(c, p);
    const once = JSON.stringify(p);
    expect(repairPlanByContract(c, p).added).toEqual([]);
    expect(JSON.stringify(p)).toBe(once);
  });
  it("a plan that satisfies the contract is not touched at all", () => {
    const p: ContractPlan = { stages: [listing(), comments(), replies()] };
    const before = JSON.stringify(p);
    expect(repairPlanByContract(buildRequestContract(YT), p).added).toEqual([]);
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe("the send-back text and its budget", () => {
  it("names the missing stage and the tools that can serve it; the budget is two", () => {
    const v = checkPlanAgainstContract(buildRequestContract(YT), { stages: [listing()] });
    const issues = contractSendBackIssues(v, buildRequestContract(YT), { commentsTools: ["crawl4ai.youtube.video.comments"] });
    expect(issues.join(" ")).toContain("crawl4ai.youtube.video.comments");
    expect(issues.join(" ")).toMatch(/comments/);
    expect(CONTRACT_SEND_BACKS_MAX).toBe(2);
  });
  it("no send-back for a plan that only needs a statement (a condition no tool carries)", () => {
    const v = checkPlanAgainstContract(buildRequestContract(TT), { stages: [stage({ key: "videos", parent_key: null, engine: { params: { query: "الذكاء الاصطناعي" } } }), stage({ key: "comments", parent_key: "videos" }), replies()] });
    expect(contractSendBackIssues(v, buildRequestContract(TT), {})).toEqual([]);
  });
});
