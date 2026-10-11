import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import jobWorkerHandler from "../src/functions/job-worker/src/main";
import {
  runJobWatchdog,
  reportStuckJobsReadOnly,
} from "../src/functions/shared/multiStepWorker";
import { releaseReservation } from "../src/functions/shared/ledger";

vi.mock("node-appwrite", () => {
  class MockClient {
    setEndpoint() { return this; }
    setProject() { return this; }
    setKey() { return this; }
  }
  return {
    Client: MockClient,
    TablesDB: vi.fn(),
    Storage: vi.fn(),
    Permission: { read: (r: string) => `read(${r})` },
    Role: { user: (u: string) => `user:${u}`, label: (l: string) => `label:${l}` },
    ID: { unique: () => "evt_unique_id" },
    Query: {
      equal: (field: string, val: any) => `equal(${field},${JSON.stringify(val)})`,
      lessThan: (field: string, val: any) => `lessThan(${field},${val})`,
      limit: (n: number) => `limit(${n})`,
      offset: (n: number) => `offset(${n})`,
    },
  };
});

function createInMemoryTables(initialJobs: any[] = [], initialLedger: any[] = []) {
  const jobsMap = new Map<string, any>(initialJobs.map((j) => [j.$id, { ...j }]));
  const ledgerMap = new Map<string, any>(initialLedger.map((l) => [l.$id, { ...l }]));
  const eventsList: any[] = [];
  const createRowCalls: any[] = [];
  const updateRowCalls: any[] = [];

  const tables: any = {
    jobsMap,
    ledgerMap,
    eventsList,
    createRowCalls,
    updateRowCalls,
    getRow: vi.fn(async ({ tableId, rowId }: any) => {
      if (tableId === "jobs") {
        const j = jobsMap.get(rowId);
        if (!j) throw Object.assign(new Error("Not found"), { code: 404 });
        return j;
      }
      if (tableId === "credit_ledger") {
        const l = ledgerMap.get(rowId);
        if (!l) throw Object.assign(new Error("Not found"), { code: 404 });
        return l;
      }
      throw Object.assign(new Error("Not found"), { code: 404 });
    }),
    listRows: vi.fn(async ({ tableId }: any) => {
      if (tableId === "jobs") {
        return { rows: Array.from(jobsMap.values()) };
      }
      if (tableId === "credit_ledger") {
        return { rows: Array.from(ledgerMap.values()) };
      }
      return { rows: [] };
    }),
    createRow: vi.fn(async ({ tableId, rowId, data }: any) => {
      createRowCalls.push({ tableId, rowId, data });
      if (tableId === "credit_ledger") {
        if (ledgerMap.has(rowId)) {
          throw Object.assign(new Error("Document already exists"), { code: 409, status: 409 });
        }
        const row = { $id: rowId, ...data };
        ledgerMap.set(rowId, row);
        return row;
      }
      if (tableId === "job_events") {
        const evt = { $id: rowId, ...data };
        eventsList.push(evt);
        return evt;
      }
      return { $id: rowId, ...data };
    }),
    updateRow: vi.fn(async ({ tableId, rowId, data }: any) => {
      updateRowCalls.push({ tableId, rowId, data });
      if (tableId === "jobs") {
        const existing = jobsMap.get(rowId) || { $id: rowId };
        const updated = { ...existing, ...data };
        jobsMap.set(rowId, updated);
        return updated;
      }
      return { $id: rowId, ...data };
    }),
  };

  return tables;
}

describe("Phase 6: Stuck 5-point reservation & watchdog recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(a) refusal path (TREG_LIVE !== 'true') marks job failed in Arabic and releases hold idempotently (rel_<jobId>)", async () => {
    const prevTregLive = process.env.TREG_LIVE;
    process.env.TREG_LIVE = "false";

    try {
      const memTables = createInMemoryTables(
        [
          {
            $id: "job_stuck_5pts",
            userId: "user_1",
            status: "queued",
            reservedCredits: 5,
            templateSlug: "tiktok-profile",
            createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          },
        ],
        [
          {
            $id: "res_job_stuck_5pts",
            userId: "user_1",
            delta: -5,
            type: "reserve",
            jobId: "job_stuck_5pts",
          },
        ]
      );

      const { TablesDB } = await import("node-appwrite");
      (TablesDB as any).mockImplementation(function () {
        return memTables;
      });

      const responses: any[] = [];
      const res = {
        json: (body: any, status = 200) => {
          responses.push({ body, status });
          return { body, status };
        },
      };

      await jobWorkerHandler({
        req: {
          body: JSON.stringify({ jobId: "job_stuck_5pts" }),
          headers: { "x-appwrite-key": "mock_key" },
        },
        res,
        log: vi.fn(),
        error: vi.fn(),
      });

      expect(responses[0].body.status).toBe("failed");
      expect(responses[0].body.released).toBe(true);
      expect(memTables.jobsMap.get("job_stuck_5pts").status).toBe("failed");
      expect(memTables.jobsMap.get("job_stuck_5pts").errorAr).toContain("استرجاع كامل الرصيد المحجوز");

      const relRow = memTables.ledgerMap.get("rel_job_stuck_5pts");
      expect(relRow).toBeDefined();
      expect(relRow.delta).toBe(5);
      expect(relRow.type).toBe("release");

      // Calling a second time must be idempotent and never double-release
      await jobWorkerHandler({
        req: {
          body: JSON.stringify({ jobId: "job_stuck_5pts" }),
          headers: { "x-appwrite-key": "mock_key" },
        },
        res,
        log: vi.fn(),
        error: vi.fn(),
      });

      expect(responses[1].body.alreadyReleased).toBe(true);
      const releaseRows = Array.from(memTables.ledgerMap.values()).filter((r) => r.type === "release");
      expect(releaseRows).toHaveLength(1);
    } finally {
      process.env.TREG_LIVE = prevTregLive;
    }
  });

  it("(b) queued job older than 30m is marked failed and its hold is released once by runJobWatchdog", async () => {
    const twoHoursAgo = new Date(Date.now() - 125 * 60 * 1000).toISOString();
    const memTables = createInMemoryTables(
      [
        {
          $id: "job_queued_2h",
          userId: "user_2",
          status: "queued",
          reservedCredits: 5,
          createdAt: twoHoursAgo,
        },
      ],
      [
        {
          $id: "res_job_queued_2h",
          userId: "user_2",
          delta: -5,
          type: "reserve",
          jobId: "job_queued_2h",
        },
      ]
    );

    const firstRun = await runJobWatchdog(memTables as any, 30);
    expect(firstRun.recoveredCount).toBe(1);
    expect(firstRun.jobIds).toEqual(["job_queued_2h"]);
    expect(memTables.jobsMap.get("job_queued_2h").status).toBe("failed");
    expect(memTables.ledgerMap.get("rel_job_queued_2h")?.delta).toBe(5);

    // Second watchdog run must not release a second time
    const secondRun = await runJobWatchdog(memTables as any, 30);
    expect(secondRun.recoveredCount).toBe(0);
    const releaseRows = Array.from(memTables.ledgerMap.values()).filter((r) => r.type === "release");
    expect(releaseRows).toHaveLength(1);
  });

  it("(c) running healthy job (<30m old) is untouched by runJobWatchdog", async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const memTables = createInMemoryTables(
      [
        {
          $id: "job_running_healthy",
          userId: "user_3",
          status: "running",
          reservedCredits: 10,
          createdAt: fiveMinutesAgo,
        },
      ],
      [
        {
          $id: "res_job_running_healthy",
          userId: "user_3",
          delta: -10,
          type: "reserve",
          jobId: "job_running_healthy",
        },
      ]
    );

    const result = await runJobWatchdog(memTables as any, 30);
    expect(result.recoveredCount).toBe(0);
    expect(memTables.jobsMap.get("job_running_healthy").status).toBe("running");
    expect(memTables.ledgerMap.has("rel_job_running_healthy")).toBe(false);
  });

  it("(d) already-released job (rel_<jobId> already exists) is skipped without throwing or double-releasing", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const memTables = createInMemoryTables(
      [
        {
          $id: "job_already_released",
          userId: "user_4",
          status: "queued",
          reservedCredits: 5,
          createdAt: oneHourAgo,
        },
      ],
      [
        {
          $id: "res_job_already_released",
          userId: "user_4",
          delta: -5,
          type: "reserve",
          jobId: "job_already_released",
        },
        {
          $id: "rel_job_already_released",
          userId: "user_4",
          delta: 5,
          type: "release",
          jobId: "job_already_released",
        },
      ]
    );

    const directRel = await releaseReservation(memTables as any, "user_4", "job_already_released", 5);
    expect(directRel.released).toBe(false);
    expect(directRel.alreadyReleased).toBe(true);

    const watchdogRes = await runJobWatchdog(memTables as any, 30);
    expect(watchdogRes.recoveredCount).toBe(0);
    expect(watchdogRes.skippedIds).toContain("job_already_released");

    const releaseRows = Array.from(memTables.ledgerMap.values()).filter((r) => r.type === "release");
    expect(releaseRows).toHaveLength(1);
  });

  it("read-only report mode returns stuck job IDs and ages without performing any DB writes, and appwrite.json schedules watchdog every 10 minutes", async () => {
    const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000).toISOString();
    const memTables = createInMemoryTables(
      [
        {
          $id: "job_stuck_readonly",
          userId: "secret_user_id_should_not_leak",
          status: "queued",
          reservedCredits: 5,
          createdAt: twoHoursAgo,
        },
      ],
      []
    );

    const report = await reportStuckJobsReadOnly(memTables as any, 30);
    expect(report.stuckCount).toBe(1);
    expect(report.stuckJobs[0].jobId).toBe("job_stuck_readonly");
    expect(report.stuckJobs[0].reservedCredits).toBe(5);
    expect(report.stuckJobs[0].alreadyReleased).toBe(false);
    expect(JSON.stringify(report)).not.toContain("secret_user_id_should_not_leak");
    expect(memTables.createRowCalls).toHaveLength(0);
    expect(memTables.updateRowCalls).toHaveLength(0);

    const appwriteConfig = JSON.parse(readFileSync("appwrite.json", "utf8"));
    const jobWorkerFn = appwriteConfig.functions.find((f: any) => f.$id === "job-worker");
    expect(jobWorkerFn?.schedule).toBe("*/10 * * * *");
  });
});
