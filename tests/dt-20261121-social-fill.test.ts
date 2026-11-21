import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTregCatalog, type CatalogEndpoint } from "../src/lib/treg/catalog";
import { hintsOf, missionPageOf, readShape } from "../src/lib/treg/shapeReader";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { planWithLlm } from "../agent/src/llmPlanner/planner";
import { ItemStore } from "../agent/src/items/itemStore";
import { createMemoryStore } from "../agent/src/memoryStore";
import { runEngine } from "../agent/src/engine/run";
import { RAW_PATH, type Gateway } from "../agent/src/gateway";
import { buildMissionFiles } from "../agent/src/workbook";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { buildPriceRows } from "../src/lib/pricingPage";
import { stagePriceInputs, type EngineSpec, type PricedPlan } from "../src/lib/agentMission/plan";
import { approveMission, settleMission } from "../src/lib/agentMission/lifecycle";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { pricedTwoStagePlan } from "./helpers/agentPlan";
import { cellsOf } from "./helpers/round11Worlds";
import { parentCountsOf } from "../src/lib/agentMission/parents";
import { shortfallClauseAr } from "../agent/src/finalize";

const mockEndpoint = (id: string, over: Partial<CatalogEndpoint> = {}): CatalogEndpoint => ({
  id,
  capability: "social.comments",
  method: "POST",
  path: "/test",
  description: "test",
  cost_usd_micro: 2000,
  latency_ms: 500,
  list_path: null,
  cursor_path: null,
  example_response_trimmed: null,
  item_fields: null,
  inputs: [],
  pagination: [],
  headers: {},
  body_format: "json",
  ...over,
} as unknown as CatalogEndpoint);

describe("DT-20261121-social-fill test suite", () => {
  beforeEach(() => vi.stubEnv("JOB_MAX_POINTS_CAP", "25000"));
  afterEach(() => vi.unstubAllEnvs());

  const catalog = loadTregCatalog();

  describe("1. TikTok Baseline Replay (unchanged behavior per D-0166)", () => {
    it("delivers 237, bills for 237 only at listed rate, 0 extra parent calls, per-parent cap strictly enforced", async () => {
      const plan = pricedTwoStagePlan();
      const [videos, comments] = plan.stages;

      videos.key = "videos";
      videos.endpoint_id = "tikhub.tiktok.search.videos";
      videos.title_ar = "الفيديوهات";
      videos.deliver = false;
      videos.planned_rows = 20;
      videos.expected_rows = 20;
      videos.columns = [{ key: "id", title_ar: "المعرف" }, { key: "link", title_ar: "الرابط" }, { key: "caption", title_ar: "الوصف" }];
      videos.execution_funding = [{ rowsPerPage: 20, callUsdMicro: 2000, mode: "paged" }];
      videos.engine = {
        endpoint_id: "tikhub.tiktok.search.videos",
        params: { keyword: "test" },
        cursor_param: null,
        map_code: "return inputs.page",
        map_file_id: "p1",
        parent_binding: null,
      };

      const unitPoints = 1.0;
      comments.key = "comments";
      comments.endpoint_id = "tikhub.tiktok.video.comments";
      comments.title_ar = "التعليقات";
      comments.parent_key = "videos";
      comments.per_parent_rows = 15;
      comments.planned_rows = 300;
      comments.expected_rows = 300;
      comments.deliver = true;
      comments.columns = [{ key: "id", title_ar: "المعرف" }, { key: "parent_id", title_ar: "المنشور" }, { key: "text", title_ar: "النص" }];
      comments.listed_rate = { unitPoints, nounAr: "تعليق" };
      comments.execution_funding = [{ rowsPerPage: 15, callUsdMicro: 1880, mode: "paged" }];
      comments.engine = {
        endpoint_id: "tikhub.tiktok.video.comments",
        params: {},
        cursor_param: null,
        map_code: "return inputs.page",
        map_file_id: "p2",
        parent_binding: { param: "video_id", from: "id" },
      };

      plan.summary_ar = "ستحصل على تعليقات تيك توك.";
      plan.quantity = { requested: 300, target: 300, stage_key: comments.key, source: "edit" };
      plan.price = priceMissionByCode(stagePriceInputs(plan.stages));

      const store = createMemoryStore();
      const parentCalls: Array<Record<string, unknown>> = [];
      let seq = 0;

      // 20 videos: videos 1..15 return 100 comments, 16..20 return fewer (3, 4, 2, 1, 2)
      // Total delivered = 15 * 15 (225) + 3 + 4 + 2 + 1 + 2 = 237
      const childCounts = [
        ...Array(15).fill(100),
        3, 4, 2, 1, 2,
      ];

      const gateway: Gateway = {
        async tregCall(input: any) {
          const ep = String(input.endpoint_id);
          const params = (input.params ?? {}) as Record<string, unknown>;
          let rows: Array<Record<string, unknown>>;
          if (ep === "tikhub.tiktok.search.videos") {
            parentCalls.push(params);
            rows = Array.from({ length: 20 }, (_, i) => ({
              id: `v_${i + 1}`,
              link: `https://www.tiktok.com/@u/video/${i + 1}`,
              caption: `فيديو ${i + 1}`,
            }));
          } else {
            const parentId = String(params.video_id);
            const pIdx = parseInt(parentId.replace("v_", ""), 10) - 1;
            const count = childCounts[pIdx] ?? 0;
            rows = Array.from({ length: count }, (_, k) => ({
              id: `${parentId}_c${k + 1}`,
              parent_id: parentId,
              text: `تعليق ${k + 1} على ${parentId}`,
            }));
          }
          const callId = `call_${String(++seq).padStart(4, "0")}`;
          await store.putFile("msn_tt", RAW_PATH(callId), JSON.stringify(rows), "application/json");
          return { ok: true, call_id: callId, http_status: 200, rows_in_page: rows.length, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "" };
        },
      } as unknown as Gateway;

      const money = fakeMoneyClient();
      const approval = await approveMission(money.client, { id: "msn_tt", user_id: "user1", plan });
      expect(approval.ok).toBe(true);
      if (!approval.ok) throw new Error(approval.code);

      const items = await ItemStore.open(store, "msn_tt");
      await runEngine({
        items,
        store,
        plan,
        missionId: "msn_tt",
        gateway,
        sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }),
        addEvent: async () => undefined,
        deadlineMs: Date.now() + 3_600_000,
        sleep: async () => undefined,
        redesignStages: new Set(["videos", "comments"]),
        fundingSchedule: new Map([
          ["videos", { calls: 14, costUsdMicro: 2000 }],
          ["comments", { calls: 100, costUsdMicro: 1880 }],
        ]),
      });

      const delivered = items.acceptedRows("comments");
      expect(delivered.length).toBe(237);

      // Verify per-parent cap strictly enforced on each video (1..15 have exactly 15)
      for (let i = 1; i <= 15; i++) {
        const vComments = delivered.filter((r) => r.parent_id === `v_${i}`);
        expect(vComments.length).toBe(15);
      }
      expect(delivered.filter((r) => r.parent_id === "v_16").length).toBe(3);
      expect(delivered.filter((r) => r.parent_id === "v_17").length).toBe(4);
      expect(delivered.filter((r) => r.parent_id === "v_18").length).toBe(2);
      expect(delivered.filter((r) => r.parent_id === "v_19").length).toBe(1);
      expect(delivered.filter((r) => r.parent_id === "v_20").length).toBe(2);

      // 0 extra parent calls (parent had exactly 1 dispatch)
      expect(parentCalls.length).toBe(1);

      // Settle mission: billed for 237 only at listed rate
      const settled = await settleMission(money.client, {
        jobId: approval.jobId,
        unitPricePoints: approval.unitPricePoints,
        reservedPoints: approval.reservePoints,
        deliveredUnits: delivered.length,
        costUsd: 0.05,
        resultPath: "results.xlsx",
      });
      expect(settled.ok).toBe(true);
      if (!settled.ok) throw new Error(settled.code);
      const expectedCharge = Math.ceil(237 * (approval.unitPricePoints ?? unitPoints));
      expect(settled.chargedPoints).toBe(expectedCharge);
    });
  });

  describe("2. Capped Case with Stale Fill Flag (P0 regression counter-case)", () => {
    it("never expands parent when per_parent_rows is numeric even with fill_total_across_parents: true and live cursor", async () => {
      const plan = pricedTwoStagePlan();
      const [videos, comments] = plan.stages;

      videos.key = "videos";
      videos.endpoint_id = "videos_ep";
      videos.deliver = false;
      videos.planned_rows = 20;
      videos.expected_rows = 20;
      videos.columns = [{ key: "id", title_ar: "المعرف" }, { key: "link", title_ar: "الرابط" }, { key: "caption", title_ar: "الوصف" }];
      videos.execution_funding = [{ rowsPerPage: 3, callUsdMicro: 2000, mode: "paged" }];
      videos.engine = {
        endpoint_id: "videos_ep",
        params: { keyword: "test" },
        cursor_param: "cursor",
        map_code: "return inputs.page",
        map_file_id: "p1",
        parent_binding: null,
      };

      comments.key = "comments";
      comments.endpoint_id = "comments_ep";
      comments.parent_key = "videos";
      comments.per_parent_rows = 15; // EXPLICIT NUMERIC CAP
      comments.planned_rows = 300;
      comments.expected_rows = 300;
      comments.deliver = true;
      comments.columns = [{ key: "id", title_ar: "المعرف" }, { key: "parent_id", title_ar: "المنشور" }, { key: "text", title_ar: "النص" }];
      comments.listed_rate = { unitPoints: 1.0, nounAr: "تعليق" };
      comments.execution_funding = [{ rowsPerPage: 15, callUsdMicro: 1880, mode: "paged" }];
      comments.engine = {
        endpoint_id: "comments_ep",
        params: {},
        cursor_param: null,
        map_code: "return inputs.page",
        map_file_id: "p2",
        parent_binding: { param: "video_id", from: "id" },
        fill_total_across_parents: true, // STALE FLAG FROM BASE EDITOR
      };

      plan.summary_ar = "خطة مجتزأة مع وسام قديم.";
      plan.quantity = { requested: 300, target: 300, stage_key: comments.key, source: "edit" };
      plan.price = priceMissionByCode(stagePriceInputs(plan.stages));

      const store = createMemoryStore();
      const parentCalls: Array<Record<string, unknown>> = [];
      let seq = 0;

      const childCounts = [
        ...Array(15).fill(100),
        3, 4, 2, 1, 2,
      ];

      const gateway: Gateway = {
        async tregCall(input: any) {
          const ep = String(input.endpoint_id);
          const params = (input.params ?? {}) as Record<string, unknown>;
          let rows: Array<Record<string, unknown>>;
          if (ep === "videos_ep") {
            parentCalls.push(params);
            rows = Array.from({ length: 20 }, (_, i) => ({
              id: `v_${i + 1}`,
              link: `https://www.tiktok.com/@u/video/${i + 1}`,
              caption: `فيديو ${i + 1}`,
            }));
          } else {
            const parentId = String(params.video_id);
            const pIdx = parseInt(parentId.replace("v_", ""), 10) - 1;
            const count = childCounts[pIdx] ?? 0;
            rows = Array.from({ length: count }, (_, k) => ({
              id: `${parentId}_c${k + 1}`,
              parent_id: parentId,
              text: `تعليق ${k + 1}`,
            }));
          }
          const callId = `call_${String(++seq).padStart(4, "0")}`;
          await store.putFile("msn_stale", RAW_PATH(callId), JSON.stringify(rows), "application/json");
          return { ok: true, call_id: callId, http_status: 200, rows_in_page: rows.length, has_more: true, next_cursor: "cur_p2", shape: null, first_rows: [], warnings: [], saved: "" };
        },
      } as unknown as Gateway;

      const items = await ItemStore.open(store, "msn_stale");
      await runEngine({
        items,
        store,
        plan,
        missionId: "msn_stale",
        gateway,
        sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }),
        addEvent: async () => undefined,
        deadlineMs: Date.now() + 3_600_000,
        sleep: async () => undefined,
        redesignStages: new Set(["videos", "comments"]),
        fundingSchedule: new Map([
          ["videos", { calls: 14, costUsdMicro: 2000 }],
          ["comments", { calls: 100, costUsdMicro: 1880 }],
        ]),
      });

      // 0 expansion calls: parent dispatched exactly 1 call (initial)
      expect(parentCalls.length).toBe(1);
      expect(items.acceptedRows("comments").length).toBe(237);
    });
  });

  describe("3. Total-Only Facebook Case (flag true, no per-parent cap, funded)", () => {
    it("expands parent pages to reach 200 delivered comments within funding schedule and ledger caps", async () => {
      const plan = pricedTwoStagePlan();
      const [posts, comments] = plan.stages;

      const unitPoints = 1.034;
      posts.endpoint_id = "anyapi.facebook.user.posts";
      posts.deliver = false;
      posts.planned_rows = 20;
      posts.expected_rows = 20;
      posts.columns = [{ key: "text", title_ar: "النص" }, { key: "link", title_ar: "الرابط" }];
      posts.measured_cost_per_row_usd = 0.002 / 3;
      posts.execution_funding = [{ rowsPerPage: 3, callUsdMicro: 2000, mode: "paged" }];
      posts.engine = {
        endpoint_id: "anyapi.facebook.user.posts",
        params: {},
        cursor_param: "cursor",
        map_code: "return inputs.p1",
        map_file_id: "p1",
        parent_binding: null,
        catalog_paging: true,
      };

      comments.endpoint_id = "fb_comments";
      comments.parent_key = "posts";
      comments.planned_rows = 200;
      comments.expected_rows = 200;
      comments.deliver = true;
      comments.columns = [{ key: "id", title_ar: "المعرف" }, { key: "parent_id", title_ar: "المنشور" }, { key: "text", title_ar: "النص" }, { key: "url", title_ar: "الرابط" }];
      comments.measured_cost_per_row_usd = 0.00188 / 2;
      comments.listed_rate = { unitPoints, nounAr: "تعليق" };
      comments.execution_funding = [{ rowsPerPage: 2, callUsdMicro: 1880, mode: "paged" }];
      delete comments.per_parent_rows;
      comments.engine = {
        endpoint_id: "fb_comments",
        params: {},
        cursor_param: "cursor",
        map_code: "return inputs.page",
        map_file_id: "p2",
        parent_binding: { param: "url", from: "link" },
        fill_total_across_parents: true,
        catalog_paging: true,
      };

      plan.summary_ar = "ستحصل على ٢٠٠ تعليق من فيسبوك.";
      plan.quantity = { requested: 200, target: 200, stage_key: comments.key, source: "edit" };
      plan.price = priceMissionByCode(stagePriceInputs(plan.stages));

      const store = createMemoryStore();
      const parentCalls: Array<Record<string, unknown>> = [];
      const childCalls: Array<Record<string, unknown>> = [];
      let seq = 0;

      const postsPerPage: Record<number, Array<{ id: string; link: string }>> = {
        1: [{ id: "p1", link: "l1" }, { id: "p2", link: "l2" }, { id: "p3", link: "l3" }],
        2: [{ id: "p4", link: "l4" }, { id: "p5", link: "l5" }, { id: "p6", link: "l6" }],
        3: [{ id: "p7", link: "l7" }, { id: "p8", link: "l8" }, { id: "p9", link: "l9" }],
        4: [{ id: "p10", link: "l10" }, { id: "p11", link: "l11" }, { id: "p12", link: "l12" }],
        5: [{ id: "p13", link: "l13" }, { id: "p14", link: "l14" }, { id: "p15", link: "l15" }],
        6: [{ id: "p16", link: "l16" }, { id: "p17", link: "l17" }, { id: "p18", link: "l18" }],
        7: [{ id: "p19", link: "l19" }],
        8: [{ id: "p20", link: "l20" }],
        9: [{ id: "p20", link: "l20" }], // Duplicate page: repeats post 20 and points to page 10
        10: [{ id: "p21", link: "l21" }, { id: "p22", link: "l22" }, { id: "p23", link: "l23" }, { id: "p24", link: "l24" }, { id: "p25", link: "l25" }], // 5 new posts x 8 comments
      };

      const gateway: Gateway = {
        async tregCall(input: any) {
          const ep = String(input.endpoint_id);
          const params = (input.params ?? {}) as Record<string, unknown>;
          let rows: Array<Record<string, unknown>>;
          let nextCursor: string | null = null;
          let hasMore = true;

          const callId = `call_${String(++seq).padStart(4, "0")}`;
          if (ep === "anyapi.facebook.user.posts") {
            parentCalls.push(params);
            const pageNum = params.cursor ? parseInt(String(params.cursor).replace("page_", ""), 10) : 1;
            rows = (postsPerPage[pageNum] ?? []).map((p) => ({ ...p, text: `نص المنشور ${p.id}` }));
            nextCursor = pageNum < 10 ? `page_${pageNum + 1}` : null;
            hasMore = pageNum < 10;
            const envelope = { output: { data: { posts: rows, nextCursor } } };
            await store.putFile("msn_fb", RAW_PATH(callId), JSON.stringify(envelope), "application/json");
          } else {
            childCalls.push(params);
            const url = String(params.url);
            const postNum = parseInt(url.replace("l", ""), 10);
            const count = postNum <= 2 ? 9 : 8;
            rows = Array.from({ length: count }, (_, k) => ({
              id: `c_${postNum}_${k + 1}`,
              parent_id: `p${postNum}`,
              text: `تعليق ${k + 1} على p${postNum}`,
              url: `https://facebook.com/c_${postNum}_${k + 1}`,
            }));
            await store.putFile("msn_fb", RAW_PATH(callId), JSON.stringify(rows), "application/json");
          }
          return { ok: true, call_id: callId, http_status: 200, rows_in_page: rows.length, has_more: hasMore, next_cursor: nextCursor, shape: null, first_rows: [], warnings: [], saved: "" };
        },
      } as unknown as Gateway;

      const money = fakeMoneyClient();
      const approval = await approveMission(money.client, { id: "msn_fb", user_id: "user1", plan });
      expect(approval.ok).toBe(true);
      if (!approval.ok) throw new Error(approval.code);

      const items = await ItemStore.open(store, "msn_fb");
      await runEngine({
        items,
        store,
        plan,
        missionId: "msn_fb",
        gateway,
        sandbox: async (_c, inputs) => {
          const val: any = Object.values(inputs)[0];
          const data = Array.isArray(val) ? val : (val?.output?.data?.posts ?? []);
          return { ok: true, resultJson: JSON.stringify(data), logs: [] };
        },
        addEvent: async () => undefined,
        deadlineMs: Date.now() + 3_600_000,
        sleep: async () => undefined,
        redesignStages: new Set(["posts", "comments"]),
      });

      const delivered = items.acceptedRows("comments");
      expect(delivered.length).toBe(200);

      // Parent dispatches <= 14 (production schedule)
      expect(parentCalls.length).toBeLessThanOrEqual(14);
      expect(parentCalls.length).toBeGreaterThan(7);

      // Child dispatches within schedule
      expect(childCalls.length).toBeLessThanOrEqual(276);

      // Settle mission: charged for 200 only at listed rate
      const settled = await settleMission(money.client, {
        jobId: approval.jobId,
        unitPricePoints: approval.unitPricePoints,
        reservedPoints: approval.reservePoints,
        deliveredUnits: 200,
        costUsd: 0.10,
        resultPath: "results.xlsx",
      });
      expect(settled.ok).toBe(true);
      if (!settled.ok) throw new Error(settled.code);
      expect(settled.chargedPoints).toBe(Math.ceil(200 * unitPoints));
      expect(settled.chargedPoints).toBeLessThanOrEqual(approval.reservePoints);

      // Workbook rows = 201 (header + 200)
      const rowsByStage = {
        posts: items.acceptedRows("posts"),
        comments: delivered,
      };
      const files = await buildMissionFiles(plan, rowsByStage);
      const sheets = await cellsOf(files.xlsx);
      const commentSheet = sheets["التعليقات"] ?? sheets[Object.keys(sheets).find((k) => !k.startsWith("ملخص"))!];
      expect(commentSheet.length).toBe(201);

      // stage_1_read >= stage_1_used
      const counts = parentCountsOf(plan, rowsByStage);
      expect(counts.stage_1_read).toBeGreaterThanOrEqual(counts.stage_1_used);
      expect(counts.stage_1_read).toBe(25);
      expect(counts.stage_1_used).toBeGreaterThanOrEqual(25);
    });
  });

  describe("4. Facebook Counter-case A (source exhausted at 162)", () => {
    it("stops gracefully when parent source is exhausted at 162 comments, billing for 162 only", async () => {
      const plan = pricedTwoStagePlan();
      const [posts, comments] = plan.stages;

      const unitPoints = 1.034;
      posts.endpoint_id = "fb_posts";
      posts.deliver = false;
      posts.planned_rows = 20;
      posts.expected_rows = 20;
      posts.columns = [{ key: "text", title_ar: "النص" }, { key: "link", title_ar: "الرابط" }];
      posts.measured_cost_per_row_usd = 0.002 / 3;
      posts.execution_funding = [{ rowsPerPage: 3, callUsdMicro: 2000, mode: "paged" }];
      posts.engine = {
        endpoint_id: "fb_posts",
        params: {},
        cursor_param: "cursor",
        map_code: "return inputs.page",
        map_file_id: "p1",
        parent_binding: null,
      };

      comments.endpoint_id = "fb_comments";
      comments.parent_key = "posts";
      comments.planned_rows = 200;
      comments.expected_rows = 200;
      comments.deliver = true;
      comments.columns = [{ key: "id", title_ar: "المعرف" }, { key: "parent_id", title_ar: "المنشور" }, { key: "text", title_ar: "النص" }, { key: "url", title_ar: "الرابط" }];
      comments.measured_cost_per_row_usd = 0.00188 / 2;
      comments.listed_rate = { unitPoints, nounAr: "تعليق" };
      comments.execution_funding = [{ rowsPerPage: 2, callUsdMicro: 1880, mode: "paged" }];
      delete comments.per_parent_rows;
      comments.engine = {
        endpoint_id: "fb_comments",
        params: {},
        cursor_param: "cursor",
        map_code: "return inputs.page",
        map_file_id: "p2",
        parent_binding: { param: "url", from: "link" },
        fill_total_across_parents: true,
        catalog_paging: true,
      };

      plan.summary_ar = "ستحصل على ٢٠٠ تعليق من فيسبوك.";
      plan.quantity = { requested: 200, target: 200, stage_key: comments.key, source: "edit" };
      plan.price = priceMissionByCode(stagePriceInputs(plan.stages));

      const store = createMemoryStore();
      let seq = 0;

      const postsPerPage: Record<number, Array<{ id: string; link: string }>> = {
        1: [{ id: "p1", link: "l1" }, { id: "p2", link: "l2" }, { id: "p3", link: "l3" }],
        2: [{ id: "p4", link: "l4" }, { id: "p5", link: "l5" }, { id: "p6", link: "l6" }],
        3: [{ id: "p7", link: "l7" }, { id: "p8", link: "l8" }, { id: "p9", link: "l9" }],
        4: [{ id: "p10", link: "l10" }, { id: "p11", link: "l11" }, { id: "p12", link: "l12" }],
        5: [{ id: "p13", link: "l13" }, { id: "p14", link: "l14" }, { id: "p15", link: "l15" }],
        6: [{ id: "p16", link: "l16" }, { id: "p17", link: "l17" }, { id: "p18", link: "l18" }],
        7: [{ id: "p19", link: "l19" }],
        8: [{ id: "p20", link: "l20" }],
      };

      const gateway: Gateway = {
        async tregCall(input: any) {
          const ep = String(input.endpoint_id);
          const params = (input.params ?? {}) as Record<string, unknown>;
          let rows: Array<Record<string, unknown>>;
          let nextCursor: string | null = null;
          let hasMore = true;

          if (ep === "fb_posts") {
            const pageNum = params.cursor ? parseInt(String(params.cursor).replace("page_", ""), 10) : 1;
            rows = (postsPerPage[pageNum] ?? []).map((p) => ({ ...p, text: `منشور ${p.id}` }));
            if (pageNum >= 8) {
              nextCursor = null;
              hasMore = false;
            } else {
              nextCursor = `page_${pageNum + 1}`;
            }
          } else {
            const url = String(params.url);
            const postNum = parseInt(url.replace("l", ""), 10);
            const count = postNum <= 2 ? 9 : 8;
            rows = Array.from({ length: count }, (_, k) => ({
              id: `c_${postNum}_${k + 1}`,
              parent_id: `p${postNum}`,
              text: `تعليق ${k + 1}`,
            }));
          }
          const callId = `call_${String(++seq).padStart(4, "0")}`;
          await store.putFile("msn_ex", RAW_PATH(callId), JSON.stringify(rows), "application/json");
          return { ok: true, call_id: callId, http_status: 200, rows_in_page: rows.length, has_more: hasMore, next_cursor: nextCursor, shape: null, first_rows: [], warnings: [], saved: "" };
        },
      } as unknown as Gateway;

      const money = fakeMoneyClient();
      const approval = await approveMission(money.client, { id: "msn_ex", user_id: "user1", plan });
      expect(approval.ok).toBe(true);
      if (!approval.ok) throw new Error(approval.code);

      const items = await ItemStore.open(store, "msn_ex");
      await runEngine({
        items,
        store,
        plan,
        missionId: "msn_ex",
        gateway,
        sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }),
        addEvent: async () => undefined,
        deadlineMs: Date.now() + 3_600_000,
        sleep: async () => undefined,
        redesignStages: new Set(["posts", "comments"]),
        fundingSchedule: new Map([
          ["posts", { calls: 14, costUsdMicro: 2000 }],
          ["comments", { calls: 100, costUsdMicro: 1880 }],
        ]),
      });

      const delivered = items.acceptedRows("comments");
      expect(delivered.length).toBe(162);
      expect(items.stage("comments").stop).toBe("source_exhausted");

      const settled = await settleMission(money.client, {
        jobId: approval.jobId,
        unitPricePoints: approval.unitPricePoints,
        reservedPoints: approval.reservePoints,
        deliveredUnits: 162,
        costUsd: 0.08,
        resultPath: "results.xlsx",
      });
      expect(settled.ok).toBe(true);
      if (!settled.ok) throw new Error(settled.code);
      expect(settled.chargedPoints).toBe(Math.ceil(162 * unitPoints));
    });

    it("handles repeated-cursor case: page 9 returns the same cursor again without looping endlessly", async () => {
      const plan = pricedTwoStagePlan();
      const [posts, comments] = plan.stages;

      const unitPoints = 1.034;
      posts.endpoint_id = "fb_posts";
      posts.deliver = false;
      posts.planned_rows = 20;
      posts.expected_rows = 20;
      posts.columns = [{ key: "text", title_ar: "النص" }, { key: "link", title_ar: "الرابط" }];
      posts.measured_cost_per_row_usd = 0.002 / 3;
      posts.execution_funding = [{ rowsPerPage: 3, callUsdMicro: 2000, mode: "paged" }];
      posts.engine = {
        endpoint_id: "fb_posts",
        params: {},
        cursor_param: "cursor",
        map_code: "return inputs.page",
        map_file_id: "p1",
        parent_binding: null,
      };

      comments.endpoint_id = "fb_comments";
      comments.parent_key = "posts";
      comments.planned_rows = 200;
      comments.expected_rows = 200;
      comments.deliver = true;
      comments.columns = [{ key: "id", title_ar: "المعرف" }, { key: "parent_id", title_ar: "المنشور" }, { key: "text", title_ar: "النص" }, { key: "url", title_ar: "الرابط" }];
      comments.measured_cost_per_row_usd = 0.00188 / 2;
      comments.listed_rate = { unitPoints, nounAr: "تعليق" };
      comments.execution_funding = [{ rowsPerPage: 2, callUsdMicro: 1880, mode: "paged" }];
      delete comments.per_parent_rows;
      comments.engine = {
        endpoint_id: "fb_comments",
        params: {},
        cursor_param: "cursor",
        map_code: "return inputs.page",
        map_file_id: "p2",
        parent_binding: { param: "url", from: "link" },
        fill_total_across_parents: true,
        catalog_paging: true,
      };

      plan.summary_ar = "ستحصل على ٢٠٠ تعليق من فيسبوك.";
      plan.quantity = { requested: 200, target: 200, stage_key: comments.key, source: "edit" };
      plan.price = priceMissionByCode(stagePriceInputs(plan.stages));

      const store = createMemoryStore();
      const parentCalls: Array<Record<string, unknown>> = [];
      let seq = 0;

      const postsPerPage: Record<number, Array<{ id: string; link: string }>> = {
        1: [{ id: "p1", link: "l1" }, { id: "p2", link: "l2" }, { id: "p3", link: "l3" }],
        2: [{ id: "p4", link: "l4" }, { id: "p5", link: "l5" }, { id: "p6", link: "l6" }],
        3: [{ id: "p7", link: "l7" }, { id: "p8", link: "l8" }, { id: "p9", link: "l9" }],
        4: [{ id: "p10", link: "l10" }, { id: "p11", link: "l11" }, { id: "p12", link: "l12" }],
        5: [{ id: "p13", link: "l13" }, { id: "p14", link: "l14" }, { id: "p15", link: "l15" }],
        6: [{ id: "p16", link: "l16" }, { id: "p17", link: "l17" }, { id: "p18", link: "l18" }],
        7: [{ id: "p19", link: "l19" }],
        8: [{ id: "p20", link: "l20" }],
        9: [{ id: "p20", link: "l20" }],
      };

      const gateway: Gateway = {
        async tregCall(input: any) {
          const ep = String(input.endpoint_id);
          const params = (input.params ?? {}) as Record<string, unknown>;
          let rows: Array<Record<string, unknown>>;
          let nextCursor: string | null = null;
          let hasMore = true;

          if (ep === "fb_posts") {
            parentCalls.push(params);
            const pageNum = params.cursor ? parseInt(String(params.cursor).replace("page_", ""), 10) : 1;
            rows = (postsPerPage[pageNum] ?? []).map((p) => ({ ...p, text: `منشور ${p.id}` }));
            if (pageNum === 8) {
              nextCursor = "page_9";
              hasMore = true;
            } else if (pageNum >= 9) {
              // Page 9 returns the same cursor "page_9" again!
              nextCursor = "page_9";
              hasMore = true;
            } else {
              nextCursor = `page_${pageNum + 1}`;
            }
          } else {
            const url = String(params.url);
            const postNum = parseInt(url.replace("l", ""), 10);
            const count = postNum <= 2 ? 9 : 8;
            rows = Array.from({ length: count }, (_, k) => ({
              id: `c_${postNum}_${k + 1}`,
              parent_id: `p${postNum}`,
              text: `تعليق ${k + 1}`,
            }));
          }
          const callId = `call_${String(++seq).padStart(4, "0")}`;
          await store.putFile("msn_rep_cur", RAW_PATH(callId), JSON.stringify(rows), "application/json");
          return { ok: true, call_id: callId, http_status: 200, rows_in_page: rows.length, has_more: hasMore, next_cursor: nextCursor, shape: null, first_rows: [], warnings: [], saved: "" };
        },
      } as unknown as Gateway;

      const money = fakeMoneyClient();
      const approval = await approveMission(money.client, { id: "msn_rep_cur", user_id: "user1", plan });
      expect(approval.ok).toBe(true);
      if (!approval.ok) throw new Error(approval.code);

      const items = await ItemStore.open(store, "msn_rep_cur");
      await runEngine({
        items,
        store,
        plan,
        missionId: "msn_rep_cur",
        gateway,
        sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }),
        addEvent: async () => undefined,
        deadlineMs: Date.now() + 3_600_000,
        sleep: async () => undefined,
        redesignStages: new Set(["posts", "comments"]),
        fundingSchedule: new Map([
          ["posts", { calls: 14, costUsdMicro: 2000 }],
          ["comments", { calls: 100, costUsdMicro: 1880 }],
        ]),
      });

      const delivered = items.acceptedRows("comments");
      expect(delivered.length).toBe(162);
      expect(items.stage("comments").stop).toBe("source_exhausted");
      // Call count is bounded: exactly 9 calls dispatched
      expect(parentCalls.length).toBe(9);
    });
  });

  describe("5. Total-Only Facebook Case with No Funded Parent Entry", () => {
    it("dispatches 0 expansion calls when funding schedule lacks parent entry and reports shortfall", async () => {
      const plan = pricedTwoStagePlan();
      const [posts, comments] = plan.stages;

      // Unlisted / no listedRate so stages run without mandatory schedule check in runEngine,
      // but fundingSchedule passed to runEngine lacks parent entry
      posts.deliver = false;
      posts.planned_rows = 20;
      posts.expected_rows = 20;
      posts.columns = [{ key: "id", title_ar: "المعرف" }, { key: "link", title_ar: "الرابط" }, { key: "text", title_ar: "النص" }];
      posts.engine = {
        endpoint_id: "fb_posts",
        params: {},
        cursor_param: "cursor",
        map_code: "return inputs.page",
        map_file_id: "p1",
        parent_binding: null,
      };

      comments.parent_key = "posts";
      comments.planned_rows = 200;
      comments.expected_rows = 200;
      comments.deliver = true;
      comments.columns = [{ key: "id", title_ar: "المعرف" }, { key: "parent_id", title_ar: "المنشور" }, { key: "text", title_ar: "النص" }];
      delete comments.per_parent_rows;
      comments.engine = {
        endpoint_id: "fb_comments",
        params: {},
        cursor_param: "cursor",
        map_code: "return inputs.page",
        map_file_id: "p2",
        parent_binding: { param: "url", from: "link" },
        fill_total_across_parents: true,
        catalog_paging: true,
      };

      const store = createMemoryStore();
      const parentCalls: Array<Record<string, unknown>> = [];
      let seq = 0;

      const postsPerPage: Record<number, Array<{ id: string; link: string }>> = {
        1: [{ id: "p1", link: "l1" }, { id: "p2", link: "l2" }, { id: "p3", link: "l3" }],
        2: [{ id: "p4", link: "l4" }, { id: "p5", link: "l5" }, { id: "p6", link: "l6" }],
        3: [{ id: "p7", link: "l7" }, { id: "p8", link: "l8" }, { id: "p9", link: "l9" }],
        4: [{ id: "p10", link: "l10" }, { id: "p11", link: "l11" }, { id: "p12", link: "l12" }],
        5: [{ id: "p13", link: "l13" }, { id: "p14", link: "l14" }, { id: "p15", link: "l15" }],
        6: [{ id: "p16", link: "l16" }, { id: "p17", link: "l17" }, { id: "p18", link: "l18" }],
        7: [{ id: "p19", link: "l19" }, { id: "p20", link: "l20" }],
        8: [{ id: "p21", link: "l21" }, { id: "p22", link: "l22" }, { id: "p23", link: "l23" }],
      };

      const gateway: Gateway = {
        async tregCall(input: any) {
          const ep = String(input.endpoint_id);
          const params = (input.params ?? {}) as Record<string, unknown>;
          let rows: Array<Record<string, unknown>>;
          let nextCursor: string | null = null;
          let hasMore = true;

          if (ep === "fb_posts") {
            parentCalls.push(params);
            const pageNum = params.cursor ? parseInt(String(params.cursor).replace("page_", ""), 10) : 1;
            rows = (postsPerPage[pageNum] ?? []).map((p) => ({ ...p, text: `منشور ${p.id}` }));
            nextCursor = pageNum < 8 ? `page_${pageNum + 1}` : null;
            hasMore = pageNum < 8;
          } else {
            const url = String(params.url);
            const postNum = parseInt(url.replace("l", ""), 10);
            const count = postNum <= 2 ? 9 : 8;
            rows = Array.from({ length: count }, (_, k) => ({
              id: `c_${postNum}_${k + 1}`,
              parent_id: `p${postNum}`,
              text: `تعليق ${k + 1}`,
            }));
          }
          const callId = `call_${String(++seq).padStart(4, "0")}`;
          await store.putFile("msn_nofund", RAW_PATH(callId), JSON.stringify(rows), "application/json");
          return { ok: true, call_id: callId, http_status: 200, rows_in_page: rows.length, has_more: hasMore, next_cursor: nextCursor, shape: null, first_rows: [], warnings: [], saved: "" };
        },
      } as unknown as Gateway;

      const items = await ItemStore.open(store, "msn_nofund");
      // fundingSchedule has NO entry for posts!
      await runEngine({
        items,
        store,
        plan,
        missionId: "msn_nofund",
        gateway,
        sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }),
        addEvent: async () => undefined,
        deadlineMs: Date.now() + 3_600_000,
        sleep: async () => undefined,
        redesignStages: new Set(["posts", "comments"]),
        fundingSchedule: new Map([
          ["comments", { calls: 100, costUsdMicro: 1880 }],
        ]),
      });

      // Exactly 7 calls for initial 20 posts; 0 expansion calls dispatched!
      expect(parentCalls.length).toBe(7);
      expect(items.acceptedRows("comments").length).toBe(162);

      const clause = shortfallClauseAr(items.stage("comments").stop, { pending: 0, stop: null });
      expect(clause).toContain("المصدر");
    });
  });

  describe("6. Facebook Counter-case C (exhausted parent limit vs exhausted child limit & USD cap)", () => {
    it("respects parent fundedCalls limit ceiling", async () => {
      const plan = pricedTwoStagePlan();
      const [posts, comments] = plan.stages;

      posts.deliver = false;
      posts.planned_rows = 5;
      posts.expected_rows = 5;
      posts.columns = [{ key: "id", title_ar: "المعرف" }, { key: "link", title_ar: "الرابط" }, { key: "text", title_ar: "النص" }];
      posts.engine = { endpoint_id: "fb_posts", params: {}, cursor_param: "cursor", map_code: "return inputs.page", map_file_id: "p1", parent_binding: null };

      comments.parent_key = "posts";
      comments.planned_rows = 100;
      comments.expected_rows = 100;
      comments.deliver = true;
      comments.columns = [{ key: "id", title_ar: "المعرف" }, { key: "parent_id", title_ar: "المنشور" }, { key: "text", title_ar: "النص" }];
      delete comments.per_parent_rows;
      comments.engine = { endpoint_id: "fb_comments", params: {}, cursor_param: null, map_code: "return inputs.page", map_file_id: "p2", parent_binding: { param: "url", from: "link" }, fill_total_across_parents: true };

      const store = createMemoryStore();
      const parentCalls: Array<Record<string, unknown>> = [];
      let seq = 0;

      const gateway: Gateway = {
        async tregCall(input: any) {
          const ep = String(input.endpoint_id);
          const params = (input.params ?? {}) as Record<string, unknown>;
          if (ep === "fb_posts") {
            parentCalls.push(params);
            const pageNum = params.cursor ? parseInt(String(params.cursor).replace("page_", ""), 10) : 1;
            const rows = [{ id: `p${pageNum}`, link: `l${pageNum}`, text: `post ${pageNum}` }];
            const callId = `c_${++seq}`;
            await store.putFile("msn_cap_p", RAW_PATH(callId), JSON.stringify(rows), "application/json");
            return { ok: true, call_id: callId, http_status: 200, rows_in_page: 1, has_more: true, next_cursor: `page_${pageNum + 1}`, shape: null, first_rows: [], warnings: [], saved: "" };
          }
          const callId = `c_${++seq}`;
          const rows = [{ id: `c_${seq}`, parent_id: "p1", text: "comm" }];
          await store.putFile("msn_cap_p", RAW_PATH(callId), JSON.stringify(rows), "application/json");
          return { ok: true, call_id: callId, http_status: 200, rows_in_page: 1, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "" };
        },
      } as unknown as Gateway;

      const items = await ItemStore.open(store, "msn_cap_p");
      // Initial 5 posts take 5 calls. Max parent calls limit = 7 -> expansion stops after 2 extra calls = 7 calls total!
      await runEngine({
        items,
        store,
        plan,
        missionId: "msn_cap_p",
        gateway,
        sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }),
        addEvent: async () => undefined,
        deadlineMs: Date.now() + 3_600_000,
        sleep: async () => undefined,
        redesignStages: new Set(["posts", "comments"]),
        fundingSchedule: new Map([
          ["posts", { calls: 7, costUsdMicro: 2000 }],
          ["comments", { calls: 100, costUsdMicro: 1880 }],
        ]),
      });

      expect(parentCalls.length).toBe(7);
    });

    it("respects child fundedCallLimit ceiling", async () => {
      const plan = pricedTwoStagePlan();
      const [posts, comments] = plan.stages;

      posts.deliver = false;
      posts.planned_rows = 1;
      posts.expected_rows = 1;
      posts.columns = [{ key: "id", title_ar: "المعرف" }, { key: "link", title_ar: "الرابط" }, { key: "text", title_ar: "النص" }];
      posts.engine = { endpoint_id: "fb_posts", params: {}, cursor_param: null, map_code: "return inputs.page", map_file_id: "p1", parent_binding: null };

      comments.parent_key = "posts";
      comments.planned_rows = 100;
      comments.expected_rows = 100;
      comments.deliver = true;
      comments.columns = [{ key: "id", title_ar: "المعرف" }, { key: "parent_id", title_ar: "المنشور" }, { key: "text", title_ar: "النص" }];
      delete comments.per_parent_rows;
      comments.engine = { endpoint_id: "fb_comments", params: {}, cursor_param: "cursor", map_code: "return inputs.page", map_file_id: "p2", parent_binding: { param: "url", from: "link" }, fill_total_across_parents: true };

      const store = createMemoryStore();
      const childCalls: Array<Record<string, unknown>> = [];
      let seq = 0;

      const gateway: Gateway = {
        async tregCall(input: any) {
          const ep = String(input.endpoint_id);
          const params = (input.params ?? {}) as Record<string, unknown>;
          if (ep === "fb_posts") {
            const rows = [{ id: "p1", link: "l1", text: "post 1" }];
            const callId = `c_${++seq}`;
            await store.putFile("msn_cap_c", RAW_PATH(callId), JSON.stringify(rows), "application/json");
            return { ok: true, call_id: callId, http_status: 200, rows_in_page: 1, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "" };
          }
          childCalls.push(params);
          const pageNum = params.cursor ? parseInt(String(params.cursor).replace("cpage_", ""), 10) : 1;
          const rows = [{ id: `c_${pageNum}`, parent_id: "p1", text: `comment ${pageNum}` }];
          const callId = `c_${++seq}`;
          await store.putFile("msn_cap_c", RAW_PATH(callId), JSON.stringify(rows), "application/json");
          return { ok: true, call_id: callId, http_status: 200, rows_in_page: 1, has_more: true, next_cursor: `cpage_${pageNum + 1}`, shape: null, first_rows: [], warnings: [], saved: "" };
        },
      } as unknown as Gateway;

      const items = await ItemStore.open(store, "msn_cap_c");
      // Child limit = 5 calls
      await runEngine({
        items,
        store,
        plan,
        missionId: "msn_cap_c",
        gateway,
        sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }),
        addEvent: async () => undefined,
        deadlineMs: Date.now() + 3_600_000,
        sleep: async () => undefined,
        redesignStages: new Set(["posts", "comments"]),
        fundingSchedule: new Map([
          ["posts", { calls: 10, costUsdMicro: 2000 }],
          ["comments", { calls: 5, costUsdMicro: 1880 }],
        ]),
      });

      expect(childCalls.length).toBe(5);
    });

    it("stops on gateway over_budget without exceeding limits", async () => {
      const plan = pricedTwoStagePlan();
      const [posts, comments] = plan.stages;

      posts.deliver = false;
      posts.planned_rows = 1;
      posts.expected_rows = 1;
      posts.columns = [{ key: "id", title_ar: "المعرف" }, { key: "link", title_ar: "الرابط" }, { key: "text", title_ar: "النص" }];
      posts.engine = { endpoint_id: "fb_posts", params: {}, cursor_param: null, map_code: "return inputs.page", map_file_id: "p1", parent_binding: null };

      comments.parent_key = "posts";
      comments.planned_rows = 100;
      comments.expected_rows = 100;
      comments.deliver = true;
      comments.columns = [{ key: "id", title_ar: "المعرف" }, { key: "parent_id", title_ar: "المنشور" }, { key: "text", title_ar: "النص" }];
      delete comments.per_parent_rows;
      comments.engine = { endpoint_id: "fb_comments", params: {}, cursor_param: "cursor", map_code: "return inputs.page", map_file_id: "p2", parent_binding: { param: "url", from: "link" }, fill_total_across_parents: true };

      const store = createMemoryStore();
      let calls = 0;

      const gateway: Gateway = {
        async tregCall(input: any) {
          const ep = String(input.endpoint_id);
          if (ep === "fb_posts") {
            const rows = [{ id: "p1", link: "l1", text: "post 1" }];
            await store.putFile("msn_cap_b", RAW_PATH("c_p"), JSON.stringify(rows), "application/json");
            return { ok: true, call_id: "c_p", http_status: 200, rows_in_page: 1, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "" };
          }
          calls++;
          if (calls > 2) {
            return { ok: false, call_id: "c_ref", refused: "over_budget", message: "Budget limit reached" };
          }
          const callId = `c_c_${calls}`;
          const rows = [{ id: `c_${calls}`, parent_id: "p1", text: `comment ${calls}` }];
          await store.putFile("msn_cap_b", RAW_PATH(callId), JSON.stringify(rows), "application/json");
          return { ok: true, call_id: callId, http_status: 200, rows_in_page: 1, has_more: true, next_cursor: `cur_${calls}`, shape: null, first_rows: [], warnings: [], saved: "" };
        },
      } as unknown as Gateway;

      const items = await ItemStore.open(store, "msn_cap_b");
      await runEngine({
        items,
        store,
        plan,
        missionId: "msn_cap_b",
        gateway,
        sandbox: async (_c, inputs) => ({ ok: true, resultJson: JSON.stringify(Object.values(inputs)[0]), logs: [] }),
        addEvent: async () => undefined,
        deadlineMs: Date.now() + 3_600_000,
        sleep: async () => undefined,
        redesignStages: new Set(["posts", "comments"]),
      });

      expect(calls).toBe(3); // 2 success + 1 refusal = 3 calls
      expect(items.stage("comments").stop).toBe("budget");
    });
  });

  describe("7. YouTube Case 3 (shapeReader, digest, & multi-option probeStep)", () => {
    const ytEndpoint = catalog.byId.get("tikhub.youtube.video.comments")!;

    it("parses terminal wrapper { code: 200, data: { comments: null, continuation_token: null } } via readShape and buildShapeDigest as 0 rows, list_path, hasMore: false, no warnings", () => {
      const wrapper1 = { code: 200, data: { comments: null, continuation_token: null } };
      const wrapper2 = { code: 200, data: {} };

      const cfg = missionPageOf(ytEndpoint.id);
      expect(cfg).toBeDefined();
      const hints = { ...hintsOf(ytEndpoint), missionPage: cfg };

      for (const w of [wrapper1, wrapper2]) {
        const shape = readShape(w, hints);
        expect(shape.rows).toHaveLength(0);
        expect(shape.listStrategy).toBe("list_path");
        expect(shape.hasMore).toBe(false);
        expect(shape.nextCursor).toBeNull();
        expect(shape.warnings).toEqual([]);

        const digest = buildShapeDigest(w, ytEndpoint);
        expect(digest.reading.rows).toHaveLength(0);
        expect(digest.reading.listStrategy).toBe("list_path");
        expect(digest.reading.hasMore).toBe(false);
        expect(digest.reading.nextCursor).toBeNull();
        expect(digest.reading.warnings).toEqual([]);
      }
    });

    it("budgets probeStep so 3rd ranked tool receives attempts and builds plan when 1st is terminal wrapper and 2nd is empty", async () => {
      const probedEndpoints: string[] = [];
      const request = "هات فيديوهات وتعليقات";
      const answers: Record<string, unknown> = {
        request_plan: {
          decision: "plan",
          understanding_ar: request,
          steps: [
            { key: "videos", title_ar: "الفيديوهات", platform: "youtube", capability: "youtube.search.videos", parent: null, deliver: false, count: { total: 4, per_parent: null, all: false }, source: null, topic: "الفلك", search_terms: ["الفلك"], period: null },
            { key: "comments", title_ar: "التعليقات", platform: "youtube", capability: "youtube.video.comments", parent: "videos", deliver: true, count: { total: 8, per_parent: null, all: false }, source: null, topic: null, search_terms: [], period: null },
          ],
        },
      };

      const model = async ({ tool, user }: any) => {
        if (tool.name === "request_plan") return { input: answers.request_plan, costUsd: 0 };
        if (tool.name === "tool_choice") {
          if (user.includes('"key":"videos"')) {
            return { input: { options: [{ endpoint_id: "tikhub.youtube.search.videos", params: { keyword: "الفلك" }, cursor_input: null, parent_input: null }] }, costUsd: 0 };
          }
          return {
            input: {
              options: [
                { endpoint_id: "tikhub.youtube.video.comments", params: {}, cursor_input: "continuation_token", parent_input: { param: "video_id", from_field: "id" } },
                { endpoint_id: "crawl4ai.youtube.video.comments", params: {}, cursor_input: null, parent_input: { param: "video", from_field: "id" } },
                { endpoint_id: "scrapecreators.youtube.video.comments", params: {}, cursor_input: null, parent_input: { param: "url", from_field: "link" } },
              ],
            },
            costUsd: 0,
          };
        }
        if (tool.name === "field_map") {
          return { input: { fields: { id: ["video_id", "id"], text: ["title", "text"], link: ["url"] }, extra: [] }, costUsd: 0 };
        }
        return { input: {}, costUsd: 0 };
      };

      const res = await planWithLlm({ words: ["الفلك"], request }, {
        catalog,
        access: null,
        today: "2026-11-21",
        model,
        probe: async (id, params) => {
          probedEndpoints.push(id);
          if (id === "tikhub.youtube.search.videos") {
            return { ok: true, call_id: "c_v", http_status: 200, rows_in_page: 4, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "c_v" };
          }
          if (id === "tikhub.youtube.video.comments") {
            return { ok: true, call_id: "c_c1", http_status: 200, rows_in_page: 0, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "c_c1" };
          }
          if (id === "crawl4ai.youtube.video.comments") {
            return { ok: true, call_id: "c_c2", http_status: 200, rows_in_page: 0, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "c_c2" };
          }
          return { ok: true, call_id: "c_c3", http_status: 200, rows_in_page: 2, has_more: true, next_cursor: "cur_next", shape: null, first_rows: [], warnings: [], saved: "c_c3" };
        },
        readPage: async (callId) => {
          if (callId === "c_v") return { data: { videos: [{ video_id: "v1", title: "ت1", url: "https://youtube.com/watch?v=v1" }, { video_id: "v2", title: "ت2", url: "https://youtube.com/watch?v=v2" }, { video_id: "v3", title: "ت3", url: "https://youtube.com/watch?v=v3" }, { video_id: "v4", title: "ت4", url: "https://youtube.com/watch?v=v4" }] } };
          if (callId === "c_c1") return { code: 200, data: { comments: null, continuation_token: null } };
          if (callId === "c_c2") return [];
          return [{ id: "c1", text: "cmt1", url: "u1" }, { id: "c2", text: "cmt2", url: "u2" }];
        },
      });

      // Verify scrapecreators was reached and evaluated thanks to fair probeStep budgeting
      expect(probedEndpoints).toContain("scrapecreators.youtube.video.comments");
      expect(res.kind).toBe("plan");
      if (res.kind === "plan") {
        expect(res.plan.stages[1].endpoint_id).toBe("scrapecreators.youtube.video.comments");
        expect(res.plan.stages[1].sample_rows).toHaveLength(2);
        expect(res.plan.stages[1].sample_rows[0].text).toBe("cmt1");
      }
    });

    it("offers no plan card when all comment tools return empty or terminal wrappers", async () => {
      const request = "هات فيديوهات وتعليقات";
      const answers: Record<string, unknown> = {
        request_plan: {
          decision: "plan",
          understanding_ar: request,
          steps: [
            { key: "videos", title_ar: "الفيديوهات", platform: "youtube", capability: "youtube.search.videos", parent: null, deliver: false, count: { total: 4, per_parent: null, all: false }, source: null, topic: "الفلك", search_terms: ["الفلك"], period: null },
            { key: "comments", title_ar: "التعليقات", platform: "youtube", capability: "youtube.video.comments", parent: "videos", deliver: true, count: { total: 8, per_parent: null, all: false }, source: null, topic: null, search_terms: [], period: null },
          ],
        },
      };

      const model = async ({ tool, user }: any) => {
        if (tool.name === "request_plan") return { input: answers.request_plan, costUsd: 0 };
        if (tool.name === "tool_choice") {
          if (user.includes('"key":"videos"')) {
            return { input: { options: [{ endpoint_id: "tikhub.youtube.search.videos", params: { keyword: "الفلك" }, cursor_input: null, parent_input: null }] }, costUsd: 0 };
          }
          return {
            input: {
              options: [
                { endpoint_id: "tikhub.youtube.video.comments", params: {}, cursor_input: "continuation_token", parent_input: { param: "video_id", from_field: "id" } },
                { endpoint_id: "crawl4ai.youtube.video.comments", params: {}, cursor_input: null, parent_input: { param: "video", from_field: "id" } },
                { endpoint_id: "scrapecreators.youtube.video.comments", params: {}, cursor_input: null, parent_input: { param: "url", from_field: "link" } },
              ],
            },
            costUsd: 0,
          };
        }
        if (tool.name === "field_map") {
          return { input: { fields: { id: ["video_id", "id"], text: ["title", "text"], link: ["url"] }, extra: [] }, costUsd: 0 };
        }
        return { input: {}, costUsd: 0 };
      };

      const res = await planWithLlm({ words: ["الفلك"], request }, {
        catalog,
        access: null,
        today: "2026-11-21",
        model,
        probe: async (id, params) => {
          if (id === "tikhub.youtube.search.videos") {
            return { ok: true, call_id: "c_v", http_status: 200, rows_in_page: 4, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "c_v" };
          }
          if (id === "tikhub.youtube.video.comments") {
            return { ok: true, call_id: "c_c1", http_status: 200, rows_in_page: 0, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "c_c1" };
          }
          if (id === "crawl4ai.youtube.video.comments") {
            return { ok: true, call_id: "c_c2", http_status: 200, rows_in_page: 0, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "c_c2" };
          }
          return { ok: true, call_id: "c_c3", http_status: 200, rows_in_page: 0, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "c_c3" };
        },
        readPage: async (callId) => {
          if (callId === "c_v") return { data: { videos: [{ video_id: "v1", title: "ت1", url: "https://youtube.com/watch?v=v1" }] } };
          if (callId === "c_c1") return { code: 200, data: { comments: null, continuation_token: null } };
          if (callId === "c_c2") return [];
          return [];
        },
      });

      expect(res.kind).not.toBe("plan");
    });
  });

  describe("8. YouTube Counter-cases", () => {
    const ytEndpoint = catalog.byId.get("tikhub.youtube.video.comments")!;
    const cfg = missionPageOf(ytEndpoint.id)!;
    const hints = { ...hintsOf(ytEndpoint), missionPage: cfg };

    it("handles malformed continuation tokens with hasMore: null (never false) and warnings", () => {
      const malformedCases = [
        { code: 200, data: { comments: null, continuation_token: 12345 } },
        { code: 200, data: { comments: [], continuation_token: "" } },
        { code: 200, data: { comments: [], continuation_token: { bad: 1 } } },
      ];

      for (const mc of malformedCases) {
        const reading = readShape(mc, hints);
        expect(reading.hasMore).toBeNull();
        expect(reading.warnings.length > 0 || reading.listStrategy === "declared_missing").toBe(true);
      }
    });

    it("treats bad terminal flag (e.g. code: 500) as declared_missing / uncertain", () => {
      const badFlag = { code: 500, data: { comments: null, continuation_token: null } };
      const reading = readShape(badFlag, hints);
      expect(reading.listStrategy).toBe("declared_missing");
    });

    it("reads valid continuation and 1-comment page correctly", () => {
      const singleComment = { code: 200, data: { comments: [{ comment_id: "c1", content: "واحد" }], continuation_token: null } };
      const reading1 = readShape(singleComment, hints);
      expect(reading1.rows).toHaveLength(1);
      expect(reading1.listStrategy).toBe("list_path");

      const withNext = { code: 200, data: { comments: [{ comment_id: "c1", content: "واحد" }], continuation_token: "tok_2" } };
      const reading2 = readShape(withNext, hints);
      expect(reading2.rows).toHaveLength(1);
      expect(reading2.nextCursor).toBe("tok_2");
    });

    it("recovers rows: 1 (single_object) on unreviewed lookup endpoint without missionPage via buildShapeDigest", () => {
      const unreviewedEndpoint = mockEndpoint("unreviewed.person.lookup", {
        list_path: "items",
      });
      const response = { data: { email: "a@b.com", name: "X" } };
      const digest = buildShapeDigest(response, unreviewedEndpoint);
      expect(digest.reading.rows).toHaveLength(1);
      expect(digest.reading.listStrategy).toBe("single_object");
    });
  });

  describe("9. Catalog Child Stream Guard", () => {
    it("reads all pages of a catalog child stream without stopping after page 1", async () => {
      const plan = pricedTwoStagePlan();
      const [parent, child] = plan.stages;

      parent.deliver = false;
      parent.planned_rows = 1;
      parent.expected_rows = 1;
      parent.columns = [{ key: "id", title_ar: "المعرف" }, { key: "link", title_ar: "الرابط" }];
      parent.engine = {
        endpoint_id: "parent_ep",
        params: {},
        cursor_param: null,
        map_code: "return inputs.p1",
        map_file_id: "p1",
        parent_binding: null,
      };

      child.endpoint_id = "tikhub.youtube.video.comments";
      child.parent_key = parent.key;
      child.planned_rows = 10;
      child.expected_rows = 10;
      child.deliver = true;
      child.columns = [{ key: "id", title_ar: "المعرف" }, { key: "parent_id", title_ar: "المنشور" }, { key: "text", title_ar: "النص" }];
      child.engine = {
        endpoint_id: "tikhub.youtube.video.comments",
        params: {},
        cursor_param: "continuation_token",
        map_code: "return inputs.page",
        map_file_id: "p2",
        parent_binding: { param: "video_id", from: "id" },
        catalog_paging: true,
      };

      const store = createMemoryStore();
      const childCalls: Array<Record<string, unknown>> = [];
      let seq = 0;

      const gateway: Gateway = {
        async tregCall(input: any) {
          const ep = String(input.endpoint_id);
          const params = (input.params ?? {}) as Record<string, unknown>;
          if (ep === "parent_ep") {
            const rows = [{ id: "v1", link: "l1" }];
            const callId = `c_${++seq}`;
            await store.putFile("msn_child_guard", RAW_PATH(callId), JSON.stringify(rows), "application/json");
            return { ok: true, call_id: callId, http_status: 200, rows_in_page: 1, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: "" };
          }
          childCalls.push(params);
          const cursor = params.continuation_token ? String(params.continuation_token) : null;
          let rows: Array<Record<string, unknown>>;
          let nextCursor: string | null = null;
          let hasMore = true;

          if (!cursor) {
            // Page 1
            rows = [{ comment_id: "c1", content: "comment 1" }];
            nextCursor = "token_page_2";
          } else if (cursor === "token_page_2") {
            // Page 2
            rows = [{ comment_id: "c2", content: "comment 2" }];
            nextCursor = "token_page_3";
          } else {
            // Page 3
            rows = [{ comment_id: "c3", content: "comment 3" }];
            nextCursor = null;
            hasMore = false;
          }

          const callId = `c_${++seq}`;
          const body = { code: 200, data: { comments: rows, continuation_token: nextCursor } };
          await store.putFile("msn_child_guard", RAW_PATH(callId), JSON.stringify(body), "application/json");
          return { ok: true, call_id: callId, http_status: 200, rows_in_page: rows.length, has_more: hasMore, next_cursor: nextCursor, shape: null, first_rows: [], warnings: [], saved: "" };
        },
      } as unknown as Gateway;

      const items = await ItemStore.open(store, "msn_child_guard");
      await runEngine({
        items,
        store,
        plan,
        missionId: "msn_child_guard",
        gateway,
        sandbox: async (_c, inputs) => {
          const val: any = Object.values(inputs)[0];
          const data = Array.isArray(val) ? val : (val?.data?.comments ?? []);
          return { ok: true, resultJson: JSON.stringify(data.map((r: any) => ({ id: r.comment_id, text: r.content }))), logs: [] };
        },
        addEvent: async () => undefined,
        deadlineMs: Date.now() + 3_600_000,
        sleep: async () => undefined,
        redesignStages: new Set([parent.key, child.key]),
      });

      // All 3 pages of the catalog child stream were read
      expect(childCalls.length).toBe(3);
      expect(items.acceptedRows(child.key).length).toBe(3);
      expect(items.stage(child.key).stop).toBe("source_exhausted");
    });
  });

  describe("10. FIX3 v3 Legacy Envelope Fallback & Malformed Admission Probes", () => {
    const probeEndpoints = [
      "tikhub.youtube.video.comments",
      "anyapi.facebook.user.posts",
      "tikhub.tiktok.search.videos",
    ];

    it("(a) Fazza probe for all 3 mission pages: declared list present but malformed [42] plus alternate items -> 0 admitted rows and 0 worker rows", () => {
      for (const epId of probeEndpoints) {
        const ep = catalog.byId.get(epId);
        expect(ep).toBeDefined();
        const mp = missionPageOf(epId)!;
        expect(mp).toBeDefined();

        // Construct fake response with present-but-malformed declared list [42] plus alternate items
        const body: Record<string, unknown> = {
          output: {
            data: { items: [{ id: "alt_1", text: "retry", url: "https://example.com/retry" }] },
            items: [{ id: "alt_1", text: "retry" }],
          },
        };
        // Place [42] at the declared list path
        const parts = mp.listPath.split(".");
        let cur: any = body;
        for (let i = 0; i < parts.length - 1; i++) {
          cur = cur[parts[i]] ??= {};
        }
        cur[parts[parts.length - 1]] = [42];

        // 1. Without opt-in: 0 admitted rows
        const resWithoutOptIn = buildShapeDigest(body, ep!);
        expect(resWithoutOptIn.reading.rows.length).toBe(0);
        expect(resWithoutOptIn.digest.rowsInSample).toBe(0);
        expect(resWithoutOptIn.reading.listStrategy).toBe("declared_missing");

        // 2. With opt-in: 0 admitted rows
        const resWithOptIn = buildShapeDigest(body, ep!, { allowLegacyEnvelope: true });
        expect(resWithOptIn.reading.rows.length).toBe(0);
        expect(resWithOptIn.digest.rowsInSample).toBe(0);
        expect(resWithOptIn.reading.listStrategy).toBe("declared_missing");
        expect(resWithOptIn.digest.listPath).not.toBe("output.data.items");
        expect(resWithOptIn.digest.listPath).not.toBe("output.items");

        // 3. Worker rows: strict endpoint reading yields 0 rows
        const strictReading = readShape(body, { ...hintsOf(ep!), missionPage: mp });
        expect(strictReading.rows.length).toBe(0);
        expect(strictReading.listStrategy).toBe("declared_missing");
      }
    });

    it("(b) Declared list absent and no opt-in -> 0 admitted rows", () => {
      for (const epId of probeEndpoints) {
        const ep = catalog.byId.get(epId);
        expect(ep).toBeDefined();

        // Declared list is absent, only alternate output.data.items is present
        const body = {
          output: {
            data: { items: [{ id: "alt_1", text: "retry" }] },
          },
        };

        const res = buildShapeDigest(body, ep!);
        expect(res.reading.rows.length).toBe(0);
        expect(res.digest.rowsInSample).toBe(0);
        expect(res.reading.listStrategy).toBe("declared_missing");
      }
    });

    it("(c) Approved fixture path with opt-in and valid absent-list envelope -> expected rows", () => {
      for (const epId of probeEndpoints) {
        const ep = catalog.byId.get(epId);
        expect(ep).toBeDefined();

        // Declared list absent, valid alternate items present, opt-in true
        const body = {
          output: {
            data: { items: [{ id: "1", text: "نص", url: "https://x.com/a/status/1" }] },
          },
        };

        const res = buildShapeDigest(body, ep!, { allowLegacyEnvelope: true });
        expect(res.reading.rows.length).toBe(1);
        expect(res.digest.rowsInSample).toBe(1);
        expect(res.reading.listPath).toBe("output.data.items");
        expect(res.reading.listStrategy).toBe("common_keys");
        expect(res.reading.rows).toEqual([{ id: "1", text: "نص", url: "https://x.com/a/status/1" }]);
      }
    });
  });
});
