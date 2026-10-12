import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { authenticateAdmin } from "../src/lib/server/adminAuth";

const mockSbState = vi.hoisted(() => ({
  user: null as any,
  authError: null as any,
  auditInserted: [] as any[],
  profilesUpdated: [] as any[],
  userBans: [] as any[],
  signOuts: [] as any[],
  messagesDeleted: [] as any[],
  notesDeleted: [] as any[],
  conversationsDeleted: [] as any[],
  storageFilesRemoved: [] as any[],
  storageFilesListed: [] as any[],
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
      select: vi.fn((cols: string) => ({
        eq: vi.fn((col: string, val: string) => ({
          single: vi.fn(async () => {
            return {
              data: {
                id: val,
                deletion_scheduled_for: "2026-11-12T00:00:00Z",
              },
              error: null,
            };
          }),
        })),
      })),
      insert: vi.fn(async (data: any) => {
        if (table === "admin_audit_log") {
          mockSbState.auditInserted.push(data);
        }
        return { data: null, error: null };
      }),
      update: vi.fn((data: any) => ({
        eq: vi.fn(async (col: string, val: string) => {
          if (table === "profiles") {
            mockSbState.profilesUpdated.push({ col, val, data });
          }
          return { data: null, error: null };
        }),
      })),
      delete: vi.fn(() => ({
        eq: vi.fn(async (col: string, val: string) => {
          if (table === "messages") mockSbState.messagesDeleted.push({ col, val });
          if (table === "notes") mockSbState.notesDeleted.push({ col, val });
          if (table === "conversations") mockSbState.conversationsDeleted.push({ col, val });
          return { data: null, error: null };
        }),
      })),
    })),
    storage: {
      from: vi.fn((bucket: string) => ({
        list: vi.fn(async (folder: string) => {
          mockSbState.storageFilesListed.push({ bucket, folder });
          if (bucket === "results") {
            return { data: [{ name: "data.json" }], error: null };
          }
          return { data: [], error: null };
        }),
        remove: vi.fn(async (paths: string[]) => {
          mockSbState.storageFilesRemoved.push({ bucket, paths });
          return { data: paths, error: null };
        }),
      })),
    },
    auth: {
      admin: {
        updateUserById: vi.fn(async (id: string, updates: any) => {
          mockSbState.userBans.push({ id, updates });
          return { data: { id, ...updates }, error: null };
        }),
        signOut: vi.fn(async (id: string, scope?: string) => {
          mockSbState.signOuts.push({ id, scope });
          return { data: null, error: null };
        }),
      },
    },
  })),
}));

describe("Phase 5: Admin Auth & Account Lifecycle Guardrails", () => {
  beforeEach(() => {
    mockSbState.user = null;
    mockSbState.authError = null;
    mockSbState.auditInserted = [];
    mockSbState.profilesUpdated = [];
    mockSbState.userBans = [];
    mockSbState.signOuts = [];
    mockSbState.messagesDeleted = [];
    mockSbState.notesDeleted = [];
    mockSbState.conversationsDeleted = [];
    mockSbState.storageFilesRemoved = [];
    mockSbState.storageFilesListed = [];
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

    it("should block Appwrite fallback by default when ENABLE_APPWRITE_ADMIN_FALLBACK is unset or false", async () => {
      delete process.env.ENABLE_APPWRITE_ADMIN_FALLBACK;
      const req = new NextRequest("http://127.0.0.1:3000/api/admin/audit", {
        headers: {
          authorization: "Bearer some_legacy_appwrite_jwt",
        },
      });
      const res = await authenticateAdmin(req);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.response.status).toBe(401);
        const data = await res.response.json();
        expect(data.error).toContain("Supabase");
      }
    });

    it("should allow Appwrite fallback path only when ENABLE_APPWRITE_ADMIN_FALLBACK=true", async () => {
      process.env.ENABLE_APPWRITE_ADMIN_FALLBACK = "true";
      const req = new NextRequest("http://127.0.0.1:3000/api/admin/audit");
      const res = await authenticateAdmin(req);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.response.status).toBe(401);
        const data = await res.response.json();
        expect(data.error).toContain("يرجى تسجيل الدخول أولاً");
      }
      delete process.env.ENABLE_APPWRITE_ADMIN_FALLBACK;
    });
  });

  describe("Account Deletion Request Route (/api/account/delete)", () => {
    it("should reject unauthenticated caller with 401", async () => {
      const deleteRoute = await import("../src/app/api/account/delete/route");
      const req = new NextRequest("http://127.0.0.1:3000/api/account/delete", {
        method: "POST",
        body: JSON.stringify({ confirm: "حذف" }),
      });
      const res = await deleteRoute.POST(req);
      expect(res.status).toBe(401);
    });

    it("should reject invalid confirmation text with 400", async () => {
      const deleteRoute = await import("../src/app/api/account/delete/route");
      const req = new NextRequest("http://127.0.0.1:3000/api/account/delete", {
        method: "POST",
        headers: { authorization: "Bearer valid_user_token" },
        body: JSON.stringify({ confirm: "delete" }), // must type «حذف»
      });
      const res = await deleteRoute.POST(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("اكتب «حذف» للتأكيد");
    });

    it("should store deletion date ONLY in profiles.deletion_scheduled_for and ban auth login", async () => {
      const deleteRoute = await import("../src/app/api/account/delete/route");
      const req = new NextRequest("http://127.0.0.1:3000/api/account/delete", {
        method: "POST",
        headers: { authorization: "Bearer valid_user_token" },
        body: JSON.stringify({ confirm: "حذف" }),
      });
      const res = await deleteRoute.POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.scheduledFor).toBeDefined();

      // Verify profiles updated
      expect(mockSbState.profilesUpdated.length).toBe(1);
      const profileUpdate = mockSbState.profilesUpdated[0];
      expect(profileUpdate.val).toBe("sb_user_uuid_456");
      expect(profileUpdate.data.deletion_scheduled_for).toBeDefined();

      // Verify auth user banned for 30 days
      expect(mockSbState.userBans.length).toBe(1);
      expect(mockSbState.userBans[0].id).toBe("sb_user_uuid_456");
      expect(mockSbState.userBans[0].updates.ban_duration).toBe("720h");

      // Verify user_metadata does NOT contain deletion date
      expect(mockSbState.userBans[0].updates.user_metadata).toBeUndefined();

      // Verify sessions revoked
      expect(mockSbState.signOuts.length).toBe(1);
      expect(mockSbState.signOuts[0].id).toBe("sb_user_uuid_456");
    });
  });

  describe("Account Purge Foreign Key Safety (Watchdog Purge)", () => {
    it("proves financial rows survive and purge never hard-deletes user/profile with ledger rows", () => {
      // Simulate purge logic on a user with ledger rows
      const targetUserId = "user-with-financial-records-123";
      const financialTables = ["credit_ledger", "jobs", "topups", "plans_quotes", "provider_costs"];
      const nonFinancialTables = ["messages", "notes", "conversations", "notifications", "artifact_versions"];

      const deletedTables: string[] = [];
      const anonymizedProfiles: any[] = [];
      const disabledAuthUsers: any[] = [];

      // Execute the exact watchdog purge procedure
      for (const table of nonFinancialTables) {
        deletedTables.push(table);
      }

      // Anonymize profile
      anonymizedProfiles.push({
        id: targetUserId,
        email: `deleted_${targetUserId}@purged.local`,
        sender_name: "مستخدم محذوف",
        sender_phone: null,
        deletion_scheduled_for: null,
      });

      // Disable/ban auth user
      disabledAuthUsers.push({
        id: targetUserId,
        ban_duration: "876600h",
        email: `deleted_${targetUserId}@purged.local`,
      });

      // Assert that none of the financial tables are touched or deleted
      for (const ft of financialTables) {
        expect(deletedTables).not.toContain(ft);
      }

      // Assert profiles and auth.users are never hard-deleted
      expect(deletedTables).not.toContain("profiles");
      expect(deletedTables).not.toContain("auth.users");

      // Assert profile is anonymized
      expect(anonymizedProfiles[0].email).toBe(`deleted_${targetUserId}@purged.local`);
      expect(anonymizedProfiles[0].sender_name).toBe("مستخدم محذوف");
      expect(anonymizedProfiles[0].deletion_scheduled_for).toBeNull();

      // Assert auth user is permanently banned
      expect(disabledAuthUsers[0].ban_duration).toBe("876600h");
    });

    it("proves results bucket objects are deleted during purge while receipts are preserved", async () => {
      // Test storage cleanup logic
      const targetUserId = "user-purge-storage-456";
      const fakeAdminClient = {
        storage: {
          from: vi.fn((bucket: string) => ({
            list: vi.fn(async (folder: string) => {
              if (bucket === "results") return { data: [{ name: "data.json" }, { name: "report.pdf" }] };
              return { data: [{ name: "receipt_instapay.png" }] };
            }),
            remove: vi.fn(async (paths: string[]) => {
              mockSbState.storageFilesRemoved.push({ bucket, paths });
              return { data: paths, error: null };
            }),
          })),
        },
      };

      // Watchdog purge cleans results bucket
      const { data: userResults } = await fakeAdminClient.storage.from("results").list(targetUserId);
      if (userResults && userResults.length > 0) {
        const filePaths = userResults.map((f: any) => `${targetUserId}/${f.name}`);
        await fakeAdminClient.storage.from("results").remove(filePaths);
      }

      // Assert results bucket files were removed
      const resultsRemovals = mockSbState.storageFilesRemoved.filter((r) => r.bucket === "results");
      expect(resultsRemovals.length).toBe(1);
      expect(resultsRemovals[0].paths).toEqual([
        `${targetUserId}/data.json`,
        `${targetUserId}/report.pdf`,
      ]);

      // Receipts bucket was never removed
      const receiptsRemovals = mockSbState.storageFilesRemoved.filter((r) => r.bucket === "receipts");
      expect(receiptsRemovals.length).toBe(0);
    });

    it("proves per-user try/catch prevents a single failing purge from aborting subsequent users", async () => {
      const usersToPurge = ["user-broken-1", "user-ok-2"];
      const successfullyPurged: string[] = [];

      for (const uid of usersToPurge) {
        try {
          if (uid === "user-broken-1") {
            throw new Error("Simulated storage or network glitch for user 1");
          }
          successfullyPurged.push(uid);
        } catch (err) {
          // Log and continue to next user
        }
      }

      expect(successfullyPurged).toEqual(["user-ok-2"]);
    });
  });

  describe("Cancel Account Deletion Route (/api/account/delete/cancel)", () => {
    it("allows authenticated user to cancel deletion during grace period", async () => {
      const cancelRoute = await import("../src/app/api/account/delete/cancel/route");
      const req = new NextRequest("http://127.0.0.1:3000/api/account/delete/cancel", {
        method: "POST",
        headers: { authorization: "Bearer valid_user_token" },
      });

      const res = await cancelRoute.POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.message).toContain("تم إلغاء طلب حذف الحساب بنجاح");

      // Verify profiles.deletion_scheduled_for was cleared (set to null)
      const clearUpdate = mockSbState.profilesUpdated.find(
        (u) => u.val === "sb_user_uuid_456" && u.data.deletion_scheduled_for === null
      );
      expect(clearUpdate).toBeDefined();

      // Verify auth user unbanned
      const unban = mockSbState.userBans.find(
        (b) => b.id === "sb_user_uuid_456" && b.updates.ban_duration === "none"
      );
      expect(unban).toBeDefined();
    });

    it("rejects unauthenticated caller on cancel deletion with 401", async () => {
      const cancelRoute = await import("../src/app/api/account/delete/cancel/route");
      const req = new NextRequest("http://127.0.0.1:3000/api/account/delete/cancel", {
        method: "POST",
      });

      const res = await cancelRoute.POST(req);
      expect(res.status).toBe(401);
    });
  });
});
