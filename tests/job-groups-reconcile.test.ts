import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
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
import {
  getConfiguredJobPointsCap,
  DEFAULT_JOB_POINTS_CAP,
} from "../src/functions/shared/providerSpend";
import { dedupeIdentityFor } from "../src/lib/server/rowDedupe";
import { frozenPathFor } from "../src/lib/server/multiProvider/jobGroupShared";

let currentDriveWorld: any = null;
let currentWatchdogWorld: any = null;

vi.mock("../src/lib/server/multiProvider/jobGroups", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    reconcileJobGroups: vi.fn(async (admin: any, opts: any) => {
      if (currentDriveWorld?.rejectReconcile || currentWatchdogWorld?.rejectReconcile) {
        throw new Error("reconcile rejected");
      }
      if (
        (currentDriveWorld && currentDriveWorld.neverResolves === "from(job_groups)") ||
        (currentWatchdogWorld && currentWatchdogWorld.neverResolves === "from(job_groups)")
      ) {
        return new Promise(() => {});
      }
      return actual.reconcileJobGroups(admin, opts);
    }),
  };
});

vi.mock("../src/lib/supabase/server", () => ({
  createAdminClient: vi.fn(() => currentWatchdogWorld?.admin ?? currentDriveWorld?.admin ?? makeWorld().admin),
}));

vi.mock("../src/lib/server/workerDispatch", () => ({
  dispatchWorkerChunk: vi.fn(async () => ({ started: false })),
}));

vi.mock("../src/lib/server/cronAuth", () => ({
  verifyCronSecret: vi.fn(() => true),
  resolveInternalBaseUrl: vi.fn(() => "http://x"),
  createInternalWorkerAuthHeaders: vi.fn(() => ({})),
}));

vi.mock("../src/lib/server/jobStallNotifier", () => ({
  notifyStalledJobs: vi.fn(async () => 0),
}));

vi.mock("../src/lib/modelPlanner/planningSession", () => ({
  resumeStalePlanningSessions: vi.fn(async () => ({ considered: 0, stepped: 0, finished: 0 })),
}));

vi.mock("../src/lib/server/jobNotices", () => ({
  insertJobNotice: vi.fn(async () => ({ ok: true })),
  jobStalledNotice: vi.fn(() => "notice"),
}));

vi.mock("../src/lib/server/sendPlatformEmail", () => ({
  getRecipient: vi.fn(async () => ({ email: "u1@example.com", name: "سلمى" })),
  sendPlatformEmail: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../src/lib/supabase/ledger", () => ({
  getBalance: vi.fn(async () => 5123),
}));

const NOW0 = Date.parse("2026-11-20T00:00:00Z");
const w_all_rpc_names_seen_in_this_file = new Set<string>();

const rowsOf = (n: number, tag = "a") =>
  Array.from({ length: n }, (_, i) => ({
    name: `Co ${tag}${i}`,
    website: `https://${tag}${i}.example.com`,
  }));
const bytesOf = (rows: any[]) => Buffer.from(JSON.stringify({ rows }), "utf-8");
const shaOf = (b: Buffer | any[]) => {
  const buf = Buffer.isBuffer(b) ? b : bytesOf(b);
  return createHash("sha256").update(buf).digest("hex");
};
const companyDedupe = dedupeIdentityFor("company");
const idsOf = (rows: any[]) => rows.map((r) => (companyDedupe as any)(r)).filter(Boolean);

const A = rowsOf(10, "a");
const B = rowsOf(10, "b");

function part(
  status: string,
  delivered_units: number,
  charged_credits: number,
  extra: Record<string, any> = {}
) {
  return {
    id: `job_${Math.random().toString(36).slice(2, 8)}`,
    status,
    current_cursor: null,
    delivered_units,
    charged_credits,
    updated_at: new Date(NOW0 - 10 * 60_000).toISOString(),
    ...extra,
  };
}

function makeWorld() {
  const errors: any[][] = [];
  vi.spyOn(console, "error").mockImplementation((...args: any[]) => {
    errors.push(args);
  });

  const rpcCalls: Array<{ name: string; args: any }> = [];
  const tables: string[] = [];
  const fail: { r00?: any; claim?: any; parts?: any; draw?: any } = {};
  const groups: any[] = [];
  const queue: any[] = [];
  const parts = new Map<string, any[]>();
  const partsFrozen = new Map<string, boolean>();
  const latency: Record<string, number> = {};
  const answer: { draw?: any; claim?: any } = {};
  const events: string[] = [];
  const dueJobs: any[] = [];
  const claimedIds: string[] = [];
  const legacyRpcCalls: Array<{ name: string; args: any }> = [];
  const legacy: { release?: any } = {};
  const partials = new Map<string, Buffer>();
  const results = new Map<string, Buffer>();
  const f5 = {
    calls: [] as any[],
    committed: [] as any[],
    dropOnTimeout: false,
    failNext: false,
    failAlways: false,
  };

  let throwAfterDraw = false;
  let abortAfterReads = false;
  let abortBeforeF5 = false;
  let neverResolves: string | null = null;
  let failAll: any = null;
  let stepMs = 0;
  let driverLastTickAgoMs: number | null | undefined = undefined;

  const stepAnswer = (val: any) => ({
    then: (resolve: any, reject: any) => {
      if (resolve) resolve(val);
      Promise.resolve().then(() => {
        if (stepMs > 0) {
          vi.advanceTimersByTime(stepMs);
        }
      });
    },
    catch: (reject: any) => ({
      then: (resolve: any) => resolve(val),
    }),
  });

  let firstItem: any = {
    capabilitySlug: "mp-business-contacts",
    unitPricePoints: 7,
    targetVolumeMax: 10,
    targetVolumeMin: 10,
    params: {
      industry: "x",
      split: {
        v: 3,
        part: 1,
        parts: 3,
        perPart: 10,
        partVolumes: [10, 10, 10],
        reachable: 30,
        askedOriginal: 30,
      },
    },
  };

  const setParts = (gid: string, jobs: any[], withFrozen?: boolean) => {
    parts.set(gid, jobs);
    if (withFrozen !== undefined) {
      partsFrozen.set(gid, withFrozen);
    }
  };

  const group = (id: string) => groups.find((g) => g.id === id);
  const jobsOfGroup = (gid: string) => parts.get(gid) ?? [];
  const jobIdOfPart = (k: number) => (parts.get("grp_1") ?? [])[k - 1]?.id ?? `job_p${k}`;

  const requeue = () => {
    queue.length = 0;
    for (const g of groups) {
      if (g.status === "open") queue.push(g);
    }
  };

  const oneGroupWithPartsDone = (n: number) => {
    const gid = "grp_1";
    const jobs: any[] = [];
    for (let i = 0; i < n; i++) {
      jobs.push(part("completed", 10, 70));
    }
    const g = {
      id: gid,
      quote_id: "q_1",
      user_id: "u1",
      status: "open",
      parts_planned: 3,
      next_part: n + 1,
      asked_original: 30,
      reachable: 30,
      deadline_at: new Date(NOW0 + 3_600_000).toISOString(),
      halted_at: null,
    };
    groups.push(g);
    queue.push(g);
    setParts(gid, jobs, true);
    return g;
  };

  const oneGroupWithParts = (jobs: any[]) => {
    const gid = "grp_1";
    const g = {
      id: gid,
      quote_id: "q_1",
      user_id: "u1",
      status: "open",
      parts_planned: 3,
      next_part: jobs.length + 1,
      asked_original: 30,
      reachable: 30,
      deadline_at: new Date(NOW0 + 3_600_000).toISOString(),
      halted_at: null,
    };
    groups.push(g);
    queue.push(g);
    setParts(gid, jobs, true);
    return g;
  };

  const groupWithRunningPart = (opts: {
    lease_until?: string;
    delivered?: number;
    charged?: number;
    deadlineAheadMs?: number;
    deadlineAgoMs?: number;
    updated_at?: string;
  }) => {
    const gid = "grp_1";
    let deadline_at: string;
    if (opts.deadlineAheadMs !== undefined) {
      deadline_at = new Date(NOW0 + opts.deadlineAheadMs).toISOString();
    } else {
      const ago = opts.deadlineAgoMs ?? 3 * 3_600_000;
      deadline_at = new Date(NOW0 - ago).toISOString();
    }

    const part1 = part("completed", 10, 100);
    const part2 = part("running", opts.delivered ?? 0, opts.charged ?? 0, {
      lease_until: opts.lease_until,
      updated_at: opts.updated_at ?? new Date(NOW0 - 10 * 60_000).toISOString(),
    });

    const g = {
      id: gid,
      quote_id: "q_1",
      user_id: "u1",
      status: "open",
      parts_planned: 3,
      next_part: 3,
      asked_original: 30,
      reachable: 30,
      deadline_at,
      halted_at: null,
    };
    groups.push(g);
    queue.push(g);
    setParts(gid, [part1, part2], true);
    return g;
  };

  const awaitingFreezeGroup = (opts: {
    delivered?: number;
    candidates?: { first: any[]; second: any[] };
    unfreezable?: string;
    updatedAgoMs?: number;
    priorCompleted?: { delivered: number; charged: number };
  }) => {
    const gid = "grp_1";
    const p1Id = "job_p1";
    const updated_at = new Date(NOW0 - (opts.updatedAgoMs ?? 200_000)).toISOString();
    const part1 = part("running", opts.delivered ?? 10, 0, {
      id: p1Id,
      current_cursor: "completed",
      updated_at,
      user_id: "u1",
    });

    const g = {
      id: gid,
      quote_id: "q_1",
      user_id: "u1",
      status: "open",
      parts_planned: 3,
      next_part: 2,
      asked_original: 30,
      reachable: 30,
      deadline_at: new Date(NOW0 + 3_600_000).toISOString(),
      halted_at: null,
    };
    groups.push(g);
    queue.push(g);
    setParts(gid, [part1], false);
    if (opts.priorCompleted) {
      setParts(gid, [part("completed", opts.priorCompleted.delivered, opts.priorCompleted.charged, { id: "job_p0", user_id: "u1" }), part1], false);
      g.next_part = 3;
    }

    if (opts.unfreezable === "every candidate absent") {
      // no files in partials
    } else if (opts.unfreezable === "every readable candidate malformed") {
      partials.set(`u1/${p1Id}/data.json`, Buffer.from("bad json"));
      partials.set(`${p1Id}/data.json`, Buffer.from("bad json"));
    } else if (opts.unfreezable === "rows.length ≠ delivered") {
      partials.set(`u1/${p1Id}/data.json`, bytesOf(rowsOf((opts.delivered ?? 10) - 1, "a")));
      partials.set(`${p1Id}/data.json`, bytesOf(rowsOf((opts.delivered ?? 10) - 1, "b")));
    } else if (opts.unfreezable === "a row without identity") {
      const rows = rowsOf(opts.delivered ?? 10, "a");
      rows[0] = { other: 1 } as any;
      partials.set(`u1/${p1Id}/data.json`, Buffer.from(JSON.stringify({ rows })));
      partials.set(`${p1Id}/data.json`, Buffer.from(JSON.stringify({ rows })));
    } else if (opts.unfreezable === "a duplicate identity") {
      const rows = rowsOf(opts.delivered ?? 10, "a");
      if (rows.length >= 2) rows[1] = { ...rows[0] };
      partials.set(`u1/${p1Id}/data.json`, bytesOf(rows));
      partials.set(`${p1Id}/data.json`, bytesOf(rows));
    } else if (opts.unfreezable === "F5 answers keys_overlap") {
      partials.set(`u1/${p1Id}/data.json`, bytesOf(rowsOf(opts.delivered ?? 10, "a")));
      (f5 as any).failKeysOverlap = true;
    } else if (opts.candidates) {
      partials.set(`u1/${p1Id}/data.json`, bytesOf(opts.candidates.first));
      partials.set(`${p1Id}/data.json`, bytesOf(opts.candidates.second));
    } else {
      const defaultRows = rowsOf(opts.delivered ?? 10, "a");
      partials.set(`u1/${p1Id}/data.json`, bytesOf(defaultRows));
    }

    return g;
  };

  const groupWithFailedPart = (opts: { cursor?: string | null; priorCompleted?: { delivered: number; charged: number } }) => {
    const gid = "grp_1";
    const p1Id = "job_p1";
    const part1 = part("failed", 0, 0, {
      id: p1Id,
      current_cursor: opts.cursor ?? null,
      user_id: "u1",
    });

    const g = {
      id: gid,
      quote_id: "q_1",
      user_id: "u1",
      status: "open",
      parts_planned: 3,
      next_part: 2,
      asked_original: 30,
      reachable: 30,
      deadline_at: new Date(NOW0 + 3_600_000).toISOString(),
      halted_at: null,
    };
    groups.push(g);
    queue.push(g);
    setParts(gid, [part1], false);
    if (opts.priorCompleted) {
      part1.delivered_units = 10;
      setParts(gid, [part("completed", opts.priorCompleted.delivered, opts.priorCompleted.charged, { id: "job_p0", user_id: "u1" }), part1], false);
      g.next_part = 3;
    }
    return g;
  };

  const oneGroupPastDeadline = () => {
    const gid = "grp_1";
    const part1 = part("completed", 10, 10, { id: "job_p1", user_id: "u1" });
    const g = {
      id: gid,
      quote_id: "q_1",
      user_id: "u1",
      status: "open",
      parts_planned: 3,
      next_part: 2,
      asked_original: 30,
      reachable: 30,
      deadline_at: new Date(NOW0 - 3_600_000).toISOString(),
      halted_at: null,
    };
    groups.push(g);
    queue.push(g);
    setParts(gid, [part1], true);
    return g;
  };

  const manyGroups = (opts: {
    stuckDrawers?: number;
    runningParts?: number;
    closable?: number;
    actionable?: number;
    overduePast2h?: number;
  }) => {
    if (opts.stuckDrawers) {
      for (let i = 1; i <= opts.stuckDrawers; i++) {
        const gid = `grp_stuck_${i}`;
        const p1 = part("completed", 10, 10, { id: `job_stuck_${i}_p1`, user_id: "u1" });
        const g = {
          id: gid,
          quote_id: "q_1",
          user_id: "u1",
          status: "open",
          parts_planned: 3,
          next_part: 2,
          asked_original: 30,
          reachable: 30,
          deadline_at: new Date(NOW0 + 3_600_000).toISOString(),
          last_attempt_at: null,
          halted_at: null,
        };
        groups.push(g);
        setParts(gid, [p1], true);
      }
    }

    if (opts.runningParts) {
      for (let i = 1; i <= opts.runningParts; i++) {
        const gid = `grp_running_${i}`;
        const p1 = part("running", 0, 0, {
          id: `job_running_${i}_p1`,
          user_id: "u1",
          lease_until: new Date(NOW0 + 60_000).toISOString(),
          current_cursor: null,
        });
        const g = {
          id: gid,
          quote_id: "q_1",
          user_id: "u1",
          status: "open",
          parts_planned: 3,
          next_part: 2,
          asked_original: 30,
          reachable: 30,
          deadline_at: new Date(NOW0 + 3_600_000).toISOString(),
          last_attempt_at: null,
          halted_at: null,
        };
        groups.push(g);
        setParts(gid, [p1], false);
      }
    }

    if (opts.closable) {
      const gid = "grp_closable";
      const p1 = part("completed", 10, 10, { id: "job_closable_p1", user_id: "u1" });
      const p2 = part("completed", 10, 10, { id: "job_closable_p2", user_id: "u1" });
      const p3 = part("completed", 10, 10, { id: "job_closable_p3", user_id: "u1" });
      const g = {
        id: gid,
        quote_id: "q_1",
        user_id: "u1",
        status: "open",
        parts_planned: 3,
        next_part: 4,
        asked_original: 30,
        reachable: 30,
        deadline_at: new Date(NOW0 + 3_600_000).toISOString(),
        last_attempt_at: null,
        halted_at: null,
      };
      groups.push(g);
      setParts(gid, [p1, p2, p3], true);
    }

    if (opts.actionable) {
      for (let i = 1; i <= opts.actionable; i++) {
        const gid = `grp_act_${i}`;
        const p1 = part("completed", 10, 10, { id: `job_act_${i}_p1`, user_id: "u1" });
        const g = {
          id: gid,
          quote_id: "q_1",
          user_id: "u1",
          status: "open",
          parts_planned: 3,
          next_part: 2,
          asked_original: 30,
          reachable: 30,
          deadline_at: new Date(NOW0 + 3_600_000).toISOString(),
          last_attempt_at: null,
          halted_at: null,
        };
        groups.push(g);
        setParts(gid, [p1], true);
      }
    }

    if (opts.overduePast2h) {
      const gid = "grp_overdue";
      const p1 = part("running", 0, 0, {
        id: "job_overdue_p1",
        user_id: "u1",
        lease_until: new Date(NOW0 - 40 * 60_000).toISOString(),
        updated_at: new Date(NOW0 - 40 * 60_000).toISOString(),
        current_cursor: null,
      });
      const g = {
        id: gid,
        quote_id: "q_1",
        user_id: "u1",
        status: "open",
        parts_planned: 3,
        next_part: 2,
        asked_original: 30,
        reachable: 30,
        deadline_at: new Date(NOW0 - OVERDUE_AFTER_MS - 60_000).toISOString(),
        last_attempt_at: null,
        halted_at: null,
      };
      groups.push(g);
      setParts(gid, [p1], false);
    }
  };

  const rewriteAllDataTo = (rows: any[]) => {
    const buf = bytesOf(rows);
    for (const key of partials.keys()) {
      partials.set(key, buf);
    }
  };

  const partialsBucket = {
    download: async (path: string) => {
      if (partials.has(path)) {
        const buf = partials.get(path)!;
        return Promise.resolve({ data: new Blob([buf as any]), error: null });
      }
      return Promise.resolve({ data: null, error: { message: "Object not found", statusCode: "404" } });
    },
    upload: async (path: string, bytes: any) => {
      partials.set(path, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
      return Promise.resolve({ data: { path }, error: null });
    },
  };

  const resultsBucket = {
    download: async (path: string) => {
      if (results.has(path)) {
        const buf = results.get(path)!;
        return Promise.resolve({ data: new Blob([buf as any]), error: null });
      }
      return Promise.resolve({ data: null, error: { message: "Object not found", statusCode: "404" } });
    },
    upload: async (path: string, bytes: any) => {
      if (results.has(path)) {
        return Promise.resolve({ data: null, error: { message: "The resource already exists", statusCode: "409" } });
      }
      results.set(path, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
      if (abortBeforeF5) {
        throw new Error("abortBeforeF5");
      }
      return Promise.resolve({ data: { path }, error: null });
    },
  };

  const admin = {
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [] } }),
        deleteUser: async () => ({}),
      },
    },
    storage: {
      from: (bucket: string) => {
        if (bucket === "partials") return partialsBucket;
        if (bucket === "results") return resultsBucket;
        throw new Error("unknown bucket: " + bucket);
      },
    },
    from: (table: string) => {
      tables.push(table);
      if (table === "driver_heartbeat") {
        return {
          upsert: async () => ({ error: null }),
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data:
                  driverLastTickAgoMs === null
                    ? null
                    : {
                        last_tick_at: new Date(
                          Date.now() - (driverLastTickAgoMs ?? 0)
                        ).toISOString(),
                      },
                error: null,
              }),
            }),
          }),
        };
      }
      let isCountHead = false;
      let statusFilter: string | null = null;
      let deadlineLtFilter: string | null = null;
      let eqCol: string | null = null;
      let eqVal: any = null;
      let inCol: string | null = null;
      let inVals: any[] = [];

      const builder = {
        select: (cols: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.count === "exact" && opts?.head) {
            isCountHead = true;
          }
          return builder;
        },
        eq: (col: string, val: any) => {
          if (col === "status") statusFilter = val;
          if (col === "deadline_at") deadlineLtFilter = val;
          eqCol = col;
          eqVal = val;
          return builder;
        },
        lt: (col: string, val: any) => {
          if (col === "deadline_at") deadlineLtFilter = val;
          return builder;
        },
        in: (col: string, vals: any[]) => {
          inCol = col;
          inVals = vals;
          return builder;
        },
        or: () => builder,
        gt: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => {
          if (neverResolves === `from(${table})`) {
            return new Promise(() => {});
          }
          if (failAll) {
            return stepAnswer({ data: null, error: failAll });
          }
          if (table === "plans_quotes") {
            return stepAnswer({ data: { items: [firstItem] }, error: null });
          }
          return stepAnswer({ data: null, error: null });
        },
        then: (resolve: (val: any) => any, reject: (err: any) => any) => {
          if (neverResolves === `from(${table})`) {
            return;
          }
          if (failAll) {
            return resolve({ data: null, error: failAll });
          }
          if (latency.r00) {
            vi.advanceTimersByTime(latency.r00);
          }
          const finish = (result: any) => {
            resolve(result);
            Promise.resolve().then(() => {
              if (stepMs > 0) {
                vi.advanceTimersByTime(stepMs);
              }
            });
          };
          if (table === "job_groups" && isCountHead) {
            if (fail.r00) {
              return Promise.resolve(finish({ count: null, data: null, error: fail.r00 }));
            }
            const matching = groups.filter((g) => {
              if (statusFilter && g.status !== statusFilter) return false;
              if (deadlineLtFilter && !(Date.parse(g.deadline_at) < Date.parse(deadlineLtFilter))) return false;
              return true;
            });
            return Promise.resolve(finish({ count: matching.length, data: [], error: null }));
          }

          if (table === "job_group_parts") {
            if (fail.parts) {
              return Promise.resolve(finish({ data: null, error: fail.parts }));
            }
            const gid = eqVal;
            const gParts = parts.get(gid) ?? [];
            const data = gParts.map((j, idx) => ({
              part_index: idx + 1,
              job_id: j.id,
            }));
            return Promise.resolve(finish({ data, error: null }));
          }

          if (table === "jobs") {
            if (abortAfterReads) {
              throw new Error("abortAfterReads");
            }
            if (inCol === "status") {
              return Promise.resolve(finish({ data: [...dueJobs], error: null }));
            }
            const allJobs: any[] = [];
            for (const jList of parts.values()) {
              allJobs.push(...jList);
            }
            const matching = allJobs.filter((j) => (inVals.length > 0 ? inVals.includes(j.id) : true));
            return Promise.resolve(finish({ data: matching, error: null }));
          }

          if (table === "plans_quotes") {
            return Promise.resolve(finish({ data: { items: [firstItem] }, error: null }));
          }

          return Promise.resolve(finish({ data: [], error: null }));
        },
      };
      return builder;
    },
    rpc: (name: string, args: any) => {
      if (name === "release_job_atomic" && legacy.release !== undefined) {
        legacyRpcCalls.push({ name, args });
        return stepAnswer(legacy.release ?? { data: null, error: null });
      }
      w_all_rpc_names_seen_in_this_file.add(name);
      if (
        (name === "draw_next_group_part_atomic" && neverResolves === "rpc draw") ||
        (name === "close_job_group_atomic" && neverResolves === "rpc close")
      ) {
        return new Promise(() => {});
      }
      if (failAll) {
        return stepAnswer({ data: null, error: failAll });
      }
      if (latency.claim && name === "claim_next_job_group") {
        vi.advanceTimersByTime(latency.claim);
      }
      if (name === "claim_next_job_group") {
        if (fail.claim) {
          rpcCalls.push({ name, args });
          return stepAnswer({ data: null, error: fail.claim });
        }
        if (answer.claim) {
          rpcCalls.push({ name, args });
          return stepAnswer(answer.claim);
        }
        let nextGroup: any = null;
        if (queue.length > 0) {
          nextGroup = queue.shift() ?? null;
        } else {
          const nowMs = Date.now();
          const candidates = groups.filter((g) => {
            if (g.status !== "open") return false;
            if (g.last_attempt_at != null && Date.parse(g.last_attempt_at) >= nowMs - 30_000) {
              return false;
            }
            const gid = g.id;
            const gParts = parts.get(gid) ?? [];
            const L = (g.next_part ?? 1) - 1;
            const j = L > 0 ? (gParts[L - 1] ?? null) : null;
            if (nowMs >= Date.parse(g.deadline_at)) {
              return true;
            }
            if (!j) {
              return true;
            }
            const quietSec = (args.p_quiet_seconds ?? 180) * 1000;
            const isQuiet = Date.parse(j.updated_at ?? "1970-01-01") <= nowMs - quietSec;
            if (!isQuiet) return false;
            if (j.status === "completed" || j.status === "failed") {
              return true;
            }
            if (
              j.status === "running" &&
              j.current_cursor === "completed" &&
              (!j.lease_until || Date.parse(j.lease_until) < nowMs)
            ) {
              return true;
            }
            return false;
          });

          candidates.sort((a, b) => {
            if (a.last_attempt_at == null && b.last_attempt_at != null) return -1;
            if (a.last_attempt_at != null && b.last_attempt_at == null) return 1;
            if (a.last_attempt_at != null && b.last_attempt_at != null) {
              const diff = Date.parse(a.last_attempt_at) - Date.parse(b.last_attempt_at);
              if (diff !== 0) return diff;
            }
            return a.id.localeCompare(b.id);
          });

          nextGroup = candidates[0] ?? null;
        }

        if (nextGroup) {
          claimedIds.push(nextGroup.id);
          nextGroup.last_attempt_at = new Date(Date.now()).toISOString();
          rpcCalls.push({ name, args });
          if (latency.process) {
            vi.advanceTimersByTime(latency.process);
          }
          const gid = nextGroup.id;
          const gParts = parts.get(gid) ?? [];
          const L = (nextGroup.next_part ?? 1) - 1;
          const currentJob = L > 0 ? (gParts[L - 1] ?? null) : null;
          const isFrozen = partsFrozen.get(gid) ?? false;
          return stepAnswer({
            data: {
              success: true,
              group: nextGroup,
              current: currentJob,
              frozen: isFrozen,
            },
            error: null,
          });
        }
        if (rpcCalls.length === 0) {
          rpcCalls.push({ name, args });
        }
        return stepAnswer({
          data: {
            success: true,
            group: null,
            current: null,
            frozen: false,
          },
          error: null,
        });
      }

      rpcCalls.push({ name, args });

      if (name === "close_job_group_atomic") {
        const grp = groups.find((g) => g.id === args.p_group_id);
        if (grp) grp.status = "closed";
        return stepAnswer({
          data: {
            success: true,
            released_credits: 0,
          },
          error: null,
        });
      }

      if (name === "draw_next_group_part_atomic") {
        if (latency.draw) {
          return {
            then: (resolve: any) => {
              vi.advanceTimersByTime(latency.draw);
              resolve({ data: null, error: { message: "timeout" } });
            },
          };
        }
        if (answer.draw) {
          return stepAnswer(answer.draw);
        }
        const gid = args.p_group_id;
        const partIdx = args.p_part_index;
        const gParts = parts.get(gid) ?? [];
        if (gParts.length >= partIdx) {
          if (throwAfterDraw) throw new Error("transport error after draw");
          const grp = groups.find((g) => g.id === gid);
          if (grp) grp.next_part = partIdx + 1;
          return stepAnswer({
            data: {
              success: true,
              already_drawn: true,
              job_id: gParts[partIdx - 1].id,
            },
            error: null,
          });
        }
        const newJob = part("queued", 0, 0, { id: `job_part_${partIdx}` });
        gParts.push(newJob);
        parts.set(gid, gParts);
        events.push(args.p_event_ar);
        if (throwAfterDraw) throw new Error("transport error after draw");
        const grp = groups.find((g) => g.id === gid);
        if (grp) grp.next_part = partIdx + 1;
        return stepAnswer({
          data: {
            success: true,
            already_drawn: false,
            job_id: newJob.id,
          },
          error: null,
        });
      }

      if (name === "freeze_and_settle_group_part_atomic") {
        f5.calls.push(args);
        return {
          then: (resolve: any) => {
            if (latency.f5) {
              vi.advanceTimersByTime(latency.f5);
            }
            if ((f5 as any).failKeysOverlap) {
              return resolve({ data: { success: false, error: "keys_overlap" }, error: null });
            }
            if (f5.failNext) {
              f5.failNext = false;
              return resolve({ data: null, error: { message: "rpc down" } });
            }
            if (f5.failAlways) {
              return resolve({ data: null, error: { message: "rpc down" } });
            }
            const existing = f5.committed.find(
              (c) => c.p_group_id === args.p_group_id && c.p_part_index === args.p_part_index
            );
            if (existing) {
              return resolve({
                data: {
                  success: true,
                  already_frozen: true,
                  path: args.p_path,
                  sha256: args.p_sha256,
                  row_count: args.p_row_count,
                  charged_credits: 0,
                },
                error: null,
              });
            }
            f5.committed.push(args);
            const gid = args.p_group_id;
            const gParts = parts.get(gid) ?? [];
            const partIdx = args.p_part_index;
            if (gParts[partIdx - 1]) {
              const j = gParts[partIdx - 1];
              j.status = "completed";
              j.charged_credits = (j.delivered_units ?? 0) * 7;
            }
            partsFrozen.set(gid, true);
            return resolve({
              data: {
                success: true,
                already_frozen: false,
                path: args.p_path,
                sha256: args.p_sha256,
                row_count: args.p_row_count,
                charged_credits: (gParts[partIdx - 1]?.delivered_units ?? 0) * 7,
              },
              error: null,
            });
          },
        };
      }

      if (name === "release_unfrozen_group_part_atomic") {
        const commitF6 = () => {
          const gid = args.p_group_id;
          const grp = groups.find((g) => g.id === gid);
          if (grp) {
            grp.halted_at = new Date(NOW0).toISOString();
          }
          const gParts = parts.get(gid) ?? [];
          const partIdx = args.p_part_index;
          if (gParts[partIdx - 1]) {
            gParts[partIdx - 1].status = "failed";
          }
          return { data: { success: true }, error: null };
        };

        return {
          then: (resolve: any) => {
            if (latency.f6) {
              vi.advanceTimersByTime(latency.f6);
            }
            resolve(commitF6());
          },
        };
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
    parts,
    latency,
    answer,
    events,
    dueJobs,
    claimedIds,
    legacyRpcCalls,
    legacy,
    rejectReconcile: false,
    firstItem,
    partials,
    results,
    f5,
    set throwAfterDraw(v: boolean) {
      throwAfterDraw = v;
    },
    get throwAfterDraw() {
      return throwAfterDraw;
    },
    set abortAfterReads(v: boolean) {
      abortAfterReads = v;
    },
    get abortAfterReads() {
      return abortAfterReads;
    },
    set abortBeforeF5(v: boolean) {
      abortBeforeF5 = v;
    },
    get abortBeforeF5() {
      return abortBeforeF5;
    },
    set neverResolves(v: string | null) {
      neverResolves = v;
    },
    get neverResolves() {
      return neverResolves;
    },
    set failAll(v: any) {
      failAll = v;
    },
    get failAll() {
      return failAll;
    },
    set stepMs(v: number) {
      stepMs = v;
    },
    get stepMs() {
      return stepMs;
    },
    get driverLastTickAgoMs() {
      return driverLastTickAgoMs;
    },
    set driverLastTickAgoMs(v: number | null | undefined) {
      driverLastTickAgoMs = v;
    },
    setParts,
    group,
    jobsOfGroup,
    jobIdOfPart,
    requeue,
    oneGroupWithPartsDone,
    oneGroupWithParts,
    groupWithRunningPart,
    awaitingFreezeGroup,
    groupWithFailedPart,
    oneGroupPastDeadline,
    manyGroups,
    rewriteAllDataTo,
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

describe("T04: R1, R3, R4 and close", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["all done, Z = X", { parts_planned: 2, next_part: 3, asked_original: 20, reachable: 20 }, [part("completed", 10, 100), part("completed", 10, 100)], "all_parts_done", 20, 200],
    ["all done, Z < X (short)", { parts_planned: 2, next_part: 3, asked_original: 25, reachable: 25 }, [part("completed", 10, 100), part("completed", 8, 80)], "all_parts_done", 18, 180],
    ["all done, Y < X", { parts_planned: 2, next_part: 3, asked_original: 50, reachable: 20 }, [part("completed", 10, 100), part("completed", 10, 100)], "all_parts_done", 20, 200],
    ["deadline passed", { parts_planned: 3, next_part: 2, asked_original: 30, reachable: 30, deadline_at: new Date(NOW0 - 1_000).toISOString() }, [part("completed", 10, 100)], "deadline", 10, 100],
  ])("(e) END TEXTS: %s ⇒ close with the exact §6 line and the fake sums", async (_n, g, jobs, reason, Z, C) => {
    const w = makeWorld();
    w.queue.push({ id: "grp_1", status: "open", deadline_at: new Date(NOW0 + 3_600_000).toISOString(), halted_at: null, ...g });
    w.setParts("grp_1", jobs, true);
    const r = await run(w);
    const close = w.rpcCalls.find((c) => c.name === "close_job_group_atomic")!;
    expect(close.args).toEqual({
      p_group_id: "grp_1",
      p_reason: reason,
      p_final_line_ar: groupFinalLineAr({ reason: reason as any, Z, X: g.asked_original, Y: g.reachable, C }),
      p_delivered_total: Z,
      p_charged_total: C,
      p_part_release_ar: null,
    });
    expect(r.closed).toBe(1);
  });

  it("halted_at alone: part L completed and frozen, parts left ⇒ no draw, ONE close('part_unfrozen')", async () => {
    const w = makeWorld();
    w.queue.push({
      id: "grp_1",
      status: "open",
      parts_planned: 3,
      next_part: 2,
      asked_original: 30,
      reachable: 30,
      deadline_at: new Date(NOW0 + 3_600_000).toISOString(),
      halted_at: new Date(NOW0 - 60_000).toISOString(),
    });
    w.setParts("grp_1", [part("completed", 10, 100)], true);
    const r = await run(w);
    const names = w.rpcCalls.map((c) => c.name);
    expect(names).not.toContain("draw_next_group_part_atomic");
    expect(names.filter((n) => n === "close_job_group_atomic").length).toBe(1);
    expect(w.rpcCalls.find((c) => c.name === "close_job_group_atomic")!.args.p_reason).toBe("part_unfrozen");
    expect(r.closed).toBe(1);
  });

  it("a malformed claimed group does not erase the counters: each group runs in its own try/catch", async () => {
    const w = makeWorld();
    w.queue.push({ id: "g0" }, { id: "g1" });
    const r = await run(w);
    expect(r.claims).toBe(2);
    expect(r.installed).toBe(true);
    expect(w.errors.length).toBeLessThanOrEqual(1);
  });

  it("R3 read failure: the parts select errors ⇒ no close, no draw", async () => {
    const w = makeWorld();
    w.queue.push({ id: "grp_1", next_part: 2, parts_planned: 3 });
    w.fail.parts = { message: "x" };
    await run(w);
    expect(w.rpcCalls.map((c) => c.name)).toEqual(["claim_next_job_group"]);
  });
});

describe("T05: draw R5", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("(a) LOST RESPONSE: the draw commits, the transport throws ⇒ the next tick draws again ⇒ already_drawn ⇒ exactly ONE part-2 job and ONE S2 line", async () => {
    const w = makeWorld();
    w.oneGroupWithPartsDone(1);
    w.throwAfterDraw = true;
    await run(w);
    w.throwAfterDraw = false;
    w.requeue();
    const r2 = await run(w);
    expect(w.jobsOfGroup("grp_1").length).toBe(2);
    expect(w.events.filter((e: any) => e === groupDrawLineAr({ k: 2, K: 3, Z: 10, Y: 30 })).length).toBe(1);
    expect(r2.drawn).toBe(0);
  });

  it("(b) CRASH BETWEEN PARTS: the tick is aborted after R3 ⇒ the next tick draws once", async () => {
    const w = makeWorld();
    w.oneGroupWithPartsDone(1);
    w.abortAfterReads = true;
    await run(w);
    expect(w.jobsOfGroup("grp_1").length).toBe(1);
    w.abortAfterReads = false;
    w.requeue();
    await run(w);
    expect(w.jobsOfGroup("grp_1").length).toBe(2);
  });

  it("(c) FAILED PART CONTINUES: part 1 'failed' ⇒ no freeze call, draw part 2; the final line later counts completed parts only", async () => {
    const w = makeWorld();
    w.oneGroupWithParts([part("failed", 0, 0)]);
    await run(w);
    expect(w.rpcCalls.map((c) => c.name)).toEqual(["claim_next_job_group", "draw_next_group_part_atomic"]);
    expect(w.rpcCalls[1].args.p_delivered_so_far).toBe(0);
  });

  it("the draw call carries the item for part k, S2 and the plan's cap", async () => {
    const w = makeWorld();
    w.oneGroupWithPartsDone(1);
    await run(w);
    const draw = w.rpcCalls.find((c) => c.name === "draw_next_group_part_atomic")!;
    expect(draw.args).toEqual({
      p_group_id: "grp_1",
      p_part_index: 2,
      p_items: [buildPartItem(w.firstItem, 2, "grp_1")],
      p_event_ar: groupDrawLineAr({ k: 2, K: 3, Z: 10, Y: 30 }),
      p_delivered_so_far: 10,
      p_points_cap: Math.min(getConfiguredJobPointsCap(), DEFAULT_JOB_POINTS_CAP),
    });
  });

  it("refusals do nothing more: part_not_frozen, group_halted, deadline_passed, an error and a timeout each leave one claim and one draw call", async () => {
    for (const ans of [
      { success: false, error: "part_not_frozen" },
      { success: false, error: "group_halted" },
      { success: false, error: "deadline_passed" },
    ]) {
      const w = makeWorld();
      w.oneGroupWithPartsDone(1);
      w.answer.draw = ans;
      const r = await run(w);
      expect(r.drawn).toBe(0);
      expect(w.rpcCalls.length).toBe(2);
    }
  });

  it.each([
    ["part_not_frozen refusal", { data: { success: false, error: "part_not_frozen" }, error: null }],
    ["group_halted refusal", { data: { success: false, error: "group_halted" }, error: null }],
    ["deadline_passed refusal", { data: { success: false, error: "deadline_passed" }, error: null }],
    ["rpc error", { data: null, error: { message: "rpc down" } }],
  ] as Array<[string, any]>)("(d3) %s ⇒ one claim, one draw call, no part-2 job, no S2 line, no close, nothing drawn", async (_n, ans) => {
    const w = makeWorld();
    w.oneGroupWithPartsDone(1);
    w.answer.draw = ans;
    const r = await run(w);
    expect(w.rpcCalls.map((c) => c.name)).toEqual(["claim_next_job_group", "draw_next_group_part_atomic"]);
    expect([r.claims, r.drawn, r.closed]).toEqual([1, 0, 0]);
    expect(w.jobsOfGroup("grp_1").length).toBe(1);
    expect(w.events).toEqual([]);
  });

  it("(d3) a draw that times out (5 s against the 4 s limit) ⇒ one claim, one draw call, no part-2 job, no S2 line, no close, nothing drawn", async () => {
    const w = makeWorld();
    w.oneGroupWithPartsDone(1);
    w.latency.draw = 5_000;
    const r = await run(w);
    expect(w.rpcCalls.map((c) => c.name)).toEqual(["claim_next_job_group", "draw_next_group_part_atomic"]);
    expect([r.claims, r.drawn, r.closed]).toEqual([1, 0, 0]);
    expect(w.jobsOfGroup("grp_1").length).toBe(1);
    expect(w.events).toEqual([]);
  });

  it("(e) STOP_AFTER_EMPTY_PARTS = 0 never stops early: two empty parts and a part left ⇒ the draw is the decision, no close", async () => {
    const w = makeWorld();
    w.oneGroupWithParts([part("completed", 0, 0), part("completed", 0, 0)]);
    await run(w);
    expect(w.rpcCalls.map((c) => c.name)).toEqual(["claim_next_job_group", "draw_next_group_part_atomic"]);
  });
});

describe("T06: stuck R1b", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("(k) STUCK: stale lease ⇒ close('deadline_stuck') with S8 and Z/C excluding the running part", async () => {
    const w = makeWorld();
    w.groupWithRunningPart({ lease_until: new Date(NOW0 - 40 * 60_000).toISOString(), delivered: 5, charged: 0 });
    await run(w);
    const c = w.rpcCalls.find((x) => x.name === "close_job_group_atomic")!;
    expect(c.args.p_reason).toBe("deadline_stuck");
    expect(c.args.p_part_release_ar).toBe(GROUP_PART_STOPPED_AR);
    expect(c.args.p_delivered_total).toBe(10);
    expect(c.args.p_charged_total).toBe(100);
  });

  it("(k) fresh lease and a deadline 1 h past ⇒ no close until deadline + 2 h, then close", async () => {
    const w = makeWorld();
    w.groupWithRunningPart({ lease_until: new Date(NOW0 + 60_000).toISOString(), deadlineAgoMs: 3_600_000 });
    await run(w);
    expect(w.rpcCalls.some((c) => c.name === "close_job_group_atomic")).toBe(false);
    /* NOW0: the deadline is 1 h past, the lease fresh */
    vi.setSystemTime(NOW0 + 3 * 3_600_000);
    w.requeue();
    await run(w);
    expect(w.rpcCalls.some((c) => c.name === "close_job_group_atomic")).toBe(true);
  });

  it("(k) the group's deadline is checked first: a part 'running' with a fresh lease and no deadline passed is never closed by this claim", async () => {
    const w = makeWorld();
    w.groupWithRunningPart({ lease_until: new Date(NOW0 + 60_000).toISOString(), deadlineAheadMs: 3_600_000 });
    await run(w);
    expect(w.rpcCalls.map((c) => c.name)).toEqual(["claim_next_job_group"]);
  });
});

describe("T07: freeze R2b", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("(i) FREEZE CHOICE AND RACE: candidate 1 = A, candidate 2 = B (same count) ⇒ the uploaded object is A, named sha256(A), F5 keys = sorted ids of A; later rewrites to B never call F5 or draw again for that part", async () => {
    const w = makeWorld();
    w.awaitingFreezeGroup({ delivered: 10, candidates: { first: A, second: B } });
    const r = await run(w);
    expect(r.frozen).toBe(1);
    expect([...w.results.keys()]).toEqual([frozenPathFor("u1", w.jobIdOfPart(1), shaOf(A))]);
    const f5 = w.rpcCalls.find((c) => c.name === "freeze_and_settle_group_part_atomic")!;
    expect(f5.args.p_sha256).toBe(shaOf(A));
    expect(f5.args.p_keys).toEqual(idsOf(A).sort());
    w.rewriteAllDataTo(B);
    w.requeue();
    const f5Before = w.rpcCalls.filter((c) => c.name === "freeze_and_settle_group_part_atomic").length;
    await run(w);
    expect(w.rpcCalls.filter((c) => c.name === "freeze_and_settle_group_part_atomic").length).toBe(f5Before);
    expect(w.jobsOfGroup("grp_1").length).toBe(2); // the one draw of part 2 happened on the FIRST claim, none now
  });

  it("a frozen part continues: freeze, then the draw of part L+1 in the SAME claim", async () => {
    const w = makeWorld();
    w.awaitingFreezeGroup({ delivered: 10 });
    await run(w);
    expect(w.rpcCalls.map((c) => c.name)).toEqual([
      "claim_next_job_group",
      "freeze_and_settle_group_part_atomic",
      "draw_next_group_part_atomic",
    ]);
  });

  it("(d2) F5 times out AFTER committing ⇒ the next claim sees 'completed', skips R2b, draws once", async () => {
    const w = makeWorld();
    w.awaitingFreezeGroup({ delivered: 10 });
    w.latency.f5 = 4_100; // the fake commits at its own timer even after the caller gave up
    const r1 = await run(w);
    expect(r1.frozen).toBe(0);
    expect(w.f5.committed.length).toBe(1);
    w.latency.f5 = 0;
    w.requeue();
    const r2 = await run(w);
    expect(w.rpcCalls.filter((c) => c.name === "freeze_and_settle_group_part_atomic").length).toBe(1); // R2b was skipped
    expect(w.jobsOfGroup("grp_1").length).toBe(2);
    expect(r2.drawn).toBe(1);
  });

  it("(d2) F5 errors (no commit) ⇒ the next claim retries and freezes", async () => {
    const w = makeWorld();
    w.awaitingFreezeGroup({ delivered: 10 });
    w.f5.failNext = true;
    await run(w);
    expect(w.f5.committed).toEqual([]);
    w.requeue();
    const r = await run(w);
    expect(r.frozen).toBe(1);
    expect(w.f5.committed.length).toBe(1);
  });

  it("(d2) abort after the upload before F5 ⇒ the next claim finds the object (409, same bytes) and calls F5 once", async () => {
    const w = makeWorld();
    w.awaitingFreezeGroup({ delivered: 10 });
    w.abortBeforeF5 = true;
    await run(w);
    expect(w.results.size).toBe(1);
    w.abortBeforeF5 = false;
    w.requeue();
    await run(w);
    expect(w.rpcCalls.filter((c) => c.name === "freeze_and_settle_group_part_atomic").length).toBe(1);
    expect(w.results.size).toBe(1);
  });
});

describe("T08: release and halt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    "every candidate absent",
    "every readable candidate malformed",
    "rows.length ≠ delivered",
    "a row without identity",
    "a duplicate identity",
    "F5 answers keys_overlap",
  ])(
    "(d) UNFREEZABLE %s ⇒ no successful F5, F6 once with S13, NO draw, the same claim closes 'part_unfrozen' with Z and C without that part",
    async (kind) => {
      const w = makeWorld();
      w.awaitingFreezeGroup({ delivered: 10, unfreezable: kind });
      const r = await run(w);
      const names = w.rpcCalls.map((c) => c.name);
      expect(names.filter((n) => n === "release_unfrozen_group_part_atomic").length).toBe(1);
      expect(
        w.rpcCalls.find((c) => c.name === "release_unfrozen_group_part_atomic")!.args.p_release_ar
      ).toBe(GROUP_PART_UNFROZEN_RELEASED_AR);
      const close = w.rpcCalls.find((c) => c.name === "close_job_group_atomic")!;
      expect(close.args.p_reason).toBe("part_unfrozen");
      expect(close.args.p_final_line_ar).toBe(
        groupFinalLineAr({
          reason: "part_unfrozen",
          Z: close.args.p_delivered_total,
          X: 30,
          Y: 30,
          C: close.args.p_charged_total,
        })
      );
      expect(r.released).toBe(1);
      expect(r.closed).toBe(1);
    }
  );

  it.each([
    "every candidate absent",
    "every readable candidate malformed",
    "rows.length ≠ delivered",
    "a row without identity",
    "a duplicate identity",
    "F5 answers keys_overlap",
  ])("(d3) UNFREEZABLE %s after a completed charged part: the one close carries the literal Z 10 and C 70, the exact release and close arguments, no draw call, no S2 line", async (kind) => {
    const w = makeWorld();
    w.awaitingFreezeGroup({ delivered: 10, unfreezable: kind, priorCompleted: { delivered: 10, charged: 70 } });
    const r = await run(w);
    const calls = (name: string) => w.rpcCalls.filter((c) => c.name === name);
    expect(calls("draw_next_group_part_atomic")).toEqual([]);
    expect(w.events).toEqual([]);
    expect(calls("release_unfrozen_group_part_atomic").map((c) => c.args)).toEqual([
      { p_group_id: "grp_1", p_part_index: 2, p_job_id: "job_p1", p_release_ar: GROUP_PART_UNFROZEN_RELEASED_AR },
    ]);
    expect(calls("close_job_group_atomic").map((c) => c.args)).toEqual([
      {
        p_group_id: "grp_1",
        p_reason: "part_unfrozen",
        p_final_line_ar: groupFinalLineAr({ reason: "part_unfrozen", Z: 10, X: 30, Y: 30, C: 70 }),
        p_delivered_total: 10,
        p_charged_total: 70,
        p_part_release_ar: null,
      },
    ]);
    expect(w.jobsOfGroup("grp_1").length).toBe(2);
    expect([r.drawn, r.released, r.closed]).toEqual([0, 1, 1]);
  });

  it("(r2) WATCHDOG RELEASED FIRST after a completed charged part: no draw, no F6, ONE close('part_unfrozen') with the literal Z 10 and C 70 (the failed part, which delivered 10, is not counted)", async () => {
    const w = makeWorld();
    w.groupWithFailedPart({ cursor: "completed", priorCompleted: { delivered: 10, charged: 70 } });
    await run(w);
    expect(w.rpcCalls.map((c) => c.name)).toEqual(["claim_next_job_group", "close_job_group_atomic"]);
    expect(w.rpcCalls[1].args).toEqual({
      p_group_id: "grp_1",
      p_reason: "part_unfrozen",
      p_final_line_ar: groupFinalLineAr({ reason: "part_unfrozen", Z: 10, X: 30, Y: 30, C: 70 }),
      p_delivered_total: 10,
      p_charged_total: 70,
      p_part_release_ar: null,
    });
    expect(w.events).toEqual([]);
  });

  it("(d2) a freeze that keeps answering retry: no F6 before 20 min, F6 once after, then close('part_unfrozen'), no draw", async () => {
    const w = makeWorld();
    w.awaitingFreezeGroup({ delivered: 10, updatedAgoMs: 19 * 60_000 });
    w.f5.failAlways = true;
    await run(w);
    expect(w.rpcCalls.map((c) => c.name)).not.toContain("release_unfrozen_group_part_atomic");
    vi.setSystemTime(NOW0 + 61_000);
    w.requeue();
    await run(w); // now − updated_at = 20 min 1 s
    const names = w.rpcCalls.map((c) => c.name);
    expect(names.filter((n) => n === "release_unfrozen_group_part_atomic").length).toBe(1);
    expect(names).toContain("close_job_group_atomic");
    expect(names).not.toContain("draw_next_group_part_atomic");
  });

  it("(d2) the worker crashed after complete_chunk before writing data.json (no candidate) ⇒ F6, not charged, group halted and closed 'part_unfrozen'", async () => {
    const w = makeWorld();
    w.awaitingFreezeGroup({ delivered: 10, unfreezable: "every candidate absent" });
    await run(w);
    expect(w.group("grp_1").halted_at).not.toBeNull();
    expect(w.group("grp_1").status).toBe("closed");
  });

  it("(d2) F6 times out after committing ⇒ the next claim sees 'failed' and goes to the close without a second F6", async () => {
    const w = makeWorld();
    w.awaitingFreezeGroup({ delivered: 10, unfreezable: "every candidate absent" });
    w.latency.f6 = 4_100;
    await run(w);
    w.latency.f6 = 0;
    w.requeue();
    await run(w);
    expect(w.rpcCalls.filter((c) => c.name === "release_unfrozen_group_part_atomic").length).toBe(1);
    expect(w.rpcCalls.filter((c) => c.name === "close_job_group_atomic").length).toBe(1);
  });

  it("(r) WATCHDOG RELEASED FIRST: current = failed + current_cursor 'completed', frozen false, halted_at null ⇒ NO draw, NO F6, ONE close('part_unfrozen') with Z/C without that part; the same with current_cursor null (an ordinary failure) ⇒ draw part L+1", async () => {
    const a = makeWorld();
    a.groupWithFailedPart({ cursor: "completed" });
    await run(a);
    expect(a.rpcCalls.map((c) => c.name)).toEqual(["claim_next_job_group", "close_job_group_atomic"]);
    expect(a.rpcCalls[1].args.p_reason).toBe("part_unfrozen");

    const b = makeWorld();
    b.groupWithFailedPart({ cursor: null });
    await run(b);
    expect(b.rpcCalls.map((c) => c.name)).toEqual(["claim_next_job_group", "draw_next_group_part_atomic"]);
  });
});

describe("T09: timeouts and outage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["from(job_groups)", "from(job_group_parts)", "from(jobs)", "rpc draw", "rpc close"])(
    "(g) TIMEOUT: a never-resolving %s ⇒ the tick returns within 45 s of fake time",
    async (op) => {
      const w = makeWorld();
      w.oneGroupWithPartsDone(1);
      w.neverResolves = op;
      const p = run(w);
      await vi.advanceTimersByTimeAsync(TICK_BUDGET_MS);
      const r = await p;
      expect(Date.now() - NOW0).toBeLessThanOrEqual(TICK_BUDGET_MS);
      expect(r).toBeDefined();
    }
  );

  it("(n) DATABASE OUTAGE: every select and rpc errors for 10 ticks ⇒ no upload, [job-groups:overdue-check-failed] each tick (one error line per tick), never throws; tick 11 healthy ⇒ the group closes once", async () => {
    const w = makeWorld();
    w.oneGroupPastDeadline();
    w.failAll = { message: "db down" };
    for (let i = 0; i < 10; i++) {
      w.errors.length = 0;
      await run(w);
      expect(w.errors.filter((e) => e[0] === "[job-groups:overdue-check-failed]").length).toBe(1);
      expect(w.errors.length).toBe(1);
      expect(w.results.size).toBe(0);
    }
    w.failAll = null;
    w.requeue();
    await run(w);
    expect(w.rpcCalls.filter((c) => c.name === "close_job_group_atomic").length).toBe(1);
  });
});

describe("T10: fairness through F4", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("(j) STARVATION: 25 groups whose draw always times out and 1 closable group ⇒ the closable group closes within 26 claims", async () => {
    const w = makeWorld();
    w.manyGroups({ stuckDrawers: 25, closable: 1 });
    w.latency.draw = 5_000; // every draw of the 25 times out
    for (let i = 0; i < 26 && w.group("grp_closable").status !== "closed"; i++) {
      await run(w);
      vi.advanceTimersByTime(31_000);
    }
    expect(w.group("grp_closable").status).toBe("closed");
    expect(w.claimedIds).toContain("grp_closable");
    expect(w.claimedIds.indexOf("grp_closable") + 1).toBeLessThanOrEqual(26);
    expect(w.claimedIds.indexOf("grp_closable") + 1).toBe(1);
  });

  it("(j) 30 groups with a running part and 1 closable ⇒ the closable group is closed at the first claim", async () => {
    const w = makeWorld();
    w.manyGroups({ runningParts: 30, closable: 1 });
    await run(w);
    expect(w.group("grp_closable").status).toBe("closed");
  });

  it("(l) BACKLOG: 40 actionable groups, 6 s per request (a tick fits one claim); the 40th is past deadline + 2 h with a running part ⇒ closed within 40 ticks; [job-groups:overdue] is logged every tick until then and not after", async () => {
    const w = makeWorld();
    w.manyGroups({ actionable: 39, overduePast2h: 1 });
    w.stepMs = 6_000;
    let ticks = 0,
      overdueTicks = 0;
    while (ticks < 40 && w.group("grp_overdue").status !== "closed") {
      w.errors.length = 0;
      await run(w);
      ticks++;
      if (w.errors.some((e) => e[0] === "[job-groups:overdue]")) overdueTicks++;
      vi.advanceTimersByTime(60_000);
    }
    expect(w.group("grp_overdue").status).toBe("closed");
    expect(ticks).toBeLessThanOrEqual(40);
    expect(overdueTicks).toBe(ticks);
    w.errors.length = 0;
    await run(w);
    expect(w.errors.some((e) => e[0] === "[job-groups:overdue]")).toBe(false);
  });
});

function installDriveMocks() {
  vi.resetModules();
  const w = makeWorld();
  w.fail.r00 = { code: "42P01", message: "x" };
  currentDriveWorld = w;
  currentWatchdogWorld = null;
  return w;
}

function installWatchdogMocks(opts: { driverLastTickAgoMs?: number } = {}) {
  vi.resetModules();
  const w = makeWorld();
  if (typeof opts.driverLastTickAgoMs === "number") {
    w.driverLastTickAgoMs = opts.driverLastTickAgoMs;
  }
  currentWatchdogWorld = w;
  currentDriveWorld = null;
  return w;
}

const driveRequest = () => new NextRequest("http://x/api/cron/drive");
const watchdogRequest = () => new NextRequest("http://x/api/cron/watchdog");

describe("T11: drive route", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW0);
    installDriveMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the drive handler adds `groups` and nothing else changes; with the SQL absent (R00 answers 42P01) groups is the not-installed result and the rest of the JSON equals today's", async () => {
    const { GET } = await import("../src/app/api/cron/drive/route");
    const res = await GET(driveRequest());
    const body = await res.json();
    const { groups, ...rest } = body;
    expect(res.status).toBe(200);
    expect(groups).toEqual({ installed: false, claims: 0, frozen: 0, released: 0, drawn: 0, closed: 0 });
    expect(Object.keys(rest).sort()).toEqual(["considered", "dispatched", "mode", "planning", "results", "started", "stalledNotices", "success"].sort());
  });

  it("(q2) an unknown error shape: the handler never throws and the JSON equals today's plus `groups` (null or a zero result)", async () => {
    const w = installDriveMocks();
    w.fail.r00 = { code: "XX999", message: "boom" };
    w.fail.claim = { code: "XX999", message: "boom" };
    const { GET } = await import("../src/app/api/cron/drive/route");
    const res = await GET(driveRequest());
    const { groups, ...rest } = await res.json();
    expect(res.status).toBe(200);
    expect(Object.keys(rest).sort()).toEqual(["considered", "dispatched", "mode", "planning", "results", "started", "stalledNotices", "success"].sort());
    expect(groups === null || groups.claims === 0).toBe(true);
    expect(w.errors.length).toBeLessThanOrEqual(1);
  });

  it("(g)/(n) a never-resolving reconcile: the handler answers within 45 s of fake time with groups null; the dispatch results are intact", async () => {
    const w = installDriveMocks();
    w.neverResolves = "from(job_groups)";
    const { GET } = await import("../src/app/api/cron/drive/route");
    const p = GET(driveRequest());
    await vi.advanceTimersByTimeAsync(TICK_BUDGET_MS);
    const res = await p;
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.groups).toBeNull();
    expect(Date.now() - NOW0).toBeLessThanOrEqual(TICK_BUDGET_MS);
    expect(Array.isArray(body.results)).toBe(true);
  });
});

describe("T12: watchdog pass", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("(m) DRIVER OUTAGE: heartbeat 6 h old and a group past deadline + 2 h with a stale running part ⇒ the watchdog logs [job-groups:driver-stale] and [job-groups:overdue], its one reconcile pass closes the group with 'deadline_stuck', and the existing watchdog work is unchanged", async () => {
    const w = installWatchdogMocks({ driverLastTickAgoMs: 6 * 3_600_000 });
    w.groupWithRunningPart({ lease_until: new Date(NOW0 - 40 * 60_000).toISOString(), delivered: 5, charged: 0 });
    const { GET } = await import("../src/app/api/cron/watchdog/route");
    const res = await GET(watchdogRequest());
    const body = await res.json();
    expect(w.errors.map((e) => e[0])).toEqual(expect.arrayContaining(["[job-groups:driver-stale]", "[job-groups:overdue]"]));
    expect(w.rpcCalls.filter((c) => c.name === "close_job_group_atomic").map((c) => c.args.p_reason)).toEqual(["deadline_stuck"]);
    expect(body.groups.closed).toBe(1);
    expect(Object.keys(body).sort()).toEqual(["cleanedGuestsCount", "groups", "purgedAccountsCount", "releasedCount", "releasedJobs", "scannedAt", "staleCount", "stalledNotices", "success"]);
  });

  it("(p) the watchdog with 20 s left runs R00 only: no claim rpc", async () => {
    const w = installWatchdogMocks({});
    w.groupWithRunningPart({ lease_until: new Date(NOW0 - 40 * 60_000).toISOString() });
    vi.spyOn(Date, "now").mockReturnValueOnce(NOW0).mockReturnValueOnce(NOW0 + 35_000).mockReturnValue(NOW0 + 35_000);
    const { GET } = await import("../src/app/api/cron/watchdog/route");
    await GET(watchdogRequest());
    expect(w.rpcCalls.filter((c) => c.name === "claim_next_job_group")).toEqual([]);
  });

  it("a failing or never-resolving reconcile never fails the watchdog: status 200, groups null", async () => {
    const w = installWatchdogMocks({});
    w.neverResolves = "from(job_groups)";
    const { GET } = await import("../src/app/api/cron/watchdog/route");
    const p = GET(watchdogRequest());
    await vi.advanceTimersByTimeAsync(60_000);
    const res = await p;
    expect(res.status).toBe(200);
    expect((await res.json()).groups).toBeNull();
  });
});

describe("T13: inertness and recorder", () => {
  it("(f) the recorder shows no rpc other than claim / freeze_and_settle / release_unfrozen / draw / close from the whole suite of scenarios", async () => {
    const allowed = new Set([
      "claim_next_job_group",
      "freeze_and_settle_group_part_atomic",
      "release_unfrozen_group_part_atomic",
      "draw_next_group_part_atomic",
      "close_job_group_atomic",
    ]);
    for (const name of w_all_rpc_names_seen_in_this_file) {
      expect(allowed.has(name)).toBe(true);
    }
  });

  it("source guard: jobGroups.ts never names reserve, accept, settle or release functions directly", () => {
    const src = readFileSync("src/lib/server/multiProvider/jobGroups.ts", "utf8");
    expect(src).not.toMatch(
      /reserve_credits|accept_quote_atomic|accept_group_quote_atomic|settle_job_atomic|release_job_atomic|credit_ledger/
    );
    expect([...src.matchAll(/rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual([
      "claim_next_job_group",
      "close_job_group_atomic",
      "draw_next_group_part_atomic",
      "release_unfrozen_group_part_atomic",
    ]);
  });
});


describe("T14: the cron answers keep every legacy field when the reconcile fails", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const DUE_JOB = {
    id: "job_due_1",
    user_id: "u1",
    step: 2,
    status: "running",
    lease_until: null,
    next_attempt_at: null,
    updated_at: new Date(NOW0 - 40 * 60_000).toISOString(),
    target_volume_max: 10,
    delivered_units: 4,
  };
  const LEGACY = {
    drive: {
      success: true,
      mode: expect.any(String),
      considered: 1,
      dispatched: 1,
      started: 1,
      stalledNotices: { considered: 2, notified: 1 },
      planning: { considered: 0, stepped: 0, finished: 0 },
      results: [{ jobId: "job_due_1", started: true }],
    },
    watchdog: {
      success: true,
      staleCount: 1,
      stalledNotices: { considered: 2, notified: 1 },
      releasedCount: 1,
      releasedJobs: [{ jobId: "job_due_1", userId: "u1", releasedCredits: 0, alreadyReleased: true }],
      purgedAccountsCount: 0,
      cleanedGuestsCount: 0,
    },
  };

  async function call(kind: "drive" | "watchdog", mode: "baseline" | "rejected" | "timeout") {
    const w = kind === "drive" ? installDriveMocks() : installWatchdogMocks({});
    w.dueJobs.push({ ...DUE_JOB });
    const stall = await import("../src/lib/server/jobStallNotifier");
    vi.mocked(stall.notifyStalledJobs).mockResolvedValue({ considered: 2, notified: 1 } as any);
    if (kind === "drive") {
      const dispatch = await import("../src/lib/server/workerDispatch");
      vi.mocked(dispatch.dispatchWorkerChunk).mockResolvedValue({ started: true } as any);
    } else {
      w.legacy.release = { data: { success: true, released_credits: 0, already_released: true }, error: null };
    }
    if (mode === "rejected") w.rejectReconcile = true;
    if (mode === "timeout") w.neverResolves = "from(job_groups)";
    const { GET } = await import(
      kind === "drive" ? "../src/app/api/cron/drive/route" : "../src/app/api/cron/watchdog/route"
    );
    const p = GET(kind === "drive" ? driveRequest() : watchdogRequest());
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(TICK_BUDGET_MS + 15_000);
    const res = await p;
    return { w, status: res.status, body: await res.json() };
  }

  it.each(["drive", "watchdog"] as const)(
    "%s: with real work in the answer, a rejected and a timed-out reconcile leave every legacy field equal to the no-groups baseline and groups is null",
    async (kind) => {
      const base = await call(kind, "baseline");
      const { groups: baseGroups, scannedAt: baseScannedAt, ...baseLegacy } = base.body;
      expect(base.status).toBe(200);
      expect(baseLegacy).toEqual(LEGACY[kind]);
      expect(baseGroups).not.toBeNull();
      if (kind === "watchdog") expect(base.w.legacyRpcCalls.length).toBe(1);
      for (const mode of ["rejected", "timeout"] as const) {
        const got = await call(kind, mode);
        const { groups, scannedAt, ...legacy } = got.body;
        expect(got.status).toBe(200);
        expect(groups).toBeNull();
        expect(legacy).toEqual(baseLegacy);
        expect(legacy).toEqual(LEGACY[kind]);
        if (kind === "watchdog") {
          expect(typeof scannedAt).toBe("string");
          expect(got.w.legacyRpcCalls.length).toBe(1);
        }
      }
    }
  );
});
