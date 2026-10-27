import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPlanner, type PlannerInput } from "../src/lib/modelPlanner/planner";
import { createScriptedTransport, type ContentBlock } from "../src/lib/modelPlanner/transport";
import { resetExplorationMemoryForTesting } from "../src/lib/modelPlanner/exploration";
import { toolCatalogSearch } from "../src/lib/modelPlanner/tools";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { executeTregCall } from "../src/functions/shared/tregClient";
import { createMemoryDb } from "./helpers/memoryDb";
import { propose, sample, say, search, stubGateway, use, xAccountPlan, type GatewayStub } from "./helpers/plannerKit";

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
const lastResult = (request: any): any => {
  const blocks = request.messages[request.messages.length - 1].content as ContentBlock[];
  const r = blocks.filter((b) => b.type === "tool_result").pop() as any;
  try { return JSON.parse(r.content); } catch { return r.content; }
};

describe("the candidates are shown cheapest first, and the cheapest suitable one is sampled first", () => {
  it("the hits of a search are sorted by cost per record, each with its rank", () => {
    const hits = toolCatalogSearch({ platform: "tiktok", words: ["comments"] }, nobody, catalog).hits as Array<{ rank: number; id: string; costPerRecordUsd?: number }>;
    expect(hits.length).toBeGreaterThan(3);
    expect(hits.map((h) => h.rank)).toEqual(hits.map((_, i) => i + 1));
    const costs = hits.map((h) => h.costPerRecordUsd ?? Number.POSITIVE_INFINITY);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
  });

  const request = "أريد ٣ تعليقات من فيديو تيك توك https://www.tiktok.com/@user/video/7606449212716305678";
  const comments = { data: { comments: Array.from({ length: 3 }, (_, i) => ({ cid: `c${i}`, text: `تعليق ${i}`, digg_count: i, create_time: 1790000000 + i })) } };
  const plan = (why?: string) => ({
    summaryAr: "جمع ٣ تعليقات من فيديو تيك توك", ...(why ? { whyNotCheapest: why } : {}),
    steps: [{ endpointId: "tikhub.tiktok.video.comments", volume: 3, params: [{ name: "aweme_id", value: "7606449212716305678", source: "customer_text", quote: "https://www.tiktok.com/@user/video/7606449212716305678" }], fieldMap: { rowsPath: "data.comments", columns: [{ field: "text", headerAr: "نص التعليق", role: "text" }], pagination: { kind: "single" } } }],
  });

  it("a plan on a dearer endpoint while a cheaper candidate of the same job was never looked at is sent back; with the reason it is accepted", async () => {
    gateway = stubGateway({ "tikhub.tiktok.video.comments": comments }, { "tikhub.tiktok.video.comments": 1000 });
    const { out, transport } = await planNow([
      search("tiktok", ["comments"]),
      sample("tikhub.tiktok.video.comments", [{ name: "aweme_id", value: "7606449212716305678", source: "customer_text", quote: "https://www.tiktok.com/@user/video/7606449212716305678" }]),
      [use("propose_plan", plan())],
      (req: any) => { expect(String(lastResult(req))).toMatch(/cheaper candidate/); return [use("propose_plan", plan("the cheaper endpoint's rows were unsuitable for this link"))]; },
    ], request);
    expect(out.kind).toBe("plan");
    expect(out.failures.flat().map((i) => i.code)).toEqual(["cheaper_untried"]);
    expect(transport.requests).toHaveLength(4);
  });

  it("the cheapest candidate sampled first needs no reason", async () => {
    gateway = stubGateway({ "crawl4ai.tiktok.video.comments": { rows: [{ text: "تعليق", digg_count: 1 }, { text: "تعليق 2", digg_count: 2 }, { text: "تعليق 3", digg_count: 3 }] } }, { "crawl4ai.tiktok.video.comments": 500 });
    const { out } = await planNow([
      search("tiktok", ["comments"]),
      sample("crawl4ai.tiktok.video.comments", [{ name: "post", value: "https://www.tiktok.com/@user/video/7606449212716305678", source: "customer_text", quote: "https://www.tiktok.com/@user/video/7606449212716305678" }]),
      [use("propose_plan", { summaryAr: "جمع ٣ تعليقات", steps: [{ endpointId: "crawl4ai.tiktok.video.comments", volume: 3, params: [{ name: "post", value: "https://www.tiktok.com/@user/video/7606449212716305678", source: "customer_text", quote: "https://www.tiktok.com/@user/video/7606449212716305678" }], fieldMap: { rowsPath: "rows", columns: [{ field: "text", headerAr: "نص التعليق", role: "text" }], pagination: { kind: "single" } } }] })],
    ], request);
    expect(out.failures.flat().map((i) => i.code)).not.toContain("cheaper_untried");
    expect(out.kind).toBe("plan");
  });
});

describe("a later stage is sampled by code from the real rows of the stage before it", () => {
  const request = "هات ٣٠ تعليق تيك توك عن كرة السلة في مصر";
  const videos = { data: { search_item_list: Array.from({ length: 6 }, (_, i) => ({ aweme_info: { aweme_id: `76${i}0001`, desc: `basketball ${i}` } })) } };
  const comments = { data: { comments: Array.from({ length: 8 }, (_, i) => ({ cid: `c${i}`, text: `تعليق ${i}`, digg_count: i, create_time: 1790000000 + i })) } };
  const twoSteps = {
    summaryAr: "جمع ٣٠ تعليقًا على مقاطع تيك توك عن كرة السلة", topic: "كرة السلة",
    steps: [
      { endpointId: "tikhub.tiktok.search.videos", volume: 6, deliver: false, params: [{ name: "keyword", value: "basketball", source: "derived", quote: "كرة السلة" }], fieldMap: { rowsPath: "data.search_item_list", columns: [{ field: "aweme_info.aweme_id", headerAr: "معرف المقطع", role: "id" }, { field: "aweme_info.desc", headerAr: "وصف المقطع", role: "title" }], pagination: { kind: "single" } } },
      { endpointId: "tikhub.tiktok.video.comments", volume: 30, perItem: 5, deliver: true, params: [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: "aweme_info.aweme_id" } }], fieldMap: { rowsPath: "data.comments", columns: [{ field: "text", headerAr: "نص التعليق", role: "text" }, { field: "digg_count", headerAr: "الإعجابات", role: "likes", transform: "number" }], pagination: { kind: "single" } } },
    ],
  };

  it("the model samples only the first stage; the code samples the second one from a real row of the first, prices it from that sample, and the plan validates", async () => {
    gateway = stubGateway({ "tikhub.tiktok.search.videos": videos, "tikhub.tiktok.video.comments": comments }, { "tikhub.tiktok.search.videos": 1000, "tikhub.tiktok.video.comments": 1000 });
    const { out } = await planNow([
      search("tiktok", ["search", "videos"]),
      sample("tikhub.tiktok.search.videos", [{ name: "keyword", value: "basketball", source: "derived", quote: "كرة السلة" }]),
      propose(twoSteps),
    ], request);
    expect(out.kind).toBe("plan");
    if (out.kind !== "plan") return;
    const asked = gateway.calls.filter((c) => c.endpointId === "tikhub.tiktok.video.comments");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0].body).toMatchObject({ aweme_id: "7600001" }); // a value of the first sample's real rows
    expect(out.plan.steps[1].price).toMatchObject({ measuredFrom: "sample", rowsPerCall: 8 });
    expect(out.trace.some((t) => t.tool === "sample_call" && /automatic/.test(t.summary))).toBe(true);
    expect(out.plan.stored.stages!.map((s) => [s.parent, s.deliver])).toEqual([[null, false], [0, true]]);
    // the list stage is not delivered: it collects only the videos the comments need (30 comments at 5 per video = 6 videos)
    expect(out.plan.stored.stages![0].effVolume).toBe(6);
  });

  it("when the earlier step's field is wrong, the model is told the real fields of that step's sample", async () => {
    gateway = stubGateway({ "tikhub.tiktok.search.videos": videos }, { "tikhub.tiktok.search.videos": 1000 });
    let seen = "";
    const { out } = await planNow([
      search("tiktok", ["search", "videos"]),
      sample("tikhub.tiktok.search.videos", [{ name: "keyword", value: "basketball", source: "derived", quote: "كرة السلة" }]),
      (req: any) => { void req; return [use("sample_call", { id: "tikhub.tiktok.video.comments", params: [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: "no_such_field", endpointId: "tikhub.tiktok.search.videos" } }] })]; },
      (req: any) => { seen = JSON.stringify(lastResult(req)); return [say("ما الذي تريده بالضبط؟")]; },
    ], request);
    expect(out.kind).toBe("message");
    expect(seen).toContain("aweme_info.aweme_id");
  });
});

describe("the rows one call returns are measured on two pages, so the same request gets the same price", () => {
  it("the smaller of two pages, rounded down to a step of five: 20 and 18 rows measure 15", async () => {
    const page = (n: number, next?: number) => ({ data: { comments: Array.from({ length: n }, (_, i) => ({ cid: `c${i}`, text: `تعليق ${i}`, digg_count: i, create_time: 1790000000 + i })), ...(next ? { cursor: next } : {}) } });
    gateway = stubGateway({ "tikhub.tiktok.video.comments": (n: number) => (n === 1 ? page(20, 20) : page(18)) }, { "tikhub.tiktok.video.comments": 1000 });
    const request = "أريد ٣٠ تعليق من فيديو تيك توك https://www.tiktok.com/@user/video/7606449212716305678";
    const url = "https://www.tiktok.com/@user/video/7606449212716305678";
    const { out } = await planNow([
      search("tiktok", ["video", "comments"]),
      sample("tikhub.tiktok.video.comments", [{ name: "aweme_id", value: "7606449212716305678", source: "customer_text", quote: url }]),
      propose({ summaryAr: "جمع ٣٠ تعليقًا", steps: [{ endpointId: "tikhub.tiktok.video.comments", volume: 30, params: [{ name: "aweme_id", value: "7606449212716305678", source: "customer_text", quote: url }], fieldMap: { rowsPath: "data.comments", columns: [{ field: "text", headerAr: "نص التعليق", role: "text" }], pagination: { kind: "token", param: "cursor" } } }] }),
    ], request);
    expect(gateway.calls.filter((c) => c.endpointId === "tikhub.tiktok.video.comments")).toHaveLength(2);
    expect(String((gateway.calls[1].body as any).cursor)).toBe("20");
    expect(out.kind).toBe("plan");
    if (out.kind !== "plan") return;
    expect(out.plan.steps[0].price).toMatchObject({ rowsPerCall: 15, measuredFrom: "sample" });
  });
});

describe("the count is the customer's: no number, one question", () => {
  it("a plan with no number in the customer's words is sent back; the model then asks ONE question and the customer sees it", async () => {
    const rows = JSON.parse(JSON.stringify({ rows: [] }));
    void rows;
    const { readFileSync } = await import("node:fs");
    const fixture = JSON.parse(readFileSync("tests/fixtures/replay/real-rows_anyapi.x.user.posts.json", "utf-8")).pages[0];
    gateway = stubGateway({ "anyapi.x.user.posts": fixture }, { "anyapi.x.user.posts": 800 });
    const { out } = await planNow([
      search("x", ["user", "posts"]),
      sample("anyapi.x.user.posts", [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }]),
      propose(xAccountPlan()),
      [say("كم منشورًا تريد من هذا الحساب؟")],
    ], "هات كل المنشورات من حساب @elonmusk على منصة X");
    expect(out.failures.flat().map((i) => i.code)).toContain("volume_not_stated");
    expect(out).toMatchObject({ kind: "message", reason: "clarification", messageAr: "كم منشورًا تريد من هذا الحساب؟" });
  });
});

describe("the ACTUAL charge TREG reports is what is recorded; with none reported the catalog price is recorded and marked as an estimate", () => {
  const options = (over: Record<string, unknown> = {}) => ({ endpointId: "anyapi.x.user.posts", method: "POST" as const, params: { handle: "elonmusk" }, userId: "u1", jobId: "j1", stepId: "s", page: 1, endpointScope: "any_account", ...over });
  const answer = (headers: Record<string, string>, body: unknown = { rows: [] }) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers })));

  it("the cost header is the charge when it is there (a mismatch with the answer's own figure is logged, never hidden)", async () => {
    answer({ "x-treg-cost-micro": "1200", "x-treg-call-id": "a" }, { rows: [], _treg: { charged_micro: 300000 } });
    const r = await executeTregCall(options());
    expect(r.costMicro).toBe(1200);
    expect(r.chargedMicroReported).toBe(300000);
    expect(r.costIsEstimate).toBeUndefined();
    expect((console.warn as any).mock.calls.some((c: any[]) => String(c[0]).includes("treg_charge_mismatch"))).toBe(true);
  });

  it("a routed answer that reports its charge (`_treg.charged_micro`) with no header is recorded at that charge", async () => {
    answer({ "x-treg-call-id": "b" }, { rows: [], _treg: { charged_micro: 20000 } });
    const r = await executeTregCall(options());
    expect(r.costMicro).toBe(20000);
    expect(r.costIsEstimate).toBeUndefined();
  });

  it("nothing reported on an answered call: the call's catalog price estimate is recorded and the result says it is an estimate; an explicit zero stays zero", async () => {
    answer({ "x-treg-call-id": "c" });
    const est = await executeTregCall(options({ callEstimateUsd: 0.0125 }));
    expect(est.costMicro).toBe(12500);
    expect(est.costIsEstimate).toBe(true);
    answer({ "x-treg-cost-micro": "0", "x-treg-call-id": "d" });
    const free = await executeTregCall(options({ callEstimateUsd: 0.0125 }));
    expect(free.costMicro).toBe(0);
    expect(free.costIsEstimate).toBeUndefined();
  });
});
