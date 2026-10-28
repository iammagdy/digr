import { createHash } from "node:crypto";

/**
 * WHICH CONVERSATION OWNS A REQUEST. «طلباتي» opens a request in ITS conversation (with its mission card and its files), never in a new empty chat. A request is linked to its conversation in two ways:
 *  - an AGENT mission: the mission row names its job (`missions.job_id`) and the assistant message that shows the card keeps the mission id in `messages.plan.agentMissionId`;
 *  - an older job: the accepted quote (`plans_quotes`, whose job id is `job_quote_<md5(quote id)>`) sits in the message that proposed it (`messages.quote.quoteId`, or `request_quote_id`).
 * Read only, with the service-role client and an explicit owner check; never throws.
 */
export async function resolveJobConversation(client: any, input: { userId: string; jobId: string }): Promise<{ conversationId: string; via: "mission" | "quote" } | null> {
  const { userId, jobId } = input;
  try {
    // 1. an agent mission
    const { data: mission } = await client.from("missions").select("id,user_id").eq("job_id", jobId).maybeSingle();
    if (mission?.id && mission.user_id === userId) {
      const conversationId = await conversationOfMissionId(client, userId, String(mission.id));
      if (conversationId) return { conversationId, via: "mission" };
    }
  } catch { /* try the quote */ }
  try {
    // 2. an older job, through its accepted quote
    const { data: quotes } = await client.from("plans_quotes").select("id,status").eq("user_id", userId).eq("status", "accepted").limit(1000);
    const quote = (Array.isArray(quotes) ? quotes : []).find((q: any) => { const id = String(q?.id ?? ""); return id && (id === jobId || `job_quote_${createHash("md5").update(id).digest("hex")}` === jobId); });
    if (quote?.id) {
      const { data: messages } = await client.from("messages").select("conversation_id,quote,request_quote_id,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(2000);
      const hit = (Array.isArray(messages) ? messages : []).find((m: any) => m?.request_quote_id === quote.id || m?.quote?.quoteId === quote.id || m?.quote?.id === quote.id);
      if (hit?.conversation_id) return { conversationId: String(hit.conversation_id), via: "quote" };
    }
  } catch { /* nothing found */ }
  return null;
}

/** The conversation whose assistant message keeps this mission id in its `plan`. */
export async function conversationOfMissionId(client: any, userId: string, missionId: string): Promise<string | null> {
  try {
    const { data } = await client.from("messages").select("conversation_id,plan,role,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(2000);
    const hit = (Array.isArray(data) ? data : []).find((m: any) => m?.plan?.agentMissionId === missionId);
    return hit?.conversation_id ? String(hit.conversation_id) : null;
  } catch {
    return null;
  }
}
