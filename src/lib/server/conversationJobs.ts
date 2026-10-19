import { getJobIdForQuote } from "../md5";

/** A job whose results the customer has received (a partial delivery counts). */
export const DELIVERED_JOB_STATUSES = ["done", "completed", "partial", "completed_partial"];

export interface ConversationJob {
  id: string;
  user_id: string;
  status?: string;
  template_slug?: string | null;
  endpoint_id?: string | null;
  capability_slug?: string | null;
  platform?: string | null;
}

const JOB_COLUMNS = "id, user_id, status, template_slug, endpoint_id, capability_slug, platform";

/**
 * The job ids of a conversation, newest first. A job row does not carry its conversation: its id is derived from the quote
 * it was approved from (`job_quote_` + md5 of the quote id), and the conversation's messages carry those quote ids (the
 * customer's message as `request_quote_id`, the assistant's card as `quote.quoteId`).
 */
export async function conversationJobIds(admin: any, scope: { conversationId: string; userId: string }): Promise<string[]> {
  const { data } = await admin
    .from("messages")
    .select("request_quote_id, quote")
    .eq("conversation_id", scope.conversationId)
    .eq("user_id", scope.userId)
    .order("created_at", { ascending: false })
    .limit(100);
  const quoteIds: string[] = [];
  for (const row of Array.isArray(data) ? data : []) {
    for (const candidate of [row?.request_quote_id, row?.quote?.quoteId, row?.quote?.id]) {
      if (typeof candidate === "string" && candidate.length > 0 && !quoteIds.includes(candidate)) quoteIds.push(candidate);
    }
  }
  return quoteIds.map(getJobIdForQuote);
}

/**
 * The latest job of this conversation whose results were delivered, or null. A quote the customer never approved has no
 * job, so it is skipped: the delivered file is the one to shape, whatever plan cards came after it.
 */
export async function latestDeliveredJob(admin: any, scope: { conversationId: string; userId: string }): Promise<ConversationJob | null> {
  if (!admin || typeof admin.from !== "function") return null;
  try {
    const jobIds = await conversationJobIds(admin, scope);
    if (jobIds.length > 0) {
      const { data: jobs } = await admin
        .from("jobs")
        .select(JOB_COLUMNS)
        .in("id", jobIds)
        .eq("user_id", scope.userId)
        .in("status", DELIVERED_JOB_STATUSES)
        .order("created_at", { ascending: false })
        .limit(1);
      const job = Array.isArray(jobs) ? jobs[0] : jobs;
      if (job?.id) return job as ConversationJob;
    }
    // Deployments whose jobs table carries the conversation id: the older lookup, kept as a fallback.
    const { data: legacy } = await admin
      .from("jobs")
      .select(JOB_COLUMNS)
      .eq("conversation_id", scope.conversationId)
      .eq("user_id", scope.userId)
      .in("status", DELIVERED_JOB_STATUSES)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return legacy?.id ? (legacy as ConversationJob) : null;
  } catch {
    return null;
  }
}
