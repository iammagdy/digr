import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { readSnapshot } from "../agent/src/items/itemStore";
import { checkFieldMap, checkOptions, checkUnderstanding, planWithLlm, type LlmPlannerDeps, type PlannerModel } from "../agent/src/llmPlanner/planner";
import { platformIndex, candidatesFor } from "../agent/src/llmPlanner/catalogView";
import { llmPlannerOnValue } from "../src/lib/agentMission/llmPlannerFlag";
import type { ReviewCall } from "../agent/src/review";
import type { TregCallOptions } from "../src/functions/shared/tregClient";
import { tregResult } from "./helpers/agentHarness";
import { replay, readWorkbook, assertReplayInvariants } from "./helpers/agentReplay";

/**
 * THE LLM-FIRST PLANNER (owner direction, 15 Nov 2026). The model is scripted here (deterministic fixtures, NOT a measure of the real model's accuracy): these tests prove what CODE does with
 * the model's answers: the catalog checks, the real-page probe, the mapping, the price, and the engine reading to the customer's count across further input sets with nothing dropped for its meaning.
 */
const catalog = loadTregCatalog();

/** A scripted planning model: one queue of answers per structured tool. */
function scriptedModel(answers: Record<string, unknown[]>): { call: ReviewCall; model: PlannerModel; seen: Array<{ tool: string; user: string; system: string }> } {
  const seen: Array<{ tool: string; user: string; system: string }> = [];
  const call: ReviewCall = async (input) => {
    const name = input.tool?.name ?? "none";
    seen.push({ tool: name, user: input.user, system: input.system });
    const next = (answers[name] ?? []).shift();
    if (next === undefined) return null;
    return { text: JSON.stringify(next), usage: { input_tokens: 1000, output_tokens: 200 } };
  };
  const model: PlannerModel = async ({ system, user, tool, maxTokens }) => { const got = await call({ model: "claude-sonnet-5-5", system, user, tool, maxTokens }); return got ? { input: JSON.parse(got.text), costUsd: 0.001 } : null; };
  return { call, model, seen };
}

const tweet = (i: number) => ({ id: `19000000000000${String(i).padStart(4, "0")}`, text: `وزارة الصحة تنفي شائعة رقم ${i}`, authorName: "وزارة الصحة", authorUsername: "SaudiMOH", createdUtc: "2024-03-01T10:00:00Z", url: `https://x.com/SaudiMOH/status/19000000000000${String(i).padStart(4, "0")}`, likeCount: i, replyCount: 0, retweetCount: 0, viewCount: 10, lang: "ar", isReply: false });
const xPage = (from: number, n: number, cursor: string | null) => ({ output: { data: { items: Array.from({ length: n }, (_, k) => tweet(from + k)), nextCursor: cursor } } });

const UNDERSTOOD_X = {
  decision: "plan",
  understanding_ar: "تغريدات حساب وزارة الصحة السعودية على إكس عن الشائعات والتصدي لها خلال آخر خمس سنوات، بعدد ٥٠ تغريدة.",
  assumptions_ar: [],
  steps: [{
    key: "tweets", title_ar: "التغريدات", platform: "x", capability: "x.search.posts", parent: null, deliver: true,
    count: { total: 50, per_parent: null, all: false }, source: { kind: "account", value: "SaudiMOH" }, topic: "الشائعات والتصدي لها",
    search_terms: ["الشائعات", "شائعة", "شائعات", "إشاعة", "معلومات مغلوطة"], period: { from: "2021-11-15", to: "2026-11-15" },
  }],
};
const CHOICE_X = {
  options: [{
    endpoint_id: "anyapi.x.search.posts",
    params: { query: "(الشائعات OR شائعة OR شائعات) from:SaudiMOH since:2021-11-15 until:2026-11-16", limit: 50, queryType: "Latest", cursor: "MUST_BE_DROPPED", made_up_input: 1 },
    cursor_input: "cursor", parent_input: null,
    more_params: [{ query: "(إشاعة OR إشاعات OR \"معلومات مغلوطة\") from:SaudiMOH since:2021-11-15 until:2026-11-16", limit: 50, queryType: "Latest" }],
  }],
};
const MAP_X = { fields: { id: ["id"], text: ["text"], author: ["authorName"], username: ["authorUsername"], posted_at: ["createdUtc"], link: ["url"], likes: ["likeCount"], views: ["viewCount"], comments_count: ["no", "such"] }, link_template: null, extra: [] };

describe("the switch", () => {
  it("is ON unless the owner stores false", () => {
    expect(llmPlannerOnValue(undefined)).toBe(true);
    expect(llmPlannerOnValue(true)).toBe(true);
    expect(llmPlannerOnValue(false)).toBe(false);
    expect(llmPlannerOnValue("off")).toBe(false);
    expect(llmPlannerOnValue({ enabled: false })).toBe(false);
  });
});

describe("what code checks in the model's answers (the catalog, never the customer's words)", () => {
  it("the catalog index the model reads has every platform the catalog serves, Reddit, LinkedIn and Threads included, and no media generation", () => {
    const idx = platformIndex(catalog, null);
    for (const p of ["x:", "tiktok:", "instagram:", "facebook:", "youtube:", "reddit:", "linkedin:", "threads:", "telegram:"]) expect(idx).toMatch(new RegExp(`^${p}`, "m"));
    expect(idx).not.toMatch(/^image-gen:/m);
    expect(candidatesFor(catalog, null, "reddit", "reddit.search.posts").length).toBeGreaterThan(0);
  });

  it("an understanding with a platform or a capability the catalog does not list is refused with the reason (the model is asked again)", () => {
    expect(checkUnderstanding({ ...UNDERSTOOD_X, steps: [{ ...UNDERSTOOD_X.steps[0], platform: "myspace" }] }, catalog, null)).toMatchObject({ ok: false });
    expect(checkUnderstanding({ ...UNDERSTOOD_X, steps: [{ ...UNDERSTOOD_X.steps[0], capability: "x.teleport" }] }, catalog, null)).toMatchObject({ ok: false });
    // a child whose parent is not an EARLIER step
    const child = { ...UNDERSTOOD_X.steps[0], key: "replies", capability: "x.post.comments", parent: "nowhere" };
    expect(checkUnderstanding({ ...UNDERSTOOD_X, steps: [UNDERSTOOD_X.steps[0], child] }, catalog, null)).toMatchObject({ ok: false });
    const ok = checkUnderstanding(UNDERSTOOD_X, catalog, null);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.steps[0]).toMatchObject({ platform: "x", capability: "x.search.posts", count: { total: 50 } });
  });

  it("the customer's number is kept as the model read it (400 stays 400, up to the step maximum)", () => {
    const r = checkUnderstanding({ ...UNDERSTOOD_X, steps: [{ ...UNDERSTOOD_X.steps[0], count: { total: 400, per_parent: null, all: false } }] }, catalog, null);
    expect(r.ok && r.value.steps[0].count.total).toBe(400);
  });

  it("a tool option keeps only the tool's own inputs: an invented input and a cursor in the first page are dropped; an unknown tool is refused", () => {
    const cands = candidatesFor(catalog, null, "x", "x.search.posts");
    const opts = checkOptions(CHOICE_X, cands, false);
    expect(opts).toHaveLength(1);
    expect(opts[0].params).toEqual({ query: CHOICE_X.options[0].params.query, limit: 50, queryType: "Latest" });
    expect(opts[0].cursor).toBe("cursor");
    expect(opts[0].more).toHaveLength(1);
    expect(checkOptions({ options: [{ endpoint_id: "nope.x", params: {}, cursor_input: null, parent_input: null }] }, cands, false)).toEqual([]);
    // a required input missing: refused
    expect(checkOptions({ options: [{ endpoint_id: "anyapi.x.search.posts", params: { limit: 20 }, cursor_input: "cursor", parent_input: null }] }, cands, false)).toEqual([]);
  });

  it("a field path is kept only when it reads a value from the real items; the id is required", () => {
    const items = xPage(0, 3, null).output.data.items as Array<Record<string, unknown>>;
    const m = checkFieldMap(MAP_X, items)!;
    expect(m.fields.id).toEqual(["id"]);
    expect(m.fields.comments_count).toBeUndefined();
    expect(checkFieldMap({ fields: { id: ["nope"] } }, [{ x: 1 }])).toBeNull();
  });
});

describe("one real page per step, priced by code from what it gave", () => {
  it("planWithLlm: understanding → tool → probe → map → a priced plan whose engine reads the first input set, then the further ones", async () => {
    const m = scriptedModel({ request_plan: [UNDERSTOOD_X], tool_choice: [CHOICE_X], field_map: [MAP_X] });
    const probes: Array<{ id: string; params: Record<string, unknown> }> = [];
    const deps: LlmPlannerDeps = {
      model: async ({ system, user, tool, maxTokens }) => { const got = await m.call({ model: "m", system, user, tool, maxTokens }); return got ? { input: JSON.parse(got.text), costUsd: 0.01 } : null; },
      catalog, access: null, today: "2026-11-15",
      probe: async (id, params) => { probes.push({ id, params }); return { ok: true, call_id: "call_0001", http_status: 200, rows_in_page: 20, has_more: true, next_cursor: "c2", shape: null, first_rows: [], warnings: [], saved: "call_0001" }; },
      readPage: async () => xPage(0, 20, "c2"),
    };
    const r = await planWithLlm({ words: ["٥٠ تغريدة من حساب وزارة الصحة السعودية عن الشائعات خلال آخر خمس سنوات"], request: "" }, deps);
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(probes).toEqual([{ id: "anyapi.x.search.posts", params: { query: CHOICE_X.options[0].params.query, limit: 50, queryType: "Latest" } }]);
    const st = r.plan.stages[0];
    expect(st).toMatchObject({ key: "tweets", planned_rows: 50, endpoint_id: "anyapi.x.search.posts", deliver: true });
    expect(st.relevance).toBeUndefined();
    expect(st.filters).toBeUndefined();
    expect(st.engine).toMatchObject({ built_by: "code", cursor_param: "cursor", params: { query: CHOICE_X.options[0].params.query } });
    expect(st.engine!.alternatives).toHaveLength(1);
    expect(st.sample_rows[0]).toMatchObject({ id: tweet(0).id, text: tweet(0).text, username: "SaudiMOH", link: tweet(0).url });
    expect(r.plan.compiled?.by).toBe("compiler");
    expect(r.plan.price.deliveredRows).toBe(50);
    expect(r.costUsd).toBeCloseTo(0.03, 6);
    // the model was given the catalog index, the customer's own words and today's date
    expect(m.seen[0].system).toMatch(/^reddit:/m);
    expect(m.seen[0].user).toContain("2026-11-15");
    expect(m.seen[0].user).toContain("٥٠ تغريدة من حساب وزارة الصحة السعودية");
  });

  it("a tool that answers empty is not planned on: the next input set is tried, then the next option; nothing answers → the step is said, not invented", async () => {
    const choice = { options: [{ ...CHOICE_X.options[0] }] };
    const m = scriptedModel({ request_plan: [UNDERSTOOD_X], tool_choice: [choice], field_map: [MAP_X] });
    let n = 0;
    const deps: LlmPlannerDeps = {
      model: async (c) => { const got = await m.call({ model: "m", ...c }); return got ? { input: JSON.parse(got.text), costUsd: 0 } : null; },
      catalog, access: null, today: "2026-11-15",
      probe: async () => { n += 1; return n === 1 ? { ok: true, call_id: "call_0001", http_status: 200, rows_in_page: 0, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "" } : { ok: true, call_id: "call_0002", http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "" }; },
      readPage: async () => xPage(100, 5, null),
    };
    const r = await planWithLlm({ words: ["تغريدات"], request: "" }, deps);
    expect(n).toBe(2);
    expect(r.kind).toBe("plan");
    // the input set that answered reads first
    if (r.kind === "plan") expect(String(r.plan.stages[0].engine!.params.query)).toContain("إشاعة");
  });
});

describe("END TO END: chat → the model plans → approval → the engine reads to the customer's count → the file → settlement", () => {
  it("50 tweets of an account about a topic: the first query gives 40 and ends, the next input set gives the rest (duplicates removed), 50 delivered, nothing judged or dropped for its meaning", async () => {
    const m = scriptedModel({ request_plan: [UNDERSTOOD_X], tool_choice: [CHOICE_X], field_map: [MAP_X] });
    const queriesSeen: string[] = [];
    const page = (data: unknown) => (o: TregCallOptions) => { queriesSeen.push(String((o.params as Record<string, unknown>).query ?? "")); return tregResult(data, 0.00075); };
    const r = await replay({
      request: "هات ٥٠ تغريدة من حساب وزارة الصحة السعودية عن الشائعات خلال آخر خمس سنوات",
      planning: [], execution: () => [],
      answers: [
        page(xPage(0, 20, "c2")), // planning: the probe
        page(xPage(0, 20, "c2")), page(xPage(20, 20, null)), // execution: the first query, two pages, then its end
        page(xPage(30, 20, null)), // the next input set: 10 already held, 10 new... and 10 more
      ],
      deps: (base) => ({ ...base, plannerModel: m.model }),
    });
    expect(r.mission.status).toBe("completed");
    expect(r.mission.delivered_units).toBe(50);
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.counts("tweets").accepted).toBe(50);
    expect(queriesSeen[3]).toContain("إشاعة");
    const wb = await readWorkbook(r);
    expect(wb.getWorksheet("التغريدات")!.rowCount).toBe(51);
    // the customer's card: the model's understanding, the count, no provider, no endpoint, no dollar
    expect(r.planView.summaryAr).toContain("٥٠");
    assertReplayInvariants(r, { expectDelivered: 50, expectStatus: "completed" });
  });
});

describe("END TO END on a platform the word rules never served: Reddit posts with two comments on each", () => {
  const post = (i: number) => ({ id: `p${i}`, title: `منشور عن الذكاء الاصطناعي ${i}`, selftext: "نص المنشور", author: `user${i}`, subreddit: "egypt", created_utc: 1785167578 + i, url: `https://www.reddit.com/r/egypt/comments/p${i}/x/`, permalink: `/r/egypt/comments/p${i}/x/`, score: 10 + i, num_comments: i === 1 ? 50 : 5 });
  const comment = (p: number, c: number) => ({ id: `p${p}c${c}`, text: `تعليق ${c} على ${p}`, author: `u${c}`, created: "2026-08-31T09:51:27Z", score: c, parent: `p${p}` });
  const postsPage = (from: number, n: number, after: string | null) => ({ success: true, posts: Array.from({ length: n }, (_, k) => post(from + k)), after });
  const commentsPage = (p: number, n: number) => ({ meta: { partial: false }, rows: Array.from({ length: n }, (_, k) => comment(p, k)) });
  const UNDERSTOOD = {
    decision: "plan", understanding_ar: "ثلاثة منشورات من ريديت عن الذكاء الاصطناعي مع تعليقين على كل منشور.", assumptions_ar: [],
    steps: [
      { key: "posts", title_ar: "المنشورات", platform: "reddit", capability: "reddit.search.posts", parent: null, deliver: true, count: { total: 3, per_parent: null, all: false }, source: null, topic: "الذكاء الاصطناعي", search_terms: ["الذكاء الاصطناعي", "AI"], period: null },
      { key: "comments", title_ar: "التعليقات", platform: "reddit", capability: "reddit.post.comments", parent: "posts", deliver: true, count: { total: null, per_parent: 2, all: false }, source: null, topic: null, search_terms: [], period: null },
    ],
  };
  const CHOICE_POSTS = { options: [{ endpoint_id: "scrapecreators.reddit.search.posts", params: { query: "الذكاء الاصطناعي", sort: "relevance" }, cursor_input: "after", parent_input: null, more_params: [] }] };
  const CHOICE_COMMENTS = { options: [{ endpoint_id: "crawl4ai.reddit.post.comments", params: { limit: 100 }, cursor_input: null, parent_input: { param: "url", from_field: "link" }, more_params: [] }] };
  const MAP_POSTS = { fields: { id: ["id"], text: ["selftext"], title: ["title"], author: ["author"], posted_at: ["created_utc"], link: ["url"], likes: ["score"], comments_count: ["num_comments"] }, extra: [{ key: "subreddit", title_ar: "المجتمع", path: ["subreddit"] }] };
  const MAP_COMMENTS = { fields: { id: ["id"], text: ["text"], author: ["author"], posted_at: ["created"], likes: ["score"] }, extra: [] };

  it("the model plans both steps from the catalog; the comments of each post are read by its link; 3 + 6 delivered", async () => {
    const m = scriptedModel({ request_plan: [UNDERSTOOD], tool_choice: [CHOICE_POSTS, CHOICE_COMMENTS], field_map: [MAP_POSTS, MAP_COMMENTS] });
    const urlsAsked: string[] = [];
    const comments = (o: TregCallOptions) => { const u = String((o.params as Record<string, unknown>).url); urlsAsked.push(u); const p = Number(/\/p(\d+)\//.exec(u)?.[1] ?? 0); return tregResult(commentsPage(p, 4), 0.0009); };
    const r = await replay({
      request: "هات ٣ منشورات من ريديت عن الذكاء الاصطناعي مع تعليقين على كل منشور",
      planning: [], execution: () => [],
      answers: [tregResult(postsPage(0, 10, "t3_next"), 0.00188), comments, tregResult(postsPage(0, 10, "t3_next"), 0.00188), comments, comments, comments],
      deps: (base) => ({ ...base, plannerModel: m.model }),
    });
    expect(r.mission.status).toBe("completed");
    const plan = r.mission.plan!;
    expect(plan.stages.map((s) => [s.key, s.endpoint_id, s.planned_rows, s.parent_key])).toEqual([["posts", "scrapecreators.reddit.search.posts", 3, null], ["comments", "crawl4ai.reddit.post.comments", 6, "posts"]]);
    expect(plan.stages[1].engine!.parent_binding).toEqual({ param: "url", from: "link" });
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.counts("posts").accepted).toBe(3);
    expect(snap.counts("comments").accepted).toBe(6);
    expect(r.mission.delivered_units).toBe(9);
    // the planning probe of the comments used the MOST COMMENTED post's link (the newest may have none yet); execution read each chosen post's comments by its own link
    expect(urlsAsked).toEqual(["https://www.reddit.com/r/egypt/comments/p1/x/", "https://www.reddit.com/r/egypt/comments/p0/x/", "https://www.reddit.com/r/egypt/comments/p1/x/", "https://www.reddit.com/r/egypt/comments/p2/x/"]);
    assertReplayInvariants(r, { expectDelivered: 9, expectStatus: "completed" });
  });
});

describe("the model request and what the plan keeps for later steps", () => {
  it("the structured-output schema closes every object and drops the bounds the API does not support (claude-sonnet-5-5 accepts no forced tool call)", async () => {
    const { strictSchema } = await import("../agent/src/llmPlanner/model");
    const { UNDERSTAND_SCHEMA, TOOL_CHOICE_SCHEMA, FIELD_MAP_SCHEMA } = await import("../agent/src/llmPlanner/prompts");
    for (const schema of [UNDERSTAND_SCHEMA, TOOL_CHOICE_SCHEMA, FIELD_MAP_SCHEMA]) {
      const s = JSON.stringify(strictSchema(schema));
      expect(s).not.toMatch(/"minimum"|"maximum"|"minLength"|"null"/);
      const objects = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.flatMap(objects) : v && typeof v === "object" ? [...((v as Record<string, unknown>).type === "object" ? [v as Record<string, unknown>] : []), ...Object.values(v as Record<string, unknown>).flatMap(objects)] : []);
      for (const o of objects(strictSchema(schema))) expect(o.additionalProperties).toBe(false);
    }
  });

  it("the request sends structured output and no thinking, and reads the JSON answer; an API refusal is logged with its reason", async () => {
    const { anthropicPlannerModel } = await import("../agent/src/llmPlanner/model");
    const sent: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    const ok = anthropicPlannerModel("k", "claude-sonnet-5-5", { log: (l) => logs.push(l), fetchFn: async (_u, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => "", json: async () => ({ content: [{ type: "text", text: "{\"decision\":\"plan\"}" }], usage: { input_tokens: 1000, output_tokens: 100 }, stop_reason: "end_turn" }) }; } });
    const got = await ok({ system: "s", user: "u", tool: { name: "request_plan", description: "d", schema: { type: "object", properties: {} } }, maxTokens: 100 });
    expect(got?.input).toEqual({ decision: "plan" });
    expect(got!.costUsd).toBeCloseTo(0.003, 6);
    expect(sent[0]).toMatchObject({ thinking: { type: "between_tools" }, output_config: { format: { type: "json_schema" } } });
    expect(sent[0].tool_choice).toBeUndefined();
    const refused = anthropicPlannerModel("k", "claude-sonnet-5-5", { log: (l) => logs.push(l), fetchFn: async () => ({ ok: false, status: 400, text: async () => "{\"error\":{\"message\":\"bad schema\"}}", json: async () => ({}) }) });
    expect(await refused({ system: "s", user: "u", tool: { name: "tool_choice", description: "d", schema: {} }, maxTokens: 10 })).toBeNull();
    expect(logs.some((l) => /tool_choice status=400 .*bad schema/.test(l))).toBe(true);
  });

  it("an item's own identifiers (a place id, a short code, a handle) are kept for a later step, never as columns", async () => {
    const { carryFieldsOf } = await import("../agent/src/llmPlanner/planner");
    const items = [{ title: "مطعم", placeId: "ChIJ1", rating: 4.5, author: { username: "u1", bio: "x" }, shortcode: "Ab1" }];
    const carry = carryFieldsOf(items, { fields: { id: ["placeId"], text: ["title"] }, linkTemplate: null, extra: [] });
    expect(carry).toMatchObject({ c_placeId: ["placeId"], c_author_username: ["author", "username"], c_shortcode: ["shortcode"] });
    expect(carry.c_rating).toBeUndefined();
  });

  it("a condition the chosen tool cannot carry is said on the card before approval", async () => {
    const cands = candidatesFor(catalog, null, "x", "x.search.posts");
    const opts = checkOptions({ options: [{ ...CHOICE_X.options[0], conditions_not_carried: ["topic", "nonsense"] }] }, cands, false);
    expect(opts[0].notCarried).toEqual(["topic"]);
  });
});

describe("live findings, 15 Nov 2026 (first live missions of the planner)", () => {
  it("a child step is tried on the most commented parents first, at most three (live Facebook: the newest post, a reel minutes old, had no comment and every comments tool looked empty)", async () => {
    const { parentValuesOf, PARENTS_TRIED } = await import("../agent/src/llmPlanner/planner");
    const rows = [{ link: "a", comments_count: 0 }, { link: "b", comments_count: 40 }, { link: "c" }, { link: "d", comments_count: 7 }, { link: "" , comments_count: 99 }];
    expect(parentValuesOf(rows, "link")).toEqual(["b", "d", "a"]);
    expect(PARENTS_TRIED).toBe(3);
  });

  it("a step with a named source AND a topic also gets the platform's search tools (a search may carry both where the source's listing carries no topic)", () => {
    const plain = candidatesFor(catalog, null, "facebook", "facebook.user.posts");
    const both = candidatesFor(catalog, null, "facebook", "facebook.user.posts", 8, { alsoSearch: true });
    expect(plain.some((e) => e.capability === "facebook.search.posts")).toBe(false);
    expect(both.some((e) => e.capability === "facebook.search.posts")).toBe(true);
  });

  it("the model is told that a word with another common meaning goes only inside a phrase, and to add no restriction the customer did not ask for (live X: «شائعة» also means «common»; `lang:ar` hid most tweets)", async () => {
    const { UNDERSTAND_SYSTEM, TOOL_CHOICE_SYSTEM } = await import("../agent/src/llmPlanner/prompts");
    expect(UNDERSTAND_SYSTEM).toMatch(/another common meaning/);
    expect(TOOL_CHOICE_SYSTEM).toMatch(/Add no restriction the customer did not ask for/);
    // live retest: the model still put the bare word in the FIRST query; the rule now names every query
    expect(TOOL_CHOICE_SYSTEM).toMatch(/EVERY query, the first one included, uses only unambiguous terms/);
  });
});

describe("live finding: a TikTok file with links only (the item is big and nested)", () => {
  const item = { type: 1, aweme_info: { aweme_id: "7609673492950256917", desc: "فطار مصري على أصوله", create_time: 1772000000, author: { nickname: "علي محجوب", unique_id: "ali.mahgoub8", uid: "3048" }, statistics: { digg_count: 1200, comment_count: 54, share_count: 9, play_count: 30000 }, share_url: "https://www.tiktok.com/@ali.mahgoub8/video/7609673492950256917?_r=1&u_code=f026", music: { title: "x", author: "y", play_url: { uri: "z", url_list: ["a", "b"] } }, extra: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`k${i}`, `قيمة طويلة للحقل رقم ${i}`])) } };

  it("the model is shown every field as a path when the items are big (a cut JSON copy hid the caption and the author)", async () => {
    const { flatPathsOf, fieldMapPrompt } = await import("../agent/src/llmPlanner/planner");
    const lines = flatPathsOf([item]);
    expect(lines).toContain('["aweme_info","desc"] = فطار مصري على أصوله');
    expect(lines).toContain('["aweme_info","author","unique_id"] = ali.mahgoub8');
    expect(lines.some((l) => l.startsWith('["aweme_info","music","play_url","url_list","0"]'))).toBe(true);
    const prompt = fieldMapPrompt({ key: "videos", title_ar: "الفيديوهات", platform: "tiktok", capability: "tiktok.search.videos", parent: null, deliver: true, count: { total: 40, per_parent: null, all: false }, source: null, topic: "x", search_terms: [], period: null }, catalog.byId.get("tikhub.tiktok.search.videos")!, [item]);
    expect(prompt).toContain('["aweme_info","statistics","digg_count"] = 1200');
  });

  it("a thin map (id only) is filled from the common names inside the item's wrapping object; the share link loses its tracking query", async () => {
    const { enrichedMap, pseudoCard, runMap } = await import("../agent/src/llmPlanner/planner");
    const { cardMapCode } = await import("../src/lib/agentMission/foundation/toolCards/mapCode");
    const map = enrichedMap({ fields: { id: ["aweme_info", "aweme_id"] }, linkTemplate: null, extra: [] }, [item])!;
    expect(map.fields).toMatchObject({ text: ["aweme_info", "desc"], author: ["aweme_info", "author", "nickname"], username: ["aweme_info", "author", "unique_id"], likes: ["aweme_info", "statistics", "digg_count"], comments_count: ["aweme_info", "statistics", "comment_count"], views: ["aweme_info", "statistics", "play_count"], link: ["aweme_info", "share_url"] });
    const card = pseudoCard(catalog.byId.get("tikhub.tiktok.search.videos")!, "data.search_item_list", map, 1, {}, [item]);
    const rows = runMap(cardMapCode(card), { data: { search_item_list: [item] } });
    expect(rows[0]).toMatchObject({ id: "7609673492950256917", text: "فطار مصري على أصوله", username: "ali.mahgoub8", likes: 1200, link: "https://www.tiktok.com/@ali.mahgoub8/video/7609673492950256917" });
  });
});

describe("asked for 400, get 400: a topic search continues on the model's next tool", () => {
  it("the second tool is probed and mapped on its own real page, and execution reads it after the first tool's input sets", async () => {
    const choice = { options: [CHOICE_X.options[0], { endpoint_id: "tikhub.x.twitter-web-fetch-search-timeline", params_json: JSON.stringify({ keyword: "(الشائعات OR \"نفي شائعة\") from:SaudiMOH", search_type: "Latest" }), cursor_input: "cursor", more_params_json: [] }] };
    const otherPage = { data: { timeline: [{ rest_id: "77", legacy: { full_text: "نفي شائعة", created_at: "Mon Mar 04 10:00:00 +0000 2024" } }], next_cursor: "n2" } };
    const m = scriptedModel({ request_plan: [UNDERSTOOD_X], tool_choice: [choice], field_map: [MAP_X, { fields: { id: ["rest_id"], text: ["legacy", "full_text"] }, extra: [] }] });
    const pages = new Map<string, unknown>([["call_0001", xPage(0, 20, "c2")], ["call_0002", otherPage]]);
    let n = 0;
    const deps: LlmPlannerDeps = {
      model: m.model, catalog, access: null, today: "2026-11-15",
      probe: async () => { n += 1; return { ok: true, call_id: `call_000${n}`, http_status: 200, rows_in_page: n === 1 ? 20 : 1, has_more: true, next_cursor: "x", shape: null, first_rows: [], warnings: [], saved: "" }; },
      readPage: async (id) => pages.get(id) ?? null,
    };
    const r = await planWithLlm({ words: ["٥٠ تغريدة"], request: "" }, deps);
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    const alts = r.plan.stages[0].engine!.alternatives!;
    expect(alts.map((a) => a.endpoint_id)).toEqual(["anyapi.x.search.posts", "tikhub.x.twitter-web-fetch-search-timeline"]);
    const { runMap } = await import("../agent/src/llmPlanner/planner");
    expect(runMap(alts[1].map_code, otherPage)[0]).toMatchObject({ id: "77", text: "نفي شائعة" });
  });
});

describe("a small real sample is said before approval", () => {
  it("the source gave 2 and no next page for a request of 400: the card says the available amount is likely far below it", async () => {
    const m = scriptedModel({ request_plan: [{ ...UNDERSTOOD_X, steps: [{ ...UNDERSTOOD_X.steps[0], count: { total: 400, per_parent: null, all: false } }] }], tool_choice: [CHOICE_X], field_map: [MAP_X] });
    const deps: LlmPlannerDeps = {
      model: m.model, catalog, access: null, today: "2026-11-15",
      probe: async () => ({ ok: true, call_id: "call_0001", http_status: 200, rows_in_page: 2, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "" }),
      readPage: async () => xPage(0, 2, null),
    };
    const r = await planWithLlm({ words: ["٤٠٠ تغريدة"], request: "" }, deps);
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(r.plan.stages[0].planned_rows).toBe(400);
    expect(r.plan.notes_ar!.some((n) => /أعطت ٢ فقط/.test(n) && /أقل بكثير من ٤٠٠/.test(n))).toBe(true);
  });
});
