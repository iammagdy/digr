import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { TOPUP_ERROR_MESSAGES } from "@/lib/topupErrors";

const mockState = vi.hoisted(() => ({
  user: null as any,
  authError: null as any,
  storageFiles: new Map<string, Buffer>(),
  topupsTable: [] as any[],
  settingsPricing: null as any,
  pendingCount: 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async (token?: string) => {
        if (token === "invalid") return { data: { user: null }, error: new Error("invalid token") };
        return { data: { user: mockState.user }, error: mockState.authError };
      }),
    },
  })),
  createAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "settings_public") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: mockState.settingsPricing,
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === "topups") {
        return {
          select: vi.fn((_cols: string, opts?: { count?: string; head?: boolean }) => {
            if (opts?.head) {
              return {
                eq: vi.fn(() => ({
                  eq: vi.fn(async () => ({
                    count: mockState.pendingCount,
                    error: null,
                  })),
                })),
              };
            }
            return {
              eq: vi.fn((_col: string, val: string) => ({
                maybeSingle: vi.fn(async () => {
                  const found = mockState.topupsTable.find((t) => t.reference === val);
                  return { data: found || null, error: null };
                }),
              })),
            };
          }),
          insert: vi.fn((row: any) => ({
            select: vi.fn(() => ({
              single: vi.fn(async () => {
                if (mockState.topupsTable.some((t) => t.reference === row.reference)) {
                  return { data: null, error: { code: "23505", message: "duplicate key value" } };
                }
                mockState.topupsTable.push(row);
                return { data: row, error: null };
              }),
            })),
          })),
        };
      }
      return {};
    }),
    storage: {
      from: vi.fn((bucket: string) => {
        if (bucket === "receipts") {
          return {
            download: vi.fn(async (path: string) => {
              const buf = mockState.storageFiles.get(path);
              if (!buf) return { data: null, error: new Error("not_found") };
              const blob = new Blob([new Uint8Array(buf)]);
              return { data: blob, error: null };
            }),
          };
        }
        return { download: vi.fn(async () => ({ data: null, error: new Error("not_found") })) };
      }),
    },
  })),
}));

vi.mock("@/lib/server/sendPlatformEmail", () => ({
  sendPlatformEmail: vi.fn(async () => {}),
  resolveDisplayName: vi.fn((u: any) => u?.user_metadata?.full_name || u?.email?.split("@")[0] || "عميل Diger"),
  formatArabicDate: vi.fn(() => "١٤ أكتوبر ٢٠٢٦"),
  isEmailPreferenceEnabled: vi.fn(() => true),
}));

describe("POST /api/topup/submit: UX Simplification and Receipt Deduplication", () => {
  const userId = "usr_000000000001";

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.user = {
      id: userId,
      email: "user@example.com",
      email_confirmed_at: "2026-10-14T00:00:00Z",
      user_metadata: { full_name: "عميل تجريبي", email_verified: true },
    };
    mockState.authError = null;
    mockState.storageFiles.clear();
    mockState.topupsTable = [];
    mockState.settingsPricing = {
      key: "pricing",
      value: { ipa: "diger@instapay", maxPendingTopups: 3, creditValueEgp: 0.1 },
    };
    mockState.pendingCount = 0;
  });

  it("rejects unauthenticated requests with 401 and unauthorized reason", async () => {
    const { POST } = await import("@/app/api/topup/submit/route");
    mockState.user = null;

    const req = new NextRequest("http://localhost:3000/api/topup/submit", {
      method: "POST",
      body: JSON.stringify({ amountEgp: 100, receiptFileId: `${userId}/rec.png` }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBe("unauthorized");
    expect(body.error).toBe(TOPUP_ERROR_MESSAGES.unauthorized);
  });

  it("rejects unconfirmed email with 403 and email_not_verified reason", async () => {
    const { POST } = await import("@/app/api/topup/submit/route");
    mockState.user.email_confirmed_at = null;
    mockState.user.user_metadata.email_verified = false;

    const req = new NextRequest("http://localhost:3000/api/topup/submit", {
      method: "POST",
      body: JSON.stringify({ amountEgp: 100, receiptFileId: `${userId}/rec.png` }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBe("email_not_verified");
  });

  it("rejects file path outside user folder or containing path traversal with 400", async () => {
    const { POST } = await import("@/app/api/topup/submit/route");

    const req1 = new NextRequest("http://localhost:3000/api/topup/submit", {
      method: "POST",
      body: JSON.stringify({ amountEgp: 100, receiptFileId: `other_user/rec.png` }),
    });
    const res1 = await POST(req1);
    expect(res1.status).toBe(400);
    expect((await res1.json()).reason).toBe("invalid_file_owner");

    const req2 = new NextRequest("http://localhost:3000/api/topup/submit", {
      method: "POST",
      body: JSON.stringify({ amountEgp: 100, receiptFileId: `${userId}/../secret.png` }),
    });
    const res2 = await POST(req2);
    expect(res2.status).toBe(400);
    expect((await res2.json()).reason).toBe("invalid_file_owner");
  });

  it("rejects with payment_details_not_configured when IPA is missing", async () => {
    const { POST } = await import("@/app/api/topup/submit/route");
    mockState.settingsPricing = { key: "pricing", value: { ipa: "" } };
    delete process.env.NEXT_PUBLIC_INSTAPAY_HANDLE;

    const req = new NextRequest("http://localhost:3000/api/topup/submit", {
      method: "POST",
      body: JSON.stringify({ amountEgp: 100, receiptFileId: `${userId}/rec.png` }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBe("payment_details_not_configured");
    expect(body.error).toBe(TOPUP_ERROR_MESSAGES.payment_details_not_configured);
  });

  it("rejects with pending_limit_reached when user pending topups >= maxPending", async () => {
    const { POST } = await import("@/app/api/topup/submit/route");
    mockState.pendingCount = 3;

    const req = new NextRequest("http://localhost:3000/api/topup/submit", {
      method: "POST",
      body: JSON.stringify({ amountEgp: 100, receiptFileId: `${userId}/rec.png` }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBe("pending_limit_reached");
  });

  it("successfully submits top-up without reference number by hashing receipt bytes", async () => {
    const { POST } = await import("@/app/api/topup/submit/route");
    const receiptContent = Buffer.from("sample-receipt-image-binary-data-12345");
    const filePath = `${userId}/receipt_1.png`;
    mockState.storageFiles.set(filePath, receiptContent);

    const expectedHash = crypto.createHash("sha256").update(receiptContent).digest("hex");
    const expectedRef = `rcpt_${expectedHash}`;

    const req = new NextRequest("http://localhost:3000/api/topup/submit", {
      method: "POST",
      body: JSON.stringify({
        amountEgp: 500,
        receiptFileId: filePath,
        // Notice: no reference, no senderName, no senderPhone sent from client
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.reference).toBe(expectedRef);
    expect(body.topupId).toMatch(/^topup_/);

    expect(mockState.topupsTable.length).toBe(1);
    const inserted = mockState.topupsTable[0];
    expect(inserted.amount_egp).toBe(500);
    expect(inserted.reference).toBe(expectedRef);
    expect(inserted.sender_name).toBe("عميل تجريبي");
    expect(inserted.sender_phone).toBe("غير مسجل");
    expect(inserted.status).toBe("pending");
  });

  it("rejects duplicate receipt submissions by content hash with duplicate_receipt reason", async () => {
    const { POST } = await import("@/app/api/topup/submit/route");
    const receiptContent = Buffer.from("identical-receipt-image-pixels");
    const filePath1 = `${userId}/receipt_a.png`;
    const filePath2 = `${userId}/receipt_b.png`;
    mockState.storageFiles.set(filePath1, receiptContent);
    mockState.storageFiles.set(filePath2, receiptContent);

    // First submission succeeds
    const req1 = new NextRequest("http://localhost:3000/api/topup/submit", {
      method: "POST",
      body: JSON.stringify({ amountEgp: 300, receiptFileId: filePath1 }),
    });
    const res1 = await POST(req1);
    expect(res1.status).toBe(200);

    // Second submission with different file name but SAME byte contents is rejected!
    const req2 = new NextRequest("http://localhost:3000/api/topup/submit", {
      method: "POST",
      body: JSON.stringify({ amountEgp: 300, receiptFileId: filePath2 }),
    });
    const res2 = await POST(req2);
    expect(res2.status).toBe(400);
    const body2 = await res2.json();
    expect(body2.success).toBe(false);
    expect(body2.reason).toBe("duplicate_receipt");
    expect(body2.error).toBe(TOPUP_ERROR_MESSAGES.duplicate_receipt);
    // Table still only contains the 1 original topup
    expect(mockState.topupsTable.length).toBe(1);
  });

  it("rejects oversized receipt file (> 5MB) with file_oversized reason", async () => {
    const { POST } = await import("@/app/api/topup/submit/route");
    const largeContent = Buffer.alloc(5 * 1024 * 1024 + 10);
    const filePath = `${userId}/large.png`;
    mockState.storageFiles.set(filePath, largeContent);

    const req = new NextRequest("http://localhost:3000/api/topup/submit", {
      method: "POST",
      body: JSON.stringify({ amountEgp: 200, receiptFileId: filePath }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.reason).toBe("file_oversized");
  });

  it("verifies zero emojis in all defined error messages", () => {
    const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
    for (const [code, msg] of Object.entries(TOPUP_ERROR_MESSAGES)) {
      expect(emojiRegex.test(msg), `Emoji detected in ${code}: ${msg}`).toBe(false);
    }
  });
});
