import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: [] as any[], dispatched: [] as string[], authorized: true }));

vi.mock("../../src/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: () => {
      const chain: any = {};
      for (const method of ["select", "in", "or", "gt", "order"]) chain[method] = () => chain;
      chain.limit = async () => ({ data: state.rows, error: null });
      return chain;
    },
  }),
}));
vi.mock("../../src/lib/server/cronAuth", () => ({
  verifyCronSecret: () => state.authorized,
  resolveInternalBaseUrl: () => "https://diger.test",
  createInternalWorkerAuthHeaders: () => ({}),
}));
vi.mock("../../src/lib/server/workerDispatch", () => ({
  dispatchWorkerChunk: async (_base: string, jobId: string) => { state.dispatched.push(jobId); return { started: true, status: 200, body: {} }; },
}));

import { GET, MAX_JOBS_PER_TICK } from "../../src/app/api/cron/drive/route";

const req = () => ({ headers: new Headers() }) as any;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe("proposal 4g: the driver route", () => {
  beforeEach(() => { state.rows = []; state.dispatched = []; state.authorized = true; });

  it("refuses without the cron secret and touches nothing", async () => {
    state.authorized = false;
    state.rows = [{ id: "j1", step: 0 }];
    expect((await GET(req())).status).toBe(401);
    expect(state.dispatched).toEqual([]);
  });

  it("resumes due jobs, skips a job still in its retry backoff, and never more than the per-tick limit", async () => {
    state.rows = [
      { id: "backoff", step: 1, next_attempt_at: iso(60_000) },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `j${i}`, step: i, next_attempt_at: null })),
    ];
    const body = await (await GET(req())).json();
    expect(state.dispatched).not.toContain("backoff");
    expect(state.dispatched).toHaveLength(MAX_JOBS_PER_TICK);
    expect(body).toMatchObject({ success: true, dispatched: MAX_JOBS_PER_TICK });
  });

  it("moves no money: it only dispatches the existing worker, with no ledger or RPC call", async () => {
    const source = (await import("node:fs")).readFileSync("src/app/api/cron/drive/route.ts", "utf8");
    expect(source).not.toMatch(/credit_ledger|\.rpc\(|reserve_credits|settle_job|release_job/);
  });
});
