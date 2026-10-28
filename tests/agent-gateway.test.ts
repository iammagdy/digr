import { describe, expect, it, vi } from "vitest";
import { parseCatalog, loadTregCatalog } from "../src/lib/treg/catalog";
import { COMMENTS_ENDPOINT, POSTS_ENDPOINT, SENSITIVE_ENDPOINT, WRITE_ENDPOINT, makeHarness, postsPage, tregResult } from "./helpers/agentHarness";
import { RAW_PATH } from "../agent/src/gateway";

/** The gateway refuses BEFORE any call is made, and records every call it does make. Every TREG answer here is fake; global fetch is stubbed to fail so a real call would be loud. */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

describe("treg_call refusals (nothing is sent, nothing is spent)", () => {
  it("refuses an endpoint that is not in the catalog (an id the model made up)", async () => {
    const h = makeHarness();
    const r = await h.gateway.tregCall({ endpoint_id: "x.made.up-endpoint", params: {} });
    expect(r).toMatchObject({ ok: false, refused: "not_sellable" });
    expect(h.call).not.toHaveBeenCalled();
    expect(h.providerCosts).toHaveLength(0);
  });

  it("refuses a write action by the block list", async () => {
    const h = makeHarness();
    const r = await h.gateway.tregCall({ endpoint_id: WRITE_ENDPOINT, params: { a: 1 } });
    expect(r).toMatchObject({ ok: false, refused: "blocked" });
    expect(h.call).not.toHaveBeenCalled();
    expect(h.providerCosts).toHaveLength(0);
  });

  it("refuses the paused providers apollo and datagma by name", async () => {
    const h = makeHarness();
    for (const id of ["apollo.people.search", "datagma.people.enrich"]) {
      expect(await h.gateway.tregCall({ endpoint_id: id, params: {} })).toMatchObject({ ok: false, refused: "blocked" });
    }
    expect(h.call).not.toHaveBeenCalled();
  });

  it("refuses an own_account endpoint", async () => {
    const real = loadTregCatalog().byId.get(POSTS_ENDPOINT)!;
    const catalog = parseCatalog({ endpoints: [{ ...real, scope: "own_account" }] }, []);
    const h = makeHarness({ catalog });
    expect(await h.gateway.tregCall({ endpoint_id: POSTS_ENDPOINT, params: { query: "q" } })).toMatchObject({ ok: false, refused: "blocked" });
    expect(h.call).not.toHaveBeenCalled();
  });

  it("refuses a SENSITIVE endpoint for an account that is neither admin nor verified business", async () => {
    const h = makeHarness();
    const r = await h.gateway.tregCall({ endpoint_id: SENSITIVE_ENDPOINT, params: { email: "a@b.co" } });
    expect(r).toMatchObject({ ok: false, refused: "sensitive_not_allowed" });
    expect(h.call).not.toHaveBeenCalled();
    expect(h.providerCosts).toHaveLength(0);
  });

  it("hides a sensitive endpoint from catalog_search and describe_endpoint for that account", () => {
    const h = makeHarness();
    expect(h.gateway.describeEndpoint({ id: SENSITIVE_ENDPOINT })).toMatchObject({ ok: false, reason: "not_allowed" });
  });

  it("refuses a call with a required parameter missing", async () => {
    const h = makeHarness();
    expect(await h.gateway.tregCall({ endpoint_id: POSTS_ENDPOINT, params: {} })).toMatchObject({ ok: false, refused: "missing_params" });
    expect(h.call).not.toHaveBeenCalled();
    expect(h.providerCosts).toHaveLength(0);
  });

  it("refuses a call that would pass the mission's USD budget, and the refused call is not made", async () => {
    // posts are priced per record: 5 posts = 0.025 USD an estimate; the planning budget is 0.05
    const h = makeHarness({ budgetUsd: 0.05, responses: [tregResult(postsPage(5), 0.025), tregResult(postsPage(5), 0.025), tregResult(postsPage(5), 0.025)] });
    const ask = () => h.gateway.tregCall({ endpoint_id: POSTS_ENDPOINT, params: { query: "q", max_results: 5 } });
    expect(await ask()).toMatchObject({ ok: true });
    expect(await ask()).toMatchObject({ ok: true });
    const third = await ask();
    expect(third).toMatchObject({ ok: false, refused: "over_budget" });
    expect(h.call).toHaveBeenCalledTimes(2);
    expect(h.providerCosts).toHaveLength(2);
  });

  it("refuses a call over the provider's daily cap, before the call, and releases the budget it had reserved", async () => {
    const h = makeHarness({ dailyCapUsd: 0.01, responses: [tregResult(postsPage(5), 0.025)] });
    const r = await h.gateway.tregCall({ endpoint_id: POSTS_ENDPOINT, params: { query: "q", max_results: 5 } });
    expect(r).toMatchObject({ ok: false, refused: "daily_cap" });
    expect(h.call).not.toHaveBeenCalled();
    expect(h.budget.spentUsd()).toBe(0);
    expect(h.budget.reserve(0.05)).toBe(true); // the estimate was given back
  });

  it("does not call when the spend cannot be recorded", async () => {
    const h = makeHarness({ failReserve: true, responses: [tregResult(postsPage(5), 0.025)] });
    expect(await h.gateway.tregCall({ endpoint_id: POSTS_ENDPOINT, params: { query: "q" } })).toMatchObject({ ok: false, refused: "recording_unavailable" });
    expect(h.call).not.toHaveBeenCalled();
    expect(h.budget.spentUsd()).toBe(0);
  });

  it("records each refusal as a mission_calls row with its reason (internal; never shown to a customer)", async () => {
    const h = makeHarness();
    await h.gateway.tregCall({ endpoint_id: WRITE_ENDPOINT, params: {} });
    const rows = await h.store.listCalls(h.mission.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "refused", cost_usd: 0 });
    expect(rows[0].refused_reason).toContain("blocked");
  });
});

describe("treg_call records and digests", () => {
  it("records the ACTUAL charge in provider_costs, saves the full raw page, and returns a digest plus the first rows only", async () => {
    // the answer is 60 rows; the estimate was 0.05 (10 posts) but TREG charged 0.0123
    const page = postsPage(60);
    const h = makeHarness({ responses: [tregResult(page, 0.0123)] });
    const r = await h.gateway.tregCall({ endpoint_id: POSTS_ENDPOINT, params: { query: "قهوة", max_results: 10 } });
    expect(r.ok).toBe(true);
    if (!r.ok || !("rows_in_page" in r)) throw new Error("expected a successful call");
    expect(r.call_id).toBe("call_0001");
    expect(r.rows_in_page).toBe(60);
    expect(r.first_rows).toHaveLength(5);
    expect(JSON.stringify(r).length).toBeLessThan(JSON.stringify(page).length / 3);
    // the actual charge, not the estimate
    expect(h.providerCosts).toHaveLength(1);
    expect(h.providerCosts[0].committedUsd).toBeCloseTo(0.0123, 6);
    expect(h.providerCosts[0]).toMatchObject({ units: 60, status: "success", capabilityId: POSTS_ENDPOINT });
    // the full raw page is saved in the mission's own prefix
    const saved = await h.store.getFile(h.mission.id, RAW_PATH("call_0001"));
    expect(JSON.parse(saved!)).toEqual(page);
    // and the mission_calls row carries the same charge
    const rows = await h.store.listCalls(h.mission.id);
    expect(rows[0]).toMatchObject({ status: "ok", rows_returned: 60, endpoint_id: POSTS_ENDPOINT });
    expect(rows[0].cost_usd).toBeCloseTo(0.0123, 6);
    expect(h.budget.spentUsd()).toBeCloseTo(0.0123, 6);
  });

  it("the call carries the token the worker was given and an idempotency key of the mission", async () => {
    const h = makeHarness({ responses: [tregResult(postsPage(2), 0.01)] });
    await h.gateway.tregCall({ endpoint_id: POSTS_ENDPOINT, params: { query: "q", max_results: 2, notAnInput: "dropped" } });
    const options = h.call.mock.calls[0][0];
    expect(options.idempotencyKey).toBe("agent_msn_test0001_call_0001");
    expect(options.params.notAnInput).toBeUndefined();
    expect(options.jobId).toBe("agent_msn_test0001");
  });

  it("records a failed call at its charge (a failed answer can still be billed) and tells the model without a price", async () => {
    const h = makeHarness({ responses: [tregResult({ error: "boom" }, 0, { ok: false, httpStatus: 500, error: "http_500", errorDetails: "upstream failed" })] });
    const r = await h.gateway.tregCall({ endpoint_id: POSTS_ENDPOINT, params: { query: "q", max_results: 3 } });
    expect(r).toMatchObject({ ok: false, failed: true, http_status: 500 });
    expect(h.providerCosts[0]).toMatchObject({ status: "failed", committedUsd: 0 });
  });

  it("a call that never answered keeps its estimate counted in the budget", async () => {
    const h = makeHarness({ responses: [tregResult(null, 0, { ok: false, httpStatus: 0, timedOut: true, error: "timeout" })] });
    await h.gateway.tregCall({ endpoint_id: POSTS_ENDPOINT, params: { query: "q", max_results: 4 } });
    expect(h.budget.spentUsd()).toBeCloseTo(0.02, 6); // 4 posts at 0.005
  });

  it("never returns a price of the mission to the model", async () => {
    const h = makeHarness({ responses: [tregResult(postsPage(3), 0.015)] });
    const r = await h.gateway.tregCall({ endpoint_id: POSTS_ENDPOINT, params: { query: "q", max_results: 3 } });
    expect(JSON.stringify(r)).not.toMatch(/cost|usd|price/i);
    void COMMENTS_ENDPOINT;
  });
});
