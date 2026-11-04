import { isTypedApprovalMessage } from "../retryMessage";
import { titleFromFirstRequest, isUntitledConversation } from "../conversationTitleFromRequest";
import { MISSION_TABLE } from "./constants";
import { createCustomerMission } from "./customerActions";
import { classifyMessage, greetingReplyAr, methodologyReplyAr, otherReplyAr, serviceAnswerAr, type MessageType } from "./messageType";
import { listMethodologyMissions } from "./methodology/missions";

/**
 * ONE CHAT TURN ANSWERED BY THE AGENT. The customer's request becomes a mission for the signed-in user (or the guest, who must sign up before approving); the worker plans it; the chat card
 * (AgentMissionCard) draws it from /api/missions/<id>. The assistant message keeps the mission id in its `plan` column, so a conversation opened later shows the same card.
 *
 * A new request REPLACES the plan above it that was never approved (it holds nothing): the latest plan is the one to act on, as before.
 */
export interface AgentChatTurnInput {
  sb: any;
  userId: string;
  conversationId: string;
  userMsgId: string;
  assistantMsgId: string;
  message: string;
  conversationTitle?: string | null;
}

export type AgentChatTurnResult =
  | { ok: true; missionId: string; contentAr: string; conversationTitle?: string }
  | { ok: false; contentAr: string; status: number };

/** Consent is given with the card's button, never with typed words: a typed «موافق» is answered with where to press and starts nothing. */
export const AGENT_PRESS_APPROVE_AR = "الاعتماد يتم بزر «اعتمد» في بطاقة المهمة فقط، ولن أبدأ التنفيذ ولا أحجز رصيدًا من الكتابة.";
export const AGENT_TURN_CONTENT_AR = "بدأ الوكيل دراسة طلبك؛ تابع خطة المهمة هنا.";
const REPLACEABLE = ["plan_ready", "needs_input"];

/** The id of the mission the assistant's latest card of this conversation points at, or null. */
export async function latestMissionOfConversation(sb: any, conversationId: string): Promise<string | null> {
  try {
    const { data } = await sb.from("messages").select("plan").eq("conversation_id", conversationId).eq("role", "assistant").order("created_at", { ascending: false }).limit(20);
    for (const row of Array.isArray(data) ? data : []) {
      const id = row?.plan?.agentMissionId;
      if (typeof id === "string" && /^msn_[a-z0-9]{8,40}$/.test(id)) return id;
    }
  } catch { /* no earlier mission */ }
  return null;
}

/**
 * ROUND 21: A MESSAGE THAT IS NOT A DATA REQUEST NEVER BECOMES A MISSION. Its answer is fixed words and facts of the code (messageType.ts): no mission row, no planning, no model and no provider call. The answer is the assistant message itself and the customer's message ends «completed»
 * (as every early answer of the handler does), so it never stays «planning».
 */
async function answerWithoutMission(input: AgentChatTurnInput, type: Exclude<MessageType, "data_request">): Promise<AgentChatTurnResult> {
  const { sb } = input;
  let contentAr: string;
  if (type === "greeting") contentAr = greetingReplyAr(input.message);
  else if (type === "service_question") contentAr = serviceAnswerAr(input.message);
  else if (type === "methodology_request") contentAr = methodologyReplyAr({ text: input.message, delivered: (await listMethodologyMissions(sb, input.userId)).length });
  else contentAr = otherReplyAr();
  try {
    await Promise.all([
      sb.from("messages").update({ content_ar: contentAr }).eq("id", input.assistantMsgId),
      sb.from("messages").update({ request_status: "completed" }).eq("id", input.userMsgId),
    ]);
  } catch { /* shown anyway */ }
  return { ok: false, contentAr, status: 200 };
}

export async function agentChatTurn(input: AgentChatTurnInput): Promise<AgentChatTurnResult> {
  const { sb } = input;
  if (isTypedApprovalMessage(input.message)) {
    try { await sb.from("messages").update({ content_ar: AGENT_PRESS_APPROVE_AR }).eq("id", input.assistantMsgId); } catch { /* shown anyway */ }
    return { ok: false, contentAr: AGENT_PRESS_APPROVE_AR, status: 200 };
  }
  // ROUND 21: the type of the message is decided by code before anything is planned; only a data request goes on
  const type = classifyMessage(input.message);
  if (type !== "data_request") return answerWithoutMission(input, type);
  // the unapproved plan above is replaced by this request (nothing is held before approval, so cancelling is only a status)
  const previous = await latestMissionOfConversation(sb, input.conversationId);
  if (previous) {
    try { await sb.from(MISSION_TABLE).update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", previous).eq("user_id", input.userId).in("status", REPLACEABLE); } catch { /* the limit below still protects */ }
  }
  const created = await createCustomerMission(sb, { userId: input.userId, text: input.message });
  if (!created.ok) {
    const contentAr = created.error;
    // the answer is the sentence itself: the request never became a mission, so its message must not stay «planning» (the early answers of the handler end theirs «completed»)
    try {
      await Promise.all([
        sb.from("messages").update({ content_ar: contentAr }).eq("id", input.assistantMsgId),
        sb.from("messages").update({ request_status: "completed" }).eq("id", input.userMsgId),
      ]);
    } catch { /* shown anyway */ }
    return { ok: false, contentAr, status: created.status };
  }
  const derived = isUntitledConversation(input.conversationTitle) ? titleFromFirstRequest([{ role: "user", content: input.message }]) : null;
  try {
    await Promise.all([
      sb.from("messages").update({ content_ar: AGENT_TURN_CONTENT_AR, plan: { agentMissionId: created.id } }).eq("id", input.assistantMsgId),
      sb.from("messages").update({ request_status: "planning" }).eq("id", input.userMsgId),
      ...(derived ? [sb.from("conversations").update({ title: derived, updated_at: new Date().toISOString() }).eq("id", input.conversationId).eq("user_id", input.userId)] : []),
    ]);
  } catch (e) {
    console.warn(`[chat:agent_persist_failed] ${String((e as Error)?.message ?? "").slice(0, 80)}`);
  }
  return { ok: true, missionId: created.id, contentAr: AGENT_TURN_CONTENT_AR, ...(derived ? { conversationTitle: derived } : {}) };
}
