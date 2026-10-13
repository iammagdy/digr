import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET as getStats } from "../src/app/api/admin/stats/route";
import { GET as getFinance } from "../src/app/api/admin/finance/route";
import { GET as getTopups } from "../src/app/api/admin/topups/route";
import { Query } from "node-appwrite";
import { authenticateAdmin } from "../src/lib/server/adminAuth";

interface MockDbState {
  topups: any[];
  credit_ledger: any[];
  profiles: any[];
  provider_costs: any[];
  jobs: any[];
  conversations: any[];
  settings_public: any[];
  admin_audit_log: any[];
}

const mockState: MockDbState = {
  topups: [],
  credit_ledger: [],
  profiles: [],
  provider_costs: [],
  jobs: [],
  conversations: [],
  settings_public: [{ key: "pricing", value: { creditValueEgp: 0.1 } }],
  admin_audit_log: [],
};

let currentUser: any = null;

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async (token?: string) => {
        if (token === "admin_token") {
          return {
            data: {
              user: {
                id: "admin_uuid",
                email: "admin@diger.tech",
                app_metadata: { role: "admin" },
                user_metadata: { name: "أدمن تجريبي" },
              },
            },
            error: null,
          };
        }
        if (token === "user_token") {
          return {
            data: {
              user: {
                id: "user_uuid",
                email: "user@diger.tech",
                app_metadata: { role: "user" },
                user_metadata: { name: "مستخدم عادي" },
              },
            },
            error: null,
          };
        }
        if (currentUser) {
          return { data: { user: currentUser }, error: null };
        }
        return { data: { user: null }, error: { message: "No session" } };
      }),
    },
  })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      let filters: Array<(row: any) => boolean> = [];
      let sortFn: ((a: any, b: any) => number) | null = null;
      let rangeOffset = 0;
      let rangeLimit = 1000;
      let schemaError: any = null;

      const builder: any = {
        select: vi.fn((cols: string, opts?: any) => builder),
        eq: vi.fn((col: string, val: any) => {
          if (table === "topups" && col === "reviewed_at") {
            schemaError = { code: "42703", message: "column topups.reviewed_at does not exist" };
          }
          filters.push((r) => r[col] === val);
          return builder;
        }),
        in: vi.fn((col: string, vals: any[]) => {
          if (table === "topups" && col === "reviewed_at") {
            schemaError = { code: "42703", message: "column topups.reviewed_at does not exist" };
          }
          filters.push((r) => vals.includes(r[col]));
          return builder;
        }),
        gte: vi.fn((col: string, val: any) => {
          if (table === "topups" && col === "reviewed_at") {
            schemaError = { code: "42703", message: "column topups.reviewed_at does not exist" };
          }
          filters.push((r) => r[col] >= val);
          return builder;
        }),
        lte: vi.fn((col: string, val: any) => {
          if (table === "topups" && col === "reviewed_at") {
            schemaError = { code: "42703", message: "column topups.reviewed_at does not exist" };
          }
          filters.push((r) => r[col] <= val);
          return builder;
        }),
        order: vi.fn((col: string, { ascending }: { ascending: boolean }) => {
          if (table === "topups" && col === "reviewed_at") {
            schemaError = { code: "42703", message: "column topups.reviewed_at does not exist" };
          }
          sortFn = (a, b) => {
            const valA = a[col] ?? "";
            const valB = b[col] ?? "";
            return ascending ? valA.localeCompare(valB) : valB.localeCompare(valA);
          };
          return builder;
        }),
        range: vi.fn((from: number, to: number) => {
          rangeOffset = from;
          rangeLimit = to - from + 1;
          return builder;
        }),
        single: vi.fn(async () => {
          if (schemaError) return { data: null, error: schemaError };
          const dataList = (mockState as any)[table] || [];
          let filtered = dataList.filter((r: any) => filters.every((f) => f(r)));
          return { data: filtered[0] || null, error: filtered[0] ? null : { message: "not_found" } };
        }),
        maybeSingle: vi.fn(async () => {
          if (schemaError) return { data: null, error: schemaError };
          const dataList = (mockState as any)[table] || [];
          let filtered = dataList.filter((r: any) => filters.every((f) => f(r)));
          return { data: filtered[0] || null, error: null };
        }),
        then: vi.fn((resolve: any) => {
          if (schemaError) {
            return Promise.resolve({ data: null, count: null, error: schemaError }).then(resolve);
          }
          const dataList = (mockState as any)[table] || [];
          let filtered = dataList.filter((r: any) => filters.every((f) => f(r)));
          if (sortFn) filtered.sort(sortFn);
          const sliced = filtered.slice(rangeOffset, rangeOffset + rangeLimit);
          return Promise.resolve({ data: sliced, count: filtered.length, error: null }).then(resolve);
        }),
        insert: vi.fn(async (data: any) => {
          if (table === "admin_audit_log") {
            mockState.admin_audit_log.push(data);
          }
          return { data, error: null };
        }),
      };
      return builder;
    }),
  })),
}));

describe("Admin Dashboard Schema Integrity & Stats Routes (/api/admin/stats)", () => {
  beforeEach(() => {
    currentUser = null;
    mockState.topups = [];
    mockState.credit_ledger = [];
    mockState.profiles = [
      { id: "admin_uuid", email: "admin@diger.tech", name: "مسؤول النظام", created_at: "2026-10-01T00:00:00Z" },
      { id: "user_uuid", email: "user@diger.tech", name: "أحمد باحث", created_at: "2026-10-02T00:00:00Z" },
    ];
    mockState.provider_costs = [];
    mockState.jobs = [];
    mockState.conversations = [];
    mockState.settings_public = [{ key: "pricing", value: { creditValueEgp: 0.1 } }];
    mockState.admin_audit_log = [];
  });

  const makeReq = (url: string, token: string = "admin_token") =>
    new NextRequest(`http://127.0.0.1:3000${url}`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-forwarded-for": "197.38.12.1",
      },
    });

  it("1. Denies access to non-admin users (app_metadata.role !== 'admin')", async () => {
    const req = makeReq("/api/admin/stats", "user_token");
    const res = await getStats(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toContain("ممنوع");
  });

  it("2. Denies access to unauthenticated requests", async () => {
    const req = makeReq("/api/admin/stats", "invalid_or_missing_token");
    const res = await getStats(req);
    expect([401, 403]).toContain(res.status);
  });

  it("3. Loads Admin overview with zero topups without throwing schema error 42703", async () => {
    const req = makeReq("/api/admin/stats");
    const res = await getStats(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.range).toBe(30);
    expect(data.totals.rev).toBe(0);
    expect(data.totals.profit).toBe(0);
    expect(data.pendingCount).toBe(0);
    expect(data.topPayers).toEqual([]);
    expect(data.series.rev.every((v: number) => v === 0)).toBe(true);
  });

  it("4. Loads Admin overview with pending topups, accurately showing pending count and 0 revenue", async () => {
    const nowIso = new Date().toISOString();
    mockState.topups.push({
      id: "topup_pending_1",
      user_id: "user_uuid",
      amount_egp: 250,
      reference: "IP-112233",
      sender_name: "أحمد باحث",
      sender_phone: "01012345678",
      receipt_file_id: "rcpt_1",
      status: "pending",
      created_at: nowIso,
    });

    const req = makeReq("/api/admin/stats");
    const res = await getStats(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    // Pending topups must never be counted as approved revenue
    expect(data.totals.rev).toBe(0);
    expect(data.pendingCount).toBe(1);

    // Activity feed shows deposit submission event ("pay"), but not approval event ("check")
    const payEvent = data.activity.find((e: any) => e.type === "pay");
    expect(payEvent).toBeDefined();
    expect(payEvent.what).toContain("أرسل طلب شحن");
    expect(payEvent.value).toContain("+250 ج.م");

    const checkEvent = data.activity.find((e: any) => e.type === "check");
    expect(checkEvent).toBeUndefined();
  });

  it("5. Derives approved topup review timestamp and credits from append-only credit_ledger without schema error", async () => {
    const creationTime = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
    const approvalTime = new Date().toISOString();

    // In tracked schema, public.topups has NO reviewed_at column
    mockState.topups.push({
      id: "topup_app_1",
      user_id: "user_uuid",
      amount_egp: 500,
      reference: "IP-998877",
      sender_name: "أحمد باحث",
      sender_phone: "01012345678",
      receipt_file_id: "rcpt_2",
      status: "approved",
      created_at: creationTime,
    });

    // Approved topup records its exact timestamp and credits in credit_ledger
    mockState.credit_ledger.push({
      id: "top_topup_app_1",
      user_id: "user_uuid",
      delta: 5000,
      type: "topup",
      topup_id: "topup_app_1",
      note: "شحن رصيد (طلب: topup_app_1)",
      created_at: approvalTime,
    });

    const req = makeReq("/api/admin/stats");
    const res = await getStats(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.totals.rev).toBe(500);
    expect(data.pendingCount).toBe(0);

    // Activity feed records both deposit and ledger-backed admin approval
    const checkEvent = data.activity.find((e: any) => e.type === "check");
    expect(checkEvent).toBeDefined();
    expect(checkEvent.who).toBe("الإدارة");
    expect(checkEvent.what).toContain("اعتمدت شحن");
    expect(checkEvent.value).toBe("+5000 نقطة");
  });

  it("6. Never fabricates financial statistics or approval dates if ledger entry is absent", async () => {
    const creationTime = new Date(Date.now() - 3600000).toISOString();

    // Topup marked approved, but with no corresponding credit_ledger entry
    mockState.topups.push({
      id: "topup_orphan_1",
      user_id: "user_uuid",
      amount_egp: 700,
      reference: "IP-445566",
      sender_name: "أحمد باحث",
      sender_phone: "01012345678",
      receipt_file_id: "rcpt_3",
      status: "approved",
      created_at: creationTime,
    });

    const req = makeReq("/api/admin/stats");
    const res = await getStats(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    // Because reviewedAt could not be derived from the ledger, it is not fabricated from createdAt.
    // Therefore it is not counted in approvedInWindow revenue.
    expect(data.totals.rev).toBe(0);

    // No fabricated admin approval event
    const checkEvent = data.activity.find((e: any) => e.type === "check");
    expect(checkEvent).toBeUndefined();
  });

  it("7. Defensive adapter test: drops reviewed_at on topups query to prevent error 42703", async () => {
    const req = makeReq("/api/admin/stats");
    const auth = await authenticateAdmin(req);
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;

    // Passing Query.orderDesc("reviewedAt") on topups table must not throw error 42703
    const res = await auth.ctx.tables.listRows({
      databaseId: "digr",
      tableId: "topups",
      queries: [Query.orderDesc("reviewedAt")],
    });
    expect(res).toBeDefined();
    expect(Array.isArray(res.rows)).toBe(true);
  });

  it("8. Admin finance route (/api/admin/finance) runs successfully without querying nonexistent reviewed_at", async () => {
    const nowIso = new Date().toISOString();
    mockState.topups.push({
      id: "topup_fin_1",
      user_id: "user_uuid",
      amount_egp: 1000,
      reference: "IP-123456",
      sender_name: "أحمد باحث",
      sender_phone: "01012345678",
      receipt_file_id: "rcpt_fin",
      status: "approved",
      created_at: nowIso,
    });
    mockState.credit_ledger.push({
      id: "top_topup_fin_1",
      user_id: "user_uuid",
      delta: 10000,
      type: "topup",
      topup_id: "topup_fin_1",
      note: "شحن رصيد",
      created_at: nowIso,
    });

    const req = makeReq("/api/admin/finance");
    const res = await getFinance(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.cards.rev).toBe(1000);
    expect(Array.isArray(data.monthly)).toBe(true);
  });

  it("9. Admin topups route (/api/admin/topups) runs successfully and derives review metrics from ledger", async () => {
    const createTime = new Date(Date.now() - 1200000).toISOString(); // 20 mins ago
    const approveTime = new Date().toISOString();

    mockState.topups.push({
      id: "topup_route_1",
      user_id: "user_uuid",
      amount_egp: 300,
      reference: "IP-778899",
      sender_name: "أحمد باحث",
      sender_phone: "01012345678",
      receipt_file_id: "rcpt_t1",
      status: "approved",
      created_at: createTime,
    });
    mockState.credit_ledger.push({
      id: "top_topup_route_1",
      user_id: "user_uuid",
      delta: 3000,
      type: "topup",
      topup_id: "topup_route_1",
      created_at: approveTime,
    });

    const req = makeReq("/api/admin/topups");
    const res = await getTopups(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.topups).toHaveLength(1);
    expect(data.topups[0].reviewedAt).toBe(approveTime);
    expect(data.topups[0].credits).toBe(3000);
    expect(data.stats.approvedThisMonthEgp).toBe(300);
    expect(data.stats.avgReviewMinutes).toBe(20);
  });
});
