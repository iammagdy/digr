import { Query, TablesDB } from "./dbCompat";
import { createHash } from "crypto";

export function artifactVersionRowId(jobId: string, versionNum: number): string {
  const digest = createHash("sha256").update(jobId).digest("hex").slice(0, 20);
  return `ver_${digest}_${versionNum}`;
}

export interface InitialArtifactVersionInput {
  userId: string;
  conversationId: string;
  jobId: string;
  rowCount: number;
  fileIds: { xlsx: string; pdf: string; csv: string };
  snapshotFileId?: string;
}

export async function recordInitialArtifactVersion(tables: TablesDB, input: InitialArtifactVersionInput): Promise<void> {
  if (process.env.ARTIFACT_VERSIONS_ENABLED === "false") return;
  if (!input.userId || !input.conversationId || !input.jobId) {
    console.warn("[artifact-versions:METADATA_UNAVAILABLE]");
    return;
  }
  try {
    const existing = await tables.listRows({
      databaseId: "digr",
      tableId: "artifact_versions",
      queries: [Query.equal("jobId", input.jobId), Query.limit(1)],
    });
    if (existing.rows.length) return;
    await tables.createRow({
      databaseId: "digr",
      tableId: "artifact_versions",
      rowId: artifactVersionRowId(input.jobId, 1),
      data: {
        conversationId: input.conversationId,
        userId: input.userId,
        jobId: input.jobId,
        versionNum: 1,
        parentVersionId: null,
        operationJson: JSON.stringify({ action: "original", snapshotFileId: input.snapshotFileId || null }),
        rowCount: Math.max(0, Math.floor(input.rowCount)),
        fileIdXlsx: input.fileIds.xlsx,
        fileIdPdf: input.fileIds.pdf,
        fileIdCsv: input.fileIds.csv,
        isOriginal: true,
        createdAt: new Date().toISOString(),
      },
    });
  } catch {
    try {
      await tables.getRow({ databaseId: "digr", tableId: "artifact_versions", rowId: artifactVersionRowId(input.jobId, 1) });
    } catch {
      console.warn("[artifact-versions:SCHEMA_UNAVAILABLE]");
    }
  }
}
