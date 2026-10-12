import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ prefs: [] as any[], status: [] as any[], sessions: [] as any[], rows: [] as any[] }));

vi.mock("node-appwrite", () => {
  class MockClient { setEndpoint() { return this; } setProject() { return this; } setKey() { return this; } }
  class Users {
    async get() { return { prefs: { notif: { news: true } } }; }
    async updatePrefs(a: any) { calls.prefs.push(a); }
    async deleteSessions(a: any) { calls.sessions.push(a); }
    async updateStatus(a: any) { calls.status.push(a); }
  }
  class TablesDB {
    async listRows() { return { rows: [{ $id: "p1", userId: "u1" }] }; }
    async updateRow(a: any) { calls.rows.push(a); }
  }
  return { Client: MockClient, Users, TablesDB, Query: { equal: () => "eq", limit: () => "lim" } };
});

import handler from "../src/functions/request-account-deletion/src/main";

async function call(body: unknown, userId: string | null = "u1") {
  let out: any = null;
  const res = { json: (b: any, s = 200) => { out = { body: b, status: s }; return out; } };
  await handler({ req: { headers: userId ? { "x-appwrite-user-id": userId } : {}, body: JSON.stringify(body) }, res, log: () => {}, error: () => {} });
  return out;
}

describe("request-account-deletion", () => {
  beforeEach(() => { calls.prefs = []; calls.status = []; calls.sessions = []; calls.rows = []; });

  it("requires a signed-in caller and the typed confirmation word", async () => {
    expect((await call({ confirm: "حذف" }, null)).status).toBe(401);
    expect((await call({ confirm: "delete" })).status).toBe(400);
    expect(calls.status).toHaveLength(0);
  });

  it("schedules deletion 30 days out, keeps existing prefs, revokes sessions and disables sign-in", async () => {
    const r = await call({ confirm: " حذف " });
    expect(r.status).toBe(200);
    const days = (new Date(r.body.scheduledFor).getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(calls.prefs[0].prefs).toMatchObject({ notif: { news: true }, deletionScheduledFor: r.body.scheduledFor });
    expect(calls.rows[0]).toMatchObject({ tableId: "profiles", rowId: "p1", data: { deletionScheduledFor: r.body.scheduledFor } });
    expect(calls.sessions).toHaveLength(1);
    expect(calls.status[0]).toMatchObject({ userId: "u1", status: false });
  });
});
