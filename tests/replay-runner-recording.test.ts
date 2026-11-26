import { describe, it, expect, vi } from "vitest";
import {
  canonicalParams,
  canonicalParamsEquals,
  candidatePaginationKeysOf,
  recordedNextCursorsOn,
  matchRecordedCall,
  recordedGatewayResult,
  resolvePrompt,
  evaluateCrit2,
  type RecordedCallSpec,
  type ReplayRows,
} from "../scripts/full-flow-replay-runner";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { loadTregCatalog, type CatalogEndpoint, type TregCatalog } from "../src/lib/treg/catalog";

const catalog = loadTregCatalog();

const dummyEp1: CatalogEndpoint = {
  id: "test.synthetic.ep1",
  provider: "prov_a",
  platform: "x",
  category: "search",
  capability: "x.search.posts",
  name: "EP 1",
  summary: null,
  method: "GET",
  path: "/posts",
  kind: "direct",
  tier: "core",
  async: null,
  async_config: null,
  inputs: [],
  pagination: ["cursor", "limit"],
  cost: null,
  observed: null,
  scope: "default",
  cost_confidence: null,
  siblings: [],
  test_request: null,
  list_path: null,
  cursor_path: null,
  item_fields: null,
  example_response_trimmed: null,
};

describe("DT-20261125-tweets-replay-parity: Replay Runner Recording Engine Tests", () => {
  it("T1: exact match serves matching recorded call regardless of request order", () => {
    const calls: RecordedCallSpec[] = [
      { phase: "planning", endpoint_id: dummyEp1.id, params: { q: "alpha", limit: 10 }, status: 200, envelope: { output: { posts: [{ id: "p_alpha" }] } } },
      { phase: "planning", endpoint_id: dummyEp1.id, params: { q: "beta", limit: 10 }, status: 200, envelope: { output: { posts: [{ id: "p_beta" }] } } },
    ];
    const res = matchRecordedCall({
      requestedEndpoint: dummyEp1,
      params: { q: "beta", limit: 10 },
      phase: "planning",
      calls,
      catalog: { ...catalog, byId: new Map([[dummyEp1.id, dummyEp1]]) } as any,
    });
    expect(res).not.toBeNull();
    expect(res!.matchRule).toBe("exact");
    expect((res!.call.envelope as any).output.posts[0].id).toBe("p_beta");
  });

  it("T2: page chain serves calls 1, 2, 3 linked by cursor and ends with has_more false", () => {
    const calls: RecordedCallSpec[] = [
      { phase: "execution", endpoint_id: dummyEp1.id, params: { q: "feed" }, status: 200, envelope: { output: { posts: [{ id: "p1" }], next_cursor: "cur_1", has_more: true } } },
      { phase: "execution", endpoint_id: dummyEp1.id, params: { q: "feed", cursor: "cur_1" }, status: 200, envelope: { output: { posts: [{ id: "p2" }], next_cursor: "cur_2", has_more: true } } },
      { phase: "execution", endpoint_id: dummyEp1.id, params: { q: "feed", cursor: "cur_2" }, status: 200, envelope: { output: { posts: [{ id: "p3" }], next_cursor: null, has_more: false } } },
    ];
    const miniCatalog = { ...catalog, byId: new Map([[dummyEp1.id, dummyEp1]]) } as any;

    const m1 = matchRecordedCall({ requestedEndpoint: dummyEp1, params: { q: "feed" }, phase: "execution", calls, catalog: miniCatalog });
    expect(m1?.matchRule).toBe("exact");
    const dig1 = buildShapeDigest(m1!.call.envelope, dummyEp1);
    expect(dig1.reading.nextCursor).toBe("cur_1");
    expect(dig1.reading.hasMore).toBe(true);

    const m2 = matchRecordedCall({ requestedEndpoint: dummyEp1, params: { q: "feed", cursor: "cur_1" }, phase: "execution", calls, catalog: miniCatalog });
    expect(m2).not.toBeNull();
    expect(m2!.matchRule).toBe("page_chain");
    const dig2 = buildShapeDigest(m2!.call.envelope, dummyEp1);
    expect(dig2.reading.nextCursor).toBe("cur_2");

    const m3 = matchRecordedCall({ requestedEndpoint: dummyEp1, params: { q: "feed", cursor: "cur_2" }, phase: "execution", calls, catalog: miniCatalog });
    expect(m3).not.toBeNull();
    expect(m3!.matchRule).toBe("page_chain");
    const dig3 = buildShapeDigest(m3!.call.envelope, dummyEp1);
    expect(dig3.reading.nextCursor).toBeNull();
    expect(dig3.reading.hasMore).toBeFalsy();
  });

  it("T2b: endpoint with size-like key in pagination with same value across pages still chains by cursor, never by size key", () => {
    const dummyEpWithSize: CatalogEndpoint = {
      ...dummyEp1,
      id: "test.synthetic.ep.with_size",
      pagination: ["cursor_token", "synthetic_batch_size"],
    };

    const callsWithSize: RecordedCallSpec[] = [
      {
        phase: "execution",
        endpoint_id: dummyEpWithSize.id,
        params: { q: "feed", cursor_token: null, synthetic_batch_size: 50 },
        status: 200,
        envelope: { output: { posts: [{ id: "p1" }], next_cursor: "page_tok_2" } },
      },
      {
        phase: "execution",
        endpoint_id: dummyEpWithSize.id,
        params: { q: "feed", cursor_token: "page_tok_2", synthetic_batch_size: 50 },
        status: 200,
        envelope: { output: { posts: [{ id: "p2" }], next_cursor: "page_tok_3" } },
      },
      {
        phase: "execution",
        endpoint_id: dummyEpWithSize.id,
        params: { q: "feed", cursor_token: "page_tok_3", synthetic_batch_size: 50 },
        status: 200,
        envelope: { output: { posts: [{ id: "p3" }], next_cursor: null } },
      },
    ];

    const miniCatalogSize = {
      ...catalog,
      byId: new Map([[dummyEpWithSize.id, dummyEpWithSize]]),
    } as any;

    // Requesting page 2 with matching cursor_token and identical synthetic_batch_size
    const m2 = matchRecordedCall({
      requestedEndpoint: dummyEpWithSize,
      params: { q: "feed", cursor_token: "page_tok_2", synthetic_batch_size: 50 },
      phase: "execution",
      calls: callsWithSize,
      catalog: miniCatalogSize,
    });
    expect(m2).not.toBeNull();
    expect(m2!.matchRule).toBe("page_chain");
    expect((m2!.call.envelope as any).output.posts[0].id).toBe("p2");

    // Requesting page 3 with matching cursor_token and identical synthetic_batch_size
    const m3 = matchRecordedCall({
      requestedEndpoint: dummyEpWithSize,
      params: { q: "feed", cursor_token: "page_tok_3", synthetic_batch_size: 50 },
      phase: "execution",
      calls: callsWithSize,
      catalog: miniCatalogSize,
    });
    expect(m3).not.toBeNull();
    expect(m3!.matchRule).toBe("page_chain");
    expect((m3!.call.envelope as any).output.posts[0].id).toBe("p3");
  });

  it("T3: nearest first page matches when query text differs from recorded query", () => {
    const calls: RecordedCallSpec[] = [
      { phase: "planning", endpoint_id: dummyEp1.id, params: { q: "historical recorded text", limit: 20 }, status: 200, envelope: { output: { posts: [{ id: "p_orig" }] } } },
    ];
    const logs: string[] = [];
    const res = matchRecordedCall({
      requestedEndpoint: dummyEp1,
      params: { q: "model modified text", limit: 20 },
      phase: "planning",
      calls,
      catalog: { ...catalog, byId: new Map([[dummyEp1.id, dummyEp1]]) } as any,
      log: (l) => logs.push(l),
    });
    expect(res).not.toBeNull();
    expect(res!.matchRule).toBe("nearest");
    expect(logs.some((l) => l.includes("[recording:nearest]"))).toBe(true);
  });

  it("T4: capability fallback serves endpoint of same capability AND same kind, never different kind", () => {
    const routedEpA: CatalogEndpoint = { ...dummyEp1, id: "test.routed.epA", kind: "routed", capability: "social.search" };
    const routedEpB: CatalogEndpoint = { ...dummyEp1, id: "test.routed.epB", kind: "routed", capability: "social.search" };
    const directEpC: CatalogEndpoint = { ...dummyEp1, id: "test.direct.epC", kind: "direct", capability: "social.search" };

    const calls: RecordedCallSpec[] = [
      { phase: "planning", endpoint_id: routedEpA.id, params: { query: "news" }, status: 200, envelope: { output: { posts: [{ id: "routed_row" }] } } },
    ];
    const miniCatalog = {
      ...catalog,
      byId: new Map<string, CatalogEndpoint>([
        [routedEpA.id, routedEpA],
        [routedEpB.id, routedEpB],
        [directEpC.id, directEpC],
      ]),
    } as any;

    const logs: string[] = [];
    const resB = matchRecordedCall({
      requestedEndpoint: routedEpB,
      params: { query: "news" },
      phase: "planning",
      calls,
      catalog: miniCatalog,
      log: (l) => logs.push(l),
    });
    expect(resB?.matchRule).toBe("capability");
    expect(resB?.call.endpoint_id).toBe(routedEpA.id);
    expect(logs.some((l) => l.includes("[recording:capability]"))).toBe(true);

    const resC = matchRecordedCall({
      requestedEndpoint: directEpC,
      params: { query: "news" },
      phase: "planning",
      calls,
      catalog: miniCatalog,
    });
    expect(resC).toBeNull();
  });

  it("T5: routed fixture with direct requested endpoint returns 0 rows + not_recorded + unmatched 1; routed endpoint returns rows of output (pure synthetic)", () => {
    const syntheticRoutedEp: CatalogEndpoint = {
      ...dummyEp1,
      id: "test.synthetic.routed",
      kind: "routed",
      capability: "social.search",
    };
    const syntheticDirectEp: CatalogEndpoint = {
      ...dummyEp1,
      id: "test.synthetic.direct",
      kind: "direct",
      capability: "social.search",
    };

    const syntheticCatalog: TregCatalog = {
      ...catalog,
      byId: new Map<string, CatalogEndpoint>([
        [syntheticRoutedEp.id, syntheticRoutedEp],
        [syntheticDirectEp.id, syntheticDirectEp],
      ]),
    };

    const routedFixture: ReplayRows = {
      probeRows: [],
      executionRows: [],
      sourceDescription: "Synthetic Routed Fixture",
      origin: "cli",
      routed: {
        endpointId: syntheticRoutedEp.id,
        probeEnvelopes: [
          {
            output: {
              items: [
                { id: "101", text: "Post 1" },
                { id: "102", text: "Post 2" },
              ],
              next_cursor: null,
            },
            _treg: { outcome: "hit", tried: [{ endpoint_id: "ep_direct_sub", status: 200 }] },
          },
        ],
        executionEnvelopes: [],
      },
    };

    // Direct endpoint requesting from routed fixture must be rejected by C4 guard
    const resDirect = recordedGatewayResult({
      fixture: routedFixture,
      requestedEndpoint: syntheticDirectEp,
      params: { q: "test" },
      phase: "planning",
      catalog: syntheticCatalog,
      callId: "call_direct_1",
    });
    expect(resDirect.result.ok).toBe(true);
    if (resDirect.result.ok) {
      expect(resDirect.result.rows_in_page).toBe(0);
      expect(resDirect.result.warnings).toContain("not_recorded");
    }
    expect(resDirect.unmatched).toBe(1);

    // Routed endpoint requesting from routed fixture succeeds
    const resRouted = recordedGatewayResult({
      fixture: routedFixture,
      requestedEndpoint: syntheticRoutedEp,
      params: { q: "test" },
      phase: "planning",
      catalog: syntheticCatalog,
      callId: "call_routed_1",
    });
    expect(resRouted.result.ok).toBe(true);
    if (resRouted.result.ok) {
      expect(resRouted.result.rows_in_page).toBe(2);
    }
    expect(resRouted.unmatched).toBe(0);
  });

  it("T6: empty routed envelope (output list null) returns 0 rows", () => {
    const emptyEnvelope = {
      output: { posts: null, next_cursor: null },
      _treg: { outcome: "empty", tried: [{ endpoint_id: "ep_a", status: 200 }] },
    };
    const digest = buildShapeDigest(emptyEnvelope, { ...dummyEp1, kind: "routed" });
    expect(digest.reading.rows).toHaveLength(0);
  });

  it("T7: no recorded call at all returns 0 rows, has_more false, warning not_recorded, unmatched 1", () => {
    const emptyRecordingFixture: ReplayRows = {
      probeRows: [],
      executionRows: [],
      sourceDescription: "Empty Recording Fixture",
      origin: "cli",
      recording: {
        request: "dummy request",
        calls: [],
      },
    };
    const res = recordedGatewayResult({
      fixture: emptyRecordingFixture,
      requestedEndpoint: dummyEp1,
      params: { test: "unknown" },
      phase: "planning",
      catalog: { ...catalog, byId: new Map([[dummyEp1.id, dummyEp1]]) } as any,
      callId: "call_unmatched_1",
    });
    expect(res.result.ok).toBe(true);
    if (res.result.ok) {
      expect(res.result.rows_in_page).toBe(0);
      expect(res.result.has_more).toBe(false);
      expect(res.result.warnings).toContain("not_recorded");
    }
    expect(res.unmatched).toBe(1);
  });

  it("T7b: recorded refusal (envelope null, status 403) returns ok false, same status, 0 rows", () => {
    const refusalFixture: ReplayRows = {
      probeRows: [],
      executionRows: [],
      sourceDescription: "Refusal Recording Fixture",
      origin: "cli",
      recording: {
        request: "refusal request",
        calls: [
          {
            phase: "planning",
            endpoint_id: dummyEp1.id,
            params: { q: "blocked" },
            status: 403,
            envelope: null,
          },
        ],
      },
    };
    const res = recordedGatewayResult({
      fixture: refusalFixture,
      requestedEndpoint: dummyEp1,
      params: { q: "blocked" },
      phase: "planning",
      catalog: { ...catalog, byId: new Map([[dummyEp1.id, dummyEp1]]) } as any,
      callId: "call_refusal_1",
    });
    expect(res.result.ok).toBe(false);
    if (!res.result.ok && "http_status" in res.result) {
      expect(res.result.http_status).toBe(403);
      expect((res.result as any).rows_in_page).toBe(0);
    }
    expect(res.unmatched).toBe(0);
  });

  it("T7c: routed fixture with empty executionEnvelopes returns 0 rows, has_more false, warnings not_recorded, unmatched 1, without throwing", () => {
    const syntheticRoutedEp: CatalogEndpoint = {
      ...dummyEp1,
      id: "test.synthetic.routed.empty",
      kind: "routed",
      capability: "social.search",
    };
    const syntheticCatalog: TregCatalog = {
      ...catalog,
      byId: new Map<string, CatalogEndpoint>([[syntheticRoutedEp.id, syntheticRoutedEp]]),
    };
    const emptyRoutedFixture: ReplayRows = {
      probeRows: [],
      executionRows: [],
      sourceDescription: "Empty Routed Fixture",
      origin: "cli",
      routed: {
        endpointId: syntheticRoutedEp.id,
        probeEnvelopes: [],
        executionEnvelopes: [],
      },
    };

    const res = recordedGatewayResult({
      fixture: emptyRoutedFixture,
      requestedEndpoint: syntheticRoutedEp,
      params: { q: "test" },
      phase: "execution",
      catalog: syntheticCatalog,
      callId: "call_routed_empty_1",
    });

    expect(res.result.ok).toBe(true);
    if (res.result.ok) {
      expect(res.result.http_status).toBe(200);
      expect(res.result.rows_in_page).toBe(0);
      expect(res.result.has_more).toBe(false);
      expect(res.result.next_cursor).toBeNull();
      expect((res.result as any).shape.shape).toBe("empty");
      expect(res.result.warnings).toContain("not_recorded");
    }
    expect(res.unmatched).toBe(1);
  });

  it("T8: prompt precedence enforces --prompt > fixture request > built-in only on built-ins; exits 2 on empty external", () => {
    const p1 = resolvePrompt(
      { prompt: "CLI prompt", promptPassed: true, missionId: "msn_dummy", fixturePath: "custom.json" },
      { probeRows: [], executionRows: [], sourceDescription: "CLI fixture", origin: "cli", recording: { request: "Fixture request", calls: [] } }
    );
    expect(p1).toBe("CLI prompt");

    const p2 = resolvePrompt(
      { prompt: "default prompt", promptPassed: false, missionId: "msn_dummy", fixturePath: "custom.json" },
      { probeRows: [], executionRows: [], sourceDescription: "CLI fixture", origin: "cli", recording: { request: "Fixture request", calls: [] } }
    );
    expect(p2).toBe("Fixture request");

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("EXIT_2"); }) as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      resolvePrompt(
        { prompt: "default prompt", promptPassed: false, missionId: "msn_24fd8dc0470a2c990cc0", fixturePath: "empty.json" },
        { probeRows: [], executionRows: [], sourceDescription: "CLI fixture", origin: "cli", recording: { request: "", calls: [] } }
      );
    }).toThrow("EXIT_2");
    expect(exitSpy).toHaveBeenCalledWith(2);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("T9: crit2 logic passes at minimum (200/200) and above minimum (549/631) when card matches, fails on mismatch", () => {
    const makePlan = (max: number, reserve: number) => ({
      summary_ar: "خطة تجريبية",
      stages: [{ key: "s1", endpoint_id: "ep1", title_ar: "تغريدات", planned_rows: 10, deliver: true, columns: [], sample_rows: [] }],
      price: { maxChargePoints: max, reservePoints: reserve, unitPricePoints: 10, deliveredRows: 10 },
    });

    const c1 = evaluateCrit2(makePlan(200, 200), null);
    expect(c1.pass).toBe(true);

    const c2 = evaluateCrit2(makePlan(549, 631), null);
    expect(c2.pass).toBe(true);

    const c3 = evaluateCrit2(makePlan(549, 631), 549);
    expect(c3.pass).toBe(true);

    const c4 = evaluateCrit2(makePlan(549, 631), 500);
    expect(c4.pass).toBe(false);

    const c5 = evaluateCrit2(makePlan(700, 631), null);
    expect(c5.pass).toBe(false);
  });

  it("T11a: recording call whose envelope has a next cursor at the catalog cursor_out_path and NO has_more field returns has_more null and next_cursor", () => {
    const syntheticPagingEp: CatalogEndpoint = {
      ...dummyEp1,
      id: "test.synthetic.ep.paging",
      cursor_path: "output.next_cursor",
    };
    const syntheticCatalog: TregCatalog = {
      ...catalog,
      byId: new Map<string, CatalogEndpoint>([[syntheticPagingEp.id, syntheticPagingEp]]),
    };
    const fixtureT11a: ReplayRows = {
      probeRows: [],
      executionRows: [],
      sourceDescription: "Synthetic Recording T11a",
      origin: "cli",
      recording: {
        request: "fetch data",
        calls: [
          {
            phase: "planning",
            endpoint_id: syntheticPagingEp.id,
            params: { q: "test" },
            status: 200,
            envelope: {
              output: {
                items: [{ id: "item_1", text: "Alpha" }],
                next_cursor: "cursor_synth_next_page",
              },
            },
          },
        ],
      },
    };

    const res = recordedGatewayResult({
      fixture: fixtureT11a,
      requestedEndpoint: syntheticPagingEp,
      params: { q: "test" },
      phase: "planning",
      catalog: syntheticCatalog,
    });

    expect(res.result.ok).toBe(true);
    if (res.result.ok) {
      expect(res.result.has_more).toBeNull();
      expect(res.result.next_cursor).toBe("cursor_synth_next_page");
    }
  });

  it("T11b: recording call with envelope has_more false and cursor returns has_more false", () => {
    const syntheticPagingEp: CatalogEndpoint = {
      ...dummyEp1,
      id: "test.synthetic.ep.paging.b",
      cursor_path: "output.next_cursor",
    };
    const syntheticCatalog: TregCatalog = {
      ...catalog,
      byId: new Map<string, CatalogEndpoint>([[syntheticPagingEp.id, syntheticPagingEp]]),
    };
    const fixtureT11b: ReplayRows = {
      probeRows: [],
      executionRows: [],
      sourceDescription: "Synthetic Recording T11b",
      origin: "cli",
      recording: {
        request: "fetch data",
        calls: [
          {
            phase: "planning",
            endpoint_id: syntheticPagingEp.id,
            params: { q: "test" },
            status: 200,
            envelope: {
              output: {
                items: [{ id: "item_1", text: "Alpha" }],
                next_cursor: "cursor_synth_next_page",
                has_more: false,
              },
            },
          },
        ],
      },
    };

    const res = recordedGatewayResult({
      fixture: fixtureT11b,
      requestedEndpoint: syntheticPagingEp,
      params: { q: "test" },
      phase: "planning",
      catalog: syntheticCatalog,
    });

    expect(res.result.ok).toBe(true);
    if (res.result.ok) {
      expect(res.result.has_more).toBe(false);
    }
  });

  it("T11c: recording call with envelope has_more true returns has_more true", () => {
    const syntheticPagingEp: CatalogEndpoint = {
      ...dummyEp1,
      id: "test.synthetic.ep.paging.c",
      cursor_path: "output.next_cursor",
    };
    const syntheticCatalog: TregCatalog = {
      ...catalog,
      byId: new Map<string, CatalogEndpoint>([[syntheticPagingEp.id, syntheticPagingEp]]),
    };
    const fixtureT11c: ReplayRows = {
      probeRows: [],
      executionRows: [],
      sourceDescription: "Synthetic Recording T11c",
      origin: "cli",
      recording: {
        request: "fetch data",
        calls: [
          {
            phase: "planning",
            endpoint_id: syntheticPagingEp.id,
            params: { q: "test" },
            status: 200,
            envelope: {
              output: {
                items: [{ id: "item_1", text: "Alpha" }],
                next_cursor: "cursor_synth_next_page",
                has_more: true,
              },
            },
          },
        ],
      },
    };

    const res = recordedGatewayResult({
      fixture: fixtureT11c,
      requestedEndpoint: syntheticPagingEp,
      params: { q: "test" },
      phase: "planning",
      catalog: syntheticCatalog,
    });

    expect(res.result.ok).toBe(true);
    if (res.result.ok) {
      expect(res.result.has_more).toBe(true);
    }
  });

  it("T11d: routed fixture envelope with a next cursor and no has_more on a routed endpoint returns has_more null", () => {
    const syntheticRoutedEp: CatalogEndpoint = {
      ...dummyEp1,
      id: "test.synthetic.routed.paging.d",
      kind: "routed",
      capability: "social.search",
      cursor_path: "output.next_cursor",
    };
    const syntheticCatalog: TregCatalog = {
      ...catalog,
      byId: new Map<string, CatalogEndpoint>([[syntheticRoutedEp.id, syntheticRoutedEp]]),
    };
    const routedFixtureT11d: ReplayRows = {
      probeRows: [],
      executionRows: [],
      sourceDescription: "Synthetic Routed T11d",
      origin: "cli",
      routed: {
        endpointId: syntheticRoutedEp.id,
        probeEnvelopes: [
          {
            output: {
              items: [{ id: "item_1", text: "Alpha" }],
              next_cursor: "cursor_synth_routed_page",
            },
            _treg: { outcome: "hit", tried: [{ endpoint_id: "ep_direct_sub", status: 200 }] },
          },
        ],
        executionEnvelopes: [],
      },
    };

    const res = recordedGatewayResult({
      fixture: routedFixtureT11d,
      requestedEndpoint: syntheticRoutedEp,
      params: { q: "test" },
      phase: "planning",
      catalog: syntheticCatalog,
    });

    expect(res.result.ok).toBe(true);
    if (res.result.ok) {
      expect(res.result.has_more).toBeNull();
      expect(res.result.next_cursor).toBe("cursor_synth_routed_page");
    }
  });
});
