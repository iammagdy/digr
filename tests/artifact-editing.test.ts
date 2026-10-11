import { describe, expect, it } from "vitest";
import { applyArtifactEdit, ArtifactEditOperationSchema } from "../src/functions/shared/artifactEditing";

describe("versioned artifact edits", () => {
  const payload = {
    metadata: { title: "النتيجة" },
    rows: [
      { id: "1", username: "@a", followers: 100, verified: "نعم", bio: "عام" },
      { id: "2", username: "@b", followers: 50, verified: "لا", bio: "عام" },
      { id: "1", username: "@a", followers: 100, verified: "نعم", bio: "عام" },
    ],
  };

  it("filters and sorts rows without changing the original input", () => {
    const filtered = applyArtifactEdit(payload, { action: "filter", field: "followers", operator: "gte", value: 50 });
    const sorted = applyArtifactEdit(filtered, { action: "sort", field: "followers", direction: "desc" });
    expect(sorted.rows?.map((row) => row.followers)).toEqual([100, 100, 50]);
    expect(payload.rows).toHaveLength(3);
  });

  it("selects and renames columns deterministically", () => {
    const selected = applyArtifactEdit(payload, { action: "select_columns", columns: ["username", "followers"] });
    const renamed = applyArtifactEdit(selected, { action: "rename_columns", renames: { followers: "followerTotal" } });
    expect(renamed.rows?.[0]).toEqual({ username: "@a", followerTotal: 100 });
  });

  it("deduplicates using only the declared keys", () => {
    const deduped = applyArtifactEdit(payload, { action: "dedupe", keys: ["id"] });
    expect(deduped.rows).toHaveLength(2);
  });

  it("groups and aggregates rows with code-owned arithmetic", () => {
    const grouped = applyArtifactEdit(payload, {
      action: "group_aggregate",
      groupBy: "verified",
      metrics: [
        { operation: "count", as: "count" },
        { field: "followers", operation: "average", as: "averageFollowers" },
      ],
    });
    expect(grouped.rows).toEqual([
      { verified: "نعم", count: 2, averageFollowers: 100 },
      { verified: "لا", count: 1, averageFollowers: 50 },
    ]);
  });

  it("anonymizes requested fields and updates summary metadata without altering source payload", () => {
    const edited = applyArtifactEdit(payload, { action: "anonymize", fields: ["username", "bio"] });
    expect(edited.rows?.[0]).not.toHaveProperty("username");
    expect(edited.rows?.[0]).not.toHaveProperty("bio");
    const summary = applyArtifactEdit(edited, { action: "rewrite_summary", summaryAr: "ملخص آمن" });
    expect(summary.metadata?.summaryAr).toBe("ملخص آمن");
    expect(payload.rows[0]).toHaveProperty("username", "@a");
  });

  it("rejects unknown operations, unsafe field names, and extra data", () => {
    expect(ArtifactEditOperationSchema.safeParse({ action: "delete_database" }).success).toBe(false);
    expect(ArtifactEditOperationSchema.safeParse({ action: "sort", field: "__proto__", direction: "asc" }).success).toBe(false);
    expect(ArtifactEditOperationSchema.safeParse({ action: "dedupe", keys: ["id"], chargePoints: 50 }).success).toBe(false);
  });
});
