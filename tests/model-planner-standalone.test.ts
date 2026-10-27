import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_UNAVAILABLE_AR, runPlanner, type PlannerInput } from "../src/lib/modelPlanner/planner";
import { createAnthropicTransport, createScriptedTransport, type ContentBlock } from "../src/lib/modelPlanner/transport";
import { resetExplorationMemoryForTesting, runSampleCall } from "../src/lib/modelPlanner/exploration";
import { EXPLORATION_REQUEST_CAP_USD, MAX_PLANNER_TURNS, MODEL_PLAN_PARAM, MODEL_PLAN_SLUG } from "../src/lib/modelPlanner/constants";
import { runModelPlanChunk } from "../src/lib/modelPlanner/interpreter";
import { readStepRows } from "../src/lib/modelPlanner/reader";
import { loadMeasuredAvgCallUsd } from "../src/lib/modelPlanner/measured";
import { loadRecipeForEndpoint, saveRecipeAfterDelivery } from "../src/lib/modelPlanner/recipes";
import { unitCost } from "../src/lib/modelPlanner/pricing";
import { mapParamsToSibling, paramClass, rankSiblings } from "../src/lib/modelPlanner/siblings";
import { clearTregCatalogCache, loadTregCatalog } from "../src/lib/treg/catalog";
import { validatePlan } from "../src/lib/modelPlanner/validate";
import { revalidateStoredPlan } from "../src/lib/modelPlanner/editPlan";
import { ProposePlanSchema } from "../src/lib/modelPlanner/types";
import { toolCatalogSearch } from "../src/lib/modelPlanner/tools";
import type { ProviderAdapterCallInput } from "../src/lib/server/tregAdapter";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { createMemoryDb } from "./helpers/memoryDb";
import { describe as describeTool, propose, sample, search, say, use, stubGateway, type GatewayStub } from "./helpers/plannerKit";

const catalog = loadTregCatalog();
const nobody = { isAdmin: false, verifiedBusiness: false };
let gateway: GatewayStub | null = null;

beforeEach(() => {
  process.env.TREG_TOKEN = "test-token";
  resetExplorationMemoryForTesting();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { gateway?.restore(); gateway = null; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

type Step = ContentBlock[] | ((request: any) => ContentBlock[]);
const planNow = (script: Step[], customerText: string, over: Partial<PlannerInput> = {}) => {
  const transport = createScriptedTransport(script as any);
  const db = createMemoryDb();
  return runPlanner({ transport, customerMessages: [customerText], access: nobody, catalog, exploration: { client: db, requestId: "req1", userId: "u1" }, ...over }).then((out) => ({ out, transport, db }));
};
/** The last tool_result the model was shown, as an object (what the model reads back). */
const lastResult = (request: any): any => {
  const msgs = request.messages;
  const blocks = msgs[msgs.length - 1].content as ContentBlock[];
  const r = blocks.filter((b) => b.type === "tool_result").pop() as any;
  try { return JSON.parse(r.content); } catch { return r.content; }
};

const columnsFor = (fields: string[]) => fields.map((f) => ({ field: f, headerAr: `عمود ${f}` }));

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("PRODUCTION CONDITION: the catalog is read the way the deployed bundle reads it", () => {
  it("the loader needs only the two traced files under data/treg of the working directory: with only them in a fresh directory the catalog loads and the search tool answers", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bundle-"));
    mkdirSync(path.join(dir, "data", "treg"), { recursive: true });
    for (const f of ["treg_catalog_sellable.json", "treg_write_actions.json"]) copyFileSync(path.join(process.cwd(), "data", "treg", f), path.join(dir, "data", "treg", f));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
    clearTregCatalogCache();
    try {
      const loaded = loadTregCatalog();
      expect(loaded.endpoints.length).toBeGreaterThan(3000);
      const hits = toolCatalogSearch({ platform: "x", words: ["user", "posts"] }, nobody, loaded).hits;
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]).toHaveProperty("inputs");
    } finally { cwd.mockRestore(); clearTregCatalogCache(); }
  });

  it("every route that loads the catalog at run time declares it for file tracing (the chat, the plan edit, the admin lookup and the admin planner self-test), so no route reads a file the bundle does not hold", () => {
    const config = readFileSync("next.config.mjs", "utf-8");
    for (const route of ["/api/chat", "/api/chat/edit-plan", "/api/admin/reverse-lookup", "/api/admin/planner-selftest"]) {
      const line = config.split("\n").find((l) => l.includes(`"${route}":`));
      expect(line, route).toBeTruthy();
      expect(line, route).toContain("treg_catalog_sellable.json");
      expect(line, route).toContain("treg_write_actions.json");
    }
  });
});

describe("PRODUCTION CONDITION: the provider's real tool-use response shape", () => {
  const reply = (content: unknown[], stop_reason: string) => ({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content, stop_reason, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 90, cache_read_input_tokens: 3000, cache_creation_input_tokens: 400, service_tier: "standard" } });

  it("the transport sends the request the provider expects and reads a reply that has text AND several tool_use blocks, the stop reason and the cached-token usage", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-not-real");
    const sent: any[] = [];
    const fetchFn = vi.fn(async (_url: any, init: any) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify(reply([
      { type: "text", text: "أبحث في الفهرس" },
      { type: "tool_use", id: "toolu_01A", name: "catalog_search", input: { platform: "x", words: ["user", "posts"] } },
      { type: "tool_use", id: "toolu_01B", name: "catalog_search", input: { platform: "twitter", words: ["posts"] } },
    ], "tool_use")), { status: 200 }); });
    const transport = createAnthropicTransport({ fetchFn: fetchFn as any });
    const res = await transport.send({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [{ name: "a", description: "d", input_schema: { type: "object" } }, { name: "b", description: "d", input_schema: { type: "object" } }], timeoutMs: 5000 });
    expect(res.stopReason).toBe("tool_use");
    expect(res.content.map((b) => b.type)).toEqual(["text", "tool_use", "tool_use"]);
    expect(res.usage).toEqual({ inputTokens: 1200, outputTokens: 90, cacheReadTokens: 3000, cacheWriteTokens: 400 });
    expect(sent[0]).toMatchObject({ model: "claude-haiku-5-5", tool_choice: { type: "auto" }, max_tokens: 2048 });
    expect(sent[0].tools[1].cache_control).toEqual({ type: "ephemeral" });
    expect(sent[0].system[0]).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });
  });

  it("a turn with several tool_use blocks is answered with ONE user message that holds a tool_result for each id, in order; text before the tool calls is kept", async () => {
    const two = [say("سأبحث وأصف"), use("catalog_search", { platform: "x", words: ["user", "posts"] }), use("describe_endpoint", { id: "anyapi.x.user.posts" })];
    const { out, transport } = await planNow([two, [say("ما اسم الحساب الذي تريده؟")]], "اكس");
    expect(out).toMatchObject({ kind: "message", reason: "clarification", turns: 2, toolCalls: 2 });
    const second = transport.requests[1].messages;
    expect(second[1].role).toBe("assistant");
    expect((second[1].content as ContentBlock[]).map((b) => b.type)).toEqual(["text", "tool_use", "tool_use"]);
    const results = second[2].content as any[];
    expect(results.map((r) => r.type)).toEqual(["tool_result", "tool_result"]);
    expect(results.map((r) => r.tool_use_id)).toEqual((second[1].content as any[]).filter((b) => b.type === "tool_use").map((b) => b.id));
    expect(out.stopReasons).toEqual(["tool_use", "end_turn"]);
  });

  it("a reply cut at max_tokens in the middle of a tool call (bad input) is answered with an error result the model can fix, not a crash", async () => {
    const cut = [use("sample_call", { id: "anyapi.x.user.posts", params: "not-a-list" })];
    const { out, transport } = await planNow([cut, [say("ما اسم الحساب الذي تريده؟")]], "اكس");
    expect(out.kind).toBe("message");
    expect(String((transport.requests[1].messages[2].content as any[])[0].content)).toContain("invalid sample_call input");
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("ONE READER: a single-object answer (the natgeo profile) is ONE row, read the same way by the sample and by the worker", () => {
  const profile = { username: "natgeo", full_name: "National Geographic", user_id: "787132", followers: 268273892, following: 142, posts: 29810, is_verified: true, is_private: false, biography: "Experience the world." };
  const plan = (over: Record<string, unknown> = {}) => ({
    summaryAr: "بيانات حساب انستقرام natgeo",
    topic: "بيانات حساب انستقرام natgeo",
    steps: [{ endpointId: "crawl4ai.instagram.user.profile", volume: 1, params: [{ name: "username", value: "natgeo", source: "customer_text", quote: "@natgeo" }], fieldMap: { columns: [{ field: "username", headerAr: "اسم المستخدم", role: "author_handle" }, { field: "full_name", headerAr: "الاسم الكامل", role: "author_name" }, { field: "followers", headerAr: "عدد المتابعين", role: "followers", transform: "number" }, { field: "is_verified", headerAr: "موثّق", transform: "bool" }], pagination: { kind: "single" } }, filters: [] }],
    ...over,
  });
  const callWith = (body: unknown) => async (_o: TregCallOptions): Promise<TregCallResult> => ({ ok: true, httpStatus: 200, tregCallId: "t", costMicro: 900, latencyMs: 5, data: body, isRouteMaxCost: false, isPlatformBalanceLow: false });
  const request = "هات بيانات حساب انستقرام @natgeo";
  const script = [search("instagram", ["user", "profile"]), sample("crawl4ai.instagram.user.profile", [{ name: "username", value: "natgeo", source: "customer_text", quote: "@natgeo" }]), propose(plan())];

  it("the catalog's list path for this endpoint is WRONG («rows») and the live answer is a bare object: the sample still reads one row, and the plan is priced per object (one call, one row)", async () => {
    expect(catalog.byId.get("crawl4ai.instagram.user.profile")!.list_path).toBe("rows");
    const { out } = await planNow(script, request, { exploration: { client: createMemoryDb(), requestId: "r1", userId: "u1", call: callWith(profile) } });
    expect(out.kind).toBe("plan");
    if (out.kind !== "plan") return;
    expect(out.plan.steps[0].price).toMatchObject({ rowsPerCall: 1, passRate: 1, measuredFrom: "sample" });
    expect(out.plan.sampleRows).toHaveLength(1);
    expect(out.plan.sampleRows[0]).toMatchObject({ username: "natgeo", followers_count: 268273892 });
    // 0.0009 USD per object x 5500 = 4.95 points per record (the price the customer saw in production)
    expect(out.plan.price.unitPricePoints).toBe(4.95);
  });

  it("the worker reads the SAME answer with the SAME hints and delivers the row (production delivered zero), and a topic review that would hold every row is not attached to a lookup of one named thing", async () => {
    const { out } = await planNow(script, request, { exploration: { client: createMemoryDb(), requestId: "r1", userId: "u1", call: callWith(profile) } });
    if (out.kind !== "plan") throw new Error("no plan");
    expect(out.plan.stored.topic).toBeUndefined(); // «the model said topic = the account»: a lookup has no subject to review
    expect(out.plan.stored.steps[0].facts).toMatchObject({ listPath: null, rootObjectIsRow: true });
    const input = { jobId: "j", userId: "u", step: 0, endpointId: "crawl4ai.instagram.user.profile", capabilitySlug: MODEL_PLAN_SLUG, method: "POST", params: { [MODEL_PLAN_PARAM]: out.plan.stored }, paginationStrategy: "cursor", cursor: null, pageSize: 1, remainingNeeded: 1, targetVolumeMax: 1, deliveredSoFar: 0 } as ProviderAdapterCallInput;
    const rejectEverything = vi.fn(async () => ({ verdicts: new Map(), usage: null, failure: "bad_reply" as const }));
    const chunk = await runModelPlanChunk(input, { call: callWith(profile), advisor: rejectEverything as any });
    expect(chunk.ok).toBe(true);
    expect(chunk.rows).toEqual([{ username: "natgeo", author_name: "National Geographic", followers_count: 268273892, "موثّق": true }]);
    expect(rejectEverything).not.toHaveBeenCalled();
  });

  it("the sample and the worker agree on every shape the reader meets: a list under the catalog's path, the answer itself, an object under data, and a wrapper that is not a record", async () => {
    const shapes: Array<[string, unknown, number]> = [["a bare object", profile, 1], ["rows list", { rows: [profile], meta: { cached: true } }, 1], ["object under data", { data: profile }, 1], ["an error body", { status: "error", message: "bad" }, 0], ["an empty list", { rows: [] }, 0]];
    for (const [label, body, count] of shapes) {
      const first = await planNow(script, request, { exploration: { client: createMemoryDb(), requestId: `s${label}`, userId: "u", call: callWith(body) } });
      if (count === 0) { expect(first.out.kind, label).not.toBe("plan"); continue; }
      expect(first.out.kind, label).toBe("plan");
      if (first.out.kind !== "plan") continue;
      expect(readStepRows(body, first.out.plan.stored.steps[0].facts).rows.length, label).toBe(count);
    }
  });

  it("an EDIT of the approved plan keeps the way its answer is read (no new sample is made): the single-object reading survives the new volume and the new price", async () => {
    const { out } = await planNow(script, request, { exploration: { client: createMemoryDb(), requestId: "r1", userId: "u1", call: callWith(profile) } });
    if (out.kind !== "plan") throw new Error("no plan");
    const verdict = revalidateStoredPlan({ stored: out.plan.stored, summaryAr: out.plan.summaryAr, customerText: request, newVolume: 3, access: nobody, catalog });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.plan.stored.steps[0].facts).toMatchObject({ listPath: null, rootObjectIsRow: true });
    expect(verdict.plan.price.unitPricePoints).toBe(out.plan.price.unitPricePoints);
    expect(readStepRows(profile, verdict.plan.stored.steps[0].facts).rows).toHaveLength(1);
  });

  it("a plan whose facts would make the worker read fewer rows than the sample did is refused with the reason (reader_mismatch), never stored", () => {
    const row = { username: "natgeo", full_name: "National Geographic", followers: 1, is_verified: true };
    const digest = { rowsInSample: 2, listPath: "rows", listStrategy: "list_path" as const, nextCursorPath: null, cursorKind: null, hasMore: null, fields: [], sampleRows: [row], warnings: [] };
    const samples = new Map([["crawl4ai.instagram.user.profile", { endpointId: "crawl4ai.instagram.user.profile", rows: [row, row], digest, costUsd: 0.0009, body: { nothing: "here" } }]]);
    const verdict = validatePlan(ProposePlanSchema.parse(plan()), { customerText: request, access: nobody, catalog, samples, today: new Date("2026-10-27T12:00:00Z") });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.issues.map((i) => i.code)).toContain("reader_mismatch");
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("PROVIDER ALTERNATIVES at planning time: a failing, empty, slow or over-budget endpoint is replaced by its catalog siblings, cheapest and most reliable first, in the same budget", () => {
  const xParams = [{ name: "handle", value: "elonmusk", source: "customer_text" as const, quote: "@elonmusk" }];
  const xRequest = "هات ١٠ بوستات من حساب @elonmusk على أكس";
  const tweet = (i: number) => ({ text: `post ${i}`, created_at: "Mon Oct 26 10:00:00 +0000 2026", favorite_count: i, id_str: `${i}`, screen_name: "elonmusk" });
  const ctx = () => ({ customerText: xRequest, access: nobody, catalog, samples: new Map(), stats: { madeCalls: 0 } });
  const deps = (db: any, over: Record<string, unknown> = {}) => ({ client: db, requestId: "req1", userId: "u1", ...over });

  it("the siblings are ranked by cost, then observed success, a slow endpoint after the others, a routed wrapper last; parameters are mapped by what they ARE (handle, username, screen_name), a customer value is never dropped", () => {
    const e = catalog.byId.get("anyapi.x.user.posts")!;
    const ranked = rankSiblings(e, catalog, nobody, { pageRows: 1 }).map((c) => c.endpoint.id);
    expect(ranked.at(-1)).toBe("treg.x.user.posts");
    expect(ranked.indexOf("crawl4ai.x.user.posts")).toBeGreaterThan(ranked.indexOf("anyapi.x.user.posts.timeline")); // 13 s median: tried after the faster ones
    expect(paramClass("screen_name")).toBe("account");
    expect(paramClass("username")).toBe("account");
    expect(paramClass("aweme_id")).toBe("id:aweme");
    const mapped = (id: string) => mapParamsToSibling(xParams, catalog.byId.get(id)!);
    expect(mapped("tikhub.x.user.posts")).toMatchObject({ ok: true, params: [{ name: "screen_name", value: "elonmusk" }] });
    expect(mapped("crawl4ai.x.user.posts")).toMatchObject({ ok: true, params: [{ name: "username", value: "elonmusk" }] });
    expect(mapped("justoneapi.x.twitter-get-user-posts-v1")).toMatchObject({ ok: false }); // it needs a numeric id the customer did not give: nothing invented
  });

  it("an endpoint that answers HTTP 500 is replaced by a sibling that answers: the model is told which endpoint served, with its parameter names, the attempts are listed without a price, and both calls are recorded", async () => {
    gateway = stubGateway({
      "anyapi.x.user.posts": new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "x-treg-cost-micro": "0" } }),
      "anyapi.x.user.posts.timeline": { output: { data: { tweets: Array.from({ length: 5 }, (_, i) => ({ text: `post ${i}`, createdUtc: 1790000000 + i, likes: i, authorHandle: "elonmusk", isReply: false })) } } },
    }, { "anyapi.x.user.posts.timeline": 750 });
    const db = createMemoryDb();
    const out = await runSampleCall({ id: "anyapi.x.user.posts", params: xParams }, ctx(), deps(db));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.note.endpointUsed).toBe("anyapi.x.user.posts.timeline");
    expect(out.note.paramsUsed).toEqual([{ name: "handle", value: "elonmusk" }]);
    expect(out.note.attempts.map((a) => [a.endpointId, a.outcome])).toEqual([["anyapi.x.user.posts", "http_error"], ["anyapi.x.user.posts.timeline", "ok"]]);
    const rows = db.rows("exploration_calls");
    expect(rows.map((r: any) => [r.endpoint_id, r.http_status, r.refused_reason?.split(":")[0] ?? null])).toEqual([["anyapi.x.user.posts", 500, "http_error"], ["anyapi.x.user.posts.timeline", 200, null]]);
    expect(out.sample.endpointId).toBe("anyapi.x.user.posts.timeline");
  });

  it("through the planner: the model asked for the failing endpoint, reads «endpointUsed», plans with the sibling and its own parameter names, and the plan validates and is priced from the sibling's real sample", async () => {
    gateway = stubGateway({
      "anyapi.x.user.posts": new Response("oops", { status: 502, headers: { "x-treg-cost-micro": "0" } }),
      "anyapi.x.user.posts.timeline": { output: { data: { tweets: Array.from({ length: 8 }, (_, i) => ({ text: `post ${i}`, createdUtc: 1790000000 + i, likes: i, authorHandle: "elonmusk", isReply: false })) } } },
    }, { "anyapi.x.user.posts.timeline": 750 });
    const proposal = (req: any) => {
      const r = lastResult(req);
      const used = r.endpointUsed as string;
      const handle = (r.paramsUsed as any[])[0];
      return propose({ summaryAr: "جمع ١٠ منشورات من حساب @elonmusk", steps: [{ endpointId: used, volume: 10, params: [{ name: handle.name, value: handle.value, source: "customer_text", quote: "@elonmusk" }], fieldMap: { columns: [{ field: "text", headerAr: "نص", role: "text" }, { field: "likes", headerAr: "الإعجابات", transform: "number" }], pagination: { kind: "single" } }, filters: [] }] });
    };
    const { out, transport } = await planNow([search("x", ["user", "posts"]), sample("anyapi.x.user.posts", xParams), proposal], xRequest);
    expect(out.kind).toBe("plan");
    if (out.kind !== "plan") return;
    expect(out.plan.steps[0].step.endpointId).toBe("anyapi.x.user.posts.timeline");
    expect(out.plan.steps[0].price).toMatchObject({ rowsPerCall: 8, measuredFrom: "sample" });
    expect(out.attempts.map((a) => a.outcome)).toEqual(["http_error", "ok"]);
    const sampleResult = lastResultOf(transport.requests[2]);
    expect(sampleResult.note).toContain("anyapi.x.user.posts.timeline");
    expect(JSON.stringify(sampleResult)).not.toMatch(/USD|costUsd|costMicro/); // the sample's answer carries no price
  });

  it("a call that TIMES OUT counts as a failure and the next sibling is tried; a call that answers with NO rows does the same", async () => {
    const calls: string[] = [];
    const call = async (o: TregCallOptions): Promise<TregCallResult> => {
      calls.push(o.endpointId);
      if (o.endpointId === "anyapi.x.user.posts") return { ok: false, httpStatus: 503, tregCallId: "", costMicro: 0, latencyMs: 12000, data: null, error: "network_failure", timedOut: true, isRouteMaxCost: false, isPlatformBalanceLow: false };
      if (o.endpointId === "anyapi.x.user.posts.timeline") return { ok: true, httpStatus: 200, tregCallId: "t", costMicro: 750, latencyMs: 10, data: { output: { data: { tweets: [] } } }, isRouteMaxCost: false, isPlatformBalanceLow: false };
      return { ok: true, httpStatus: 200, tregCallId: "t", costMicro: 1000, latencyMs: 10, data: { data: { timeline: [tweet(1), tweet(2)] } }, isRouteMaxCost: false, isPlatformBalanceLow: false };
    };
    const db = createMemoryDb();
    const out = await runSampleCall({ id: "anyapi.x.user.posts", params: xParams }, ctx(), deps(db, { call }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.note.attempts.map((a) => [a.endpointId, a.outcome])).toEqual([["anyapi.x.user.posts", "timeout"], ["anyapi.x.user.posts.timeline", "empty"], ["tikhub.x.user.posts", "ok"]]);
    expect(calls).toEqual(["anyapi.x.user.posts", "anyapi.x.user.posts.timeline", "tikhub.x.user.posts"]);
  });

  it("an endpoint too dear for the per-request exploration budget (0.05 USD) is NOT called; without a sibling the model is told which of ITS OWN searched candidates fit, and the next turn samples one of them (Facebook keyword posts)", async () => {
    gateway = stubGateway({ "justoneapi.x.facebook-search-post-v1": { data: { posts: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, text: `منشور ${i}`, author: "page", created_at: 1790000000 + i })) } } }, { "justoneapi.x.facebook-search-post-v1": 29520 });
    const customer = "هات ٥ بوستات عن الترندات الصحية على فيسبوك في مصر";
    const script: Step[] = [
      search("facebook", ["search", "posts"]),
      sample("anyapi.facebook.search_posts", [{ name: "query", value: "الصحة", source: "derived", quote: "الصحية" }]),
      sample("justoneapi.x.facebook-search-post-v1", [{ name: "keyword", value: "الصحة", source: "derived", quote: "الصحية" }]),
      [say("هل تريد ملف إكسل؟")],
    ];
    const { out, transport, db } = await planNow(script, customer);
    expect(out.attempts.map((a) => [a.endpointId, a.outcome])).toEqual([["anyapi.facebook.search_posts", "over_budget"], ["justoneapi.x.facebook-search-post-v1", "ok"]]);
    expect(gateway.calls.map((c) => c.endpointId)).toEqual(["justoneapi.x.facebook-search-post-v1"]); // nothing was sent to the dear one
    const refusal = lastResultOf(transport.requests[2]);
    expect(String(refusal)).toContain("justoneapi.x.facebook-search-post-v1"); // the model is shown a candidate that fits
    expect(db.rows("exploration_calls").some((r: any) => r.endpoint_id === "anyapi.facebook.search_posts" && /over_budget/.test(r.refused_reason))).toBe(true);
    expect(0.0295 < EXPLORATION_REQUEST_CAP_USD).toBe(true);
  });

  it("a sample the model asked for with a WRONG value (not the customer's) costs no real call and does not use up the calls a request may make: three bad tries, then a good one still reaches the source", async () => {
    gateway = stubGateway({ "anyapi.x.user.posts": { output: { data: { tweets: [tweet(1)] } } } });
    const bad = sample("anyapi.x.user.posts", [{ name: "handle", value: "invented", source: "customer_text", quote: "@someoneelse" }]);
    const { out } = await planNow([bad, bad, bad, sample("anyapi.x.user.posts", xParams), [say("هل تريد ملف إكسل؟")]], xRequest);
    expect(out.sampleCalls).toBe(4);
    expect(gateway.calls).toHaveLength(1);
  });
});

describe("PRODUCTION REQUEST: TikTok comments about a topic (two stages: videos of the topic, then the comments of each video) when the comments endpoint fails and its sibling answers", () => {
  const request = "هات ٣٠ تعليق تيك توك عن كرة السلة في مصر";
  const videos = { data: { search_item_list: Array.from({ length: 6 }, (_, i) => ({ aweme_info: { aweme_id: `76${i}0001`, desc: `basketball ${i}` } })), cursor: 6 } };
  const comments = { data: { comments: Array.from({ length: 8 }, (_, i) => ({ cid: `c${i}`, text: `تعليق ${i}`, digg_count: i, create_time: 1790000000 + i })), cursor: 8 } };

  it("the second sample takes the video id from the first sample's REAL rows, the failing comments endpoint is replaced by its sibling, and the two-step plan validates and is priced", async () => {
    gateway = stubGateway({
      "tikhub.tiktok.search.videos": videos,
      "tikhub.tiktok.video.comments": new Response("x", { status: 500, headers: { "x-treg-cost-micro": "0" } }),
      "tikhub.x.tiktok-app-v3-fetch-video-comments": comments,
    }, { "tikhub.tiktok.search.videos": 1000, "tikhub.x.tiktok-app-v3-fetch-video-comments": 1000 });
    const step2 = (req: any) => {
      const r = lastResult(req);
      return propose({
        summaryAr: "جمع ٣٠ تعليقًا على مقاطع تيك توك عن كرة السلة", topic: "كرة السلة",
        steps: [
          { endpointId: "tikhub.tiktok.search.videos", volume: 6, params: [{ name: "keyword", value: "basketball", source: "derived", quote: "كرة السلة" }], fieldMap: { rowsPath: "data.search_item_list", columns: [{ field: "aweme_info.aweme_id", headerAr: "معرف المقطع", role: "id" }, { field: "aweme_info.desc", headerAr: "وصف المقطع", role: "title" }], pagination: { kind: "single" } }, filters: [] },
          { endpointId: r.endpointUsed, volume: 30, perItem: 5, params: [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: "aweme_info.aweme_id" } }], fieldMap: { columns: [{ field: "text", headerAr: "نص التعليق", role: "text" }, { field: "digg_count", headerAr: "الإعجابات", role: "likes", transform: "number" }], pagination: { kind: "single" } }, filters: [] },
        ],
      });
    };
    const { out, transport } = await planNow([
      search("tiktok", ["search", "videos"]),
      sample("tikhub.tiktok.search.videos", [{ name: "keyword", value: "basketball", source: "derived", quote: "كرة السلة" }]),
      sample("tikhub.tiktok.video.comments", [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: "aweme_info.aweme_id" } }]),
      step2,
    ], request);
    expect(out.kind).toBe("plan");
    if (out.kind !== "plan") return;
    expect(out.attempts.map((a) => [a.endpointId, a.outcome])).toEqual([["tikhub.tiktok.search.videos", "ok"], ["tikhub.tiktok.video.comments", "http_error"], ["tikhub.x.tiktok-app-v3-fetch-video-comments", "ok"]]);
    expect(gateway.calls.map((c) => c.endpointId)).toEqual(["tikhub.tiktok.search.videos", "tikhub.tiktok.video.comments", "tikhub.x.tiktok-app-v3-fetch-video-comments"]);
    expect(gateway.calls[1].body).toMatchObject({ aweme_id: "7600001" }); // a value from the first sample's rows, not invented
    expect(out.plan.steps).toHaveLength(2);
    expect(out.plan.steps[1].step.endpointId).toBe("tikhub.x.tiktok-app-v3-fetch-video-comments");
    expect(out.plan.price.unitPricePoints).toBeGreaterThan(0);
    expect(out.plan.stored.topic).toBe("كرة السلة"); // many rows ABOUT a subject: the topic review stays
    expect(String(lastResult(transport.requests[3]).note)).toContain("tikhub.x.tiktok-app-v3-fetch-video-comments");
  });
});

function lastResultOf(request: any): any { return lastResult(request); }

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("PROVIDER ALTERNATIVES at run time: a failed call tries the plan's siblings under the approved per-call ceiling; the price never changes", () => {
  const facts = { method: "POST" as const, scope: "any_account", limitName: "limit", limitMax: 100, listPath: "rows", cursorPath: null, itemFields: null, callEstimateUsd: 0.001 };
  const alt = (over: Record<string, unknown> = {}) => ({ endpointId: "tikhub.x.user.posts", method: "GET" as const, scope: "any_account", params: [{ name: "screen_name", value: "elonmusk", source: "customer_text" as const, quote: "@elonmusk" }], listPath: "data.timeline", cursorPath: null, itemFields: null, limitName: null, limitMax: null, callEstimateUsd: 0.001, ...over });
  const plan = (alternates: unknown[]) => ({
    v: 1, measured: [{ rowsPerCall: 10, passRate: 1, costPerCallUsd: 0.001 }],
    steps: [{ endpointId: "anyapi.x.user.posts", volume: 10, params: [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }], fieldMap: { columns: [{ field: "text", headerAr: "نص", role: "text" }, { field: "id", headerAr: "المعرف", role: "id" }], pagination: { kind: "single" } }, filters: [], facts: { ...facts, alternates } }],
  });
  const input = (p: any): ProviderAdapterCallInput => ({ jobId: "j", userId: "u", step: 0, endpointId: "anyapi.x.user.posts", capabilitySlug: MODEL_PLAN_SLUG, method: "POST", params: { [MODEL_PLAN_PARAM]: p }, paginationStrategy: "cursor", cursor: null, pageSize: 10, remainingNeeded: 10, targetVolumeMax: 10, deliveredSoFar: 0 });
  const res = (ok: boolean, data: any, httpStatus = 200, costMicro = 0): TregCallResult => ({ ok, httpStatus, tregCallId: "c", costMicro, latencyMs: 1, data, error: ok ? undefined : `http_${httpStatus}`, isRouteMaxCost: false, isPlatformBalanceLow: false });
  const posts = Array.from({ length: 4 }, (_, i) => ({ text: `t${i}`, id: `i${i}` }));

  it("the primary fails (HTTP 500): the sibling is called with its own parameter name, the approved field map reads its rows, and the cost of both calls is reported", async () => {
    const seen: TregCallOptions[] = [];
    const call = async (o: TregCallOptions) => { seen.push(o); return o.endpointId === "anyapi.x.user.posts" ? res(false, null, 500, 0) : res(true, { data: { timeline: posts } }, 200, 1000); };
    const out = await runModelPlanChunk(input(plan([alt()])), { call });
    expect(out.ok).toBe(true);
    expect(out.rows).toHaveLength(4);
    expect(seen.map((o) => o.endpointId)).toEqual(["anyapi.x.user.posts", "tikhub.x.user.posts"]);
    expect(seen[1].params).toEqual({ screen_name: "elonmusk" });
    expect(seen[1].method).toBe("GET");
    expect(out.costMicro).toBe(1000);
    expect(out.providerCallCount).toBe(2);
    expect(out.nextCursor).toBeNull();
  });

  it("the primary answers NOTHING on the first page: the sibling is tried; a sibling dearer than the approved per-call ceiling is never called; a refusal (a budget stop) is never retried elsewhere", async () => {
    const seen: string[] = [];
    const call = async (o: TregCallOptions) => { seen.push(o.endpointId); return o.endpointId === "anyapi.x.user.posts" ? res(true, { rows: [] }) : res(true, { data: { timeline: posts } }, 200, 1000); };
    const dear = alt({ endpointId: "scrapecreators.x.user.posts", callEstimateUsd: 0.00188 });
    const out = await runModelPlanChunk(input(plan([dear, alt()])), { call });
    expect(out.rows).toHaveLength(4);
    expect(seen).toEqual(["anyapi.x.user.posts", "tikhub.x.user.posts"]);
    const stopped = vi.fn(async (o: TregCallOptions): Promise<TregCallResult> => ({ ...res(false, null, 0), budgetStopped: true, error: "job_budget" }));
    const refused = await runModelPlanChunk(input(plan([alt()])), { call: stopped });
    expect(refused.ok).toBe(false);
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it("a sibling whose rows the approved field map cannot read is not accepted: the job fails with the full release instead of delivering empty cells", async () => {
    const call = async (o: TregCallOptions) => (o.endpointId === "anyapi.x.user.posts" ? res(false, null, 500) : res(true, { data: { timeline: [{ other: 1 }, { other: 2 }] } }));
    const out = await runModelPlanChunk(input(plan([alt()])), { call });
    expect(out.ok).toBe(false);
    expect(out.errorMessageAr).toContain("تعذر الحصول على البيانات");
  });

  it("the plan stored at approval carries the siblings it may fall back to (none dearer per call than the step's own ceiling) and the charge stays ceil(delivered x unit)", async () => {
    gateway = stubGateway({ "anyapi.x.user.posts": { rows: Array.from({ length: 10 }, (_, i) => ({ text: `p${i}`, likes: i })) } }, { "anyapi.x.user.posts": 450 });
    const proposal = propose({ summaryAr: "جمع ١٠ منشورات", steps: [{ endpointId: "anyapi.x.user.posts", volume: 10, params: [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }], fieldMap: { rowsPath: "rows", columns: columnsFor(["text", "likes"]), pagination: { kind: "single" } }, filters: [] }] });
    const { out } = await planNow([sample("anyapi.x.user.posts", [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }]), proposal], "هات ١٠ بوستات من حساب @elonmusk على أكس");
    expect(out.kind).toBe("plan");
    if (out.kind !== "plan") return;
    const alternates = out.plan.stored.steps[0].facts.alternates ?? [];
    expect(alternates.length).toBeGreaterThan(0);
    expect(alternates.length).toBeLessThanOrEqual(2);
    for (const a of alternates) expect(a.callEstimateUsd).toBeLessThanOrEqual(out.plan.stored.steps[0].facts.callEstimateUsd + 1e-12);
    expect(alternates.every((a) => a.endpointId !== "anyapi.x.user.posts")).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("MODEL LOOP ROBUSTNESS: every refusal goes back with its exact reason until the turns run out; a refusal of the model's own is sent back while candidates remain; one refusal sentence", () => {
  const badThenGood = (n: number): Step[] => {
    const wrong = (i: number) => propose({ summaryAr: "جمع منشورات", steps: [{ endpointId: "anyapi.x.user.posts", volume: 10, params: [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }], fieldMap: { rowsPath: "rows", columns: columnsFor([`nofield${i}`]), pagination: { kind: "single" } }, filters: [] }] });
    const good = propose({ summaryAr: "جمع ١٠ منشورات", steps: [{ endpointId: "anyapi.x.user.posts", volume: 10, params: [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }], fieldMap: { rowsPath: "rows", columns: columnsFor(["text"]), pagination: { kind: "single" } }, filters: [] }] });
    return [sample("anyapi.x.user.posts", [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }]), ...Array.from({ length: n }, (_, i) => wrong(i)), good];
  };
  const xRows = { rows: Array.from({ length: 6 }, (_, i) => ({ text: `p${i}` })) };
  const customer = "هات ١٠ بوستات من حساب @elonmusk على أكس";

  it("three refusals in a row (the old limit was two) are each answered with the exact reason, and the fourth proposal is accepted", async () => {
    gateway = stubGateway({ "anyapi.x.user.posts": xRows });
    const { out, transport } = await planNow(badThenGood(3), customer);
    expect(out.kind).toBe("plan");
    expect(out.turns).toBe(5);
    expect(out.failures).toHaveLength(3);
    for (const i of [2, 3, 4]) expect(String(lastResultOf(transport.requests[i]))).toContain("no row has a value at «nofield");
  });

  it("the turn limit is six: with refusals to the end the customer gets ONE sentence, and the loop never runs a seventh turn", async () => {
    expect(MAX_PLANNER_TURNS).toBe(6);
    gateway = stubGateway({ "anyapi.x.user.posts": xRows });
    const { out, transport } = await planNow(badThenGood(9), customer);
    expect(out).toMatchObject({ kind: "message", reason: "unavailable", messageAr: PLAN_UNAVAILABLE_AR, turns: 6 });
    expect(transport.requests).toHaveLength(6);
    expect(PLAN_UNAVAILABLE_AR).toBe("هذه الخدمة غير متاحة حاليًا، ولم يُحجز أي رصيد.");
    expect(String(lastResultOf(transport.requests[5]))).toContain("ONE turn left");
  });

  it("a model that says «غير متاح حاليًا» right after a search that found candidates is sent back to try them (twice at most); only then the one sentence is said, whatever wording the model used", async () => {
    const give = [say("غير متاح حاليًا")];
    const { out, transport } = await planNow([search("x", ["user", "posts"]), give, give, give], customer);
    expect(out).toMatchObject({ kind: "message", reason: "unavailable", messageAr: PLAN_UNAVAILABLE_AR, turns: 4 });
    const pushed = (transport.requests[2].messages.at(-1)!.content as string);
    expect(pushed).toContain("Do not give up yet");
    expect(pushed).toContain("Untried candidates");
    // a QUESTION is never sent back: the customer left a value out
    const asked = await planNow([search("x", ["user", "posts"]), [say("ما اسم الحساب؟")]], "٥٠ تغريدة");
    expect(asked.out).toMatchObject({ kind: "message", reason: "clarification", messageAr: "ما اسم الحساب؟", turns: 2 });
  });

  it("a model reply that cannot be shown to a customer (Latin words, a provider) becomes the same one sentence, never the raw text", async () => {
    const { out } = await planNow([[say("The service tikhub is down, sorry")]], customer);
    expect(out).toMatchObject({ kind: "message", messageAr: PLAN_UNAVAILABLE_AR });
  });

  it("the turn's own time is respected: with no time left no model call is made and the sentence is the same", async () => {
    const { out, transport } = await planNow([search("x", ["user", "posts"])], customer, { deadlineAtMs: Date.now() + 1000 });
    expect(transport.requests).toHaveLength(0);
    expect(out).toMatchObject({ kind: "message", reason: "no_model", messageAr: PLAN_UNAVAILABLE_AR });
    expect(out.endReason).toMatch(/no time left/);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("PRICING: routed endpoints use what was measured when it exists, else the highest sibling; a saved recipe is used by the next request without a sample; the database decides", () => {
  it("a routed endpoint's price is its highest sibling's, and the MEASURED average of its real calls (from the database) once there are enough of them", async () => {
    const routed = catalog.byId.get("treg.x.user.posts")!;
    expect(unitCost(routed, catalog)).toMatchObject({ usd: 0.01476, basis: "routed_worst_sibling" });
    const db = createMemoryDb();
    expect(await loadMeasuredAvgCallUsd(db, "treg.x.user.posts")).toBeNull();
    db.seed("exploration_calls", [0.002, 0.004, 0.006].map((c, i) => ({ id: `e${i}`, endpoint_id: "treg.x.user.posts", cost_usd: c, http_status: 200, rows_returned: 5, created_at: `2026-10-2${i}T10:00:00Z` })));
    const avg = await loadMeasuredAvgCallUsd(db, "treg.x.user.posts");
    expect(avg).toBe(0.004);
    expect(unitCost(routed, catalog, avg)).toMatchObject({ usd: 0.004, basis: "measured_average" });
  });

  it("the planner asks for the measured average only for a routed endpoint, and prices the plan with it", async () => {
    gateway = stubGateway({ "treg.x.user.posts": { rows: Array.from({ length: 4 }, (_, i) => ({ text: `p${i}` })) } }, { "treg.x.user.posts": 4000 });
    const loadMeasuredAvg = vi.fn(async () => 0.004);
    const proposal = propose({ summaryAr: "جمع ٤ منشورات", steps: [{ endpointId: "treg.x.user.posts", volume: 4, params: [{ name: "username", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }], fieldMap: { rowsPath: "rows", columns: columnsFor(["text"]), pagination: { kind: "single" } }, filters: [] }] });
    const { out } = await planNow([sample("treg.x.user.posts", [{ name: "username", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }]), proposal], "هات ٤ بوستات من حساب @elonmusk على أكس", { loadMeasuredAvg });
    expect(loadMeasuredAvg).toHaveBeenCalledWith("treg.x.user.posts");
    expect(out.kind).toBe("plan");
    if (out.kind === "plan") expect(out.plan.steps[0].price).toMatchObject({ basis: "measured_average", costPerCallUsd: 0.004, rowsPerCall: 4 });
  });

  it("RECIPES: after a delivery with at least one row the recipe is saved; the NEXT similar request loads it, skips sample_call, and is priced from what the recipe measured; a draft that delivered is used without a review", async () => {
    gateway = stubGateway({ "anyapi.x.user.posts": { rows: Array.from({ length: 10 }, (_, i) => ({ text: `p${i}`, likes: i })) } }, { "anyapi.x.user.posts": 450 });
    const planOf = (handle: string) => propose({ summaryAr: "جمع ١٠ منشورات", steps: [{ endpointId: "anyapi.x.user.posts", volume: 10, params: [{ name: "handle", value: handle, source: "customer_text", quote: `@${handle}` }], fieldMap: { rowsPath: "rows", columns: columnsFor(["text", "likes"]), pagination: { kind: "single" } }, filters: [] }] });
    const first = await planNow([sample("anyapi.x.user.posts", [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }]), planOf("elonmusk")], "هات ١٠ بوستات من حساب @elonmusk على أكس");
    if (first.out.kind !== "plan") throw new Error("no plan");
    const db = createMemoryDb();
    expect(await saveRecipeAfterDelivery(db, first.out.plan.stored, { deliveredUnits: 0, jobId: "j0" })).toBe(false); // nothing delivered: nothing saved
    expect(await saveRecipeAfterDelivery(db, first.out.plan.stored, { deliveredUnits: 7, jobId: "j1" })).toBe(true);
    expect(db.rows("recipes")).toHaveLength(1);
    expect(db.rows("recipes")[0]).toMatchObject({ status: "draft", endpoint_id: "anyapi.x.user.posts", created_by: "agent", catalog_snapshot_sha256: null });
    expect(JSON.stringify(db.rows("recipes")[0])).not.toContain("elonmusk"); // no customer value is stored
    expect(await saveRecipeAfterDelivery(db, first.out.plan.stored, { deliveredUnits: 7, jobId: "j2" })).toBe(false); // already saved
    const loaded = await loadRecipeForEndpoint(db, "anyapi.x.user.posts");
    expect(loaded).toMatchObject({ endpointIds: ["anyapi.x.user.posts"] });
    gateway.calls.length = 0;
    const second = await planNow([describeTool("anyapi.x.user.posts"), planOf("naval")], "هات ١٠ بوستات من حساب @naval على أكس", { loadRecipe: (id) => loadRecipeForEndpoint(db, id) });
    expect(second.out.kind).toBe("plan");
    expect(second.out.sampleCalls).toBe(0);
    expect(gateway.calls).toHaveLength(0);
    if (second.out.kind === "plan") expect(second.out.plan.steps[0].price.measuredFrom).toBe("recipe");
  });
});
