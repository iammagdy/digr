import { describe, expect, it } from "vitest";
import { readShape } from "../src/lib/treg/shapeReader";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { callTregWithAsync } from "../agent/src/asyncTreg";
import { stageScopeOf, createSourceGateway } from "../agent/src/engine/sourceGateway";
import { RAW_PATH, type GatewayCallResult } from "../agent/src/gateway";

describe("FX-CAT Ph1 Phase 4A: Shape Inference Fallbacks", () => {
  it("infers deeply nested list at response.batches.0.listings when list_path is NOT FOUND", () => {
    const payload = {
      response: {
        batches: [
          {
            batch_id: "b1",
            listings: [
              { id: "item1", title: "Product 1", price: 100 },
              { id: "item2", title: "Product 2", price: 200 },
            ],
          },
        ],
      },
    };
    const r = readShape(payload, { listPath: "NOT FOUND", example: null });
    expect(r.listStrategy).toBe("inferred_list");
    expect(r.listPath).toBe("response.batches.0.listings");
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].id).toBe("item1");
    expect(r.rows[1].price).toBe(200);
  });

  it("infers single object under non-common key (channel_info) as single_object", () => {
    const payload = {
      ok: true,
      channel_info: {
        username: "durov",
        title: "Durov",
        subscribers: 1200000,
        description: "Official channel",
      },
    };
    const r = readShape(payload, { listPath: "NOT FOUND", example: null });
    expect(r.listStrategy).toBe("single_object");
    expect(r.listPath).toBe("channel_info");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].username).toBe("durov");
    expect(r.rows[0].subscribers).toBe(1200000);
  });

  it("infers flat object as root_object when list_path is NOT FOUND and looksLikeOneRecord is true", () => {
    const payload = {
      username: "durov",
      title: "Durov",
      subscribers: 1200000,
    };
    const r = readShape(payload, { listPath: "NOT FOUND", example: null });
    expect(r.listStrategy).toBe("root_object");
    expect(r.listPath).toBe("root");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].username).toBe("durov");
  });

  it("rejects non-record status wrapper (< 3 non-wrapper scalars)", () => {
    const payload = {
      status: "pending",
      message: "queued",
    };
    const r = readShape(payload, { listPath: "NOT FOUND", example: null });
    expect(r.listStrategy).toBe("none");
    expect(r.rows).toEqual([]);
  });
});

describe("FX-CAT Ph1 Phase 4B: Async Polling (async_config)", () => {
  const catalog = loadTregCatalog();
  const submitId = "dataforseo.x.app-data-apple-app-reviews-task-post";
  const pollId = "dataforseo.x.app-data-apple-app-reviews-task-get-advanced";

  function createMockStore() {
    const files = new Map<string, string>();
    return {
      files,
      store: {
        async getFile(_mid: string, path: string) {
          return files.get(path) ?? null;
        },
        async putFile(_mid: string, path: string, content: string) {
          files.set(path, content);
        },
      } as any,
    };
  }

  it("executes submit and polls until success (20100 -> 20000), unwrapping rows and rows_in_code", async () => {
    const { store, files } = createMockStore();
    const missionId = "m_test_async_1";
    let callSeq = 0;
    const callsMade: Array<{ endpoint: string; params: Record<string, unknown> }> = [];

    const callFn = async (endpointId: string, params: Record<string, unknown>): Promise<GatewayCallResult> => {
      callSeq++;
      const callId = `call_${String(callSeq).padStart(4, "0")}`;
      callsMade.push({ endpoint: endpointId, params });

      if (endpointId === submitId) {
        files.set(RAW_PATH(callId), JSON.stringify({ tasks: [{ id: "task_123" }] }));
        return { ok: true, call_id: callId, http_status: 200, rows_in_page: 0 } as GatewayCallResult;
      }
      if (endpointId === pollId && callSeq === 2) {
        files.set(RAW_PATH(callId), JSON.stringify({ tasks: [{ status_code: 20100 }] }));
        return { ok: true, call_id: callId, http_status: 200, rows_in_page: 0 } as GatewayCallResult;
      }
      if (endpointId === pollId && callSeq === 3) {
        files.set(
          RAW_PATH(callId),
          JSON.stringify({
            tasks: [
              {
                status_code: 20000,
                result: [{ items: [{ id: "r1", rating: 5, text: "Great app" }] }],
              },
            ],
          })
        );
        return { ok: true, call_id: callId, http_status: 200, rows_in_page: 0 } as GatewayCallResult;
      }
      throw new Error(`Unexpected call ${endpointId}`);
    };

    const result = await callTregWithAsync(
      { catalog, store, missionId, sleep: async () => {} },
      callFn,
      submitId,
      { app_id: "com.test" }
    );

    expect(result.ok).toBe(true);
    expect(result.rows_in_page).toBe(1);
    expect((result as any).first_rows?.[0]?.id).toBe("r1");
    expect((result as any).rows_in_code).toBe("inputs.call_0003[0].items");
    expect(callsMade).toHaveLength(3);
    expect(callsMade[0].endpoint).toBe(submitId);
    expect(callsMade[1].endpoint).toBe(pollId);
    expect(callsMade[1].params).toEqual({ id: "task_123" });
    expect(callsMade[2].endpoint).toBe(pollId);
    expect(callsMade[2].params).toEqual({ id: "task_123" });
  });

  it("stops cleanly on billed_failure without hanging", async () => {
    const { store, files } = createMockStore();
    const missionId = "m_test_async_fail";
    let callSeq = 0;

    const callFn = async (endpointId: string, _params: Record<string, unknown>): Promise<GatewayCallResult> => {
      callSeq++;
      const callId = `call_${String(callSeq).padStart(4, "0")}`;
      if (endpointId === submitId) {
        files.set(RAW_PATH(callId), JSON.stringify({ tasks: [{ id: "task_fail" }] }));
        return { ok: true, call_id: callId, http_status: 200, rows_in_page: 0 } as GatewayCallResult;
      }
      files.set(RAW_PATH(callId), JSON.stringify({ tasks: [{ status_code: 50000 }] }));
      return { ok: true, call_id: callId, http_status: 200, rows_in_page: 0 } as GatewayCallResult;
    };

    const result = await callTregWithAsync(
      { catalog, store, missionId, sleep: async () => {} },
      callFn,
      submitId,
      { app_id: "com.test" }
    );

    expect(result.ok).toBe(false);
    expect((result as any).failed).toBe(true);
    expect(result.http_status).toBe(500);
  });

  it("sourceGateway stageScopeOf includes poll.endpoint in stage scope", () => {
    const plan = {
      stages: [
        {
          key: "stage_01",
          engine: {
            endpoint_id: submitId,
            alternatives: [],
          },
        },
      ],
    };
    const scope = stageScopeOf(plan as any, catalog);
    expect(scope.stage_01.endpointIds).toContain(submitId);
    expect(scope.stage_01.endpointIds).toContain(pollId);
  });

  it("sourceGateway executes async submit and poll when catalog & store are configured", async () => {
    const { store, files } = createMockStore();
    const missionId = "m_test_engine_async";
    let callSeq = 0;

    const gateway = {
      async tregCall(opts: any): Promise<GatewayCallResult> {
        callSeq++;
        const callId = `call_${String(callSeq).padStart(4, "0")}`;
        if (opts.endpoint_id === submitId) {
          files.set(RAW_PATH(callId), JSON.stringify({ tasks: [{ id: "task_eng" }] }));
          return { ok: true, call_id: callId, http_status: 200, rows_in_page: 0 } as GatewayCallResult;
        }
        if (opts.endpoint_id === pollId) {
          files.set(
            RAW_PATH(callId),
            JSON.stringify({
              tasks: [{ status_code: 20000, result: [{ items: [{ id: "r99", rating: 5 }] }] }],
            })
          );
          return { ok: true, call_id: callId, http_status: 200, rows_in_page: 0 } as GatewayCallResult;
        }
        throw new Error(`Unexpected endpoint ${opts.endpoint_id}`);
      },
    };

    const plan = {
      stages: [{ key: "s1", engine: { endpoint_id: submitId, alternatives: [] } }],
    };
    const sg = createSourceGateway({
      gateway,
      scope: stageScopeOf(plan as any, catalog),
      budget: { spentUsd: () => 0 },
      catalog,
      store,
      missionId,
      sleep: async () => {},
    });

    const res = await sg.call({ stageKey: "s1", endpoint_id: submitId, params: { app_id: "com.test" } });
    expect(res.ok).toBe(true);
    expect((res as any).rows_in_page).toBe(1);
    expect((res as any).call_id).toBe("call_0002");
  });
});
