import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { dedupeIdentityFor } from "../src/lib/server/rowDedupe";
import {
  FREEZE_BUDGET_MS,
  FREEZE_IO_TIMEOUT_MS,
  FREEZE_RPC_TIMEOUT_MS,
  freezeCandidates,
  FreezeOutcome,
  freezeGroupPart,
} from "../src/lib/server/multiProvider/jobGroupFreeze";
import { frozenPathFor } from "../src/lib/server/multiProvider/jobGroupShared";

const uid = "u1", jobId = "job_p1";
const rowsOf = (n: number, tag = "a") =>
  Array.from({ length: n }, (_, i) => ({ name: `Co ${tag}${i}`, website: `https://${tag}${i}.example.com` }));
const bytesOf = (rows: any[]) => Buffer.from(JSON.stringify({ rows }), "utf-8");
const shaOf = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function makeWorld(): {
  admin: any;
  partials: Map<string, Buffer>;
  results: Map<string, Buffer>;
  latency: { read: number; upload: number; download: number; rpc: number };
  readLatency: Map<string, number>;
  readFails: Set<string>;
  reads: string[];
  f5: { calls: any[]; committed: any[]; dropOnTimeout: boolean; failNext: boolean; answer?: (args: any) => any };
} {
  const partials = new Map<string, Buffer>();
  const results = new Map<string, Buffer>();
  const latency = { read: 0, upload: 0, download: 0, rpc: 0 };
  const readLatency = new Map<string, number>();
  const readFails = new Set<string>();
  const reads: string[] = [];
  const f5: { calls: any[]; committed: any[]; dropOnTimeout: boolean; failNext: boolean; answer?: (args: any) => any } = {
    calls: [],
    committed: [],
    dropOnTimeout: false,
    failNext: false,
  };

  const partialsBucket = {
    download: async (path: string) => {
      reads.push(path);
      const lat = readLatency.get(path) ?? latency.read;
      return new Promise<{ data: any; error: any }>((resolve) => {
        setTimeout(() => {
          if (readFails.has(path)) {
            resolve({ data: null, error: { message: "upstream error", statusCode: "500" } });
          } else if (partials.has(path)) {
            resolve({ data: new Blob([partials.get(path)!]), error: null });
          } else {
            resolve({ data: null, error: { message: "Object not found", statusCode: "404" } });
          }
        }, lat);
      });
    },
    upload: async (path: string, bytes: any, _opts?: any) => {
      const lat = latency.upload;
      return new Promise<{ data: any; error: any }>((resolve) => {
        setTimeout(() => {
          if (partials.has(path)) {
            resolve({ data: null, error: { message: "The resource already exists", statusCode: "409" } });
          } else {
            partials.set(path, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
            resolve({ data: { path }, error: null });
          }
        }, lat);
      });
    },
  };

  const resultsBucket = {
    download: async (path: string) => {
      const lat = latency.download;
      return new Promise<{ data: any; error: any }>((resolve) => {
        setTimeout(() => {
          if (results.has(path)) {
            resolve({ data: new Blob([results.get(path)!]), error: null });
          } else {
            resolve({ data: null, error: { message: "Object not found", statusCode: "404" } });
          }
        }, lat);
      });
    },
    upload: async (path: string, bytes: any, _opts?: any) => {
      const lat = latency.upload;
      return new Promise<{ data: any; error: any }>((resolve) => {
        setTimeout(() => {
          if (results.has(path)) {
            resolve({ data: null, error: { message: "The resource already exists", statusCode: "409" } });
          } else {
            results.set(path, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
            resolve({ data: { path }, error: null });
          }
        }, lat);
      });
    },
  };

  const admin = {
    storage: {
      from: (bucket: string) => {
        if (bucket === "partials") return partialsBucket;
        if (bucket === "results") return resultsBucket;
        throw new Error("unknown bucket: " + bucket);
      },
    },
    rpc: async (name: string, args: any) => {
      if (name !== "freeze_and_settle_group_part_atomic") throw new Error("unknown rpc: " + name);
      f5.calls.push(args);
      const lat = latency.rpc;
      return new Promise<{ data: any; error: any }>((resolve) => {
        setTimeout(() => {
          if (f5.failNext) {
            f5.failNext = false;
            resolve({ data: null, error: { message: "rpc down" } });
            return;
          }
          if (lat > 4000 && f5.dropOnTimeout) {
            resolve({ data: null, error: { message: "rpc timeout" } });
            return;
          }
          const existing = f5.committed.find(
            (c) => c.p_group_id === args.p_group_id && c.p_part_index === args.p_part_index
          );
          if (existing) {
            if (existing.p_path === args.p_path && existing.p_sha256 === args.p_sha256) {
              resolve({
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
            } else {
              resolve({ data: { success: false, error: "freeze_conflict" }, error: null });
            }
            return;
          }
          if (f5.answer) {
            resolve(f5.answer(args));
            return;
          }
          f5.committed.push(args);
          resolve({
            data: {
              success: true,
              already_frozen: false,
              path: args.p_path,
              sha256: args.p_sha256,
              row_count: args.p_row_count,
              charged_credits: 0,
            },
            error: null,
          });
        }, lat);
      });
    },
  };

  return { admin, partials, results, latency, readLatency, readFails, reads, f5 };
}

async function runFreeze(
  w: ReturnType<typeof makeWorld>,
  over: Partial<Parameters<typeof freezeGroupPart>[1]> = {}
): Promise<FreezeOutcome> {
  const p = freezeGroupPart(w.admin, {
    groupId: "grp_1",
    partIndex: 1,
    job: { id: jobId, user_id: uid, delivered_units: 10 },
    ...over,
  });
  await vi.runAllTimersAsync();
  return p;
}

describe("jobGroupFreeze", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("constants and candidates are the plan's", () => {
    expect([FREEZE_BUDGET_MS, FREEZE_IO_TIMEOUT_MS, FREEZE_RPC_TIMEOUT_MS]).toEqual([30_000, 5_000, 4_000]);
    expect(freezeCandidates(uid, jobId)).toEqual([
      { bucket: "partials", path: "u1/job_p1/data.json" },
      { bucket: "partials", path: "job_p1/data.json" },
    ]);
  });
});
