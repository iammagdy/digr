import { getJobIdForQuote } from "../md5";
import { hasAddonMarker } from "../agentMission/addonMarker";

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

/** `*`, not a column list: the jobs table has no template_slug, capability_slug or platform column, and a column it lacks fails the whole query (the same cause as the live preview). */
const JOB_COLUMNS = "*";

const MISSION_ID_RE = /^msn_[a-z0-9]{8,40}$/;

/**
 * The job ids of a conversation, newest first. A job row does not carry its conversation: its id is derived from the quote
 * it was approved from (`job_quote_` + md5 of the quote id), and the conversation's messages carry those quote ids (the
 * customer's message as `request_quote_id`, the assistant's card as `quote.quoteId`). For an agent mission, the assistant's
 * card stores `plan.agentMissionId`, and the job id is read from the `missions` table.
 */
export async function conversationJobIds(admin: any, scope: { conversationId: string; userId: string }): Promise<string[]> {
  const { data } = await admin
    .from("messages")
    .select("request_quote_id, quote, plan")
    .eq("conversation_id", scope.conversationId)
    .eq("user_id", scope.userId)
    .order("created_at", { ascending: false })
    .limit(100);
  const quoteIds: string[] = [];
  const missionIds: string[] = [];
  for (const row of Array.isArray(data) ? data : []) {
    for (const candidate of [row?.request_quote_id, row?.quote?.quoteId, row?.quote?.id]) {
      if (typeof candidate === "string" && candidate.length > 0 && !quoteIds.includes(candidate)) quoteIds.push(candidate);
    }
    const agentMissionId = row?.plan?.agentMissionId;
    if (typeof agentMissionId === "string" && MISSION_ID_RE.test(agentMissionId) && !missionIds.includes(agentMissionId)) {
      missionIds.push(agentMissionId);
    }
  }

  const jobIds = quoteIds.map(getJobIdForQuote);

  if (missionIds.length > 0) {
    try {
      const { data: missions } = await admin
        .from("missions")
        .select("id, job_id, plan")
        .in("id", missionIds)
        .eq("user_id", scope.userId);

      if (Array.isArray(missions)) {
        const missionJobMap = new Map<string, string>();
        for (const m of missions) {
          if (hasAddonMarker(m)) continue;
          if (typeof m?.job_id === "string" && m.job_id.length > 0) {
            missionJobMap.set(m.id, m.job_id);
          }
        }
        for (const mid of missionIds) {
          const jId = missionJobMap.get(mid);
          if (jId && !jobIds.includes(jId)) {
            jobIds.push(jId);
          }
        }
      }
    } catch {
      // keep quote jobIds on failure
    }
  }

  return jobIds;
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
