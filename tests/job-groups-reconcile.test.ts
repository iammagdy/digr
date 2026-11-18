import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TICK_BUDGET_MS,
  MIN_LEFT_FOR_CLAIM_MS,
  MAX_CLAIMS_PER_TICK,
  QUIET_SECONDS,
  FREEZE_GIVE_UP_MS,
  OVERDUE_AFTER_MS,
  STOP_AFTER_EMPTY_PARTS,
  buildPartItem,
  reconcileJobGroups,
} from "../src/lib/server/multiProvider/jobGroups";
import {
  GROUP_CLOSING_NOTICE_AR,
  GROUP_PART_STOPPED_AR,
  GROUP_PART_UNFROZEN_RELEASED_AR,
  groupDrawLineAr,
  groupFinalLineAr,
} from "../src/lib/multiProvider/copy";

const NOW0 = Date.parse("2026-11-20T00:00:00Z");
const w_all_rpc_names_seen_in_this_file = new Set<string>();

function makeWorld() {
  const errors: any[][] = [];
  vi.spyOn(console, "error").mockImplementation((...args: any[]) => {
    errors.push(args);
  });

  const rpcCalls: Array<{ name: string; args: any }> = [];
  const tables: string[] = [];
  const fail: { r00?: any; claim?: any; parts?: any } = {};
  const groups: any[] = [];
  const queue: any[] = [];
  const latency: Record<string, number> = {};
  const answer: { draw?: any; claim?: any } = {};

  const admin = {
    from: (table: string) => {
      tables.push(table);
      let isCountHead = false;
      let statusFilter: string | null = null;
      let deadlineLtFilter: string | null = null;

      const builder = {
        select: (cols: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.count === "exact" && opts?.head) {
            isCountHead = true;
          }
          return builder;
        },
        eq: (col: string, val: any) => {
          if (col === "status") statusFilter = val;
          return builder;
        },
        lt: (col: string, val: any) => {
          if (col === "deadline_at") deadlineLtFilter = val;
          return builder;
        },
        then: (resolve: (val: any) => any, reject: (err: any) => any) => {
          if (latency.r00) {
            vi.advanceTimersByTime(latency.r00);
          }
          if (table === "job_groups" && isCountHead) {
            if (fail.r00) {
              return Promise.resolve(resolve({ count: null, data: null, error: fail.r00 }));
            }
            const matching = groups.filter((g) => {
              if (statusFilter && g.status !== statusFilter) return false;
              if (deadlineLtFilter && !(Date.parse(g.deadline_at) < Date.parse(deadlineLtFilter))) return false;
              return true;
            });
            return Promise.resolve(resolve({ count: matching.length, data: [], error: null }));
          }
          return Promise.resolve(resolve({ data: [], error: null }));
        },
      };
      return builder;
    },
    rpc: (name: string, args: any) => {
      w_all_rpc_names_seen_in_this_file.add(name);
      rpcCalls.push({ name, args });
      if (latency.claim) {
        vi.advanceTimersByTime(latency.claim);
      }
      if (name === "claim_next_job_group") {
        if (fail.claim) {
          return Promise.resolve({ data: null, error: fail.claim });
        }
        if (answer.claim) {
          return Promise.resolve(answer.claim);
        }
        const nextGroup = queue.shift() ?? null;
        if (nextGroup && latency.process) {
          vi.advanceTimersByTime(latency.process);
        }
        return Promise.resolve({
          data: {
            success: true,
            group: nextGroup,
            current: null,
            frozen: false,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };

  return {
    admin,
    rpcCalls,
    tables,
    errors,
    fail,
    groups,
    queue,
    latency,
    answer,
  };
}

const run = (w: ReturnType<typeof makeWorld>, over: any = {}) =>
  reconcileJobGroups(w.admin, {
    nowMs: Date.now(),
    source: "drive",
    budgetMs: TICK_BUDGET_MS,
    ...over,
  });

describe("T01: constants and buildPartItem", () => {
  it("constants are the plan's", () => {
    expect([
      TICK_BUDGET_MS,
      MIN_LEFT_FOR_CLAIM_MS,
      MAX_CLAIMS_PER_TICK,
      QUIET_SECONDS,
      FREEZE_GIVE_UP_MS,
      OVERDUE_AFTER_MS,
      STOP_AFTER_EMPTY_PARTS,
    ]).toEqual([45_000, 35_000, 10, 180, 1_200_000, 8_100_000, 0]);
  });

  it("buildPartItem clones part 1's item for part k with the part's volume, split.part/groupId, no excludeRowKeys; the input is untouched", () => {
    const first = {
      capabilitySlug: "mp-business-contacts",
      unitPricePoints: 7,
      targetVolumeMax: 40,
      targetVolumeMin: 30,
      params: {
        industry: "x",
        excludeRowKeys: ["domain:a.com"],
        split: {
          v: 3,
          part: 1,
          parts: 3,
          perPart: 40,
          partVolumes: [40, 40, 25],
          reachable: 105,
          askedOriginal: 105,
        },
      },
    };
    const snapshot = JSON.stringify(first);
    const item = buildPartItem(first, 3, "grp_1");
    expect(item.targetVolumeMax).toBe(25);
    expect(item.targetVolumeMin).toBe(25);
    expect(item.unitPricePoints).toBe(7);
    expect(item.params.split).toEqual({
      v: 3,
      part: 3,
      parts: 3,
      perPart: 40,
      partVolumes: [40, 40, 25],
      reachable: 105,
      askedOriginal: 105,
      groupId: "grp_1",
    });
    expect("excludeRowKeys" in item.params).toBe(false);
    expect(JSON.stringify(first)).toBe(snapshot);
    expect(buildPartItem(first, 2, "grp_1").targetVolumeMin).toBe(30); // min(30, 40)
  });
});

describe("T02: reconcileJobGroups skeleton and R00", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    [{ code: "42P01", message: "x" }],
    [{ code: "PGRST205", message: "x" }],
    [{ message: "Could not find the table 'public.job_groups' in the schema cache" }],
  ])("(q) NOT INSTALLED: R00 answers %j ⇒ installed:false, no console line, no other call", async (err) => {
    const w = makeWorld();
    w.fail.r00 = err;
    expect(await run(w)).toEqual({ installed: false, claims: 0, frozen: 0, released: 0, drawn: 0, closed: 0 });
    expect(w.errors).toEqual([]);
    expect(w.rpcCalls).toEqual([]);
  });

  it("(q2) UNKNOWN ERROR SHAPE: R00 and the claim answer { code: 'XX999', message: 'boom' } ⇒ at most one console.error per call, never throws", async () => {
    const w = makeWorld();
    w.fail.r00 = { code: "XX999", message: "boom" };
    w.fail.claim = { code: "XX999", message: "boom" };
    const r = await run(w);
    expect(r.installed).toBe(true);
    expect(r.claims).toBe(0);
    expect(w.errors.length).toBeLessThanOrEqual(1);
  });

  it("R00 logs [job-groups:overdue] with the count and the source, and writes nothing", async () => {
    const w = makeWorld();
    w.groups.push({ id: "g1", status: "open", deadline_at: new Date(NOW0 - 3 * 3_600_000).toISOString() });
    await run(w, { source: "watchdog" });
    expect(w.errors).toContainEqual(["[job-groups:overdue]", { count: 1, source: "watchdog" }]);
  });

  it("R00 is skipped when less than 4 s are left", async () => {
    const w = makeWorld();
    await run(w, { budgetMs: 3_000 });
    expect(w.tables).toEqual([]);
  });
});

describe("T03: claim loop R0", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("the claim carries p_quiet_seconds 180 and the S12 text exactly", async () => {
    const w = makeWorld();
    await run(w);
    expect(w.rpcCalls[0]).toEqual({
      name: "claim_next_job_group",
      args: {
        p_quiet_seconds: 180,
        p_closing_notice_ar: GROUP_CLOSING_NOTICE_AR,
      },
    });
  });

  it("(p) CLAIM BUDGET: budget 45 s, first claim's processing takes 12 s ⇒ a second claim; budget 45 s with R00 3 s and processing 12 s ⇒ no second claim after 45 − 3 − 12 < 35", async () => {
    const a = makeWorld();
    a.queue.push({ id: "g1" }, { id: "g2" });
    a.latency.process = 1_000;
    expect((await run(a)).claims).toBe(2);

    const b = makeWorld();
    b.queue.push({ id: "g1" }, { id: "g2" });
    b.latency.r00 = 3_000;
    b.latency.process = 12_000;
    expect((await run(b)).claims).toBe(1);
  });

  it("a watchdog pass with budgetMs 20 s runs R00 only: no claim rpc", async () => {
    const w = makeWorld();
    w.queue.push({ id: "g1" });
    await run(w, { source: "watchdog", budgetMs: 20_000 });
    expect(w.rpcCalls).toEqual([]);
    expect(w.tables).toEqual(["job_groups"]);
  });

  it.each([
    [{ code: "PGRST202", message: "x" }],
    [{ code: "42883", message: "x" }],
  ])("(q) NOT INSTALLED: the claim answers %j ⇒ installed:false, no console line", async (err) => {
    const w = makeWorld();
    w.fail.claim = err;
    expect((await run(w)).installed).toBe(false);
    expect(w.errors).toEqual([]);
  });

  it.each([
    [{ success: true }],
    [{ success: true, group: null }],
    [{ success: false, group: { id: "g" } }],
  ])("the loop ends unless success === true and the group is an object: %j ⇒ 0 claims", async (data) => {
    const w = makeWorld();
    w.answer.claim = { data, error: null };
    expect((await run(w)).claims).toBe(0);
  });

  it("never more than 10 claims in a tick", async () => {
    const w = makeWorld();
    for (let i = 0; i < 15; i++) w.queue.push({ id: `g${i}` });
    expect((await run(w, { budgetMs: 10_000_000 })).claims).toBe(10);
  });
});
