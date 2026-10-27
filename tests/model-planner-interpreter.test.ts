import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runModelPlanChunk, parseInterpreterState } from "../src/lib/modelPlanner/interpreter";
import { MODEL_PLAN_PARAM, MODEL_PLAN_PURPOSE_PARAM, MODEL_PLAN_SLUG, MAX_CALLS_PER_CHUNK } from "../src/lib/modelPlanner/constants";
import { createJobCallBudget, JOB_BUDGET_STOP_AR } from "../src/lib/server/callBudget";
import type { ProviderAdapterCallInput } from "../src/lib/server/tregAdapter";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import { createMemoryDb } from "./helpers/memoryDb";
import { fixturePages, stubGateway } from "./helpers/plannerKit";

const facts = (over: Record<string, unknown> = {}) => ({ method: "POST", scope: "any_account", limitName: "limit", limitMax: 100, listPath: "rows", cursorPath: null, itemFields: null, callEstimateUsd: 0.0005, ...over });
const column = { field: "text", headerAr: "نص", role: "text" };
const oneStage = (over: Record<string, unknown> = {}, stepOver: Record<string, unknown> = {}) => ({
  v: 1, measured: [{ rowsPerCall: 10, passRate: 1, costPerCallUsd: 0.0005 }],
  steps: [{ endpointId: "anyapi.x.user.posts", volume: 10, params: [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }], fieldMap: { columns: [column, { field: "id", headerAr: "المعرف", role: "id" }], pagination: { kind: "token", param: "cursor" } }, filters: [], facts: facts(), ...stepOver }],
  ...over,
});
const input = (plan: any, over: Partial<ProviderAdapterCallInput> = {}): ProviderAdapterCallInput => ({
  jobId: "job_1", userId: "u1", step: 0, endpointId: plan.steps[0].endpointId, capabilitySlug: MODEL_PLAN_SLUG, method: "POST", params: { [MODEL_PLAN_PARAM]: plan }, paginationStrategy: "cursor",
  cursor: null, pageSize: 10, remainingNeeded: 10, targetVolumeMax: 10, deliveredSoFar: 0, ...over,
});
const ok = (data: any, costMicro = 500): TregCallResult => ({ ok: true, httpStatus: 200, tregCallId: "c", costMicro, latencyMs: 1, data, isRouteMaxCost: false, isPlatformBalanceLow: false });
const fail = (httpStatus: number, extra: Partial<TregCallResult> = {}): TregCallResult => ({ ok: false, httpStatus, tregCallId: "", costMicro: 0, latencyMs: 1, data: null, error: `http_${httpStatus}`, isRouteMaxCost: false, isPlatformBalanceLow: false, ...extra });
const rows = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ id: `r${from + i}`, text: `t${from + i}` }));

beforeEach(() => { process.env.TREG_TOKEN = "t"; vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("one stage: pages of one endpoint", () => {
  it("reads the rows with the plan's field map and carries the next-page token in the cursor; the next chunk sends it back; the last page has no cursor", async () => {
    const calls: TregCallOptions[] = [];
    const pages = [{ rows: rows(3), cursor: "NEXT1" }, { rows: rows(2, 4) }];
    const call = async (o: TregCallOptions) => { calls.push(o); return ok(pages[calls.length - 1]); };
    const plan = oneStage();
    const first = await runModelPlanChunk(input(plan), { call });
    expect(first.ok).toBe(true);
    expect(first.rows).toEqual([{ text: "t1", source_id: "r1" }, { text: "t2", source_id: "r2" }, { text: "t3", source_id: "r3" }]);
    expect(first.nextCursor).not.toBeNull();
    expect(parseInterpreterState(first.nextCursor).next).toBe("NEXT1");
    expect(first.costMicro).toBe(500);
    expect(calls[0].params).toEqual({ handle: "elonmusk", limit: 10 });
    expect(calls[0].endpointScope).toBe("any_account");
    const second = await runModelPlanChunk(input(plan, { cursor: first.nextCursor }), { call });
    expect(calls[1].params).toEqual({ handle: "elonmusk", cursor: "NEXT1", limit: 10 });
    expect(second.rows).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });

  it("page and offset pagination; the page size is the wanted count over the pass rate, never above the endpoint's maximum; a token that repeats stops the paging", async () => {
    const seen: any[] = [];
    const call = async (o: TregCallOptions) => { seen.push(o.params); return ok({ rows: rows(5), cursor: "SAME" }); };
    const pagePlan = oneStage({ measured: [{ rowsPerCall: 10, passRate: 0.25, costPerCallUsd: 0.0005 }] }, { fieldMap: { columns: [column], pagination: { kind: "page", param: "page" } }, facts: facts({ limitMax: 30 }) });
    const p1 = await runModelPlanChunk(input(pagePlan, { remainingNeeded: 20 }), { call });
    expect(seen[0]).toEqual({ handle: "elonmusk", page: 1, limit: 30 }); // 20 / 0.25 = 80, held to the endpoint's maximum 30
    const p2 = await runModelPlanChunk(input(pagePlan, { cursor: p1.nextCursor, remainingNeeded: 20 }), { call });
    expect(seen[1].page).toBe(2);
    const offsetPlan = oneStage({}, { fieldMap: { columns: [column], pagination: { kind: "offset", param: "offset" } } });
    const o1 = await runModelPlanChunk(input(offsetPlan), { call });
    const o2 = await runModelPlanChunk(input(offsetPlan, { cursor: o1.nextCursor }), { call });
    expect(seen[3].offset).toBe(5);
    expect(o2.ok).toBe(true);
    const tokenPlan = oneStage();
    const t1 = await runModelPlanChunk(input(tokenPlan), { call });
    const t2 = await runModelPlanChunk(input(tokenPlan, { cursor: t1.nextCursor }), { call });
    expect(t2.nextCursor).toBeNull(); // the source returned the token it was just given: no next page
    const none = await runModelPlanChunk(input(oneStage({}, { fieldMap: { columns: [column], pagination: { kind: "single" } } })), { call });
    expect(none.nextCursor).toBeNull();
  });

  it("the filters are applied BEFORE the rows are returned: what they drop is not delivered (and so not charged)", async () => {
    const plan = oneStage({}, { filters: [{ kind: "exclude_prefix", field: "text", prefix: "RT @" }, { kind: "exclude_true", field: "isReply" }] });
    const call = async () => ok({ rows: [{ id: "1", text: "hello", isReply: "False" }, { id: "2", text: "RT @x: hi", isReply: "False" }, { id: "3", text: "yes", isReply: "True" }] });
    const out = await runModelPlanChunk(input(plan), { call });
    expect(out.rows).toEqual([{ text: "hello", source_id: "1" }]);
  });

  it("a failed call is an Arabic error with nothing delivered; a budget stop says the job reached its limit; a blocked endpoint is never called", async () => {
    const e404 = await runModelPlanChunk(input(oneStage()), { call: async () => fail(404) });
    expect(e404).toMatchObject({ ok: false, httpStatus: 404, rows: [] });
    expect(e404.errorMessageAr).toMatch(/^[؀-ۿ\s؛،.]+$/);
    const budget = await runModelPlanChunk(input(oneStage()), { call: async () => fail(0, { error: "job_budget_exceeded", budgetStopped: true }) });
    expect(budget).toMatchObject({ ok: false, errorMessageAr: JOB_BUDGET_STOP_AR });
    const gateway = stubGateway({});
    const blockedPlan = oneStage({}, { endpointId: "openmart.deny-rules.create" });
    const blocked = await runModelPlanChunk(input(blockedPlan));
    expect(blocked.ok).toBe(false);
    expect(gateway.calls).toHaveLength(0);
    expect(await runModelPlanChunk({ ...input(oneStage()), params: { [MODEL_PLAN_PARAM]: { v: 1, steps: [], measured: [] } } })).toMatchObject({ ok: false, errorCode: "model_plan_missing" });
    expect(await runModelPlanChunk({ ...input(oneStage()), params: {} })).toMatchObject({ ok: false, errorCode: "model_plan_missing" });
  });

  it("the job's per-call USD budget is asked before EVERY call: a call that would pass the ceiling is not sent", async () => {
    const gateway = stubGateway({ "anyapi.x.user.posts": { rows: rows(2) } }, { "anyapi.x.user.posts": 500 });
    const budget = createJobCallBudget({ ceilingUsd: 0.001, spentUsd: 0 });
    const plan = oneStage();
    const a = await runModelPlanChunk(input(plan, { callBudget: budget }));
    const b = await runModelPlanChunk(input(plan, { callBudget: budget, cursor: JSON.stringify({ v: 1, stage: 0, next: "n", page: 2, offset: 0, queue: [], listDone: false }) }));
    const c = await runModelPlanChunk(input(plan, { callBudget: budget, cursor: JSON.stringify({ v: 1, stage: 0, next: "n", page: 3, offset: 0, queue: [], listDone: false }) }));
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, false]);
    expect(gateway.calls).toHaveLength(2);
    expect(c.errorMessageAr).toBe(JOB_BUDGET_STOP_AR);
  });

  it("no period is ever added: the request carries only the plan's own parameters (no dateFrom, no dateTo, no window)", async () => {
    const seen: any[] = [];
    await runModelPlanChunk(input(oneStage()), { call: async (o) => { seen.push(o.params); return ok({ rows: rows(1) }); } });
    expect(Object.keys(seen[0]).sort()).toEqual(["handle", "limit"]);
  });
});

describe("two stages: a listing, then one call per listed item", () => {
  const search = { endpointId: "anyapi.tiktok.search.videos", volume: 6, params: [{ name: "query", value: "كرة السلة", source: "customer_text", quote: "كرة السلة" }], fieldMap: { columns: [{ field: "id", headerAr: "معرف المقطع", role: "id" }], pagination: { kind: "token", param: "cursor" } }, filters: [], facts: facts({ listPath: "videos" }) };
  const comments = (over: Record<string, unknown> = {}) => ({ endpointId: "tikhub.tiktok.video.comments", volume: 6, perItem: 2, params: [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: "id" } }], fieldMap: { columns: [{ field: "text", headerAr: "نص التعليق", role: "text" }, { field: "cid", headerAr: "المعرف", role: "id" }], pagination: { kind: "single" } }, filters: [], facts: facts({ listPath: "comments", limitName: "count", limitMax: 50, callEstimateUsd: 0.001 }), ...over });
  const plan = (c = comments()) => ({ v: 1, measured: [{ rowsPerCall: 3, passRate: 1, costPerCallUsd: 0.0012 }, { rowsPerCall: 20, passRate: 1, costPerCallUsd: 0.001 }], steps: [search, c] });
  const call = (log: TregCallOptions[], listPages = [{ videos: [{ id: "v1" }, { id: "v2" }, { id: "v3" }], cursor: "L2" }, { videos: [{ id: "v4" }] }]) => async (o: TregCallOptions): Promise<TregCallResult> => {
    log.push(o);
    if (o.endpointId === "anyapi.tiktok.search.videos") return ok(listPages[Math.min(log.filter((l) => l.endpointId === o.endpointId).length, listPages.length) - 1], 1200);
    const id = o.params!.aweme_id;
    return ok({ comments: [{ cid: `${id}-1`, text: `c1 of ${id}` }, { cid: `${id}-2`, text: "c2" }, { cid: `${id}-3`, text: "c3" }] }, 1000);
  };

  it("lists the items, then reads the comments of each (the first page, at most perItem rows), at most three provider calls per chunk, and carries the queue in the cursor", async () => {
    const log: TregCallOptions[] = [];
    const first = await runModelPlanChunk(input(plan(), { remainingNeeded: 6, targetVolumeMax: 6 }), { call: call(log) });
    expect(log.map((l) => l.endpointId)).toEqual(["anyapi.tiktok.search.videos", "tikhub.tiktok.video.comments", "tikhub.tiktok.video.comments"]);
    expect(log.length).toBe(MAX_CALLS_PER_CHUNK);
    expect(log[1].params).toMatchObject({ aweme_id: "v1", count: 2 });
    expect(log[2].params).toMatchObject({ aweme_id: "v2" });
    expect(first.rows).toHaveLength(4); // 2 comments from each of two videos
    expect(first.rows.map((r) => r.text)).toEqual(["c1 of v1", "c2", "c1 of v2", "c2"]);
    expect(first.costMicro).toBe(1200 + 1000 + 1000);
    expect(first.providerCallCount).toBe(3);
    const state = parseInterpreterState(first.nextCursor);
    expect(state.queue).toEqual([{ aweme_id: "v3" }]);
    expect(state.next).toBe("L2");
    // the next chunk continues from the queue (v3), then lists the next page (v4)
    const log2: TregCallOptions[] = [];
    const second = await runModelPlanChunk(input(plan(), { cursor: first.nextCursor, remainingNeeded: 2, targetVolumeMax: 6 }), { call: call(log2) });
    expect(log2[0].params!.aweme_id).toBe("v3");
    expect(second.rows).toHaveLength(2); // capped at what is still wanted
  });

  it("a listed item whose call fails is skipped, the rest still run; a budget stop ends the chunk with what was delivered; with nothing delivered it is an error", async () => {
    const log: TregCallOptions[] = [];
    const flaky = async (o: TregCallOptions): Promise<TregCallResult> => {
      log.push(o);
      if (o.endpointId === "anyapi.tiktok.search.videos") return ok({ videos: [{ id: "v1" }, { id: "v2" }] }, 1200);
      return o.params!.aweme_id === "v1" ? fail(500) : ok({ comments: [{ cid: "x", text: "ok" }] }, 1000);
    };
    const out = await runModelPlanChunk(input(plan(), { remainingNeeded: 6 }), { call: flaky });
    expect(out.ok).toBe(true);
    expect(out.rows.map((r) => r.text)).toEqual(["ok"]);
    const stopped = async (o: TregCallOptions): Promise<TregCallResult> => (o.endpointId === "anyapi.tiktok.search.videos" ? ok({ videos: [{ id: "v1" }] }, 1200) : fail(0, { error: "job_budget_exceeded", budgetStopped: true }));
    expect(await runModelPlanChunk(input(plan(), { remainingNeeded: 6 }), { call: stopped })).toMatchObject({ ok: false, errorMessageAr: JOB_BUDGET_STOP_AR });
  });

  it("the listing stage reads no more than the fan-out limit of items, and an empty listing ends the job", async () => {
    const log: TregCallOptions[] = [];
    const many = { videos: Array.from({ length: 80 }, (_, i) => ({ id: `v${i}` })) };
    const out = await runModelPlanChunk(input(plan(), { remainingNeeded: 100 }), { call: call(log, [many]) });
    expect(parseInterpreterState(out.nextCursor).queue.length).toBeLessThanOrEqual(40);
    const empty = await runModelPlanChunk(input(plan(), { remainingNeeded: 5 }), { call: async () => ok({ videos: [] }, 1200) });
    expect(empty).toMatchObject({ ok: true, rows: [], nextCursor: null });
  });
});

describe("a SENSITIVE step in the worker goes through the audited path", () => {
  const sensitivePlan = (endpointId = "blitzapi.people.phone.reverse") => ({ v: 1, measured: [{ rowsPerCall: 1, passRate: 1, costPerCallUsd: 0.02 }], steps: [{ endpointId, volume: 1, params: [{ name: "phone", value: "+201001234567", source: "customer_text", quote: "+201001234567" }], fieldMap: { columns: [{ field: "name", headerAr: "الاسم", role: "author_name" }], pagination: { kind: "single" } }, filters: [], facts: facts({ listPath: null, callEstimateUsd: 0.02 }) }] });

  it("without the audited context the step is refused and NO request is made; with a verified account and a purpose it runs, writes one audit row (masked) and the call carries the flag", async () => {
    const gateway = stubGateway({ "blitzapi.people.phone.reverse": { data: { name: "Someone" } } }, { "blitzapi.people.phone.reverse": 20000 });
    const plan = sensitivePlan();
    const denied = await runModelPlanChunk(input(plan));
    expect(denied.ok).toBe(false);
    expect(gateway.calls).toHaveLength(0);
    const db = createMemoryDb();
    const unverified = await runModelPlanChunk(input(plan), { sensitive: { client: db, access: { isAdmin: false, verifiedBusiness: false }, purpose: "التواصل مع عميل" } });
    expect(unverified.ok).toBe(false);
    expect(unverified.errorMessageAr).toContain("حسابات الأعمال الموثّقة");
    expect(gateway.calls).toHaveLength(0);
    const out = await runModelPlanChunk(input(plan), { sensitive: { client: db, access: { isAdmin: false, verifiedBusiness: true }, purpose: "التواصل مع عميل محتمل" } });
    expect(out.ok).toBe(true);
    expect(out.rows).toEqual([{ author_name: "Someone" }]);
    expect(gateway.calls).toHaveLength(1);
    const audit = db.rows("sensitive_lookup_audit").filter((r) => r.outcome === "called");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ masked_value: "***567", job_id: "job_1", account_id: "u1", cost_usd: 0.02, purpose: "التواصل مع عميل محتمل" });
    expect(JSON.stringify(audit[0])).not.toContain("1001234");
    // the purpose stored on the quote item is used when the worker's context carries none
    const viaItem = await runModelPlanChunk({ ...input(plan), params: { [MODEL_PLAN_PARAM]: plan, [MODEL_PLAN_PURPOSE_PARAM]: "غرض مخزن على العرض" } }, { sensitive: { client: db, access: { isAdmin: false, verifiedBusiness: true }, purpose: "" } });
    expect(viaItem.ok).toBe(true);
    expect(db.rows("sensitive_lookup_audit").at(-1)).toMatchObject({ purpose: "غرض مخزن على العرض" });
  });
});

describe("raw capture and the first page", () => {
  it("the raw first page of the job is captured by the gateway client, as for every other job", async () => {
    stubGateway({ "anyapi.x.user.posts": fixturePages("real-rows_anyapi.x.user.posts")[0] });
    const captured: any[] = [];
    await runModelPlanChunk(input(oneStage({}, { facts: facts({ listPath: "rows" }) }), { rawCapture: async (r) => { captured.push(r); } }));
    expect(captured).toHaveLength(1);
    expect(captured[0].endpointId).toBe("anyapi.x.user.posts");
  });
});

describe("the topic review: only when the request has a topic, with the customer's REAL request text, fail closed", () => {
  const withTopic = () => oneStage({ topic: "كرة السلة" });
  const REQUEST = "هات ٣٠ تعليق تيك توك عن كرة السلة في مصر";
  const call = async () => ok({ rows: [{ id: "1", text: "مباراة كرة السلة" }, { id: "2", text: "إعلان عن عرض" }, { id: "3", text: "تحليل المباراة" }, { id: "4", text: "نص آخر" }] });
  const advisor = (verdicts: Record<number, string>, usage: any = { inputTokens: 900, outputTokens: 60, costUsd: 0.0001, model: "claude-haiku-5-5", latencyMs: 400 }) => vi.fn(async (_input: any) => ({ verdicts: new Map(Object.entries(verdicts).map(([i, verdict]) => [Number(i), { verdict, reasonAr: "" }])) as any, usage, failure: null }));
  const run = (plan: any, adv: any, extra: Partial<ProviderAdapterCallInput> = {}) => runModelPlanChunk({ ...input(plan, extra), params: { [MODEL_PLAN_PARAM]: plan, _customerRequest: REQUEST } }, { call, advisor: adv });

  it("a row is delivered only when the review CONFIRMS it; a doubt, a missing verdict or a no_match holds it (not delivered, so not charged); the usage is returned for the log", async () => {
    const adv = advisor({ 0: "match", 1: "no_match", 2: "match", 3: "uncertain" });
    const out = await run(withTopic(), adv);
    expect(out.rows.map((r) => r.source_id)).toEqual(["1", "3"]);
    expect(out.reviewModelUsage).toEqual([{ inputTokens: 900, outputTokens: 60, costUsd: 0.0001, model: "claude-haiku-5-5", latencyMs: 400 }]);
    // the reviewer is given the customer's own words and the rows as the plan's columns
    const given = adv.mock.calls[0][0];
    expect(given.customerRequest).toBe(REQUEST);
    expect(given.rows).toHaveLength(4);
    expect(given.rows[0].row).toEqual({ text: "مباراة كرة السلة", source_id: "1" });
  });

  it("a reviewer that fails (no verdicts), a thrown error, and a job past its review budget all HOLD every row; and the cursor carries the review spend", async () => {
    expect((await run(withTopic(), advisor({}, null))).rows).toEqual([]);
    expect((await run(withTopic(), vi.fn(async () => { throw new Error("boom"); }))).rows).toEqual([]);
    const spent = vi.fn();
    const cursor = JSON.stringify({ v: 1, stage: 0, next: null, page: 1, offset: 0, queue: [], listDone: false, reviewUsd: 0.149 });
    const over = await runModelPlanChunk({ ...input(withTopic(), { cursor }), params: { [MODEL_PLAN_PARAM]: withTopic(), _customerRequest: REQUEST } }, { call, advisor: spent as any });
    expect(over.rows).toEqual([]);
    expect(spent).not.toHaveBeenCalled();
    const first = await run(oneStage({ topic: "x" }, { fieldMap: { columns: [column, { field: "id", headerAr: "المعرف", role: "id" }], pagination: { kind: "page", param: "page" } } }), advisor({ 0: "match" }, { inputTokens: 1, outputTokens: 1, costUsd: 0.01, model: "m", latencyMs: 1 }));
    expect(parseInterpreterState(first.nextCursor).reviewUsd).toBeCloseTo(0.01, 9);
  });

  it("a request with no topic is never reviewed: the advisor is not called", async () => {
    const adv = advisor({});
    const out = await run(oneStage(), adv);
    expect(adv).not.toHaveBeenCalled();
    expect(out.rows).toHaveLength(4);
    expect(out.reviewModelUsage).toBeUndefined();
  });
});
