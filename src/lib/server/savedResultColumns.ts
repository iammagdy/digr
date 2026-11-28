import { latestDeliveredJob } from "./conversationJobs";
import { normalizeDataset } from "./normalizationPipeline";
import { inferSocialRowKind } from "./socialRows";
import { isInternalColumnKey, resolveColumn, type DatasetColumn } from "../fileSpec";
import { groupPartDataset } from "./multiProvider/groupPartDataset";
import { readDeliveredWorkbook } from "../agentMission/deliveredWorkbook";
import { deliveredColumnsOf, readDeliveredTable } from "../agentMission/deliveredTable";

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
  const group = await groupPartDataset(admin, job);
  if (group.kind === "frozen") return group.text;
  if (group.kind === "refuse") return "";
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

async function deliveredColumnsFor(admin: any, job: any): Promise<DatasetColumn[]> {
  try {
    const wb = await readDeliveredWorkbook(admin, { job });
    if (!wb.ok) return [];
    const cols = await deliveredColumnsOf(wb.bytes);
    return cols.slice(0, 60);
  } catch {
    return [];
  }
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
    if (!text) {
      const columns = job.endpoint_id === "agent-mission" ? await deliveredColumnsFor(admin, job) : [];
      return { jobId: job.id, columns };
    }
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

/** UL2a-2b B5: the distinct short cell values of each column of the latest delivered result, by column key (the keys the columns above carry). Read only when a request names a term that is not a column. */
export const RESULT_VALUES_MAX_ROWS = 20_000;
export const RESULT_VALUES_MAX_PER_COLUMN = 2_000;
export const RESULT_VALUE_MAX_CHARS = 80;
function distinctValues(rows: Array<Record<string, any>>, keys: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of keys) {
    if (isInternalColumnKey(key)) continue;
    const seen = new Set<string>();
    for (const row of rows.slice(0, RESULT_VALUES_MAX_ROWS)) {
      const v = row?.[key];
      if (v === null || v === undefined || typeof v === "object") continue;
      const text = String(v).trim();
      if (text && text.length <= RESULT_VALUE_MAX_CHARS) seen.add(text);
      if (seen.size >= RESULT_VALUES_MAX_PER_COLUMN) break;
    }
    out[key] = [...seen];
  }
  return out;
}

export async function loadLatestResultValues(admin: any, scope: { conversationId: string; userId: string }): Promise<Record<string, string[]> | null> {
  if (!admin || typeof admin.from !== "function") return null;
  try {
    const job = await latestDeliveredJob(admin, scope);
    if (!job?.id) return null;
    const text = await readJobDatasetText(admin, job);
    if (!text) {
      if (job.endpoint_id !== "agent-mission") return null;
      const wb = await readDeliveredWorkbook(admin, { job });
      if (!wb.ok) return null;
      const table = await readDeliveredTable(wb.bytes, { maxRows: RESULT_VALUES_MAX_ROWS });
      if ("error" in table) return null;
      return distinctValues(table.rows, table.columns.map((c) => c.key));
    }
    const parsed = JSON.parse(text);
    parsed.metadata = parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {};
    const normalized = normalizeDataset(parsed, {
      platform: job.platform || undefined,
      title: parsed.metadata?.title || "نتائج",
      jobId: job.id,
      socialKind: inferSocialRowKind(job.endpoint_id, job.template_slug, job.capability_slug, job.platform),
    });
    return distinctValues(normalized.rows as Array<Record<string, any>>, (normalized.columns || []).slice(0, 60));
  } catch {
    return null;
  }
}

/** Contact details, links, record ids and status flags: a sheet per one of these is never what a customer means. */
const NOT_A_GROUPING_COLUMN = /(?:^|_)(?:phone|email|url|website|linkedin|id)(?:_|$)|_status$/;

/**
 * One question's worth of choices: the columns a customer can actually split or sort by, longest text fields last. With `forGrouping` the contact, link, id and status columns are left out. The product's own fields
 * (`isInternalColumnKey`) are never offered. `preferred` (titles of real columns, the ones closest to what the customer asked for) come FIRST, so a cut at `limit` never drops them; a title that is not a real offered column is ignored.
 */
export function columnChoicesAr(columns: DatasetColumn[], limit = 8, forGrouping = false, preferred: string[] = []): string[] {
  const long = /^(?:text|comment_text|description|bio|methodology)$/;
  const visible = columns.filter((c) => !isInternalColumnKey(c.key));
  const usable = forGrouping ? visible.filter((c) => !NOT_A_GROUPING_COLUMN.test(c.key)) : visible;
  const ordered = [...usable.filter((c) => !long.test(c.key)), ...usable.filter((c) => long.test(c.key))];
  const titles = [...new Set(ordered.map((c) => c.titleAr))];
  const first = preferred.map((p) => resolveColumn(p, usable)?.titleAr).filter((t): t is string => Boolean(t));
  return [...new Set([...first, ...titles])].slice(0, limit);
}
