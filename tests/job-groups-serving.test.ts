import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { groupPartDataset } from "@/lib/server/multiProvider/groupPartDataset";

function makeAdmin(opts: { part?: any; frozen?: any; bytes?: string; storageError?: any } = {}) {
  const selects: string[] = [];
  const admin: any = {
    selects,
    from(table: string) {
      selects.push(table);
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: table === "job_group_parts" ? ("part" in opts ? opts.part : { group_id: "grp_1", part_index: 1 }) : (opts.frozen ?? null), error: null }),
      };
    },
    storage: { from: () => ({ download: async (path: string) => ({ data: opts.storageError ? null : new Blob([opts.bytes ?? ""]), error: opts.storageError ?? null, path }) }) },
  };
  return admin;
}

describe("groupPartDataset", () => {
  it("serves only the hash-pinned frozen copy", async () => {
    const text = JSON.stringify({ rows: [{ id: "A" }] });
    const sha256 = createHash("sha256").update(text).digest("hex");
    const admin = makeAdmin({ frozen: { path: `u/j/frozen-${sha256}.json`, sha256, row_count: 1 }, bytes: text });
    await expect(groupPartDataset(admin, { id: "j", user_id: "u", status: "completed" })).resolves.toEqual({ kind: "frozen", text, rowCount: 1, sha256 });
    expect(admin.selects).toEqual(["job_group_parts", "job_group_frozen"]);
  });

  it("preserves ordinary jobs when group lookup confirms no row", async () => {
    const admin = makeAdmin({ part: null });
    await expect(groupPartDataset(admin, { id: "j", user_id: "u" })).resolves.toEqual({ kind: "not_group" });
    expect(admin.selects).toEqual(["job_group_parts"]);
  });

  it("refuses an absent freeze for completed parts and a corrupted copy", async () => {
    const admin = makeAdmin({ frozen: null });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(groupPartDataset(admin, { id: "j", user_id: "u", status: "completed" })).resolves.toMatchObject({ kind: "refuse", status: 503 });
    error.mockRestore();

    const text = JSON.stringify({ rows: [{ id: "A" }] });
    const sha256 = "0".repeat(64);
    const corrupted = makeAdmin({ frozen: { path: `u/j/frozen-${sha256}.json`, sha256, row_count: 1 }, bytes: text });
    await expect(groupPartDataset(corrupted, { id: "j", user_id: "u", status: "completed" })).resolves.toMatchObject({ kind: "refuse", status: 503 });
  });
});
