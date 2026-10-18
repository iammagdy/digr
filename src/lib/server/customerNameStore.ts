import { NAME_PROMPT_AR } from "../customerName";

/** True when the most recent assistant message of the conversation was the one-time name question. */
export async function lastAssistantAskedForName(client: any, userId: string, conversationId: string): Promise<boolean> {
  if (!client || typeof client.from !== "function" || !conversationId) return false;
  try {
    const { data } = await client
      .from("messages")
      .select("content_ar")
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .eq("role", "assistant")
      .order("created_at", { ascending: false })
      .limit(1);
    const last = Array.isArray(data) ? data[0] : null;
    return typeof last?.content_ar === "string" && last.content_ar.includes(NAME_PROMPT_AR.slice(0, 12));
  } catch {
    return false;
  }
}
