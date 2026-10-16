import { describe, expect, it, vi } from "vitest";
import { artifactVersionRowId } from "../src/functions/shared/artifactVersions";
import { linkArtifactVersion } from "../src/functions/shared/artifactVersionLinking";

function makeClient(existing: Array<{ id: string }> = []) {
  const insertedRows: any[] = [];
  const updates: any[] = [];
  const query = {
    eq: vi.fn(function (this: any) { return this; }),
    order: vi.fn(function (this: any) { return this; }),
    limit: vi.fn(async () => ({ data: existing, error: null })),
  };
  const table = {
    select: vi.fn(() => query),
    update: vi.fn((row: any) => {
      updates.push(row);
      return { eq: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })) };
    }),
    insert: vi.fn(async (row: any) => {
      insertedRows.push(row);
      return { error: null };
    }),
  };
  return { client: { from: vi.fn(() => table) }, table, insertedRows, updates };
}

describe("linking generated artifacts to artifact_versions", () => {
  it("updates the latest artifact row with the PDF storage path", async () => {
    const mock = makeClient([{ id: "version_2" }]);

    await linkArtifactVersion(mock.client, "user-1", "job-1", "pdf", "user-1/job-1/result.pdf");

    expect(mock.client.from).toHaveBeenCalledWith("artifact_versions");
    expect(mock.table.select).toHaveBeenCalledWith("id");
    expect(mock.table.update).toHaveBeenCalledWith({ file_id_pdf: "user-1/job-1/result.pdf" });
    expect(mock.insertedRows).toHaveLength(0);
  });

  it("creates a deterministic row when a legacy completed job has none", async () => {
    const mock = makeClient();

    await linkArtifactVersion(mock.client, "user-1", "job-legacy", "pdf", "user-1/job-legacy/result.pdf");

    expect(mock.insertedRows).toHaveLength(1);
    expect(mock.insertedRows[0]).toMatchObject({
      id: artifactVersionRowId("job-legacy", 1),
      job_id: "job-legacy",
      user_id: "user-1",
      version_number: 1,
      file_id_xlsx: null,
      file_id_pdf: "user-1/job-legacy/result.pdf",
      file_id_csv: null,
    });
  });
});
