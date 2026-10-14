import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  created: [] as any[],
  verified: true,
  pending: 0,
  refTaken: false,
  maxPending: undefined as number | undefined,
}));

const createMockSubmitTopupSdk = vi.hoisted(() => () => {
  class MockClient { setEndpoint() { return this; } setProject() { return this; } setKey() { return this; } }
  class TablesDB {
    async listRows({ tableId, queries }: any) {
      const q = (queries || []).join("|");
      if (tableId === "topups" && q.includes('"pending"')) return { total: state.pending, rows: [] };
      if (tableId === "topups" && q.includes("reference")) return { total: state.refTaken ? 1 : 0, rows: [] };
      return { total: 0, rows: [] };
    }
    async getRow({ tableId }: any) {
      if (tableId === "settings_public") return { creditValueEgp: 0.1, ...(state.maxPending ? { maxPendingTopups: state.maxPending } : {}) };
      throw new Error("nf");
    }
    async createRow(args: any) { state.created.push(args); return { $id: args.rowId }; }
  }
  class Storage {
    async getFile() { return { $permissions: ['read("user:u1")'] }; }
    async updateFile() { return {}; }
  }
  class Users { async get() { return { emailVerification: state.verified }; } }
  return {
    Client: MockClient, TablesDB, Storage, Users,
    Permission: { read: (r: string) => `read(${r})` },
    Role: { user: (u: string) => `user:${u}`, label: (l: string) => `label:${l}` },
    ID: { unique: () => "top_1" },
    Query: { equal: (f: string, v: any) => `equal(${f},${JSON.stringify(v)})`, limit: (n: number) => `limit(${n})` },
  };
});

vi.mock("node-appwrite", createMockSubmitTopupSdk);
vi.mock("../src/functions/shared/dbCompat", createMockSubmitTopupSdk);

import submitTopup from "../src/functions/submit-topup/src/main";

const good = {
  amountEgp: 100, reference: "418290384729", senderName: "أحمد محمد علي", senderPhone: "01012345678", receiptFileId: "file_1",
};

async function call(body: unknown, userId: string | null = "u1") {
  let out: { body: any; status: number } = { body: null, status: 0 };
  const res = { json: (b: any, s = 200) => { out = { body: b, status: s }; return out; } };
  await submitTopup({ req: { headers: userId ? { "x-appwrite-user-id": userId } : {}, body: JSON.stringify(body) }, res, log: () => {}, error: () => {} });
  return out;
}

describe("submit-topup (V7 redesign)", () => {
  beforeEach(() => { state.created = []; state.verified = true; state.pending = 0; state.refTaken = false; state.maxPending = undefined; });

  it("stores senderName and senderPhone and requires the receipt", async () => {
    const ok = await call(good);
    expect(ok.status).toBe(200);
    expect(state.created[0].data).toMatchObject({ senderName: "أحمد محمد علي", senderPhone: "01012345678", receiptFileId: "file_1", status: "pending", userId: "u1" });

    const noReceipt = await call({ ...good, receiptFileId: undefined });
    expect(noReceipt.status).toBe(400);
    expect(noReceipt.body.error).toBe("صورة إيصال التحويل مطلوبة لمراجعة الطلب");
  });

  it("validates a three-part name and an Egyptian mobile number on the server", async () => {
    expect((await call({ ...good, senderName: "أحمد محمد" })).body.error).toBe("اكتب اسم المحوِّل الثلاثي كما يظهر في إنستاباي");
    expect((await call({ ...good, senderPhone: "0201234567" })).body.error).toBe("رقم الموبايل غير صحيح — ١١ رقمًا يبدأ بـ 01");
    expect(state.created).toHaveLength(0);
  });

  it("normalises Arabic digits in every numeric field", async () => {
    const r = await call({ ...good, amountEgp: "١٠٠", reference: "٤١٨٢٩٠٣٨٤٧٢٩", senderPhone: "٠١٠١٢٣٤٥٦٧٨" });
    expect(r.status).toBe(200);
    expect(state.created[0].data).toMatchObject({ amountEgp: 100, reference: "418290384729", senderPhone: "01012345678" });
  });

  it("keeps the existing duplicate-reference and pending-cap messages", async () => {
    state.refTaken = true;
    expect((await call(good)).body.error).toBe("رقم العملية مستخدم مسبقاً في طلب آخر.");
    state.refTaken = false;
    state.pending = 3;
    expect((await call(good)).body.error).toBe("لديك 3 طلبات شحن معلقة بالفعل. يرجى انتظار معالجتها قبل تقديم طلب جديد.");
    state.maxPending = 5; state.pending = 4;
    expect((await call(good)).status).toBe(200);
  });

  it("blocks unverified emails and anonymous callers", async () => {
    state.verified = false;
    expect((await call(good)).status).toBe(403);
    expect((await call(good, null)).status).toBe(401);
    expect(state.created).toHaveLength(0);
  });
});
