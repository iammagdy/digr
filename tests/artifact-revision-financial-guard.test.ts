import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/jobs/[id]/artifacts/route";

const mockAuthUser = vi.hoisted(() => ({ id: "usr_rev_test_1" }));
const mockLedgerCharges = vi.hoisted(() => new Set<string>());
const mockStorageData = vi.hoisted(() => new Map<string, any>());

vi.mock("@/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: mockAuthUser },
        error: null,
      })),
    },
  })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "jobs") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: async () => ({
                data: {
                  id: "job_rev_test_100",
                  user_id: "usr_rev_test_1",
                  status: "completed",
                },
                error: null,
              }),
            })),
          })),
        };
      }
      if (table === "credit_ledger") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn((col: string, val: string) => ({
              maybeSingle: async () => {
                if (mockLedgerCharges.has(val)) {
                  return { data: { id: val, delta: -10 }, error: null };
                }
                return { data: null, error: null };
              },
            })),
          })),
        };
      }
      if (table === "artifact_versions") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: async () => ({
                data: [
                  {
                    id: "ver_1",
                    user_id: "usr_rev_test_1",
                    job_id: "job_rev_test_100",
                    version_number: 1,
                    file_id_xlsx: "job_rev_test_100/v1.xlsx",
                    file_id_pdf: "job_rev_test_100/v1.pdf",
                    file_id_csv: "job_rev_test_100/v1.csv",
                    created_at: new Date().toISOString(),
                  },
                ],
                error: null,
              }),
            })),
          })),
          insert: vi.fn(async (row: any) => ({ data: row, error: null })),
        };
      }
      return {
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: async () => ({ data: null, error: null }) })) })),
      };
    }),
    storage: {
      from: vi.fn((bucket: string) => ({
        download: vi.fn(async (path: string) => {
          const key = `${bucket}:${path}`;
          if (mockStorageData.has(key)) {
            const val = mockStorageData.get(key);
            return {
              data: {
                text: async () => JSON.stringify(val),
              },
              error: null,
            };
          }
          return { data: null, error: new Error("File not found") };
        }),
        upload: vi.fn(async () => ({ data: { path: "uploaded" }, error: null })),
      })),
    },
  })),
}));

describe("Artifact Revision Financial Guard & Storage Verification", () => {
  it("blocks unpaid revision requests with 409 Conflict and honest Arabic explanation", async () => {
    mockLedgerCharges.clear();

    const req = new NextRequest("http://127.0.0.1:3000/api/jobs/job_rev_test_100/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersionId: "ver_1",
        operation: { action: "sort", field: "followers", direction: "desc" },
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job_rev_test_100" }) });
    expect(res.status).toBe(409);

    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.blocked).toBe(true);
    expect(json.reason).toBe("revision_charging_pending_owner_approval");
    expect(json.error).toContain("هذا التعديل غير متاح الآن");
    expect(json.error).toContain("فمجاني");
    expect(json.error).not.toMatch(/purchase_revision_atomic|atomic|[A-Za-z_]{4,}/);
    expect(json.error).not.toContain("إدارة المنصة");
  });

  it("reads data.json correctly from partials bucket when results bucket does not yet contain it", async () => {
    mockLedgerCharges.add("chg_rev_job_rev_test_100_v2");
    mockStorageData.clear();
    // Simulate active worker saving data.json in partials bucket under job_rev_test_100/data.json
    mockStorageData.set("partials:job_rev_test_100/data.json", {
      metadata: { title: "نتائج البحث" },
      rows: [
        { id: "1", username: "@test1", followers: 100 },
        { id: "2", username: "@test2", followers: 500 },
      ],
    });

    const req = new NextRequest("http://127.0.0.1:3000/api/jobs/job_rev_test_100/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersionId: "ver_1",
        operation: { action: "sort", field: "followers", direction: "desc" },
      }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "job_rev_test_100" }) });
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.version).toBeDefined();
    expect(json.version.versionNum).toBe(2);
    expect(json.version.rowCount).toBe(2);
    expect(json.version.fileIds).toBeDefined();
  });
});
