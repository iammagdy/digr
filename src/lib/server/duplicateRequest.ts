import { jobIdForQuote } from "./retryReuse";

/** A plan identical to one the customer already got results for. */
export interface DuplicateRequest {
  jobId: string;
  conversationId: string | null;
  deliveredUnits: number;
  completedAt: string | null;
}

/** «Recent»: a result older than this is not offered as a reason to skip a new request. */
export const DUPLICATE_REQUEST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The newest completed request of this customer whose plan is IDENTICAL to the one just priced (the same plan hash: same service, same
 * parameters, same count, same files) and that delivered records. Read only: nothing is written, nothing is charged, and a failed read answers null
 * (the warning is an extra, never a gate).
 */
export async function findRecentDuplicateRequest(
  client: any,
  args: { userId: string; planHash: string; excludeQuoteId?: string; now?: number },
): Promise<DuplicateRequest | null> {
  try {
    if (!client || typeof client.from !== "function" || !args.planHash) return null;
    const since = new Date((args.now ?? Date.now()) - DUPLICATE_REQUEST_WINDOW_MS).toISOString();
    const { data: quotes } = await client
      .from("plans_quotes")
      .select("id, created_at")
      .eq("user_id", args.userId)
      .eq("quote_hash", args.planHash)
      .eq("status", "accepted")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5);
    const candidates = (quotes || []).filter((quote: any) => quote?.id && quote.id !== args.excludeQuoteId);
    if (candidates.length === 0) return null;
    const jobIds = candidates.map((quote: any) => jobIdForQuote(String(quote.id)));
    const { data: jobs } = await client
      .from("jobs")
      .select("id, status, delivered_units, updated_at")
      .eq("user_id", args.userId)
      .in("id", jobIds);
    for (const quote of candidates) {
      const jobId = jobIdForQuote(String(quote.id));
      const job = (jobs || []).find((row: any) => row?.id === jobId);
      const delivered = Number(job?.delivered_units) || 0;
      if (!job || (job.status !== "completed" && job.status !== "done") || delivered <= 0) continue;
      let conversationId: string | null = null;
      try {
        const { data: message } = await client
          .from("messages")
          .select("conversation_id")
          .eq("user_id", args.userId)
          .contains("quote", { quoteId: quote.id })
          .limit(1)
          .maybeSingle();
        conversationId = typeof message?.conversation_id === "string" ? message.conversation_id : null;
      } catch {
        conversationId = null;
      }
      return { jobId, conversationId, deliveredUnits: delivered, completedAt: typeof job.updated_at === "string" ? job.updated_at : null };
    }
    return null;
  } catch {
    return null;
  }
}
