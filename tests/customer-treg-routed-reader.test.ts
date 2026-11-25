import { describe, expect, it, vi } from "vitest";
import { createGateway, RAW_PATH } from "../agent/src/gateway";
import { ItemStore } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import { approveMission, settleMission } from "../src/lib/agentMission/lifecycle";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { pricedTwoStagePlan } from "./helpers/agentPlan";
import { makeHarness, NOT_ADMIN, USER_ID, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { createMemoryStore } from "../agent/src/memoryStore";
import { validatePlan, type StepSample, type ValidateContext } from "../src/lib/modelPlanner/validate";
import { readStepRows } from "../src/lib/modelPlanner/reader";
import { ProposePlanSchema, type ProposePlanInput } from "../src/lib/modelPlanner/types";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { discoverCursor } from "../src/lib/agentMission/toolProfile";
import { callTregWithAsync, type AsyncTregDeps } from "../agent/src/asyncTreg";
import { loadRecordedRows } from "../scripts/full-flow-replay-runner";
import { loadTregCatalog, type CatalogEndpoint } from "../src/lib/treg/catalog";
import type { PricedStage, PricedPlan } from "../src/lib/agentMission/plan";

const catalog = loadTregCatalog();

const shapeA = {
  output: { comments: null, next_cursor: null },
  raw: { items: [{ id: "raw_leak_comment", text: "leak" }] },
  _treg: {
    served_by: null,
    outcome: "empty",
    tried: [{ endpoint_id: "ep_a", provider: "prov_a", outcome: "empty", status: 200, charged_micro: 100 }],
    charged_micro: 100,
    dropped: [{ endpoint_id: "ep_b", why: "cap" }, { endpoint_id: "ep_c", why: "policy" }],
  },
};

const shapeB = {
  output: { posts: null, next_cursor: null },
  raw: { data: { posts: [{ id: "raw_leak_post" }] } },
  _treg: {
    served_by: null,
    outcome: "empty",
    tried: [1, 2, 3].map((n) => ({ endpoint_id: `ep_${n}`, provider: `prov_${n}`, outcome: "empty", status: 200, charged_micro: 50 })),
    charged_micro: 150,
    dropped: [{ endpoint_id: "ep_d", why: "cap" }],
  },
};

const shapeD = (n: number, nextCursor: string | null) => ({
  output: {
    posts: Array.from({ length: n }, (_, i) => ({ id: `p_${i + 1}`, text: `Synthetic post ${i + 1}`, author: `user_${i + 1}` })),
    next_cursor: nextCursor,
  },
  raw: {
    output: { data: { posts: [{ id: "raw_only" }] }, found: true },
    provider: "prov_a",
    costUsd: 0.001,
    items: n,
    replayed: false,
    source: { id: "s1", name: "src", kind: "social", artworkKey: "k1" },
    resultId: "r1",
  },
  _treg: {
    served_by: "ep_a",
    provider: "prov_a",
    tier: "core",
    outcome: "hit",
    tried: [{ endpoint_id: "ep_a", provider: "prov_a", outcome: "hit", status: 200, charged_micro: 750 }],
    charged_micro: 750,
  },
});

const shapeE = (n: number) => ({
  output: {
    products: Array.from({ length: n }, (_, i) => ({ asin: `ASIN_${i + 1}`, title: `Product ${i + 1}`, price: 10 + i })),
    count: n,
  },
  raw: {
    code: 200,
    data: {
      total_products: n,
      items: [{ asin: "RAW_LEAK_ITEM" }],
    },
  },
  _treg: {
    served_by: "ep_amz",
    provider: "amazon_prov",
    outcome: "hit",
    tried: [{ endpoint_id: "ep_amz", provider: "amazon_prov", outcome: "hit", status: 200, charged_micro: 500 }],
    charged_micro: 500,
  },
});

describe("DT-20261125-customer-treg-reader: customer-path end-to-end delivery & caller parity", () => {
  describe("1. K4 money/charge proof: gateway -> ingestRows -> settleMission on fakeMoneyClient", () => {
    it("Shape A (treg.youtube.video.comments) yields 0 rows, 0 accepted items, and zero ledger charge on settlement", async () => {
      const harness = makeHarness({
        phase: "execution",
        responses: [tregResult(shapeA, 0.001)],
      });

      const res = await harness.gateway.tregCall({
        endpoint_id: "treg.youtube.video.comments",
        params: { video_id: "v_empty_001" },
        why: "test customer empty youtube comments",
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.rows_in_page).toBe(0);
      expect(res.first_rows).toEqual([]);
      expect((res.shape as any)?.list_path).toBeNull();

      const items = await ItemStore.open(harness.store, harness.mission.id);
      const stage = {
        key: "comments",
        title_ar: "التعليقات",
        endpoint_id: "treg.youtube.video.comments",
        expected_rows: 5,
        planned_rows: 5,
        parent_key: null,
        deliver: true,
        columns: [{ key: "id", title_ar: "المعرف" }, { key: "text", title_ar: "النص" }],
        sample_rows: [],
      } as unknown as PricedStage;

      // Ingest empty reading rows
      const ingest = await ingestRows(
        { items, plan: { summary_ar: "مهمة تجريبية", stages: [stage], price: {} } as unknown as PricedPlan, addEvent: async () => undefined },
        stage,
        [],
        { silent: true, idField: null }
      );
      expect(ingest.newlyAccepted).toBe(0);

      // Settle mission with 0 delivered units
      const money = fakeMoneyClient({ balance: 5000 });
      const plan = pricedTwoStagePlan();
      const approval = await approveMission(money.client, { id: harness.mission.id, user_id: USER_ID, plan });
      expect(approval.ok).toBe(true);
      if (!approval.ok) return;

      const settle = await settleMission(money.client, {
        jobId: approval.jobId,
        deliveredUnits: 0,
        unitPricePoints: approval.unitPricePoints,
        reservedPoints: approval.reservePoints,
        costUsd: 0.001,
        resultPath: null,
      });

      expect(settle.ok).toBe(true);
      if (!settle.ok) return;
      expect(settle.kind).toBe("released");
      expect(settle.chargedPoints).toBe(0);
      expect(settle.releasedPoints).toBe(approval.reservePoints);

      const chargeRows = money.ledger.filter((r) => r.type === "charge");
      expect(chargeRows).toHaveLength(0);
    });

    it("Shape B (treg.facebook.user.posts) yields 0 rows, 0 accepted items, and zero ledger charge on settlement", async () => {
      const harness = makeHarness({
        phase: "execution",
        responses: [tregResult(shapeB, 0.0015)],
      });

      const res = await harness.gateway.tregCall({
        endpoint_id: "treg.facebook.user.posts",
        params: { profile_id: "fb_user_empty" },
        why: "test customer empty facebook posts",
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.rows_in_page).toBe(0);
      expect(res.first_rows).toEqual([]);
      expect((res.shape as any)?.list_path).toBeNull();

      const items = await ItemStore.open(harness.store, harness.mission.id);
      const stage = {
        key: "posts",
        title_ar: "المنشورات",
        endpoint_id: "treg.facebook.user.posts",
        expected_rows: 5,
        planned_rows: 5,
        parent_key: null,
        deliver: true,
        columns: [{ key: "id", title_ar: "المعرف" }, { key: "text", title_ar: "النص" }],
        sample_rows: [],
      } as unknown as PricedStage;

      const ingest = await ingestRows(
        { items, plan: { summary_ar: "مهمة فيسبوك", stages: [stage], price: {} } as unknown as PricedPlan, addEvent: async () => undefined },
        stage,
        [],
        { silent: true, idField: null }
      );
      expect(ingest.newlyAccepted).toBe(0);

      const money = fakeMoneyClient({ balance: 5000 });
      const plan = pricedTwoStagePlan();
      const approval = await approveMission(money.client, { id: harness.mission.id, user_id: USER_ID, plan });
      expect(approval.ok).toBe(true);
      if (!approval.ok) return;

      const settle = await settleMission(money.client, {
        jobId: approval.jobId,
        deliveredUnits: 0,
        unitPricePoints: approval.unitPricePoints,
        reservedPoints: approval.reservePoints,
        costUsd: 0.0015,
        resultPath: null,
      });

      expect(settle.ok).toBe(true);
      if (!settle.ok) return;
      expect(settle.kind).toBe("released");
      expect(settle.chargedPoints).toBe(0);
      expect(money.ledger.filter((r) => r.type === "charge")).toHaveLength(0);
    });

    it("Shape D (treg.x.search.posts) returns exact rows for N=1 and N=9, accepted into ItemStore without raw leak", async () => {
      for (const n of [1, 9]) {
        const envelope = shapeD(n, "c_next");
        const harness = makeHarness({
          phase: "execution",
          responses: [tregResult(envelope, 0.00075)],
        });

        const res = await harness.gateway.tregCall({
          endpoint_id: "treg.x.search.posts",
          params: { q: "fintech" },
          why: `test shape D n=${n}`,
        });

        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.rows_in_page).toBe(n);
        expect(res.first_rows).toHaveLength(Math.min(n, 5));
        expect((res.shape as any)?.list_path).toBe("output.posts");

        const items = await ItemStore.open(harness.store, `msn_d_${n}`);
        const stage = {
          key: "posts",
          title_ar: "المنشورات",
          endpoint_id: "treg.x.search.posts",
          expected_rows: n,
          planned_rows: n,
          parent_key: null,
          deliver: true,
          columns: [{ key: "id", title_ar: "المعرف" }, { key: "text", title_ar: "النص" }],
          sample_rows: [],
        } as unknown as PricedStage;

        const digest = buildShapeDigest(envelope, catalog.byId.get("treg.x.search.posts")!);
        const ingest = await ingestRows(
          { items, plan: { summary_ar: "منشورات إكس", stages: [stage], price: {} } as unknown as PricedPlan, addEvent: async () => undefined },
          stage,
          digest.reading.rows,
          { silent: true, idField: null }
        );

        expect(ingest.newlyAccepted).toBe(n);
        const storedItems = items.acceptedRows(stage.key);
        expect(storedItems).toHaveLength(n);
        expect(storedItems.some((it: any) => it.id === "raw_only")).toBe(false);
      }
    });

    it("Shape E (treg.amazon.search.products) returns exact rows for N=16 and N=48, accepted into ItemStore without raw leak", async () => {
      for (const n of [16, 48]) {
        const envelope = shapeE(n);
        const harness = makeHarness({
          phase: "execution",
          responses: [tregResult(envelope, 0.0005)],
        });

        const res = await harness.gateway.tregCall({
          endpoint_id: "treg.amazon.search.products",
          params: { q: "keyboard" },
          why: `test shape E n=${n}`,
        });

        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.rows_in_page).toBe(n);
        expect((res.shape as any)?.list_path).toBe("output.products");

        const items = await ItemStore.open(harness.store, `msn_e_${n}`);
        const stage = {
          key: "products",
          title_ar: "المنتجات",
          endpoint_id: "treg.amazon.search.products",
          expected_rows: n,
          planned_rows: n,
          parent_key: null,
          deliver: true,
          columns: [{ key: "asin", title_ar: "الرمز" }, { key: "title", title_ar: "العنوان" }],
          sample_rows: [],
        } as unknown as PricedStage;

        const digest = buildShapeDigest(envelope, catalog.byId.get("treg.amazon.search.products")!);
        const ingest = await ingestRows(
          { items, plan: { summary_ar: "منتجات أمازون", stages: [stage], price: {} } as unknown as PricedPlan, addEvent: async () => undefined },
          stage,
          digest.reading.rows,
          { silent: true, idField: null }
        );

        expect(ingest.newlyAccepted).toBe(n);
        const storedItems = items.acceptedRows(stage.key);
        expect(storedItems).toHaveLength(n);
        expect(storedItems.some((it: any) => it.asin === "RAW_LEAK_ITEM")).toBe(false);
      }
    });
  });

  describe("2. Customer callers parity", () => {
    it("modelPlanner: validatePlan populates facts.routedOutputOnly and readStepRows obeys it", () => {
      const routedPostsEp = catalog.byId.get("treg.x.search.posts")!;
      const sampleRows = shapeD(3, null).output.posts;
      const digest = buildShapeDigest(shapeD(3, null), routedPostsEp).digest;

      const sample: StepSample = {
        endpointId: "treg.x.search.posts",
        rows: sampleRows,
        digest,
        costUsd: 0.00075,
      };

      const ctx: ValidateContext = {
        customerText: "أريد 3 منشورات من منصة X عن التكنولوجيا",
        access: NOT_ADMIN,
        catalog,
        samples: new Map([["treg.x.search.posts", sample]]),
        today: new Date("2026-11-25T12:00:00Z"),
      };

      const planInput: ProposePlanInput = ProposePlanSchema.parse({
        summaryAr: "جمع 3 منشورات من إكس",
        steps: [
          {
            endpointId: "treg.x.search.posts",
            volume: 3,
            params: [{ name: "q", value: "تكنولوجيا", source: "customer_text", quote: "التكنولوجيا" }],
            fieldMap: {
              columns: [{ field: "text", headerAr: "النص", role: "text" }],
            },
          },
        ],
      });

      const validation = validatePlan(planInput, ctx);
      expect(validation.ok).toBe(true);
      if (!validation.ok) return;

      const stepFacts = validation.plan.stored.steps[0].facts;
      expect(stepFacts.routedOutputOnly).toBe(true);

      // On Shape A, readStepRows yields 0 rows
      const readA = readStepRows(shapeA, stepFacts);
      expect(readA.rows).toEqual([]);

      // On Shape D (3 items, cursor "c2"), readStepRows yields 3 rows and "c2" cursor
      const readD = readStepRows(shapeD(3, "c2"), stepFacts);
      expect(readD.rows).toHaveLength(3);
      expect(readD.nextCursor).toBe("c2");
    });

    it("toolProfile.discoverCursor: ignores cursor in raw and reads output only for routed endpoints", () => {
      const routedPostsEp = catalog.byId.get("treg.x.search.posts")!;
      const clonedEp: CatalogEndpoint = {
        ...routedPostsEp,
        pagination: [],
        inputs: [
          ...(routedPostsEp.inputs ?? []),
          {
            name: "cursor",
            in: "query",
            type: "string",
            required: false,
            enum: null,
            minimum: null,
            maximum: null,
            default: null,
            example: null,
            note: null,
          },
        ],
      };

      // Page with raw leak and null output cursor
      const pageWithRawLeak = {
        output: { posts: [{ id: "1" }], next_cursor: null },
        raw: { next_cursor: "raw_leak_cursor" },
      };
      expect(discoverCursor(clonedEp, pageWithRawLeak)).toBeNull();

      // Page with valid output next_cursor
      const pageWithValidCursor = {
        output: { posts: [{ id: "1" }], next_cursor: "c2" },
        raw: { next_cursor: "raw_leak_cursor" },
      };
      expect(discoverCursor(clonedEp, pageWithValidCursor)).toBe("cursor");
    });

    it("asyncTreg.callTregWithAsync: routed poll endpoint returning Shape A yields rows_in_page: 0", async () => {
      const store = createMemoryStore();
      const missionId = "msn_async_routed_test";

      const pollEp = catalog.byId.get("treg.youtube.video.comments")!;
      const submitEpId = "test.async.submit";

      const submitEp: CatalogEndpoint = {
        id: submitEpId,
        provider: "test_provider",
        summary: "Synthetic async submit",
        kind: "direct",
        method: "POST",
        path: "/async/submit",
        inputs: [],
        pagination: [],
        async_config: {
          poll: { endpoint: pollEp.id, param: { name: "task_id" } },
          status: { path: "status", success: ["completed"], failure: [] },
          id_from: "task_id",
          interval: 1,
          max_age: 10,
        },
      } as unknown as CatalogEndpoint;

      const mockCatalog = {
        ...catalog,
        byId: new Map([...catalog.byId.entries(), [submitEpId, submitEp]]),
      };

      const deps: AsyncTregDeps = {
        catalog: mockCatalog,
        store,
        missionId,
        sleep: async () => undefined,
      };

      let callCount = 0;
      const callFn = vi.fn(async (endpointId: string, _params: Record<string, unknown>) => {
        callCount++;
        if (endpointId === submitEpId) {
          const callId = "call_submit_001";
          await store.putFile(missionId, RAW_PATH(callId), JSON.stringify({ task_id: "task_123" }), "application/json");
          return { ok: true, call_id: callId, rows_in_page: 0 } as any;
        }
        if (endpointId === pollEp.id) {
          const callId = "call_poll_001";
          const pollPayload = {
            status: "completed",
            ...shapeA,
          };
          await store.putFile(missionId, RAW_PATH(callId), JSON.stringify(pollPayload), "application/json");
          return { ok: true, call_id: callId, rows_in_page: 0 } as any;
        }
        throw new Error(`Unexpected endpoint ${endpointId}`);
      });

      const res = await callTregWithAsync(deps, callFn, submitEpId, {});
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.rows_in_page).toBe(0);
      expect(callFn).toHaveBeenCalledTimes(2);
    });
  });

  describe("3. Replay runner routed fixture integration (loadRecordedRows)", () => {
    it("msn_24fd8dc0470a2c990cc0 produces probeRows: 5 and executionRows: 5", () => {
      const replay = loadRecordedRows({ missionId: "msn_24fd8dc0470a2c990cc0" } as any);
      expect(replay.probeRows).toHaveLength(5);
      expect(replay.executionRows).toHaveLength(5);
      expect(replay.routed?.endpointId).toBe("treg.x.search.posts");
      expect(replay.routed?.forceRoutedEndpoint).toBe(true);
    });

    it("msn_2e341874060213f94110 produces probeRows: 0 and executionRows: 0", () => {
      const replay = loadRecordedRows({ missionId: "msn_2e341874060213f94110" } as any);
      expect(replay.probeRows).toHaveLength(0);
      expect(replay.executionRows).toHaveLength(0);
      expect(replay.routed?.endpointId).toBe("treg.youtube.video.comments");
      expect(replay.routed?.forceRoutedEndpoint).toBe(true);
    });
  });
});
