import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { buildRequestIndex } from "../src/lib/requests/buildIndex";
import { loadFailureBoard } from "../src/lib/server/failureBoard";

/**
 * DT-20261119-06 PART B (D-0117), the customer's list «طلباتي»: a delivery with nothing to charge (a people-only file where nobody carries a requested contact) releases the whole hold, and the release marks the JOB `failed`;
 * the MISSION is completed with its file. The list reads the mission's status and delivered count for a job that has a mission, so the request is under «مكتملة», never under the released-hold tab.
 */
const ME = "u-1";
const NOW = Date.parse("2026-11-19T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
let db: MemoryDb;
const clientOf = (d: MemoryDb) => { const money = fakeMoneyClient(); return { from: (t: string) => d.from(t), rpc: money.client.rpc } as any; };
const mission = (id: string, status: string, over: Record<string, unknown> = {}) => ({ id: `msn_${id}`, user_id: ME, status, request_text: `طلب ${id}`, created_at: ago(3600_000), updated_at: ago(3600_000), lease_until: null, job_id: null, summary_ar: null, error: null, ...over });
const job = (id: string, status: string, over: Record<string, unknown> = {}) => ({ id, user_id: ME, status, delivered_units: 0, target_volume_max: 15, created_at: ago(3600_000), ...over });
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: NOW }); db = createMemoryDb(); });
afterEach(() => { vi.useRealTimers(); });

describe("the list reads the mission's count and status for a job of a mission", () => {
  it("the zero edge (job released = failed, mission completed with its file): «مكتملة»; a failed job with no mission or a failed mission stays under the released-hold tab", async () => {
    db.seed("missions", [
      mission("zero", "completed", { job_id: "job_zero", delivered_units: 10 }),
      mission("billable", "completed", { job_id: "job_billable", delivered_units: 15 }),
      mission("failed", "failed", { job_id: "job_failed", delivered_units: 0 }),
    ]);
    db.seed("jobs", [
      job("job_zero", "failed", { delivered_units: 0 }),
      job("job_billable", "completed", { delivered_units: 10 }),
      job("job_failed", "failed", { delivered_units: 0 }),
      job("job_legacy", "failed", { delivered_units: 0 }),
    ]);
    const client = clientOf(db);
    const done = (await buildRequestIndex(client, { userId: ME, tab: "done", now: NOW })).rows.map((r) => r.id).sort();
    const refunded = (await buildRequestIndex(client, { userId: ME, tab: "refunded", now: NOW })).rows.map((r) => r.id).sort();
    expect(done).toEqual(["job_billable", "job_zero"]);
    expect(refunded).toEqual(["job_failed", "job_legacy"]);
  });
});

describe("the admin failure board loads the mission of each job (an add-on row is never one)", () => {
  it("a job released after a delivery with nothing billable, or stored with the billable count, raises no alarm when its mission completed with the sold rows; the same job with no mission does", async () => {
    const at = ago(3600_000);
    db.seed("jobs", [
      job("job_zero", "failed", { updated_at: at, delivered_units: 0, error_message: "عاد الحجز كاملًا" }),
      job("job_billable", "completed", { updated_at: at, delivered_units: 10 }),
      job("job_lonely", "completed", { updated_at: at, delivered_units: 10 }),
    ]);
    db.seed("missions", [
      mission("zero", "completed", { job_id: "job_zero", delivered_units: 15 }),
      mission("billable", "completed", { job_id: "job_billable", delivered_units: 15 }),
    ]);
    const board = await loadFailureBoard(clientOf(db), { now: NOW });
    expect(board.partial).not.toContain("missions");
    expect(board.rows.map((r) => `${r.jobId}:${r.kind}`)).toEqual(["job_lonely:job_partial"]);
  });
});
