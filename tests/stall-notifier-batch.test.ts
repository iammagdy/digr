import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../src/lib/server/sendPlatformEmail", async (original) => ({
  ...(await original<any>()),
  getRecipient: vi.fn(async (_admin: any, userId: string) => ({ email: `${userId}@example.com`, name: "سلمى" })),
  sendPlatformEmail: vi.fn(async (template: string, to: string, _vars: Record<string, string>, key?: string) => { mailbox.push({ template, to, key }); return { ok: true }; }),
}));
const mailbox: Array<{ template: string; to: string; key?: string }> = [];

import { notifyStalledJobs } from "../src/lib/server/jobStallNotifier";
import { jobNoticeId } from "../src/lib/server/jobNotices";

/**
 * VERCEL ACTIVE CPU / DATABASE LOAD (docs/ops/VERCEL-CPU.md): the stall notifier runs every minute (the database driver's tick). A job that STAYS stalled
 * (nine October verification fixtures in production) used to cost a count and a refused insert per job per minute. The batch check skips a job whose
 * stalled notice exists, with exactly the same outcome: one notice per job, one e-mail per new notice, nothing settled, released or moved.
 */
const NOW = Date.parse("2026-11-14T12:00:00Z");
const stale = (id: string, user = "u1", status = "queued") => ({ id, user_id: user, status, updated_at: new Date(NOW - 30 * 24 * 3_600_000).toISOString(), created_at: null, lease_until: null });

/** A fake client that keeps the notifications table and records EVERY request the notifier makes (table:operation). */
function fakeDb(jobs: any[], opts: { precheckFails?: boolean; precheckThrows?: boolean } = {}) {
  const notifications = new Map<string, any>();
  const requests: string[] = [];
  const client: any = {
    notifications,
    requests,
    from(table: string) {
      const q: any = { table, op: "select", filters: {} as Record<string, unknown>, head: false };
      q.select = (_cols: string, o?: { head?: boolean }) => { q.head = Boolean(o?.head); return q; };
      q.in = (col: string, vals: unknown[]) => { q.filters[`in:${col}`] = vals; return q; };
      for (const m of ["lt", "order", "eq", "like"]) q[m] = () => q;
      q.limit = async () => { requests.push(`${table}:select`); return { data: table === "jobs" ? jobs : [], error: null }; };
      q.then = (resolve: any) => {
        if (table === "notifications" && q.head) { requests.push("notifications:count"); return resolve({ count: 0, data: null, error: null }); }
        if (table === "notifications") {
          requests.push("notifications:precheck");
          if (opts.precheckThrows) throw new Error("network");
          if (opts.precheckFails) return resolve({ data: null, error: { message: "boom" } });
          const ids = (q.filters["in:id"] as string[]) ?? [];
          return resolve({ data: ids.filter((id) => notifications.has(id)).map((id) => ({ id })), error: null });
        }
        return resolve({ data: [], error: null });
      };
      q.insert = async (row: any) => {
        requests.push(`${table}:insert`);
        if (table !== "notifications") return { error: null };
        if (notifications.has(row.id)) return { error: { code: "23505" } };
        notifications.set(row.id, row);
        return { error: null };
      };
      return q;
    },
  };
  return client;
}

describe("the stall notifier asks once per batch, not once per job per minute", () => {
  it("first call: each new stalled job gets its notice and its e-mail, exactly as before", async () => {
    mailbox.length = 0;
    const db = fakeDb([stale("j1", "u1"), stale("j2", "u2", "running")]);
    expect(await notifyStalledJobs(db, NOW)).toEqual({ considered: 2, notified: 2 });
    expect([...db.notifications.keys()]).toEqual([jobNoticeId("stalled", "j1"), jobNoticeId("stalled", "j2")]);
    expect(mailbox.map((m) => m.to)).toEqual(["u1@example.com", "u2@example.com"]);
    expect(db.requests).toEqual(["jobs:select", "notifications:precheck", "notifications:count", "notifications:insert", "notifications:count", "notifications:insert"]);
  });

  it("every later call for jobs that stay stalled: two requests in all (the jobs read and ONE check), no count, no insert, no e-mail", async () => {
    mailbox.length = 0;
    const db = fakeDb([stale("j1"), stale("j2")]);
    await notifyStalledJobs(db, NOW);
    db.requests.length = 0; mailbox.length = 0;
    for (let minute = 1; minute <= 3; minute += 1) expect(await notifyStalledJobs(db, NOW + minute * 60_000)).toEqual({ considered: 2, notified: 0 });
    expect(db.requests).toEqual(["jobs:select", "notifications:precheck", "jobs:select", "notifications:precheck", "jobs:select", "notifications:precheck"]);
    expect(mailbox).toHaveLength(0);
    expect(db.notifications.size).toBe(2);
  });

  it("the production case: nine fixtures already noticed cost 2 requests a tick instead of 19", async () => {
    const jobs = Array.from({ length: 9 }, (_, i) => stale(`vrun_${i}`, "00000000-0000-0000-0000-000000000001", i < 2 ? "running" : "queued"));
    const db = fakeDb(jobs);
    for (const j of jobs) db.notifications.set(jobNoticeId("stalled", j.id), { id: jobNoticeId("stalled", j.id) });
    mailbox.length = 0;
    expect(await notifyStalledJobs(db, NOW)).toEqual({ considered: 9, notified: 0 });
    expect(db.requests).toEqual(["jobs:select", "notifications:precheck"]);
    expect(mailbox).toHaveLength(0);
  });

  it("a batch with one already-noticed job and one new one: only the new one is sent", async () => {
    mailbox.length = 0;
    const db = fakeDb([stale("old", "u1"), stale("new", "u2")]);
    db.notifications.set(jobNoticeId("stalled", "old"), { id: jobNoticeId("stalled", "old") });
    expect(await notifyStalledJobs(db, NOW)).toEqual({ considered: 2, notified: 1 });
    expect(mailbox.map((m) => m.to)).toEqual(["u2@example.com"]);
    expect(db.requests.filter((r: string) => r === "notifications:insert")).toHaveLength(1);
  });

  it("an unreadable check falls back to the old path: every job is tried, the primary key still refuses a second notice, no second e-mail", async () => {
    mailbox.length = 0;
    const db = fakeDb([stale("j1")], { precheckFails: true });
    db.notifications.set(jobNoticeId("stalled", "j1"), { id: jobNoticeId("stalled", "j1") });
    expect(await notifyStalledJobs(db, NOW)).toEqual({ considered: 1, notified: 0 });
    expect(db.requests).toEqual(["jobs:select", "notifications:precheck", "notifications:count", "notifications:insert"]);
    expect(mailbox).toHaveLength(0);
  });

  it("a check that THROWS also falls back: a new stalled job still gets its notice and its e-mail", async () => {
    mailbox.length = 0;
    const db = fakeDb([stale("fresh", "u3")], { precheckThrows: true });
    expect(await notifyStalledJobs(db, NOW)).toEqual({ considered: 1, notified: 1 });
    expect(mailbox.map((m) => m.to)).toEqual(["u3@example.com"]);
  });

  it("nothing stalled: no check at all", async () => {
    const db = fakeDb([]);
    expect(await notifyStalledJobs(db, NOW)).toEqual({ considered: 0, notified: 0 });
    expect(db.requests).toEqual(["jobs:select"]);
  });

  it("the notifier still moves nothing: no RPC, no update, no delete, no ledger", () => {
    expect(readFileSync("src/lib/server/jobStallNotifier.ts", "utf8")).not.toMatch(/\.rpc\(|release_job|settle_job|credit_ledger|\.update\(|\.delete\(|\.upsert\(/);
  });
});
