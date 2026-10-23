import { decisionPath, mergeChunkTrace, tracePath, type ChunkTrace, type RoutingDecision, type RoutingTrace } from "../../multiProvider/trace";

/**
 * Where the admin-only routing trace lives: the private `partials` storage bucket (service role only; no customer policy reaches it).
 * It is never put in job_events, plans_quotes or any job param, because the customer's browser can read those. Every function is best
 * effort: the trace is for the owner to read, and a failure here must never touch a job, a reserve or a charge.
 */

const BUCKET = "partials";

async function readJson(client: any, path: string): Promise<any | null> {
  try {
    const store = client?.storage?.from?.(BUCKET);
    if (!store || typeof store.download !== "function") return null;
    const { data: blob, error } = await store.download(path);
    if (error || !blob) return null;
    return JSON.parse(typeof blob.text === "function" ? await blob.text() : String(blob));
  } catch {
    return null;
  }
}

async function writeJson(client: any, path: string, value: unknown): Promise<boolean> {
  try {
    const store = client?.storage?.from?.(BUCKET);
    if (!store || typeof store.upload !== "function") return false;
    const { error } = await store.upload(path, Buffer.from(JSON.stringify(value), "utf-8"), { contentType: "application/json", upsert: true });
    return !error;
  } catch {
    return false;
  }
}

/** Plan time: keeps the router's decision for the quote (what was chosen, by whom, why, the stages and the excluded routes). */
export async function writeRoutingDecision(client: any, quoteId: string, decision: RoutingDecision): Promise<boolean> {
  if (!quoteId) return false;
  return writeJson(client, decisionPath(quoteId), decision);
}

export async function readRoutingDecision(client: any, quoteId: string): Promise<RoutingDecision | null> {
  const value = await readJson(client, decisionPath(quoteId));
  return value && typeof value === "object" && typeof value.routeId === "string" ? (value as RoutingDecision) : null;
}

/** The trace of a job as the admin reads it: the quote-time decision plus every chunk so far. */
export async function readRoutingTrace(client: any, jobId: string, quoteId?: string | null): Promise<RoutingTrace | null> {
  const stored = await readJson(client, tracePath(jobId));
  const trace: RoutingTrace | null = stored && stored.v === 1 && Array.isArray(stored.chunks) ? (stored as RoutingTrace) : null;
  if (trace && trace.decision) return trace;
  const decision = quoteId ? await readRoutingDecision(client, quoteId) : null;
  if (trace) return { ...trace, decision };
  return decision ? { v: 1, jobId, decision, chunks: [] } : null;
}

/** Worker, once per chunk: merges this chunk's facts into the job's trace (a retried chunk replaces itself, so nothing is counted twice). */
export async function appendChunkTrace(client: any, args: { jobId: string; quoteId?: string | null; chunk: ChunkTrace }): Promise<boolean> {
  try {
    const current = (await readRoutingTrace(client, args.jobId, args.quoteId)) ?? { v: 1 as const, jobId: args.jobId, decision: null, chunks: [] };
    return writeJson(client, tracePath(args.jobId), mergeChunkTrace(current, args.chunk));
  } catch {
    return false;
  }
}
