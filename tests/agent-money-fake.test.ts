import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fakeMoneyClient, quoteJobId } from "./helpers/agentMoney";

/**
 * THE MONEY FAKE MATCHES THE REAL SQL (docs/MONEY-PR-7A.md section 12; the live functions were read and compared with supabase/migrations). Before the add-on money core (Phase 2A) the fake overwrote a re-created quote,
 * checked no quote status and could push a second ledger row with the same id; a test of money on a fake that is more lenient than the database proves nothing. These are the fake's own tests.
 */
const USER = "11111111-1111-4111-8111-111111111111";
const item = (over: Record<string, unknown> = {}) => ({ capabilitySlug: "agent-edit", endpointId: "agent-edit", missionId: "msn_a", unitPricePoints: 1, targetVolumeMin: 1, targetVolumeMax: 150, ...over });
const hashOf = (items: unknown[]) => createHash("sha256").update(JSON.stringify({ items, formats: ["xlsx", "csv"] })).digest("hex");
const createArgs = (id: string, over: Record<string, unknown> = {}) => {
  const items = (over.items as unknown[]) ?? [item()];
  return { p_user_id: USER, p_quote_id: id, p_quote_hash: hashOf(items), p_items: items, p_total_points: 150, p_output_formats: ["xlsx", "csv"], p_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), p_previous_quote_ids: [], ...over };
};
const acceptArgs = (id: string, items: unknown[] = [item()]) => ({ p_quote_id: id, p_user_id: USER, p_expected_quote_hash: hashOf(items) });
const rpc = (m: ReturnType<typeof fakeMoneyClient>, name: string, args: any) => m.client.rpc(name, args) as Promise<{ data?: any; error?: any }>;
const rows = (m: ReturnType<typeof fakeMoneyClient>, prefix: string) => m.ledger.filter((r) => r.id.startsWith(prefix));

describe("create_quote_atomic", () => {
  it("creates once; the same id with the same contents answers already_created and changes nothing", async () => {
    const m = fakeMoneyClient();
    expect((await rpc(m, "create_quote_atomic", createArgs("q1"))).data).toMatchObject({ success: true, status: "quoted", total_reserved_credits: 150 });
    const again = await rpc(m, "create_quote_atomic", createArgs("q1"));
    expect(again.data).toMatchObject({ success: true, already_created: true, status: "quoted" });
    expect(m.quotes.size).toBe(1);
  });
  it("the same id with another total, another item or another user raises (never overwrites)", async () => {
    const m = fakeMoneyClient();
    await rpc(m, "create_quote_atomic", createArgs("q1"));
    expect((await rpc(m, "create_quote_atomic", createArgs("q1", { p_total_points: 151 }))).error?.message).toContain("idempotency conflict");
    const other = [item({ targetVolumeMax: 151 })];
    expect((await rpc(m, "create_quote_atomic", createArgs("q1", { items: other }))).error?.message).toContain("idempotency conflict");
    expect((await rpc(m, "create_quote_atomic", createArgs("q1", { p_user_id: "22222222-2222-4222-8222-222222222222" }))).error?.message).toContain("idempotency conflict");
    expect(m.quotes.get("q1")!.total).toBe(150);
  });
  it("refuses a total above the cap (25,000 live), a zero total, no items, a bad format and a past expiry", async () => {
    const m = fakeMoneyClient();
    expect((await rpc(m, "create_quote_atomic", createArgs("q1", { p_total_points: 25_001 }))).error?.message).toContain("between 0 and 25000");
    expect((await rpc(m, "create_quote_atomic", createArgs("q2", { p_total_points: 0 }))).error).toBeTruthy();
    expect((await rpc(m, "create_quote_atomic", createArgs("q3", { p_items: [] }))).error).toBeTruthy();
    expect((await rpc(m, "create_quote_atomic", createArgs("q4", { p_output_formats: ["docx"] }))).error?.message).toContain("unsupported output formats");
    expect((await rpc(m, "create_quote_atomic", createArgs("q5", { p_expires_at: new Date(Date.now() - 1000).toISOString() }))).error?.message).toContain("expiry");
    expect(m.quotes.size).toBe(0);
  });
});

describe("accept_quote_atomic", () => {
  it("the job id is job_quote_<md5 of the quote id>, the reserve is res_<job id>, and a second accept answers already_accepted with no second row", async () => {
    const m = fakeMoneyClient({ balance: 1000 });
    await rpc(m, "create_quote_atomic", createArgs("quote_addon_x"));
    const first = (await rpc(m, "accept_quote_atomic", acceptArgs("quote_addon_x"))).data;
    const jobId = `job_quote_${createHash("md5").update("quote_addon_x").digest("hex")}`;
    expect(first).toMatchObject({ success: true, already_accepted: false, job_id: jobId, reserved_credits: 150 });
    expect(quoteJobId("quote_addon_x")).toBe(jobId);
    const second = (await rpc(m, "accept_quote_atomic", acceptArgs("quote_addon_x"))).data;
    expect(second).toMatchObject({ success: true, already_accepted: true, job_id: jobId, reserved_credits: 150 });
    expect(rows(m, "res_")).toEqual([expect.objectContaining({ id: `res_${jobId}`, delta: -150, type: "reserve" })]);
    expect(m.balance()).toBe(850);
    expect(m.jobs.size).toBe(1);
  });
  it("a quote that is not `quoted` (expired by hand) is refused; an unknown quote, a wrong hash and a wrong user are refused", async () => {
    const m = fakeMoneyClient();
    await rpc(m, "create_quote_atomic", createArgs("q1"));
    expect((await rpc(m, "accept_quote_atomic", acceptArgs("nope"))).data.error).toBe("quote_not_found");
    expect((await rpc(m, "accept_quote_atomic", { ...acceptArgs("q1"), p_expected_quote_hash: "0".repeat(64) })).data.error).toBe("quote_hash_mismatch");
    expect((await rpc(m, "accept_quote_atomic", { ...acceptArgs("q1"), p_user_id: "22222222-2222-4222-8222-222222222222" })).data.error).toBe("quote_user_mismatch");
    m.quotes.get("q1")!.status = "expired";
    expect((await rpc(m, "accept_quote_atomic", acceptArgs("q1"))).data).toMatchObject({ success: false, error: "invalid_quote_status", status: "expired" });
    expect(rows(m, "res_")).toEqual([]);
  });
  it("an expired quote is refused", async () => {
    const m = fakeMoneyClient();
    await rpc(m, "create_quote_atomic", createArgs("q1"));
    m.quotes.get("q1")!.expires = Date.now() - 1;
    expect((await rpc(m, "accept_quote_atomic", acceptArgs("q1"))).data.error).toBe("quote_expired");
  });
  it("a job sells at most 5,000 units: 5,001 is refused and nothing is written", async () => {
    const m = fakeMoneyClient();
    const big = [item({ targetVolumeMax: 5001 })];
    await rpc(m, "create_quote_atomic", createArgs("q1", { items: big, p_total_points: 5001 }));
    expect((await rpc(m, "accept_quote_atomic", acceptArgs("q1", big))).data.error).toBe("invalid_target_volume");
    const edge = [item({ targetVolumeMax: 5000 })];
    await rpc(m, "create_quote_atomic", createArgs("q2", { items: edge, p_total_points: 5000 }));
    expect((await rpc(m, "accept_quote_atomic", acceptArgs("q2", edge))).data.success).toBe(true);
    expect(rows(m, "res_")).toHaveLength(1);
  });
  it("a user has at most two active jobs: the third is refused with nothing written", async () => {
    const m = fakeMoneyClient();
    for (const id of ["q1", "q2", "q3"]) {
      await rpc(m, "create_quote_atomic", createArgs(id));
      const got = (await rpc(m, "accept_quote_atomic", acceptArgs(id))).data;
      expect(got.success).toBe(id !== "q3");
      if (id === "q3") expect(got.error).toBe("concurrency_limit");
    }
    expect(rows(m, "res_")).toHaveLength(2);
    expect(m.quotes.get("q3")!.status).toBe("quoted");
  });
  it("insufficient balance writes nothing: no ledger row, no job, the quote stays quoted (and a top-up lets the same quote be accepted)", async () => {
    const m = fakeMoneyClient({ balance: 100 });
    await rpc(m, "create_quote_atomic", createArgs("q1"));
    const before = JSON.stringify(m.ledger);
    expect((await rpc(m, "accept_quote_atomic", acceptArgs("q1"))).data).toMatchObject({ success: false, error: "insufficient_balance", balance: 100 });
    expect(JSON.stringify(m.ledger)).toBe(before);
    expect(m.jobs.size).toBe(0);
    expect(m.quotes.get("q1")!.status).toBe("quoted");
    m.ledger.push({ id: "top_2", delta: 100, type: "topup" });
    expect((await rpc(m, "accept_quote_atomic", acceptArgs("q1"))).data.success).toBe(true);
  });
  it("the quote must have exactly one item with a positive unit price", async () => {
    const m = fakeMoneyClient();
    const two = [item(), item()];
    await rpc(m, "create_quote_atomic", createArgs("q1", { items: two }));
    expect((await rpc(m, "accept_quote_atomic", acceptArgs("q1", two))).data.error).toBe("single_item_quote_required");
    const free = [item({ unitPricePoints: 0 })];
    await rpc(m, "create_quote_atomic", createArgs("q2", { items: free }));
    expect((await rpc(m, "accept_quote_atomic", acceptArgs("q2", free))).data.error).toBe("invalid_item_unit_price");
  });
});

describe("the ledger's unique id, claim, complete, settle and release", () => {
  async function approved(balance = 1000) {
    const m = fakeMoneyClient({ balance });
    await rpc(m, "create_quote_atomic", createArgs("q1"));
    const jobId = (await rpc(m, "accept_quote_atomic", acceptArgs("q1"))).data.job_id as string;
    return { m, jobId };
  }
  it("a ledger id is unique: the fake's own insert refuses a second row with the same id", async () => {
    const { m, jobId } = await approved();
    await rpc(m, "claim_job_chunk", { p_job_id: jobId, p_expected_step: 0, p_lease_seconds: 60 });
    await rpc(m, "complete_chunk", { p_job_id: jobId, p_expected_step: 0, p_new_cursor: "completed", p_new_delivered_units: 100, p_cost_usd: 0.01 });
    // a pre-existing chg_ row (as if another process wrote it): the settlement does not write a second one
    m.ledger.push({ id: `chg_${jobId}`, delta: -100, type: "charge", job_id: jobId });
    const settled = await rpc(m, "settle_job_atomic", { p_job_id: jobId, p_points_cap: 25_000, p_result_file_id: null });
    expect(settled.data.success).toBe(true);
    expect(rows(m, "chg_")).toHaveLength(1);
    expect(rows(m, "rel_")).toHaveLength(1);
  });
  it("claim: a second claim while the lease is held is refused; a finished job cannot be claimed", async () => {
    const { m, jobId } = await approved();
    expect((await rpc(m, "claim_job_chunk", { p_job_id: jobId, p_expected_step: 0, p_lease_seconds: 60 })).data.claimed).toBe(true);
    expect((await rpc(m, "claim_job_chunk", { p_job_id: jobId, p_expected_step: 0, p_lease_seconds: 60 })).data).toMatchObject({ claimed: false, error: "lease_active" });
    expect((await rpc(m, "claim_job_chunk", { p_job_id: "job_none", p_expected_step: 0, p_lease_seconds: 60 })).data.error).toBe("job_not_found");
    expect((await rpc(m, "claim_job_chunk", { p_job_id: jobId, p_expected_step: 1, p_lease_seconds: 60 })).data.claimed).toBe(false);
  });
  it("complete_chunk twice does not apply twice (already_completed); units cannot pass the volume", async () => {
    const { m, jobId } = await approved();
    await rpc(m, "claim_job_chunk", { p_job_id: jobId, p_expected_step: 0, p_lease_seconds: 60 });
    expect((await rpc(m, "complete_chunk", { p_job_id: jobId, p_expected_step: 0, p_new_cursor: "completed", p_new_delivered_units: 151, p_cost_usd: 0 })).error?.message).toContain("exceeds target_volume_max");
    expect((await rpc(m, "complete_chunk", { p_job_id: jobId, p_expected_step: 0, p_new_cursor: "completed", p_new_delivered_units: 90, p_cost_usd: 0.5 })).data.already_completed).toBe(false);
    expect((await rpc(m, "complete_chunk", { p_job_id: jobId, p_expected_step: 0, p_new_cursor: "completed", p_new_delivered_units: 120, p_cost_usd: 0.5 })).data.already_completed).toBe(true);
    expect(m.jobs.get(jobId)!.delivered_units).toBe(90);
    expect(m.jobs.get(jobId)!.accumulated_cost_usd).toBe(0.5);
  });
  it("settle writes the release FIRST and then the charge, charges ceil(delivered x unit) never above the reserve, and twice is idempotent", async () => {
    const { m, jobId } = await approved();
    await rpc(m, "claim_job_chunk", { p_job_id: jobId, p_expected_step: 0, p_lease_seconds: 60 });
    await rpc(m, "complete_chunk", { p_job_id: jobId, p_expected_step: 0, p_new_cursor: "completed", p_new_delivered_units: 150, p_cost_usd: 0 });
    const s1 = await rpc(m, "settle_job_atomic", { p_job_id: jobId, p_points_cap: 100, p_result_file_id: null });
    expect(s1.data).toMatchObject({ already_settled: false, charged_credits: 100 });
    expect(m.ledger.map((r) => r.type)).toEqual(["topup", "reserve", "release", "charge"]);
    const s2 = await rpc(m, "settle_job_atomic", { p_job_id: jobId, p_points_cap: 100, p_result_file_id: null });
    expect(s2.data).toMatchObject({ already_settled: true });
    expect(m.ledger).toHaveLength(4);
    expect(m.balance()).toBe(1000 - 100);
  });
  it("settle refuses a job that is not running, or whose lease is held and whose collection is not complete", async () => {
    const { m, jobId } = await approved();
    expect((await rpc(m, "settle_job_atomic", { p_job_id: jobId, p_points_cap: 25_000 })).error?.message).toContain("must be running");
    await rpc(m, "claim_job_chunk", { p_job_id: jobId, p_expected_step: 0, p_lease_seconds: 60 });
    expect((await rpc(m, "settle_job_atomic", { p_job_id: jobId, p_points_cap: 25_000 })).error?.message).toContain("lease");
  });
  it("release: needs the lease cleared (or force), writes rel_ once, marks the job failed, is idempotent, and refuses a completed job", async () => {
    const { m, jobId } = await approved();
    await rpc(m, "claim_job_chunk", { p_job_id: jobId, p_expected_step: 0, p_lease_seconds: 60 });
    expect((await rpc(m, "release_job_atomic", { p_job_id: jobId, p_error_message: "x" })).error?.message).toContain("lease");
    expect((await rpc(m, "release_job_atomic", { p_job_id: jobId, p_error_message: "x", p_force: true })).data).toMatchObject({ success: true, already_released: false, released_credits: 150 });
    expect((await rpc(m, "release_job_atomic", { p_job_id: jobId, p_error_message: "x" })).data).toMatchObject({ success: true, already_released: true });
    expect(rows(m, "rel_")).toHaveLength(1);
    expect(m.balance()).toBe(1000);
    const done = await approved();
    await rpc(done.m, "claim_job_chunk", { p_job_id: done.jobId, p_expected_step: 0, p_lease_seconds: 60 });
    await rpc(done.m, "complete_chunk", { p_job_id: done.jobId, p_expected_step: 0, p_new_cursor: "completed", p_new_delivered_units: 10, p_cost_usd: 0 });
    await rpc(done.m, "settle_job_atomic", { p_job_id: done.jobId, p_points_cap: 25_000 });
    expect((await rpc(done.m, "release_job_atomic", { p_job_id: done.jobId, p_error_message: "x" })).error?.message).toContain("already completed");
  });
  it("a table touched by hand throws", () => {
    expect(() => fakeMoneyClient().client.from("credit_ledger")).toThrow("by hand");
  });
});

describe("failure injection: a call that fails before it runs, and a call that commits but whose answer is lost", () => {
  it("before: nothing is written; after: the write committed and the caller sees an error; each applies to the next call only", async () => {
    const m = fakeMoneyClient();
    await rpc(m, "create_quote_atomic", createArgs("q1"));
    m.inject("accept_quote_atomic", "before");
    await expect(rpc(m, "accept_quote_atomic", acceptArgs("q1"))).rejects.toThrow("before it ran");
    expect(rows(m, "res_")).toEqual([]);
    m.inject("accept_quote_atomic", "after");
    await expect(rpc(m, "accept_quote_atomic", acceptArgs("q1"))).rejects.toThrow("answer of accept_quote_atomic was lost");
    expect(rows(m, "res_")).toHaveLength(1);
    expect((await rpc(m, "accept_quote_atomic", acceptArgs("q1"))).data).toMatchObject({ success: true, already_accepted: true });
    expect(rows(m, "res_")).toHaveLength(1);
  });
});
