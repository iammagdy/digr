import { describe, expect, it, vi } from "vitest";
import { MAX_WORKER_START_RETRIES, recordWorkerStartFailure } from "../src/lib/server/workerStartFailure";

describe("worker start failure retry boundary", () => {
  it("permits three retries after the initial start, then releases instead of requeueing", async () => {
    expect(MAX_WORKER_START_RETRIES).toBe(3);
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { success: true, attempt_count: 1 }, error: null })
      .mockResolvedValueOnce({ data: { success: true, attempt_count: 2 }, error: null })
      .mockResolvedValueOnce({ data: { success: true, attempt_count: 3 }, error: null })
      .mockResolvedValueOnce({ data: { success: true, attempt_count: 4 }, error: null })
      .mockResolvedValueOnce({ data: { success: true }, error: null });
    const from = vi.fn((table: string) => {
      if (table === "jobs") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: "user-1" } }) }) }) };
      return { insert: vi.fn(async () => ({ data: null, error: null })) };
    });
    const client = { rpc, from };

    for (const attemptCount of [1, 2, 3]) {
      const result = await recordWorkerStartFailure(client, "job-1");
      expect(result).toMatchObject({ attemptCount, failed: false, released: false });
    }
    const terminal = await recordWorkerStartFailure(client, "job-1");
    expect(terminal).toMatchObject({ attemptCount: 4, failed: true, released: true, releaseConfirmed: true });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "record_chunk_failure", "record_chunk_failure", "record_chunk_failure", "record_chunk_failure", "release_job_atomic",
    ]);
    expect(rpc.mock.calls[4][1]).toMatchObject({ p_job_id: "job-1" });
  });
});
