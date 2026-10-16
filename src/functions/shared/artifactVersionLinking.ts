import { artifactVersionRowId } from "./artifactVersions";

export type ArtifactFormat = "xlsx" | "pdf" | "csv";

const ARTIFACT_COLUMN: Record<ArtifactFormat, "file_id_xlsx" | "file_id_pdf" | "file_id_csv"> = {
  xlsx: "file_id_xlsx",
  pdf: "file_id_pdf",
  csv: "file_id_csv",
};

/** Persist a customer-download storage path on the latest version for this owned job. */
export async function linkArtifactVersion(
  adminClient: any,
  userId: string,
  jobId: string,
  format: ArtifactFormat,
  storagePath: string,
): Promise<void> {
  if (!userId || !jobId || !storagePath) throw new Error("ARTIFACT_VERSION_INPUT_INVALID");

  const table = adminClient.from("artifact_versions");
  const column = ARTIFACT_COLUMN[format];
  const { data: versions, error: readError } = await table
    .select("id")
    .eq("job_id", jobId)
    .eq("user_id", userId)
    .order("version_number", { ascending: false })
    .limit(1);

  if (readError) throw new Error("ARTIFACT_VERSION_READ_FAILED");

  const latest = versions?.[0];
  if (latest?.id) {
    const { error } = await table.update({ [column]: storagePath }).eq("id", latest.id).eq("user_id", userId);
    if (error) throw new Error("ARTIFACT_VERSION_UPDATE_FAILED");
    return;
  }

  const { error } = await table.insert({
    id: artifactVersionRowId(jobId, 1),
    job_id: jobId,
    user_id: userId,
    version_number: 1,
    file_id_xlsx: format === "xlsx" ? storagePath : null,
    file_id_pdf: format === "pdf" ? storagePath : null,
    file_id_csv: format === "csv" ? storagePath : null,
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error("ARTIFACT_VERSION_INSERT_FAILED");
}
