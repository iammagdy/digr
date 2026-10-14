import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ rows: [] as any[], updates: [] as any[], ledger: [] as any[], audit: [] as any[], notifs: [] as any[], emails: 0, admin: true, topup: null as any }));

const createMockSdk = vi.hoisted(() => () => {
  class MockClient { setEndpoint() { return this; } setProject() { return this; } setKey() { return this; } }
  class Users {
    async get({ userId }: any) { return userId === "admin1" ? { name: "سارة علي", labels: db.admin ? ["admin"] : [] } : { name: "عميل", email: "c@example.com", prefs: {} }; }
  }
  class Messaging { async createEmail() { db.emails += 1; } }
  class TablesDB {
    async getRow({ tableId }: any) { return tableId === "topups" ? db.topup : { creditValueEgp: 0.1 }; }
    async updateRow(a: any) { db.updates.push(a); }
    async createRow(a: any) {
      if (a.tableId === "credit_ledger") db.ledger.push(a);
      if (a.tableId === "admin_audit_log") db.audit.push(a);
      if (a.tableId === "notifications") db.notifs.push(a);
      return { $id: a.rowId };
    }
  }
  return {
    Client: MockClient, Users, TablesDB, Messaging,
    ID: { unique: () => "id1" },
    Permission: { read: (r: string) => `read(${r})`, update: (r: string) => `update(${r})` },
    Role: { user: (u: string) => `user:${u}`, label: (l: string) => `label:${l}` },
    Query: {},
  };
});

vi.mock("node-appwrite", createMockSdk);
vi.mock("../src/functions/shared/dbCompat", createMockSdk);

import approve from "../src/functions/approve-topup/src/main";

async function call(body: unknown, userId = "admin1") {
  let out: any;
  const res = { json: (b: any, s = 200) => (out = { body: b, status: s }) };
  await approve({ req: { headers: { "x-appwrite-user-id": userId, "x-forwarded-for": "41.33.12.8" }, body: JSON.stringify(body) }, res, log: () => {}, error: () => {} });
  return out;
}

describe("approve-topup (V7 redesign)", () => {
  beforeEach(() => {
    Object.assign(db, { updates: [], ledger: [], audit: [], notifs: [], emails: 0, admin: true });
    db.topup = { $id: "t1", userId: "u1", status: "pending", amountEgp: 100, reference: "R1", senderName: "أحمد محمد علي" };
  });

  it("rejection requires a reason, stores it, notifies the user and writes the audit log", async () => {
    expect((await call({ topupId: "t1", action: "reject" })).status).toBe(400);
    expect(db.updates).toHaveLength(0);

    const r = await call({ topupId: "t1", action: "reject", rejectReason: "المبلغ المحوّل مختلف" });
    expect(r.status).toBe(200);
    expect(db.updates[0].data).toMatchObject({ status: "rejected", rejectReason: "المبلغ المحوّل مختلف", reviewedBy: "admin1" });
    expect(db.notifs[0].data).toMatchObject({ userId: "u1", kind: "topup_rejected" });
    expect(db.notifs[0].data.body).toContain("المبلغ المحوّل مختلف");
    expect(db.emails).toBe(1);
    expect(db.audit[0].data).toMatchObject({ actorId: "admin1", action: "reject", ip: "41.33.12.8" });
    expect(db.audit[0].permissions).toEqual(["read(label:admin)"]);
  });

  it("approval credits points from the confirmed amount, notifies and audits", async () => {
    const r = await call({ topupId: "t1", action: "approve", confirmedAmountEgp: "٢٥٠" });
    expect(r.body).toMatchObject({ success: true, status: "approved", credits: 2500 });
    expect(db.ledger[0].data.delta).toBe(2500);
    expect(db.notifs[0].data.kind).toBe("topup_approved");
    expect(db.audit[0].data.action).toBe("approve");
  });

  it("only admins may review", async () => {
    db.admin = false;
    expect((await call({ topupId: "t1", action: "approve" })).status).toBe(403);
    expect(db.ledger).toHaveLength(0);
  });
});
