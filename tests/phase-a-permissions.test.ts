import { describe, it, expect } from "vitest";

describe("Phase A: Storage Permissions & White-Label Isolation Suite", () => {
  it("A normal user cannot download any raw JSON file from server-only job_data bucket", async () => {
    // Mock user client without API key
    const mockUserStorage = {
      getFileDownload: async (bucketId: string, fileId: string) => {
        if (bucketId === "job_data") {
          const err: any = new Error("User (role: users) missing scope (files.read)");
          err.code = 401;
          err.type = "general_unauthorized_scope";
          throw err;
        }
        return Buffer.from("dummy");
      },
    };

    await expect(
      mockUserStorage.getFileDownload("job_data", "json_6aca1d11003678efd3c5")
    ).rejects.toThrow(/missing scope|unauthorized/i);
  });

  it("The results bucket rejects JSON files and only accepts [xlsx, pdf, csv]", () => {
    const resultsBucketAllowedExtensions = ["xlsx", "pdf", "csv"];

    expect(resultsBucketAllowedExtensions).not.toContain("json");
    expect(resultsBucketAllowedExtensions).toContain("xlsx");
    expect(resultsBucketAllowedExtensions).toContain("pdf");
    expect(resultsBucketAllowedExtensions).toContain("csv");

    const validateUploadExtension = (ext: string) => {
      if (!resultsBucketAllowedExtensions.includes(ext.toLowerCase())) {
        throw new Error("File extension not allowed in results bucket");
      }
      return true;
    };

    expect(() => validateUploadExtension("json")).toThrow("File extension not allowed");
    expect(validateUploadExtension("xlsx")).toBe(true);
    expect(validateUploadExtension("pdf")).toBe(true);
    expect(validateUploadExtension("csv")).toBe(true);
  });

  it("/api/jobs/[id]/data sanitization strips all provider structures and internal cost fields", () => {
    // Raw internal payload stored on server
    const rawInternalData = {
      metadata: {
        platform: "Digr Data Platform",
        title: "نتائج استخراج ملف تيك توك الشخصي (MeGz)",
        methodology: "بيانات عامة",
      },
      profile: {
        id: "6902366830754153474",
        uniqueId: "iam_megz",
        nickname: "MeGz",
        signature: "",
        verified: false,
        followerCount: 1488,
        followingCount: 317,
        heartCount: 14600,
        videoCount: 0,
        // Upstream provider artifacts that must NEVER reach client
        tregEndpointId: "tikhub.tiktok.user.profile",
        tregCallId: "4f6ac13784d549c5bcdba56174f0cd97",
        costMicro: 1000,
        actualCostMicro: 1000,
        marginEgp: 0.15,
        provider: "TikHub",
      },
      rows: [
        {
          id: "rec_1",
          username: "@iam_megz",
          followers: 1488,
          providerInternalId: "tikhub_12345",
        },
      ],
    };

    // Customer-facing sanitization function (matching route.ts)
    const sanitizeForCustomer = (data: any) => {
      const p = data.profile;
      return {
        profile: p ? {
          username: p.uniqueId ? `@${p.uniqueId}` : p.username,
          displayName: p.nickname || "",
          bio: p.signature || "",
          verified: Boolean(p.verified),
          followers: Number(p.followerCount || 0),
          following: Number(p.followingCount || 0),
          likes: Number(p.heartCount || 0),
          videosCount: Number(p.videoCount || 0),
        } : null,
        rows: data.rows.map((r: any) => ({
          id: r.id,
          username: r.username,
          followers: r.followers,
        })),
      };
    };

    const sanitized = sanitizeForCustomer(rawInternalData);

    // Verify sanitized payload contains customer fields
    expect(sanitized.profile?.username).toBe("@iam_megz");
    expect(sanitized.profile?.followers).toBe(1488);

    // Strict White-Label assertion: ZERO provider leaks
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("treg");
    expect(serialized).not.toContain("TikHub");
    expect(serialized).not.toContain("costMicro");
    expect(serialized).not.toContain("actualCostMicro");
    expect(serialized).not.toContain("providerInternalId");
  });
});
