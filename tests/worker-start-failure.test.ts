import { describe, expect, it, vi } from "vitest";
import {
  MAX_WORKER_START_RETRIES,
  WORKER_START_FINAL_REASON_AR,
  recordWorkerStartFailure,
} from "../src/lib/server/workerStartFailure";

function makeAdminClient() {
  let attempts = 0;
  let failed = false;
  const rpc = vi.fn(async (name: string, args: any) => {
    if (name === "record_chunk_failure") {
      if (failed) return { data: { success: true, ignored: true, status: "failed", attempt_count: attempts }, error: null };
      attempts += 1;
      return { data: { success: true, failed_permanently: false, attempt_count: attempts }, error: null };
    }
    if (name === "release_job_atomic") {
      failed = true;
      return { data: { success: true, released_credits: 11 }, error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  });
  const insert = vi.fn(async () => ({ error: null }));
  const client = {
    rpc,
    from: vi.fn((table: string) => {
      if (table === "jobs") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: "u1" }, error: null }) }) }) };
      if (table === "job_events") return { insert };
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
  return { client, rpc, insert };
}

describe("bounded worker-start retries", () => {
  it("allows three retries after the initial attempt, then releases the full reserve once", async () => {
    const { client, rpc, insert } = makeAdminClient();
    expect(MAX_WORKER_START_RETRIES).toBe(3);

    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await recordWorkerStartFailure(client, "job-start"));

    expect(results.slice(0, 3).every((result) => !result.failed && !result.released)).toBe(true);
    expect(results[3]).toMatchObject({ attemptCount: 4, failed: true, released: true, releaseConfirmed: true });
    expect(rpc.mock.calls.filter(([name]) => name === "record_chunk_failure")).toHaveLength(4);
    expect(rpc.mock.calls.filter(([name]) => name === "release_job_atomic")).toEqual([[
      "release_job_atomic",
      { p_job_id: "job-start", p_error_message: WORKER_START_FINAL_REASON_AR },
    ]]);
    expect(insert).toHaveBeenCalledTimes(1);

    const afterTerminal = await recordWorkerStartFailure(client, "job-start");
    expect(afterTerminal).toMatchObject({ failed: true, released: true });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.filter(([name]) => name === "release_job_atomic")).toHaveLength(1);
  });
});
