import { createHash } from "crypto";
import { isValidRetryJobId, resolveJobExecutionSpec } from "./jobExecutionSpec";

export { isValidRetryJobId };

/**
 * Retry reuse: a retried run starts from the rows a failed run already
 * collected and fetches only the missing amount.
 *
 * Nothing here moves money. The retry is an ordinary new quote that the
 * customer approves; reserve, settle and release still go through the approved
 * SQL functions. The reused rows are copied into `partials/<newJobId>/seed.json`
 * and counted as delivered by the new job, so the customer is charged only for
 * rows that are in the delivered file and the provider is called only for the
 * deficit.
 */

/** Rows older than this are re-collected instead of reused. */
export const RETRY_REUSE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SIGNATURE_IGNORED_KEYS = new Set([
  "limit", "count", "per_page", "size", "pagination", "cursor", "next_cursor", "offset", "page", "maxResults", "retryOfJobId",
]);

export interface RetrySeed {
  version: 1;
  fromJobId: string;
  /** Number of step files read from the failed run (indexes 0..fromSteps-1). */
  fromSteps: number;
  createdAt: string;
  rows: Record<string, any>[];
  uncertainRows: Record<string, any>[];
  rawRowsCount: number;
  baselineExcludedCount: number;
  relevanceExcludedCount: number;
}

export const retrySeedKey = (jobId: string) => `${jobId}/seed.json`;

/** The job id the accept-quote function derives from a quote id. */
export function jobIdForQuote(quoteId: string): string {
  return `job_quote_${createHash("md5").update(String(quoteId)).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Identity of a search plan: the capability and every parameter except paging
 * and the retry marker itself. Two runs with the same signature search for the
 * same thing, so rows from one are valid for the other.
 */
export function planParamsSignature(capabilitySlug: string, params: Record<string, any> | undefined): string {
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(params || {})) {
    if (!SIGNATURE_IGNORED_KEYS.has(key)) kept[key] = (params as Record<string, unknown>)[key];
  }
  return `${String(capabilitySlug || "").toLowerCase()}|${stableStringify(kept)}`;
}

/** Stable identity of a delivered row, or null when the row carries none. */
export function rowIdentity(row: any): string | null {
  const keys = ["company_id", "source_id", "id", "uniqueId", "unique_id", "tweet_id", "post_id", "video_id", "comment_id", "profile_id"];
  for (const key of keys) {
    const value = String(row?.[key] ?? "").trim().toLowerCase();
    if (value) return `id:${value}`;
  }
  const website = String(row?.website || row?.website_url || row?.domain || "").trim().toLowerCase();
  if (website) {
    try {
      const host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, "");
      if (host) return `domain:${host}`;
    } catch { /* fall through to the name */ }
  }
  const name = String(row?.company_name || row?.name || row?.title || "")
    .normalize("NFKC").toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "").trim();
  return name.length >= 3 ? `name:${name}` : null;
}

async function readPartialJson(adminClient: any, key: string, fallback?: Map<string, any>): Promise<any | null> {
  const bucket = adminClient?.storage?.from?.("partials");
  if (bucket && typeof bucket.download === "function") {
    try {
      const { data: blob, error } = await bucket.download(key);
      if (!error && blob) {
        const text = typeof blob.text === "function" ? await blob.text() : String(blob);
        return JSON.parse(text);
      }
    } catch {
      return null;
    }
    return null;
  }
  return fallback?.get(key) ?? null;
}

/** The seed already written for this job, if any. */
export async function loadRetrySeed(adminClient: any, jobId: string, fallback?: Map<string, any>): Promise<RetrySeed | null> {
  const seed = await readPartialJson(adminClient, retrySeedKey(jobId), fallback);
  return seed && seed.version === 1 && Array.isArray(seed.rows) ? (seed as RetrySeed) : null;
}

/** Rows collected by a failed run, read from its step files in order (stops at the first missing or corrupt file). */
export async function readReusableRows(
  adminClient: any,
  fromJobId: string,
  stepCount: number,
  targetMax: number,
  fallback?: Map<string, any>,
): Promise<Pick<RetrySeed, "rows" | "uncertainRows" | "rawRowsCount" | "baselineExcludedCount" | "relevanceExcludedCount"> & { stepsRead: number }> {
  const rows: Record<string, any>[] = [];
  const uncertainRows: Record<string, any>[] = [];
  const seen = new Set<string>();
  let rawRowsCount = 0;
  let baselineExcludedCount = 0;
  let relevanceExcludedCount = 0;
  let stepsRead = 0;
  // A step file can exist for the chunk that failed after its upload, so read one past the counted steps.
  for (let step = 0; step <= Math.max(0, stepCount); step++) {
    const stepObj = await readPartialJson(adminClient, `${fromJobId}/step_${step}.json`, fallback);
    if (!stepObj || !Array.isArray(stepObj.rows)) break;
    stepsRead = step + 1;
    rawRowsCount += Number(stepObj.rawRowsCount ?? stepObj.rows.length) || 0;
    baselineExcludedCount += Number(stepObj.baselineExcludedCount) || 0;
    relevanceExcludedCount += Number(stepObj.relevanceExcludedCount) || 0;
    for (const row of stepObj.rows) {
      const identity = rowIdentity(row);
      if (identity) {
        if (seen.has(identity)) continue;
        seen.add(identity);
      }
      if (rows.length < targetMax) rows.push(row);
    }
    if (Array.isArray(stepObj.uncertainRows)) uncertainRows.push(...stepObj.uncertainRows);
  }
  return { rows, uncertainRows, rawRowsCount, baselineExcludedCount, relevanceExcludedCount, stepsRead };
}

export type RetrySeedResult =
  | { seed: RetrySeed; created: boolean }
  | { seed: null; reason: "not_requested" | "job_not_found" | "not_owner" | "not_failed" | "too_old" | "plan_changed" | "no_rows" | "seed_write_failed" | "invalid_job_id" };

/**
 * Validate the failed run and copy its rows into the new job's seed file.
 * Every check is done from the database, never from client input: the previous
 * job must belong to the same user, be failed, be recent, and have searched for
 * exactly the same thing as the new job.
 */
export async function ensureRetrySeed(
  adminClient: any,
  args: {
    newJobId: string;
    userId: string;
    retryOfJobId: string | undefined;
    currentStep: number;
    targetMax: number;
    newSpec: { capabilitySlug: string; params: Record<string, any> };
    now?: number;
    fallback?: Map<string, any>;
  },
): Promise<RetrySeedResult> {
  const { newJobId, userId, retryOfJobId, targetMax } = args;
  if (!retryOfJobId) return { seed: null, reason: "not_requested" };
  if (!isValidRetryJobId(retryOfJobId) || retryOfJobId === newJobId) return { seed: null, reason: "invalid_job_id" };

  const existing = await loadRetrySeed(adminClient, newJobId, args.fallback);
  if (existing) return { seed: existing, created: false };
  // Seeds are created only before the first chunk of the new job completes.
  if (args.currentStep !== 0) return { seed: null, reason: "not_requested" };

  const { data: prev } = await adminClient
    .from("jobs")
    .select("id, user_id, status, step, delivered_units, endpoint_id, unit_price, updated_at, created_at")
    .eq("id", retryOfJobId)
    .maybeSingle();
  if (!prev) return { seed: null, reason: "job_not_found" };
  if (prev.user_id !== userId) return { seed: null, reason: "not_owner" };
  if (prev.status !== "failed") return { seed: null, reason: "not_failed" };
  const touchedAt = Date.parse(String(prev.updated_at || prev.created_at || ""));
  if (!Number.isFinite(touchedAt) || (args.now ?? Date.now()) - touchedAt > RETRY_REUSE_MAX_AGE_MS) {
    return { seed: null, reason: "too_old" };
  }

  const prevSpec = await resolveJobExecutionSpec(adminClient, prev.id, userId, String(prev.endpoint_id || ""), Number(prev.unit_price) || 1);
  if (
    planParamsSignature(prevSpec.capabilitySlug, prevSpec.params) !==
    planParamsSignature(args.newSpec.capabilitySlug, args.newSpec.params)
  ) {
    return { seed: null, reason: "plan_changed" };
  }

  const collected = await readReusableRows(adminClient, prev.id, Number(prev.step) || 0, targetMax, args.fallback);
  if (!collected.rows.length) return { seed: null, reason: "no_rows" };

  const seed: RetrySeed = {
    version: 1,
    fromJobId: prev.id,
    fromSteps: collected.stepsRead,
    createdAt: new Date(args.now ?? Date.now()).toISOString(),
    rows: collected.rows,
    uncertainRows: collected.uncertainRows,
    rawRowsCount: collected.rawRowsCount,
    baselineExcludedCount: collected.baselineExcludedCount,
    relevanceExcludedCount: collected.relevanceExcludedCount,
  };
  const bucket = adminClient?.storage?.from?.("partials");
  if (!bucket || typeof bucket.upload !== "function") return { seed: null, reason: "seed_write_failed" };
  const { error } = await bucket.upload(retrySeedKey(newJobId), Buffer.from(JSON.stringify(seed), "utf-8"), {
    contentType: "application/json",
    upsert: true,
  });
  if (error) return { seed: null, reason: "seed_write_failed" };
  args.fallback?.set(retrySeedKey(newJobId), seed);
  return { seed, created: true };
}

/** Remove the seed and the failed run's step files once the retried job has settled. */
export async function cleanupRetrySources(adminClient: any, jobId: string, seed: RetrySeed | null, fallback?: Map<string, any>): Promise<void> {
  if (!seed) return;
  const keys = [retrySeedKey(jobId), ...Array.from({ length: seed.fromSteps }, (_, step) => `${seed.fromJobId}/step_${step}.json`)];
  for (const key of keys) fallback?.delete(key);
  const bucket = adminClient?.storage?.from?.("partials");
  if (bucket && typeof bucket.remove === "function") {
    try { await bucket.remove(keys); } catch { /* cleanup is best effort */ }
  }
}

export interface RetryCandidate {
  jobId: string;
  quoteId: string;
  step: number;
  deliveredUnits: number;
}

/** The most recent quote of the conversation and its job, when that job failed recently (the run the retry button belongs to). */
export async function findRetryableJob(
  client: any,
  userId: string,
  conversationId: string,
  now: number = Date.now(),
): Promise<RetryCandidate | null> {
  try {
    const { data: messages } = await client
      .from("messages")
      .select("quote")
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .not("quote", "is", null)
      .order("created_at", { ascending: false })
      .limit(20);
    const quoteId = (messages || [])
      .map((row: any) => row?.quote?.quoteId || row?.quote?.id)
      .find((id: unknown): id is string => typeof id === "string" && id.length > 0);
    if (!quoteId) return null;
    const jobId = jobIdForQuote(quoteId);
    const { data: job } = await client
      .from("jobs")
      .select("id, user_id, status, step, delivered_units, updated_at, created_at")
      .eq("id", jobId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!job || job.status !== "failed") return null;
    const touchedAt = Date.parse(String(job.updated_at || job.created_at || ""));
    if (!Number.isFinite(touchedAt) || now - touchedAt > RETRY_REUSE_MAX_AGE_MS) return null;
    return { jobId, quoteId, step: Number(job.step) || 0, deliveredUnits: Number(job.delivered_units) || 0 };
  } catch {
    return null;
  }
}

/** First plan item of a stored quote, for comparing against the new plan. */
export async function loadQuoteFirstItem(client: any, userId: string, quoteId: string): Promise<{ capabilitySlug: string; params: Record<string, any> } | null> {
  try {
    const { data } = await client.from("plans_quotes").select("items").eq("id", quoteId).eq("user_id", userId).maybeSingle();
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data?.items?.items) ? data.items.items : [];
    const first = items[0];
    return first && typeof first === "object" && first.capabilitySlug
      ? { capabilitySlug: String(first.capabilitySlug), params: (first.params && typeof first.params === "object" ? first.params : {}) as Record<string, any> }
      : null;
  } catch {
    return null;
  }
}
