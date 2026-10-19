import { latestDeliveredJob } from "./conversationJobs";
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
    const job = await latestDeliveredJob(admin, scope);
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

/** Contact details, links, record ids and status flags: a sheet per one of these is never what a customer means. */
const NOT_A_GROUPING_COLUMN = /(?:^|_)(?:phone|email|url|website|linkedin|id)(?:_|$)|_status$/;

/** One question's worth of choices: the columns a customer can actually split or sort by, longest text fields last. With `forGrouping` the contact, link, id and status columns are left out. */
export function columnChoicesAr(columns: DatasetColumn[], limit = 8, forGrouping = false): string[] {
  const long = /^(?:text|comment_text|description|bio|methodology)$/;
  const usable = forGrouping ? columns.filter((c) => !NOT_A_GROUPING_COLUMN.test(c.key)) : columns;
  const ordered = [...usable.filter((c) => !long.test(c.key)), ...usable.filter((c) => long.test(c.key))];
  return [...new Set(ordered.map((c) => c.titleAr))].slice(0, limit);
}
