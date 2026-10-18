import { normalizeDataset } from "./normalizationPipeline";
import { inferSocialRowKind } from "./socialRows";
import type { DatasetColumn } from "../fileSpec";

/**
 * The columns of the customer's latest delivered result, read from the saved data (never from the provider).
 * Used when a file-shaping request arrives and the page did not send the columns of the result on screen.
 */
export interface SavedResultColumns {
  /** the latest delivered job of this conversation, or null when there is none */
  jobId: string | null;
  columns: DatasetColumn[];
}

const DELIVERED = ["done", "completed", "partial", "completed_partial"];

export async function readJobDatasetText(admin: any, job: { id: string; user_id: string }): Promise<string> {
  const candidatePaths = [`${job.user_id}/${job.id}/data.json`, `${job.id}/data.json`, `json_${job.id}`];
  for (const bucketName of ["results", "partials"]) {
    const bucket = admin?.storage?.from?.(bucketName);
    if (!bucket || typeof bucket.download !== "function") continue;
    for (const path of candidatePaths) {
      const { data: blob, error } = await bucket.download(path);
      if (!error && blob) return await blob.text();
    }
  }
  return "";
}

export async function loadLatestResultColumns(
  admin: any,
  scope: { conversationId: string; userId: string },
): Promise<SavedResultColumns> {
  const none: SavedResultColumns = { jobId: null, columns: [] };
  if (!admin || typeof admin.from !== "function") return none;
  try {
    const { data: job } = await admin
      .from("jobs")
      .select("id, user_id, status, template_slug, endpoint_id, capability_slug, platform")
      .eq("conversation_id", scope.conversationId)
      .eq("user_id", scope.userId)
      .in("status", DELIVERED)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!job?.id) return none;
    const text = await readJobDatasetText(admin, job);
    if (!text) return { jobId: job.id, columns: [] };
    const parsed = JSON.parse(text);
    parsed.metadata = parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {};
    const normalized = normalizeDataset(parsed, {
      platform: job.platform || undefined,
      title: parsed.metadata?.title || "نتائج",
      jobId: job.id,
      socialKind: inferSocialRowKind(job.endpoint_id, job.template_slug, job.capability_slug, job.platform),
    });
    const columns = (normalized.columns || []).slice(0, 60).map((key: string) => ({
      key,
      titleAr: normalized.codebook?.find((c: any) => c.field === key)?.titleAr || key,
    }));
    return { jobId: job.id, columns };
  } catch {
    return none;
  }
}

/** One question's worth of choices: the columns a customer can actually split or sort by, longest text fields last. */
export function columnChoicesAr(columns: DatasetColumn[], limit = 8): string[] {
  const long = /^(?:text|comment_text|description|bio|methodology)$/;
  const ordered = [...columns.filter((c) => !long.test(c.key)), ...columns.filter((c) => long.test(c.key))];
  return [...new Set(ordered.map((c) => c.titleAr))].slice(0, limit);
}
