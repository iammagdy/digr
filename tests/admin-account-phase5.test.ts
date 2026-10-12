import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { authenticateAdmin } from "../src/lib/server/adminAuth";

const mockSbState = vi.hoisted(() => ({
  user: null as any,
  authError: null as any,
  auditInserted: [] as any[],
}));

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async (token?: string) => {
        if (token === "valid_admin_token") {
          return {
            data: {
              user: {
                id: "sb_admin_uuid_123",
                email: "admin@diger.tech",
                app_metadata: { role: "admin" },
                user_metadata: { name: "أدمن تجريبي" },
              },
            },
            error: null,
          };
        }
        if (token === "valid_user_token") {
          return {
            data: {
              user: {
                id: "sb_user_uuid_456",
                email: "user@diger.tech",
                app_metadata: { role: "user" },
                user_metadata: { name: "مستخدم عادي" },
              },
            },
            error: null,
          };
        }
        return {
          data: { user: mockSbState.user },
          error: mockSbState.authError,
        };
      }),
    },
  })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => ({
      insert: vi.fn(async (data: any) => {
        if (table === "admin_audit_log") {
          mockSbState.auditInserted.push(data);
        }
        return { data: null, error: null };
      }),
    })),
  })),
}));

describe("Phase 5: Admin Auth & Account Lifecycle Guardrails", () => {
  beforeEach(() => {
    mockSbState.user = null;
    mockSbState.authError = null;
    mockSbState.auditInserted = [];
  });

  describe("authenticateAdmin with Supabase Auth", () => {
    it("should grant AdminContext when caller has Supabase app_metadata.role === 'admin'", async () => {
      const req = new NextRequest("http://127.0.0.1:3000/api/admin/audit", {
        headers: {
          authorization: "Bearer valid_admin_token",
          "x-forwarded-for": "197.38.12.1",
        },
      });

      const res = await authenticateAdmin(req);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.ctx.adminId).toBe("sb_admin_uuid_123");
        expect(res.ctx.adminEmail).toBe("admin@diger.tech");
        expect(res.ctx.adminName).toBe("أدمن تجريبي");
        expect(res.ctx.ip).toBe("197.38.12.1");

        // Test audit logging
        await res.ctx.audit("login", "تسجيل دخول مسؤول", "لوحة الإدارة");
        expect(mockSbState.auditInserted.length).toBe(1);
        expect(mockSbState.auditInserted[0].action).toBe("login");
        expect(mockSbState.auditInserted[0].actor_id).toBe("sb_admin_uuid_123");
      }
    });

    it("should reject caller when Supabase user has role !== 'admin' (non-admin)", async () => {
      const req = new NextRequest("http://127.0.0.1:3000/api/admin/audit", {
        headers: {
          authorization: "Bearer valid_user_token",
        },
      });

      // Without Appwrite fallback sessions either, it should return 401 or 403
      const res = await authenticateAdmin(req);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect([401, 403]).toContain(res.response.status);
      }
    });

    it("should reject unauthenticated caller without credentials", async () => {
      const req = new NextRequest("http://127.0.0.1:3000/api/admin/audit");
      const res = await authenticateAdmin(req);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.response.status).toBe(401);
      }
    });
  });

  describe("Account Deletion Route (/api/account/delete)", () => {
    it("should export force-dynamic POST handler", async () => {
      const deleteRoute = await import("../src/app/api/account/delete/route");
      expect(deleteRoute.dynamic).toBe("force-dynamic");
      expect(typeof deleteRoute.POST).toBe("function");
    });
  });
});
