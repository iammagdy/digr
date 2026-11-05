import { isRetrySamePlanMessage, isReviewPlanMessage, isTypedApprovalMessage } from "../retryMessage";
import { titleFromFirstRequest, isUntitledConversation } from "../conversationTitleFromRequest";
import { MISSION_TABLE } from "./constants";
import { ADDON_MARKER_COLUMN, hasAddonMarker } from "./addonMarker";
import { getBalance } from "../supabase/ledger";
import { answerForCustomer, createCustomerMission, editPlanForCustomer } from "./customerActions";
import { preModelAnswer } from "./guardRules";
import { decideTurn, type ChatType, type Decision, type OpenRequest, type OpenState } from "./conversationModel";
import { FULL_RESEARCH_PREFIX_AR, greetingReplyAr, isFullResearchMethodologyAsk, methodologyReplyAr, methodologyTailAr, otherReplyAr, serviceAnswerAr } from "./messageType";
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

/** What the customer reads when the plan they want to change is not ready yet. */
export const PLAN_NOT_READY_AR = "خطة طلبك ما زالت قيد التجهيز ولم تظهر بعد. انتظر ظهورها في البطاقة ثم عدّلها منها، ولن يُخصم شيء قبل موافقتك.";
/** What the customer reads when a follow-up changes something the chat cannot apply by itself (no new count): the card's own editor does it, priced again by code. */
export const EDIT_IN_CARD_AR = "لتعديل الفترة أو اللغة أو الأعمدة أو الاستثناءات استخدم زر «عدّل الطلب» في بطاقة الخطة، وسيُحسب السعر من جديد قبل موافقتك. وإن كان طلبك مختلفًا تمامًا فاكتبه كاملًا.";
export const PLAN_EDITED_AR = "عدّلنا الخطة بحسب طلبك، وحُسب السعر من جديد. راجعها في البطاقة، ولن يُخصم شيء قبل أن تعتمدها.";
export const ANSWER_RECEIVED_AR = "وصلت إجابتك، وعاد الوكيل إلى تجهيز الخطة.";

const OPEN_STATE: Record<string, OpenState> = { queued: "planning", planning: "planning", needs_input: "needs_input", plan_ready: "plan_ready" };

/** The customer's open request: the mission the latest card of the conversation points at, while it is being planned, asks a question or waits for approval. Read only. */
async function readOpenRequest(sb: any, conversationId: string, userId: string): Promise<OpenRequest | null> {
  const id = await latestMissionOfConversation(sb, conversationId);
  if (!id) return null;
  try {
    const { data } = await sb.from(MISSION_TABLE).select(`id,user_id,status,question_ar,request_text,${ADDON_MARKER_COLUMN}`).eq("id", id).maybeSingle();
    if (!data || data.user_id !== userId) return null;
    // a review, review-fix or edit request of a delivered file is not the customer's open research request: a follow-up is never applied to it as a plan edit or an answer (MONEY PR 7e, docs/MONEY-PR-7A.md section 17)
    if (hasAddonMarker(data)) return null;
    const state = OPEN_STATE[String(data.status)];
    return state ? { id, state, questionAr: data.question_ar ?? null, requestText: data.request_text ?? null } : null;
  } catch { return null; }
}

/** The customer's balance for the model's prompt (read only; null when it cannot be read: the model then says nothing about it). */
async function readBalance(sb: any, userId: string): Promise<number | null> {
  try { const n = await getBalance(sb, userId); return Number.isFinite(n) ? n : null; } catch { return null; }
}

/** The messages before this one (the model reads a little of the conversation so it can answer like an assistant). */
async function readHistory(sb: any, input: AgentChatTurnInput): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  try {
    const { data } = await sb.from("messages").select("id,role,content_ar,created_at").eq("conversation_id", input.conversationId).order("created_at", { ascending: false }).limit(8);
    const rows = (Array.isArray(data) ? data : []).filter((m: any) => m && m.id !== input.userMsgId && m.id !== input.assistantMsgId && (m.role === "user" || m.role === "assistant") && typeof m.content_ar === "string");
    return rows.reverse().map((m: any) => ({ role: m.role as "user" | "assistant", content: String(m.content_ar) }));
  } catch { return []; }
}

/** Writes the answer on the assistant message and ends the customer's message «completed» (as every early answer of the handler does), so it never stays «planning». */
async function writeAnswer(input: AgentChatTurnInput, contentAr: string, plan?: { agentMissionId: string }): Promise<void> {
  const { sb } = input;
  try {
    await Promise.all([
      sb.from("messages").update({ content_ar: contentAr, ...(plan ? { plan } : {}) }).eq("id", input.assistantMsgId),
      sb.from("messages").update({ request_status: "completed" }).eq("id", input.userMsgId),
    ]);
  } catch { /* shown anyway */ }
}

/**
 * ROUND 21/22: A MESSAGE THAT IS NOT A DATA REQUEST NEVER BECOMES A MISSION. Its answer is the chat model's reply when the code's guard passed it (round 22), else the fixed words and facts of the code (messageType.ts): no mission row, no planning and no provider call.
 * The answer is the assistant message itself and the customer's message ends «completed».
 */
async function answerWithoutMission(input: AgentChatTurnInput, type: Exclude<ChatType, "data_request" | "edit_of_open_request">, decision: Decision): Promise<AgentChatTurnResult> {
  const { sb } = input;
  let contentAr: string;
  if (type === "methodology_request") {
    const delivered = (await listMethodologyMissions(sb, input.userId)).length;
    // the model's sentences about what the document is; the part that carries the price and the chooser is the code's. A full research methodology is never promised.
    const mentionsScope = decision.reply !== null && decision.reply.includes("جمع البيانات");
    if (decision.reply === null || (isFullResearchMethodologyAsk(input.message) && !mentionsScope)) contentAr = methodologyReplyAr({ text: input.message, delivered });
    else contentAr = `${isFullResearchMethodologyAsk(input.message) && !decision.reply.includes("وليس منهجية بحث كاملة") ? FULL_RESEARCH_PREFIX_AR : ""}${decision.reply} ${methodologyTailAr(delivered)}`;
  } else if (decision.reply !== null) contentAr = decision.reply;
  else if (type === "greeting_or_small_talk") contentAr = greetingReplyAr(input.message);
  else if (type === "service_question") contentAr = serviceAnswerAr(input.message);
  else contentAr = otherReplyAr();
  await writeAnswer(input, contentAr);
  return { ok: false, contentAr, status: 200 };
}

/**
 * ROUND 22: A MESSAGE THAT CHANGES OR ANSWERS THE OPEN REQUEST goes to that request's own edit or answer path, applied by the code that already does it (the plan edit is priced again by code; the answer re-queues the mission). Never a new mission, never a generic reply.
 * The only number it can change is the count of items, and only a count the customer wrote. Nothing is held or charged here.
 */
async function answerOpenRequest(input: AgentChatTurnInput, open: OpenRequest, decision: Decision): Promise<AgentChatTurnResult> {
  const { sb } = input;
  const card = async (contentAr: string): Promise<AgentChatTurnResult> => {
    await writeAnswer(input, contentAr, { agentMissionId: open.id });
    return { ok: true, missionId: open.id, contentAr };
  };
  const text = async (contentAr: string): Promise<AgentChatTurnResult> => { await writeAnswer(input, contentAr); return { ok: false, contentAr, status: 200 }; };
  if (open.state === "planning") return text(PLAN_NOT_READY_AR);
  if (open.state === "needs_input") {
    const r = await answerForCustomer(sb, { id: open.id, userId: input.userId, text: input.message });
    return r.ok ? card(ANSWER_RECEIVED_AR) : text(r.error);
  }
  if (decision.count === null) return text(EDIT_IN_CARD_AR);
  const r = await editPlanForCustomer(sb, { id: open.id, userId: input.userId, edits: { count: decision.count } });
  return r.ok ? card(PLAN_EDITED_AR) : text(r.error);
}

/**
 * The mission the last card of the conversation points at may be replaced (cancelled) only when it is a RESEARCH mission: a review request of a delivered file is never replaced by a new chat request (MONEY PR 7e). A read that fails leaves the mission as it is
 * (the replacement is best effort: the open-missions limit protects either way).
 */
async function isResearchMission(sb: any, id: string): Promise<boolean> {
  try {
    const { data, error } = await sb.from(MISSION_TABLE).select(`id,${ADDON_MARKER_COLUMN}`).eq("id", id).maybeSingle();
    return !error && !hasAddonMarker(data);
  } catch { return false; }
}

export async function agentChatTurn(input: AgentChatTurnInput): Promise<AgentChatTurnResult> {
  const { sb } = input;
  if (isTypedApprovalMessage(input.message)) {
    try { await sb.from("messages").update({ content_ar: AGENT_PRESS_APPROVE_AR }).eq("id", input.assistantMsgId); } catch { /* shown anyway */ }
    return { ok: false, contentAr: AGENT_PRESS_APPROVE_AR, status: 200 };
  }
  // ROUND 21/22: the type of the message is decided before anything is planned (the chat model names it, code validates it); only a data request goes on, and only code routes to planning.
  // The chat's own button messages (retry, review) are data requests by code and cost no model call.
  if (!isRetrySamePlanMessage(input.message) && !isReviewPlanMessage(input.message)) {
    // ROUND 23: privacy (personal contact data of private individuals), the account and trust questions have fixed answers written BEFORE the model is called: no mission, no model, no money, and the open-missions limit never sees them
    const fixed = preModelAnswer(input.message);
    if (fixed) {
      console.info(JSON.stringify({ tag: "chat_message_type", type: `fixed_${fixed.kind}`, source: "code" }));
      await writeAnswer(input, fixed.contentAr);
      return { ok: false, contentAr: fixed.contentAr, status: 200 };
    }
    const [open, balancePoints, history] = await Promise.all([readOpenRequest(sb, input.conversationId, input.userId), readBalance(sb, input.userId), readHistory(sb, input)]);
    const decision = await decideTurn({ message: input.message, balancePoints, open, history });
    console.info(JSON.stringify({ tag: "chat_message_type", type: decision.type, source: decision.source, guarded: decision.guarded, open: open?.state ?? "none", ...(decision.failure ? { failure: decision.failure } : {}) }));
    if (decision.type === "edit_of_open_request" && open) return answerOpenRequest(input, open, decision);
    if (decision.type !== "data_request" && decision.type !== "edit_of_open_request") return answerWithoutMission(input, decision.type, decision);
  }
  // the unapproved plan above is replaced by this request (nothing is held before approval, so cancelling is only a status)
  const previous = await latestMissionOfConversation(sb, input.conversationId);
  if (previous && (await isResearchMission(sb, previous))) {
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
