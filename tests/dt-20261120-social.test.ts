import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { priceExplainOf, priceFactsOf } from "../src/lib/agentMission/customerView";
import { approveMission, repriceStoredPlan, settleMission } from "../src/lib/agentMission/lifecycle";
import { customerPlanView, stagePriceInputs, type EngineSpec, type PricedPlan } from "../src/lib/agentMission/plan";
import { executionBudgetUsd, priceMissionByCode, type StagePriceInput } from "../src/lib/agentMission/price";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { buildPriceRows } from "../src/lib/pricingPage";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { pricedTwoStagePlan } from "./helpers/agentPlan";
import { catalogPage } from "./helpers/discoveryWorld";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  hintsOf,
  missionPageOf,
  pageInputValue,
  readShape,
  type MissionPageMetadata,
} from "../src/lib/treg/shapeReader";
import {
  runProviderSync,
  type ProviderBaseline,
} from "../scripts/capabilities/sync-providers";
import { loadTregCatalog, type CatalogEndpoint } from "../src/lib/treg/catalog";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import type { RegistryArtifact } from "../src/lib/agentMission/capabilities/artifact";
import {
  checkOptions,
  chooseTools,
  bindLookups,
  assemblePlan,
  planWithLlm,
  type PlannerModel,
  type ToolOption,
} from "../agent/src/llmPlanner/planner";
import { ItemStore, foldSegments } from "../agent/src/items/itemStore";
import { fakeRecorder, NOT_ADMIN, tregResult } from "./helpers/agentHarness";
import { REPLAY_USER, replay, replayClient, readWorkbook } from "./helpers/agentReplay";
import { createMemoryDb } from "./helpers/memoryDb";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { runPlanning } from "../agent/src/runMission";
import type { TregCallOptions } from "../src/functions/shared/tregClient";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
// Structural subsets of the recorded terminal replies. Identifiers and tokens are synthetic.
const tiktokNil = (query: number) => ({
  data: { search_item_list: null, aweme_list: null, has_more: 0, cursor: 50, search_nil_info: { search_id: `nil-${query}` } },
});
const terminalComments = (post: number) => ({
  comments: [{ id: `comment-${post}-1` }, { id: `comment-${post}-2` }],
  cursor: `stale-${post}`, has_next_page: false,
});

const registry = JSON.parse(read("data/capabilities/registry.json")) as RegistryArtifact;
const snapshot = (JSON.parse(read("data/treg/treg_catalog_sellable.json")) as { endpoints: Array<Record<string, any>> }).endpoints;
const writeIds = new Set((JSON.parse(read("data/treg/treg_write_actions.json")) as Array<{ id: string }>).map((w) => w.id));
const baseline = JSON.parse(read("data/capabilities/provider-metadata.json")) as ProviderBaseline;

const mockEndpoint = (id?: string) => ({ id, list_path: null, cursor_path: null, example_response_trimmed: null, item_fields: null });

describe("DT-20261120-social extraction suite", () => {
  it("leaves a stream uncertain at its first open-empty page without buying a later page", async () => {
    const checkedCatalog = loadTregCatalog();
    const endpointId = "tikhub.tiktok.search.videos";
    const request = "هات ٢٠ فيديو من تيك توك عن الفلك";
    const answers: Record<string, unknown> = {
      request_plan: { decision: "plan", understanding_ar: request, steps: [{
        key: "videos", title_ar: "الفيديوهات", platform: "tiktok", capability: "tiktok.search.videos",
        parent: null, deliver: true, count: { total: 20, per_parent: null, all: false },
        source: null, topic: "الفلك", search_terms: ["الفلك"], period: null,
      }] },
      tool_choice: { options: [{ endpoint_id: endpointId, params: { keyword: "الفلك" } }] },
    };
    const page = { data: { search_item_list: [], has_more: 1, cursor: 50 } };
    const dispatches: Array<Record<string, unknown>> = [];
    const plan = await planWithLlm({ words: [request], request }, {
      catalog: checkedCatalog, access: null, today: "2026-11-20",
      model: async ({ tool }) => ({ input: answers[tool.name], costUsd: 0 }),
      probe: async (_id, params) => {
        dispatches.push(params);
        const { reading } = buildShapeDigest(page, checkedCatalog.byId.get(endpointId)!);
        return {
          ok: true, call_id: "test-open-empty", http_status: 200, rows_in_page: reading.rows.length,
          has_more: reading.hasMore, next_cursor: reading.nextCursor, shape: null,
          first_rows: [], warnings: reading.warnings, saved: "test-open-empty",
        };
      },
      readPage: async () => page,
    });
    expect(dispatches).toEqual([{ keyword: "الفلك" }]);
    expect(plan).toMatchObject({ kind: "cannot", detail: "no_step_served" });
  });

  describe("T1: Missing/invalid list and terminal nil (TikTok)", () => {
    const tiktokEndpointId = "tikhub.tiktok.search.videos";

    it("parses terminal nil in tiktok_search_1 and tiktok_search_2 as 0 rows, list_path, no warning, no continuation", () => {
      const cfg = missionPageOf(tiktokEndpointId);
      expect(cfg).toBeDefined();
      expect(cfg).toMatchObject({
        listPath: "data.search_item_list",
        nextPath: "data.cursor",
        cursorParam: "offset",
        cursorType: "integer",
        hasMorePath: "data.has_more",
        nilMarkerPath: "data.search_nil_info",
      });

      for (const body of [tiktokNil(1), tiktokNil(2)]) {
        const hints = { ...hintsOf(mockEndpoint(tiktokEndpointId)), missionPage: cfg };
        const reading = readShape(body, hints);
        expect(reading.rows).toEqual([]);
        expect(reading.listStrategy).toBe("list_path");
        expect(reading.warnings).toEqual([]);
        expect(reading.hasMore).toBe(false);
        expect(reading.nextCursor).toBeNull();
      }
    });

    it("reports declared_missing, produces 0 rows, warns, and rejects open continuation when declared array is absent or malformed", () => {
      const cfg = missionPageOf(tiktokEndpointId);
      const malformedBody = {
        code: 200,
        data: {
          search_item_list: { invalid: "object_instead_of_array" },
          cursor: 50,
          has_more: 1,
        },
      };
      const hints = { ...hintsOf(mockEndpoint(tiktokEndpointId)), missionPage: cfg };
      const reading = readShape(malformedBody, hints);
      expect(reading.rows).toEqual([]);
      expect(reading.listStrategy).toBe("declared_missing");
      expect(reading.warnings.length).toBeGreaterThan(0);
      expect(reading.nextCursor).toBeNull();
    });

    it("reads normal single-item page with valid next token", () => {
      const cfg = missionPageOf(tiktokEndpointId);
      const normalBody = {
        code: 200,
        data: {
          search_item_list: [{ aweme_id: "vid_101", desc: "test video" }],
          cursor: 20,
          has_more: 1,
        },
      };
      const hints = { ...hintsOf(mockEndpoint(tiktokEndpointId)), missionPage: cfg };
      const reading = readShape(normalBody, hints);
      expect(reading.rows).toHaveLength(1);
      expect(reading.listStrategy).toBe("list_path");
      expect(reading.hasMore).toBe(true);
      expect(reading.nextCursor).toBe("20");
    });
  });

  describe("T2: Stage with 300 YouTube comments & continuation guards", () => {
    const youtubeCommentsId = "tikhub.youtube.video.comments";

    it("loads reviewed contract with preferForCount: true and opaque continuation_token", () => {
      const cfg = missionPageOf(youtubeCommentsId);
      expect(cfg).toBeDefined();
      expect(cfg).toMatchObject({
        listPath: "data.comments",
        nextPath: "data.continuation_token",
        cursorParam: "continuation_token",
        cursorType: "string",
        preferForCount: true,
      });
    });

    it.each([
      {
        name: "empty-with-next",
        body: { data: { comments: [], continuation_token: "next_tok_1", has_more: true } },
        cfg: { listPath: "data.comments", nextPath: "data.continuation_token", cursorParam: "continuation_token", cursorType: "string" as const, hasMorePath: "data.has_more" },
        expectedRows: 0,
        expectedCursor: "next_tok_1",
        expectedHasMore: true,
      },
      {
        name: "empty-final",
        body: { data: { comments: [], continuation_token: "stale_tok", has_more: false } },
        cfg: { listPath: "data.comments", nextPath: "data.continuation_token", cursorParam: "continuation_token", cursorType: "string" as const, hasMorePath: "data.has_more" },
        expectedRows: 0,
        expectedCursor: null,
        expectedHasMore: false,
      },
      {
        name: "terminal-with-stale-token",
        body: { data: { comments: [{ id: "c1", text: "hi" }], continuation_token: "stale_tok", has_more: 0 } },
        cfg: { listPath: "data.comments", nextPath: "data.continuation_token", cursorParam: "continuation_token", cursorType: "string" as const, hasMorePath: "data.has_more" },
        expectedRows: 1,
        expectedCursor: null,
        expectedHasMore: false,
      },
    ])("continuation table: $name", ({ body, cfg, expectedRows, expectedCursor, expectedHasMore }) => {
      const hints = { ...hintsOf(mockEndpoint()), missionPage: cfg };
      const reading = readShape(body, hints);
      expect(reading.rows).toHaveLength(expectedRows);
      expect(reading.nextCursor).toBe(expectedCursor);
      expect(reading.hasMore).toBe(expectedHasMore);
    });

    it("normalizes pageInputValue for string and integer contracts", () => {
      const strCfg: MissionPageMetadata = { listPath: "c", nextPath: "token", cursorParam: "token", cursorType: "string" };
      const intCfg: MissionPageMetadata = { listPath: "c", nextPath: "offset", cursorParam: "offset", cursorType: "integer" };

      expect(pageInputValue("abc_123", strCfg)).toBe("abc_123");
      expect(pageInputValue("", strCfg)).toBeNull();
      expect(pageInputValue("   ", strCfg)).toBeNull();

      expect(pageInputValue("50", intCfg)).toBe(50);
      expect(pageInputValue("0", intCfg)).toBe(0);
      expect(pageInputValue(50 as any, intCfg)).toBe(50);
      expect(pageInputValue("-10", intCfg)).toBeNull();
      expect(pageInputValue("not_a_number", intCfg)).toBeNull();
    });

    it("flattens primary and alternate lookups independently in bindLookups without borrowing or collision", () => {
      const parentRow = { id: "vid_100", link: "https://youtube.com/watch?v=vid_100" };
      const steps = [
        {
          step: { key: "vids", platform: "youtube", capability: "youtube.video", parent: null, count: { total: 1, per_parent: null, all: false } },
          option: { endpoint: { id: "youtube.lookup", inputs: [], pagination: [] } as any, params: {}, cursor: null, parent: null, more: [], notCarried: [] },
          mapCode: "return []", columns: [], carryKeys: [], sampleRows: [parentRow], rowsPerPage: 1, callIds: [], hasMore: false,
          lookup: true as const,
        },
        {
          step: { key: "cmts", platform: "youtube", capability: "youtube.video.comments", parent: "vids", count: { total: 10, per_parent: null, all: false } },
          option: {
            endpoint: { id: "tikhub.youtube.video.comments", inputs: [], pagination: [] } as any,
            params: {}, cursor: "continuation_token",
            parent: { param: "video_id", from: "id" },
            more: [], notCarried: [],
          },
          mapCode: "return []", columns: [], carryKeys: [], sampleRows: [], rowsPerPage: 20, callIds: [], hasMore: false,
          second: {
            option: {
              endpoint: { id: "alt.youtube.comments", inputs: [], pagination: [] } as any,
              params: {}, cursor: "continuation_token",
              parent: { param: "url", from: "link" },
              more: [], notCarried: [],
            },
            mapCode: "return []",
          },
        },
      ];

      const bound = bindLookups(steps as any);
      expect(bound).toHaveLength(1);
      const child = bound[0];
      expect(child.step.parent).toBeNull();
      expect(child.option.params).toEqual({ video_id: "vid_100" });
      expect(child.second?.option.params).toEqual({ url: "https://youtube.com/watch?v=vid_100" });
    });

    it("drops alternate lookup when parent row lacks alternate from-field", () => {
      const parentRow = { id: "vid_100" }; // link is missing!
      const steps = [
        {
          step: { key: "vids", platform: "youtube", capability: "youtube.video", parent: null, count: { total: 1, per_parent: null, all: false } },
          option: { endpoint: { id: "youtube.lookup", inputs: [], pagination: [] } as any, params: {}, cursor: null, parent: null, more: [], notCarried: [] },
          mapCode: "return []", columns: [], carryKeys: [], sampleRows: [parentRow], rowsPerPage: 1, callIds: [], hasMore: false,
          lookup: true as const,
        },
        {
          step: { key: "cmts", platform: "youtube", capability: "youtube.video.comments", parent: "vids", count: { total: 10, per_parent: null, all: false } },
          option: {
            endpoint: { id: "tikhub.youtube.video.comments", inputs: [], pagination: [] } as any,
            params: {}, cursor: "continuation_token",
            parent: { param: "video_id", from: "id" },
            more: [], notCarried: [],
          },
          mapCode: "return []", columns: [], carryKeys: [], sampleRows: [], rowsPerPage: 20, callIds: [], hasMore: false,
          second: {
            option: {
              endpoint: { id: "alt.youtube.comments", inputs: [], pagination: [] } as any,
              params: {}, cursor: "continuation_token",
              parent: { param: "url", from: "missing_link" },
              more: [], notCarried: [],
            },
            mapCode: "return []",
          },
        },
      ];

      const bound = bindLookups(steps as any);
      expect(bound[0].second).toBeUndefined();
    });

    it("remembers visitedPositions in ItemStore StreamState across page operations and reloaded logs", () => {
      const seg1 = {
        v: 1 as const, seq: 1, writer: "w1", at: new Date().toISOString(),
        ops: [
          { t: "page" as const, stage: "s1", stream: "st1", call_id: "c1", cursor_in: null, cursor_next: "tok_1", has_more: true, ended: false, rows_in_page: 20 },
          { t: "page" as const, stage: "s1", stream: "st1", call_id: "c2", cursor_in: "tok_1", cursor_next: "tok_2", has_more: true, ended: false, rows_in_page: 20 },
        ],
      };
      const logs = foldSegments([seg1]);
      const state = logs.get("s1")?.streams.get("st1");
      expect(state).toBeDefined();
      expect(state?.visitedPositions).toBeDefined();
      expect(state?.visitedPositions.has(null)).toBe(true);
      expect(state?.visitedPositions.has("tok_1")).toBe(true);
      expect(state?.visitedPositions.has("tok_2")).toBe(false);
    });
  });

  describe("T3: Global vs per-parent quota across parents", () => {
    it("sets fill_total_across_parents: true and omits per_parent_rows for counted child with global total", () => {
      const understanding = {
        decision: "plan" as const, understanding_ar: "هات تعليقات",
        steps: [
          { key: "posts", title_ar: "منشورات", platform: "facebook", capability: "facebook.user.posts", parent: null, count: { total: 20, per_parent: null, all: false }, source: { kind: "page", value: "https://facebook.com/page" }, deliver: false },
          { key: "comments", title_ar: "تعليقات", platform: "facebook", capability: "facebook.post.comments", parent: "posts", count: { total: 200, per_parent: null, all: false }, source: null, deliver: true },
        ],
      };
      const builtSteps = [
        {
          step: understanding.steps[0],
          option: { endpoint: { id: "anyapi.facebook.user.posts", inputs: [], pagination: [] } as any, params: {}, cursor: "cursor", parent: null, more: [], notCarried: [] },
          mapCode: "return []", columns: [{ key: "id", title_ar: "ID" }, { key: "link", title_ar: "Link" }], carryKeys: [], sampleRows: [{ id: "p1", link: "l1" }], rowsPerPage: 3, callIds: [], hasMore: true,
        },
        {
          step: understanding.steps[1],
          option: { endpoint: { id: "scrapecreators.x.v1-facebook-post-comments", inputs: [], pagination: [] } as any, params: {}, cursor: "cursor", parent: { param: "url", from: "link" }, more: [], notCarried: [] },
          mapCode: "return []", columns: [{ key: "id", title_ar: "ID" }, { key: "text", title_ar: "Text" }], carryKeys: [], sampleRows: [], rowsPerPage: 2, callIds: [], hasMore: true,
        },
      ];

      const plan = assemblePlan(understanding as any, builtSteps as any, []);
      const commentsStage = plan.stages.find((s) => s.key === "comments")!;
      expect(commentsStage.per_parent_rows).toBeUndefined();
      expect((commentsStage.engine as any).fill_total_across_parents).toBe(true);
      expect((commentsStage.engine as any).catalog_paging).toBe(true);
    });

    it("seals per_parent_rows when customer explicitly asks for count per parent", () => {
      const understanding = {
        decision: "plan" as const, understanding_ar: "هات ١٥ تعليق لكل منشور",
        steps: [
          { key: "posts", title_ar: "منشورات", platform: "facebook", capability: "facebook.user.posts", parent: null, count: { total: 2, per_parent: null, all: false }, source: { kind: "page", value: "https://facebook.com/page" }, deliver: false },
          { key: "comments", title_ar: "تعليقات", platform: "facebook", capability: "facebook.post.comments", parent: "posts", count: { total: null, per_parent: 15, all: false }, source: null, deliver: true },
        ],
      };
      const builtSteps = [
        {
          step: understanding.steps[0],
          option: { endpoint: { id: "anyapi.facebook.user.posts", inputs: [], pagination: [] } as any, params: {}, cursor: "cursor", parent: null, more: [], notCarried: [] },
          mapCode: "return []", columns: [{ key: "id", title_ar: "ID" }], carryKeys: [], sampleRows: [{ id: "p1" }], rowsPerPage: 3, callIds: [], hasMore: true,
        },
        {
          step: understanding.steps[1],
          option: { endpoint: { id: "scrapecreators.x.v1-facebook-post-comments", inputs: [], pagination: [] } as any, params: {}, cursor: "cursor", parent: { param: "url", from: "id" }, more: [], notCarried: [] },
          mapCode: "return []", columns: [{ key: "id", title_ar: "ID" }], carryKeys: [], sampleRows: [], rowsPerPage: 2, callIds: [], hasMore: true,
        },
      ];

      const plan = assemblePlan(understanding as any, builtSteps as any, []);
      const commentsStage = plan.stages.find((s) => s.key === "comments")!;
      expect(commentsStage.per_parent_rows).toBe(15);
      expect((commentsStage.engine as any)?.fill_total_across_parents).toBeUndefined();
    });
  });

  describe("T4: Facebook extraction", () => {
    const fbCommentsEndpointId = "scrapecreators.x.v1-facebook-post-comments";

    it("rejects stale token when has_next_page is false on fb_comments_p1 and fb_comments_p2", () => {
      const cfg = missionPageOf(fbCommentsEndpointId);
      expect(cfg).toBeDefined();
      expect(cfg).toMatchObject({
        listPath: "comments",
        nextPath: "cursor",
        cursorParam: "cursor",
        cursorType: "string",
        hasMorePath: "has_next_page",
      });

      for (const body of [terminalComments(1), terminalComments(2)]) {
        const hints = { ...hintsOf(mockEndpoint(fbCommentsEndpointId)), missionPage: cfg };
        const reading = readShape(body, hints);
        expect(reading.rows).toHaveLength(2);
        expect(reading.hasMore).toBe(false);
        expect(reading.nextCursor).toBeNull();
      }
    });

    it("reads 3 posts per page on anyapi.facebook.user.posts with nextCursor", () => {
      const postsEndpointId = "anyapi.facebook.user.posts";
      const cfg = missionPageOf(postsEndpointId);
      expect(cfg).toBeDefined();
      expect(cfg).toMatchObject({
        listPath: "output.data.posts",
        nextPath: "output.data.nextCursor",
        cursorParam: "cursor",
        cursorType: "string",
      });

      const body = {
        output: {
          data: {
            posts: [
              { id: "p1", text: "post 1", url: "https://facebook.com/post/1" },
              { id: "p2", text: "post 2", url: "https://facebook.com/post/2" },
              { id: "p3", text: "post 3", url: "https://facebook.com/post/3" },
            ],
            nextCursor: "cursor_p2",
          },
        },
      };
      const hints = { ...hintsOf(mockEndpoint(postsEndpointId)), missionPage: cfg };
      const reading = readShape(body, hints);
      expect(reading.rows).toHaveLength(3);
      expect(reading.nextCursor).toBe("cursor_p2");
    });
  });

  describe("T8: Reviewed metadata survives drift refresh", () => {
    it("preserves missionPage and missionListedServices across runProviderSync rebuild", async () => {
      const targetEndpoint = "tikhub.tiktok.search.videos";
      const dummyGoneId = "gone.service.with.mission.page";

      const baselineWithGone: ProviderBaseline = {
        ...baseline,
        treg: {
          ...baseline.treg,
          contracts: {
            ...baseline.treg.contracts,
            [dummyGoneId]: {
              id: dummyGoneId,
              provider: "gone",
              capability: "gone.capability",
              inputs: [],
              costUsd: 0.01,
              costType: "per_call",
              listPath: "data.items",
              cursorPath: null,
              itemFields: null,
              status: null,
              supersededBy: null,
              blocked: false,
              blockedBy: null,
              policy: "public",
              missionPage: {
                listPath: "data.items",
                nextPath: "data.next",
                cursorParam: "cursor",
                cursorType: "string",
              },
            },
          },
        },
      };

      const mockFetcher = async (url: string) => {
        if (url.includes("/catalog/endpoints/")) {
          const id = url.split("/").pop()!;
          if (id === targetEndpoint) {
            // Live returns updated endpoint without missionPage
            return {
              ok: true as const,
              status: 200,
              text: JSON.stringify({
                endpoint: {
                  id: targetEndpoint,
                  provider: "tikhub",
                  capability: "tiktok.search.videos",
                  inputs: [],
                  cost_usd: "0.002",
                  cost_type: "per_call",
                  list_path: "data.search_item_list",
                  cursor_path: "data.cursor",
                },
              }),
            };
          }
          if (id === dummyGoneId) {
            return { ok: true as const, status: 404, text: JSON.stringify({ detail: { error: "unknown endpoint" } }) };
          }
        }
        return { ok: false as const, status: 500, error: "not mocked" };
      };

      const report = await runProviderSync({
        registry: {
          ...registry,
          capabilities: registry.capabilities.filter((c) => c.id === targetEndpoint),
        },
        snapshot,
        writeIds,
        baseline: baselineWithGone,
        fetchText: mockFetcher,
        date: "2026-11-20",
      });

      const nextContracts = report.baselineNext.treg.contracts;
      // 1. Target endpoint preserved its reviewed missionPage
      expect(nextContracts[targetEndpoint]?.missionPage).toBeDefined();
      expect(nextContracts[targetEndpoint]?.missionPage?.listPath).toBe("data.search_item_list");

      // 2. Gone endpoint that fell out of registry was preserved because it had missionPage
      expect(nextContracts[dummyGoneId]?.missionPage).toBeDefined();

      // 3. missionListedServices was copied from baseline
      expect(report.baselineNext.treg.missionListedServices).toEqual(baselineWithGone.treg.missionListedServices);
    });

    it("loads runtime shape options directly from committed JSON without hardcoded table", () => {
      const endpoints = [
        "tikhub.tiktok.search.videos",
        "tikhub.tiktok.video.comments",
        "tikhub.youtube.video.comments",
        "scrapecreators.x.v1-facebook-post-comments",
        "anyapi.facebook.user.posts",
      ];
      for (const id of endpoints) {
        const cfg = missionPageOf(id);
        expect(cfg).toBeDefined();
        expect(cfg?.listPath).toBeTruthy();
        expect(cfg?.cursorParam).toBeTruthy();
      }
    });
  });
});

type FundedStageInput = StagePriceInput & {
  stageKey: string;
  parentKey: string | null;
  executionFunding: Array<{ rowsPerPage: number; callUsdMicro: number; mode: "paged" | "one_shot" }>;
  listedRate?: { unitPoints: number; nounAr: string };
};

function thinCommentPricing(): FundedStageInput[] {
  const unitPoints = buildPriceRows().find((row) => row.id === "facebook-comments")!.unitPricePoints;
  return [
    {
      stageKey: "posts", parentKey: null, rows: 20, costPerRowUsd: 0.002 / 3, deliver: false,
      executionFunding: [{ rowsPerPage: 3, callUsdMicro: 2_000, mode: "paged" }],
    },
    {
      stageKey: "comments", parentKey: "posts", rows: 200, costPerRowUsd: 0.00188 / 2, deliver: true,
      listedRate: { unitPoints, nounAr: "تعليق" },
      executionFunding: [{ rowsPerPage: 2, callUsdMicro: 1_880, mode: "paged" }],
    },
  ];
}

function fundedCommentPlan(): PricedPlan {
  const plan = pricedTwoStagePlan();
  const [posts, comments] = plan.stages;
  const [parent, child] = thinCommentPricing();
  const engine: EngineSpec & { fill_total_across_parents: true } = {
    endpoint_id: comments.endpoint_id,
    params: {},
    cursor_param: "cursor",
    map_code: "return []",
    map_file_id: "out_0002",
    parent_binding: { param: "url", from: "url" },
    fill_total_across_parents: true,
  };
  Object.assign(posts, {
    deliver: false, measured_cost_per_row_usd: parent.costPerRowUsd, execution_funding: parent.executionFunding,
  });
  Object.assign(comments, {
    engine, measured_cost_per_row_usd: child.costPerRowUsd,
    execution_funding: child.executionFunding, listed_rate: child.listedRate,
  });
  delete comments.per_parent_rows;
  plan.summary_ar = "ستحصل على ٢٠٠ تعليق.";
  plan.quantity = { requested: 200, target: 200, stage_key: comments.key, source: "edit" };
  plan.price = priceMissionByCode(stagePriceInputs(plan.stages));
  return plan;
}

describe("DT-20261120-social listed rates and funding", () => {
  beforeEach(() => vi.stubEnv("JOB_MAX_POINTS_CAP", "1000"));
  afterEach(() => vi.unstubAllEnvs());
  it("funds the thin-page replay while keeping the listed charge", () => {
    const stages = thinCommentPricing();
    const price = priceMissionByCode(stages);
    expect(price).toMatchObject({
      ruleUnitPoints: 1.034, reservePoints: 752, maxChargePoints: 207, executionFundingApplied: true, overCap: false,
    });
    const fullScheduleCost = 14 * 0.002 + 276 * 0.00188;
    expect(executionBudgetUsd(price.reservePoints)).toBeGreaterThanOrEqual(fullScheduleCost);
    expect(priceMissionByCode(stages, { capPoints: 751 }).overCap).toBe(true);
  });

  it.each([
    [200, 207], [88, 91], [0, 0],
  ])("seals the card and charges %i delivered units at the quoted basis", async (delivered, charged) => {
    const plan = fundedCommentPlan();
    const money = fakeMoneyClient();
    const card = customerPlanView(plan);
    const approval = await approveMission(money.client, { id: "msn_social_funding", user_id: "synthetic", plan });
    expect(approval).toMatchObject({ ok: true, reservePoints: 752, unitPricePoints: 1.034 });
    if (!approval.ok) throw new Error(approval.code);
    expect(card.price).toMatchObject({
      listed_rate: { unit_points: 1.034, noun_ar: "تعليق" },
      execution_funding_applied: true, reserve_points: 752, max_charge_points: 207,
    });
    const facts = priceFactsOf(card);
    expect(facts.facts[0]).toEqual({ labelAr: "سعر الوحدة قبل الحد الأدنى", valueAr: "حوالي ١٠٣٫٤ نقطة لكل ١٠٠ تعليق" });
    const explain = priceExplainOf(card);
    expect(explain).toContain("الحجز المؤقت ٧٥٢ نقطة لتغطية جمع العدد المخطط. أقصى سعر للتسليم الكامل ٢٠٧ نقطة، ويُحرَّر ما لا يُستخدم من الحجز.");
    for (const text of [...facts.facts.flatMap(({ labelAr, valueAr }) => [labelAr, valueAr]), ...explain]) {
      expect(checkCustomerText(text).issues, text).toEqual([]);
    }
    const settled = await settleMission(money.client, {
      jobId: approval.jobId, unitPricePoints: approval.unitPricePoints, reservedPoints: approval.reservePoints,
      deliveredUnits: delivered, costUsd: 0.014 + Math.ceil(delivered / 2) * 0.00188,
      resultPath: delivered ? "synthetic/social.xlsx" : null,
    });
    expect(settled).toMatchObject({ ok: true, chargedPoints: charged, releasedPoints: 752 - charged });
    expect(money.balance()).toBe(100_000 - charged);
  });

  it("re-prices a total-only count edit without expanding the parent count", () => {
    const plan = fundedCommentPlan();
    const edited = applyPlanEdits(plan, { count: 201 });
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error(edited.errorAr);
    expect(edited.plan.stages.map((stage) => stage.planned_rows)).toEqual([20, 201]);
    expect(edited.plan.price).toMatchObject({ ruleUnitPoints: 1.034, reservePoints: 758, maxChargePoints: 208 });
    expect(repriceStoredPlan(edited.plan)).toEqual(edited.plan.price);
  });

  it.each([
    { id: "youtube-comments", rows: 300, noun: "تعليق", full: 200 },
    { id: "tiktok-comments", rows: 300, noun: "تعليق", full: 200 },
    { id: "facebook-posts", rows: 50, noun: "منشور", full: 200 },
    { id: "youtube-videos", rows: 20, noun: "فيديو", full: 200 },
  ])("preserves the full-delivery minimum at the $id public rate", ({ id, rows, noun, full }) => {
    const publicRate = buildPriceRows().find((row) => row.id === id)!.unitPricePoints;
    const stage: FundedStageInput = {
      stageKey: "deliver", parentKey: null, rows, costPerRowUsd: 0.002, deliver: true,
      listedRate: { unitPoints: publicRate, nounAr: noun },
      executionFunding: [{ rowsPerPage: 20, callUsdMicro: 2_000, mode: "paged" }],
    };
    const price = priceMissionByCode([stage]);
    expect(price).toMatchObject({ ruleUnitPoints: publicRate, maxChargePoints: full, reservePoints: full });
    expect(priceMissionByCode([{ ...stage, costPerRowUsd: 0.004 }])).toMatchObject({
      ruleUnitPoints: publicRate, providerCostUsd: 0.004 * rows,
    });
  });

  it("keeps the legacy cost-based quote on a mixed-delivery edit", () => {
    const stages = thinCommentPricing();
    stages[0].deliver = true;
    const unmarked = stages.map(({ listedRate: _rate, executionFunding: _funding, ...stage }) => stage);
    expect(priceMissionByCode(stages)).toEqual(priceMissionByCode(unmarked));
  });

  it("quotes a new 20-video job at the listed five-point rate and settles the existing minimum", async () => {
    const endpoint = "tikhub.youtube.search.videos";
    const request = "هات ٢٠ فيديو من يوتيوب عن الفلك";
    const modelAnswers: Record<string, unknown> = {
      request_plan: {
        decision: "plan", understanding_ar: request,
        steps: [{
          key: "videos", title_ar: "الفيديوهات", platform: "youtube", capability: "youtube.search.videos",
          parent: null, deliver: true, count: { total: 20, per_parent: null, all: false },
          source: null, topic: "الفلك", search_terms: ["الفلك"], period: null,
        }],
      },
      tool_choice: { options: [{ endpoint_id: endpoint, params: { keyword: "الفلك" }, cursor_input: "continuation_token", parent_input: null }] },
      field_map: { fields: { id: ["video_id"], text: ["title"], link: ["url"] }, extra: [] },
    };
    const plannerModel: PlannerModel = async ({ tool }) => ({ input: modelAnswers[tool.name], costUsd: 0 });
    const page = catalogPage(endpoint, Array.from({ length: 20 }, (_, i) => ({
      video_id: `video${String(i).padStart(6, "0")}`,
      title: `فيديو عن الفلك ${i}`,
      url: `https://www.youtube.com/watch?v=video${String(i).padStart(6, "0")}`,
    })));
    const answer = tregResult(page, 0.002);
    const result = await replay({ request, planning: [], execution: () => [], answers: [answer, answer], beforeChat: seedFullWallet, deps: (base) => ({ ...base, plannerModel }) });
    const publicRate = buildPriceRows().find((row) => row.id === "youtube-videos")!.unitPricePoints;
    expect(result.plannedPlan.price).toMatchObject({
      ruleUnitPoints: publicRate, unitPricePoints: 10, reservePoints: 200, maxChargePoints: 200,
    });
    expect(result.planView.priceFacts).toContainEqual({ labelAr: "سعر الوحدة قبل الحد الأدنى", valueAr: "٥ نقطة لكل فيديو" });
    expect(result.mission).toMatchObject({ status: "completed", delivered_units: 20, charged_points: 200 });
    expect((await readWorkbook(result)).getWorksheet("الفيديوهات")?.actualRowCount).toBe(21);
  });

  it.each([
    { scenario: "productive pages", paidTails: false, totalCalls: 100 },
    { scenario: "paid empty parent tails", paidTails: true, totalCalls: 138 },
  ])("delivers 200 comments at the approved hold with $scenario", async ({ paidTails, totalCalls }) => {
    const { posts, comments, request, plannerModel, page } = thinCommentWorld(paidTails);
    const result = await replay({
      request, planning: [], execution: () => [], answers: Array.from({ length: 160 }, () => page),
      beforeChat: seedFullWallet,
      deps: (base) => ({ ...base, plannerModel }),
    });
    expect(result.plannedPlan.price).toMatchObject({ ruleUnitPoints: 1.034, reservePoints: 752, maxChargePoints: 207 });
    expect(result.mission).toMatchObject({ status: "completed", delivered_units: 200, charged_points: 207 });
    const execution = (await result.store.listCalls(result.missionId)).filter((call) => call.phase === "execution");
    expect(execution.filter((call) => call.endpoint_id === posts)).toHaveLength(7);
    const childCalls = execution.filter((call) => call.endpoint_id === comments);
    expect(childCalls).toHaveLength(totalCalls);
    expect(result.money.ledger.filter((row) => row.type !== "topup").map(({ type, delta }) => [type, delta]))
      .toEqual([["reserve", -752], ["release", 752], ["charge", -207]]);
    expect(result.money.balance()).toBe(result.initialBalance - 207);
    expect(new Set(childCalls.map(({ params_digest }) => JSON.stringify([params_digest.url, params_digest.cursor]))).size).toBe(totalCalls);
    expect((await readWorkbook(result)).getWorksheet("التعليقات")?.actualRowCount).toBe(201);
  });

  it.each([
    { limit: "wallet", cap: 1000, wallet: 327, option: ["جهّز ٣٦"], phrase: "حتى ٣٦ بحجز مؤقت ٣٢٣ نقطة" },
    { limit: "job cap", cap: 300, wallet: 1000, option: ["جهّز ٣١"], phrase: "حتى ٣١ بحجز مؤقت ٢٩٧ نقطة" },
    { limit: "minimum", cap: 199, wallet: 1000, option: [], phrase: "اكتب عددًا أقل لنحسب لك الحجز المؤقت." },
  ])("asks before placing a hold when the $limit cannot fund the schedule", async ({ cap, wallet, option, phrase }) => {
    vi.stubEnv("JOB_MAX_POINTS_CAP", String(cap));
    const { request, plannerModel, page } = thinCommentWorld();
    const mission = newMission({ id: "msn_social_affordability", user_id: REPLAY_USER, request_text: request, status: "planning" });
    const store = createMemoryStore([mission]);
    const db = createMemoryDb();
    const money = fakeMoneyClient({ balance: wallet });
    db.seed("credit_ledger", [{ user_id: REPLAY_USER, delta: wallet }]);
    const { client } = replayClient(db, money);
    const { recorder, commit } = fakeRecorder({ dailyCapUsd: 5 });
    await runPlanning({
      store, client, recorder, commit, catalog: loadTregCatalog(), call: async (args) => page(args),
      plannerModel, driver: createFakeDriver([]), resolveAccess: async () => NOT_ADMIN,
      models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" },
    }, mission);
    const current = await store.getMission(mission.id);
    expect(current).toMatchObject({ status: "needs_input", plan_public: { question_options: option }, job_id: null });
    expect(current?.question_ar).toContain(phrase);
    expect(money.ledger.map((row) => row.type)).toEqual(["topup"]);
    expect(money.calls).toEqual([]);
    expect(money.balance()).toBe(wallet);
  });

  it("rechecks the funded schedule and balance before a hold", async () => {
    const plan = fundedCommentPlan();
    const money = fakeMoneyClient({ balance: 327 });
    const stale = { ...plan, price: { ...plan.price, reservePoints: 327 } };
    const mission = { id: "msn_social_stale_hold", user_id: REPLAY_USER };
    expect(await approveMission(money.client, { ...mission, plan: stale })).toMatchObject({ ok: false, code: "plan_changed" });
    expect(money.calls).toEqual([]);
    expect(await approveMission(money.client, { ...mission, plan })).toMatchObject({ ok: false, code: "insufficient_balance" });
    expect(money.ledger.map((row) => row.type)).toEqual(["topup"]);
  });
});

function seedFullWallet(db: ReturnType<typeof createMemoryDb>): void {
  db.seed("credit_ledger", [{ user_id: REPLAY_USER, delta: 100_000 }]);
}

function thinCommentWorld(paidTails = false) {
  const posts = "anyapi.facebook.user.posts";
  const comments = "scrapecreators.x.v1-facebook-post-comments";
  const source = "https://www.facebook.com/synthetic-page";
  const request = "هات ٢٠٠ تعليق على ٢٠ منشور من صفحة المرصد على فيسبوك";
  const modelAnswers: Record<string, unknown[]> = {
    request_plan: [{
      decision: "plan", understanding_ar: request,
      steps: [
        { key: "posts", title_ar: "المنشورات", platform: "facebook", capability: "facebook.user.posts", parent: null, deliver: false, count: { total: 20, per_parent: null, all: false }, source: { kind: "page", value: source }, topic: null, search_terms: [], period: null },
        { key: "comments", title_ar: "التعليقات", platform: "facebook", capability: "facebook.post.comments", parent: "posts", deliver: true, count: { total: 200, per_parent: null, all: false }, source: null, topic: null, search_terms: [], period: null },
      ],
    }],
    tool_choice: [
      { options: [{ endpoint_id: posts, params: { url: source }, parent_input: null }] },
      { options: [{ endpoint_id: comments, params: {}, parent_input: { param: "url", from_field: "link" } }] },
    ],
    field_map: [
      { fields: { id: ["id"], text: ["text"], link: ["url"] }, extra: [] },
      { fields: { id: ["id"], text: ["text"] }, extra: [] },
    ],
  };
  const plannerModel: PlannerModel = async ({ tool }) => ({ input: modelAnswers[tool.name]?.shift(), costUsd: 0 });
  const page = ({ endpointId, params }: Pick<TregCallOptions, "endpointId" | "params">) => {
    const cursor = params?.cursor ?? "0";
    const position = Number(cursor);
    if (endpointId === posts) {
      expect(params?.url).toBe(source);
      return tregResult({ output: { data: {
        posts: Array.from({ length: Math.min(3, 20 - position) }, (_, i) => ({
          id: `post${position + i}`, text: "منشور تجريبي", url: `${source}/posts/${position + i}`,
        })),
        nextCursor: position + 3 < 20 ? String(position + 3) : null,
      } } }, 0.002);
    }
    expect(endpointId).toBe(comments);
    const parent = String(params?.url).split("/").at(-1);
    if (paidTails && parent !== "19" && position > 0) {
      return tregResult({ comments: [], cursor: String(position + 2), has_next_page: position === 2 }, 0.00188);
    }
    const end = paidTails && parent === "19" ? 162 : 10;
    return tregResult({
      comments: [0, 1].map((i) => ({ id: `comment${parent}-${position + i}`, text: "تعليق تجريبي" })),
      cursor: String(position + 2), has_next_page: position + 2 < end,
    }, 0.00188);
  };
  return { posts, comments, request, plannerModel, page };
}
