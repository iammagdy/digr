import { isRetrySamePlanMessage, isReviewPlanMessage, isTypedApprovalMessage } from "../retryMessage";
import { titleFromFirstRequest, isUntitledConversation } from "../conversationTitleFromRequest";
import { MISSION_TABLE } from "./constants";
import { ADDON_MARKER_COLUMN, hasAddonMarker } from "./addonMarker";
import { getBalance } from "../supabase/ledger";
import { answerForCustomer, createCustomerMission, editPlanForCustomer } from "./customerActions";
import { contactAskVerdict, contactClarifyAr, preModelAnswer, privacyRefusalAr, PRIVACY_REFUSAL_AR } from "./guardRules";
import { decideTurn, type ChatType, type Decision, type OpenRequest, type OpenState } from "./conversationModel";
import { FULL_RESEARCH_PREFIX_AR, greetingReplyAr, isFullResearchMethodologyAsk, methodologyReplyAr, methodologyTailAr, otherReplyAr, serviceAnswerAr } from "./messageType";
import { listMethodologyMissions } from "./methodology/missions";
import { buildRequestContract } from "./requestContract";
import { briefNumbersAr, contractIsComplete, differsOnlyByCount, parseBrief, sameContract, storedBriefOf, validateBrief, type ResearchBrief } from "./researchBrief";
import { partBriefOf, partsOf, RESEARCH_GROUP_MAX_PARTS, RESEARCH_GROUP_VERSION, samePartRequest, storedGroupOf, type PartOutcome, type ResearchPart, type StoredGroupPart, type StoredResearchGroup } from "./researchGroup";
import { randomUUID } from "node:crypto";
import { readSettingValue, scopedFlagOn } from "./scopedFlag";
import { buildCapabilityRegistry, chatCapabilityLines, discoverCapabilities, operationLabelAr, PLATFORM_AR, researchNeedOf, CAPABILITY_DISCOVERY_FLAG_KEY, type CapabilityDiscovery, type CapabilityRegistry } from "./capabilities";
import { loadTregCatalog } from "../treg/catalog";
import { blockedEndpointReason } from "../treg/blockList";
import { policyVerdict } from "../treg/dataPolicy";

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
  | { ok: true; missionId: string; contentAr: string; conversationTitle?: string; /** MULTI-OBJECTIVE RESEARCH: the other parts of the same request, each on its own new assistant message with its own card. */ extraMissions?: Array<{ id: string; messageId: string; contentAr: string }> }
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
async function writeAnswer(input: AgentChatTurnInput, contentAr: string, plan?: { agentMissionId?: string; researchBrief?: ResearchBrief; researchGroup?: StoredResearchGroup }): Promise<void> {
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
    const mode = await readBriefMode(sb, input.userId);
    const [open, balancePoints, history, priorState] = await Promise.all([readOpenRequest(sb, input.conversationId, input.userId), readBalance(sb, input.userId), readHistory(sb, input), mode.enabled ? readPriorBrief(sb, input.conversationId) : Promise.resolve({ brief: null, group: null })]);
    const prior = priorState.brief;
    // what the customer asked in this conversation: the open request's stored words (typed earlier, maybe beyond the recent messages), the recent messages, this one
    const customerTurns = [...(open?.requestText ? [open.requestText] : []), ...history.filter((m) => m.role === "user").map((m) => m.content), input.message];
    const assistantQuestion = [...history].reverse().find((m) => m.role === "assistant")?.content ?? null;
    const decision = await decideTurn({ message: input.message, balancePoints, open, history, ...(mode.enabled ? { brief: { enabled: true, soFar: prior, numbersAr: briefNumbersAr({ customerTurns, prior }), ...(mode.registry ? { capabilityLines: chatCapabilityLines(mode.registry) } : {}) } } : {}) });
    const briefCtx: BriefTurnContext = { customerTurns, assistantQuestion, prior, semantic: mode.semantic, outcome: "off", ...(mode.registry ? { registry: mode.registry } : {}), ...(priorState.group ? { priorGroup: priorState.group } : {}) };
    const viaBrief = mode.enabled ? await briefTurn(input, decision, open, briefCtx) : null;
    console.info(JSON.stringify({ tag: "chat_message_type", type: decision.type, source: decision.source, guarded: decision.guarded, open: open?.state ?? "none", brief: mode.enabled ? briefCtx.outcome : "off", ...(decision.failure ? { failure: decision.failure } : {}) }));
    if (viaBrief) return viaBrief;
    if (decision.type === "edit_of_open_request" && open) return answerOpenRequest(input, open, decision);
    if (decision.type !== "data_request" && decision.type !== "edit_of_open_request") return answerWithoutMission(input, decision.type, decision);
  }
  return startMission(input, input.message);
}

/**
 * A NEW MISSION FROM A REQUEST (the customer's own message, or the research brief's consolidated request in brief mode). The unapproved plan above is replaced by it (nothing is held before approval, so cancelling is only a status). The worker plans
 * it; nothing is held or charged here. `brief` is stored with the card so the next turn can revise the same brief; `noteAr` is a short checked sentence of the model put in front of the card's line.
 */
async function startMission(input: AgentChatTurnInput, requestText: string, extra: { brief?: ResearchBrief; noteAr?: string | null; contentAr?: string } = {}): Promise<AgentChatTurnResult> {
  const { sb } = input;
  const previous = await latestMissionOfConversation(sb, input.conversationId);
  if (previous && (await isResearchMission(sb, previous))) {
    try { await sb.from(MISSION_TABLE).update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", previous).eq("user_id", input.userId).in("status", REPLACEABLE); } catch { /* the limit below still protects */ }
  }
  const created = await createCustomerMission(sb, { userId: input.userId, text: requestText });
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
  const contentAr = extra.contentAr ?? (extra.noteAr ? `${extra.noteAr} ${AGENT_TURN_CONTENT_AR}` : AGENT_TURN_CONTENT_AR);
  const derived = isUntitledConversation(input.conversationTitle) ? titleFromFirstRequest([{ role: "user", content: requestText }]) : null;
  try {
    await Promise.all([
      sb.from("messages").update({ content_ar: contentAr, plan: { agentMissionId: created.id, ...(extra.brief ? { researchBrief: extra.brief } : {}) } }).eq("id", input.assistantMsgId),
      sb.from("messages").update({ request_status: "planning" }).eq("id", input.userMsgId),
      ...(derived ? [sb.from("conversations").update({ title: derived, updated_at: new Date().toISOString() }).eq("id", input.conversationId).eq("user_id", input.userId)] : []),
    ]);
  } catch (e) {
    console.warn(`[chat:agent_persist_failed] ${String((e as Error)?.message ?? "").slice(0, 80)}`);
  }
  return { ok: true, missionId: created.id, contentAr, ...(derived ? { conversationTitle: derived } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// CONSOLIDATED MISSION: THE RESEARCH BRIEF (docs/AGENT-UNDERSTANDING-V1.md)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
/**
 * The server switch of research-brief mode: `agent_settings` key below, `true` / `"on"` for everyone or `{ "user_ids": [...] }` for named test accounts (scopedFlag.ts). OFF by default; nothing in the repository sets it. The account is the signed-in
 * user id the route verified (never anything the customer sends). Off: the chat behaves exactly as before (one model call, the same prompt, the same routing).
 */
export const CHAT_RESEARCH_BRIEF_FLAG_KEY = "chat_research_brief_v1";

async function readBriefMode(sb: any, userId: string): Promise<{ enabled: boolean; semantic: boolean; registry: CapabilityRegistry | null }> {
  // the consistency check reads the consolidated request with the parser as it is with the semantic flag OFF: the stricter reading (with the flag ON the reading only fills or corrects from the same words), and the chat never imports the
  // semantic layer (the isolation rule of PR-1.2: the privacy rules, the chat and mission creation stay independent of it)
  const enabled = scopedFlagOn(await readSettingValue(sb, CHAT_RESEARCH_BRIEF_FLAG_KEY), userId);
  // UNIFIED CAPABILITY DISCOVERY (capability_discovery_v1, read only in brief mode): the registry the discovery question and the brief are checked against. Off, or unreadable: null, and brief mode is exactly what it was.
  const registry = enabled && scopedFlagOn(await readSettingValue(sb, CAPABILITY_DISCOVERY_FLAG_KEY), userId) ? chatRegistry() : null;
  return { enabled, semantic: false, registry };
}

/**
 * The chat's registry: the local catalog snapshot (shipped with the chat route) and the documented web sources. The account's sensitive-data access is not read here (null access: the stricter policy), and the providers' keys and caps are
 * not known to the site: the worker re-runs the discovery with them and decides. Built once per process; nothing is fetched.
 */
let chatRegistryCache: CapabilityRegistry | null = null;
function chatRegistry(): CapabilityRegistry | null {
  if (chatRegistryCache) return chatRegistryCache;
  try {
    chatRegistryCache = buildCapabilityRegistry(loadTregCatalog(), { isAllowed: (id) => !blockedEndpointReason(id) && policyVerdict(id, null).allowed });
  } catch { chatRegistryCache = null; }
  return chatRegistryCache;
}

/** Said with the honest limitation when the ready brief asks for something no available capability can do: the customer chooses the reduced scope (or another source) before any mission exists. */
export function capabilityLimitReplyAr(d: CapabilityDiscovery): string {
  return [d.messageAr, d.alternativeAr].filter((x): x is string => typeof x === "string" && x.trim() !== "").join(" ");
}

/** The brief of this conversation: the one stored with the latest assistant card or question (`plan.researchBrief`, or the whole brief of a multi-part request `plan.researchGroup.brief`), and that group. A newer card without a brief (a request of the old path) ends it. Read only. */
async function readPriorBrief(sb: any, conversationId: string): Promise<{ brief: ResearchBrief | null; group: StoredResearchGroup | null }> {
  try {
    const { data } = await sb.from("messages").select("plan").eq("conversation_id", conversationId).eq("role", "assistant").order("created_at", { ascending: false }).limit(20);
    for (const row of Array.isArray(data) ? data : []) {
      const plan = row?.plan;
      if (!plan || typeof plan !== "object") continue;
      if ("researchBrief" in plan || "agentMissionId" in plan || "researchGroup" in plan) {
        const group = storedGroupOf(plan, strictBrief);
        return { brief: group ? group.brief : storedBriefOf(plan), group };
      }
    }
  } catch { /* no brief */ }
  return { brief: null, group: null };
}
const strictBrief = (raw: unknown): ResearchBrief | null => { const p = parseBrief(raw); return p.ok && p.unknown.length === 0 ? p.brief : null; };

interface BriefTurnContext {
  customerTurns: string[];
  assistantQuestion: string | null;
  prior: ResearchBrief | null;
  semantic: boolean;
  /** What happened, for the log line (a code: never the customer's words). */
  outcome: string;
  /** UNIFIED CAPABILITY DISCOVERY: the registry the ready brief is checked against (absent: the switch is off). */
  registry?: CapabilityRegistry;
  /** MULTI-OBJECTIVE RESEARCH: the parts prepared on an earlier turn of this conversation (absent: none). */
  priorGroup?: StoredResearchGroup;
}

/** Said when an unapproved plan (or a question card) is replaced by the updated request. */
export const REQUEST_UPDATED_AR = "حدّثنا طلبك بحسب رسالتك، ويجهّز الوكيل الآن خطة جديدة بسعرها؛ ولن يُخصم شيء قبل موافقتك.";
/** Said when the earlier request was already in the worker's hands: it is not stopped mid-planning, and nothing of it runs without the customer's own approval. */
export const PREVIOUS_STILL_PLANNING_AR = "حدّثنا طلبك بحسب رسالتك، ويجهّز الوكيل خطة جديدة بسعرها. أما الخطة السابقة فكانت قيد التجهيز، ولن يُنفَّذ منها شيء ولن يُخصم شيء إلا إذا اعتمدتها بنفسك.";

/**
 * ONE TURN IN BRIEF MODE. Returns the turn's answer, or null when today's path should answer (the model gave no usable brief, the brief failed a check that is not about privacy, or the message is not a request): the old behaviour is the fallback,
 * so brief mode can never do worse than today. What it never does: approve, price, hold, or start anything that the customer did not ask for.
 */
async function briefTurn(input: AgentChatTurnInput, decision: Decision, open: OpenRequest | null, ctx: BriefTurnContext): Promise<AgentChatTurnResult | null> {
  // the model could not be read: a pending discovery question is still answered (the customer's answer joins the request so far, privacy checked again), never lost
  if (decision.source === "keyword") {
    // MULTI-OBJECTIVE RESEARCH: the model's answer was cut at its output ceiling (a long request with many parts): its objectives are not dropped by reading the words alone; the customer continues with one word, the request is not retyped
    // (no second call is made: one call per message, the ceiling unchanged)
    if (decision.failure === "truncated" && ctx.registry && decision.type !== "greeting_or_small_talk" && decision.type !== "service_question" && decision.type !== "methodology_request") {
      ctx.outcome = "model_truncated";
      await writeAnswer(input, TRUNCATED_AR);
      return { ok: false, contentAr: TRUNCATED_AR, status: 200 };
    }
    const pending = ctx.prior && ctx.prior.status === "needs_clarification" && !open;
    if (!pending || decision.type === "greeting_or_small_talk" || decision.type === "service_question" || decision.type === "methodology_request") { ctx.outcome = "model_unavailable"; return null; }
    const joined = `${ctx.prior!.request}، ${input.message}`;
    const privacy = privacyRefusalAr(joined) ?? (contactAskVerdict(joined) === "clarify" ? contactClarifyAr(joined) : null);
    if (privacy) { ctx.outcome = "privacy"; await writeAnswer(input, privacy); return { ok: false, contentAr: privacy, status: 200 }; }
    ctx.outcome = "fallback_joined";
    return startMission(input, joined);
  }
  if (decision.type !== "data_request" && decision.type !== "edit_of_open_request") { ctx.outcome = "not_a_request"; return null; }
  const parsed = decision.brief;
  if (!parsed) { ctx.outcome = "none"; return null; }
  if (!parsed.ok) { ctx.outcome = `schema_${parsed.issue}`; return null; }
  const v = validateBrief(parsed.brief, { customerTurns: ctx.customerTurns, assistantQuestion: ctx.assistantQuestion, prior: ctx.prior, semantic: ctx.semantic });
  if (!v.ok) {
    ctx.outcome = `rejected_${v.reason}`;
    // a private component is never planned: the same fixed answer as a typed one
    if (v.contentAr) { await writeAnswer(input, v.contentAr); return { ok: false, contentAr: v.contentAr, status: 200 }; }
    return null;
  }
  const brief = v.brief;
  // MULTI-OBJECTIVE RESEARCH: several first objectives, or a follow-up on the parts prepared before: every part keeps its own existing plan (docs/MULTI-OBJECTIVE-RESEARCH.md)
  const parts = brief.objectives ? partsOf(brief) : [];
  if (ctx.registry && (parts.length >= 2 || (ctx.priorGroup && parts.length >= 1))) {
    // the model still asks something it needs (a genuinely missing requirement): its question, with the whole brief kept
    if (brief.status === "needs_clarification" && decision.reply !== null) {
      ctx.outcome = "group_clarify";
      await writeAnswer(input, decision.reply, { researchBrief: brief });
      return { ok: false, contentAr: decision.reply, status: 200 };
    }
    return groupTurn(input, decision, open, { ...brief, status: "ready" }, parts, ctx);
  }
  if (decision.type === "edit_of_open_request" && open) return briefEditOfOpen(input, decision, open, brief, v.contract, ctx);
  // a new research request (or the next step of the discovery): a question while something that matters is missing, else a mission from the WHOLE request
  if (brief.status === "needs_clarification" && !contractIsComplete(v.contract)) {
    if (decision.reply === null) { ctx.outcome = "clarify_without_question"; return null; }
    ctx.outcome = "clarify";
    await writeAnswer(input, decision.reply, { researchBrief: brief });
    return { ok: false, contentAr: decision.reply, status: 200 };
  }
  const gated = await capabilityGate(input, brief, ctx);
  if (gated) return gated;
  ctx.outcome = brief.status === "ready" ? "ready" : "ready_by_contract";
  return startMission(input, brief.request, { brief: { ...brief, status: "ready" }, noteAr: brief.status === "ready" ? decision.reply : null });
}

/**
 * UNIFIED CAPABILITY DISCOVERY (capability_discovery_v1): a request no available capability can (fully) serve never becomes a mission silently reduced or substituted. The customer is told what is unavailable and offered the feasible scope
 * (the brief is kept as «needs_clarification», so the next turn revises the same request); nothing is created, held or charged. Null: the request can be served (or the switch is off), the caller goes on.
 */
async function capabilityGate(input: AgentChatTurnInput, brief: ResearchBrief, ctx: BriefTurnContext): Promise<AgentChatTurnResult | null> {
  if (!ctx.registry) return null;
  const d = discoverCapabilities(researchNeedOf({ request: brief.request, brief }), ctx.registry);
  // the model understood a goal nothing serves, and nothing else: the customer is asked (with what can be collected now), never told «unsupported» because a word was not recognised
  if (d.status === "needs_clarification" && d.messageAr) {
    ctx.outcome = "objectives_unresolved_ask";
    const contentAr = capabilityLimitReplyAr(d);
    await writeAnswer(input, contentAr, { researchBrief: { ...brief, status: "needs_clarification" } });
    return { ok: false, contentAr, status: 200 };
  }
  if (d.status !== "unsupported" && d.status !== "partial" && d.status !== "blocked") return null;
  // a social request whose platform is served goes on: the social plan compiler has its own validated cards for the child steps (replies, comments) and states before approval, with the price, any step it cannot serve
  // (a part the model understood that no operation serves is still asked: it is not a child step of the compiler)
  if (d.status === "partial" && d.need.kind === "social" && (d.need.unresolved ?? []).length === 0) { ctx.outcome = "capability_partial_social_compiler"; return null; }
  ctx.outcome = `capability_${d.status}`;
  const contentAr = capabilityLimitReplyAr(d);
  await writeAnswer(input, contentAr, d.status === "blocked" ? undefined : { researchBrief: { ...brief, status: "needs_clarification" } });
  return { ok: false, contentAr, status: 200 };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// MULTI-OBJECTIVE RESEARCH (docs/MULTI-OBJECTIVE-RESEARCH.md)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const LIVE_STATUSES = new Set(["queued", "planning", "needs_input", "plan_ready", "approved", "executing", "delivered", "partial"]);
const WITHDRAWABLE = ["queued", "needs_input", "plan_ready"];
/** Said when the model's reading of a long request was cut before it ended: nothing is lost, the customer only says «كمّل». */
export const TRUNCATED_AR = "وصلني طلبك بكل أجزائه، لكن تلخيصه طلع أطول من المسموح في رد واحد. اكتب «كمّل» وأنا أكمّل تجهيز كل الأجزاء من غير ما تعيد كتابة طلبك؛ ولن يُخصم شيء قبل اعتمادك.";
/** Said when the request's parts are already prepared and nothing changed (a «تمام جهّزهم» or a repetition): nothing new is created. */
export const GROUP_UNCHANGED_AR = "أجزاء طلبك متجهّزة بالفعل، وكل جزء له بطاقته بخطته وسعره. اعتمد الجزء اللي يناسبك من بطاقته، ولن يُخصم شيء قبل اعتمادك.";
/** Said after the summary of the parts: approvals are per part. */
export const GROUP_APPROVAL_AR = "كل جزء له خطة وسعر في بطاقته، وتعتمد كل جزء لوحده بزر «اعتمد»؛ ولن يُخصم شيء قبل اعتمادك، ولا تدفع إلا عن المسلَّم فعلًا.";

interface JudgedPart { part: ResearchPart; partBrief: ResearchBrief | null; outcome: PartOutcome; label: string; noteAr: string | null; discovery: CapabilityDiscovery | null }

/** The customer-facing name of a part (the operations it carries and its platform; never a provider). */
function partLabelAr(part: ResearchPart): string {
  const deepest = [...part.objectives].reverse().find((o) => o.operation !== "unsupported");
  if (!deepest) return "جزء من طلبك لا يطابق أي نوع بيانات نقدر نجمعه";
  if (deepest.operation.startsWith("social.") && deepest.platform && !(deepest.platform in PLATFORM_AR)) return `بيانات ${deepest.platform}`;
  return operationLabelAr(deepest.operation as Exclude<typeof deepest.operation, "unsupported">, deepest.platform);
}

/** What can be done with ONE part now: its sentence validated like a brief, then the capabilities of its objectives (the same discovery a single request gets). Pure apart from the registry read. */
function judgePart(part: ResearchPart, ctx: BriefTurnContext, registry: CapabilityRegistry): JudgedPart {
  const label = partLabelAr(part);
  const base = { part, partBrief: null, label, discovery: null };
  if (part.unresolved) {
    const d = discoverCapabilities(researchNeedOf({ request: part.request ?? "", brief: { platforms: [], content: [], count: null, objectives: part.objectives } }), registry);
    return { ...base, outcome: "unsupported", noteAr: [d.messageAr, d.alternativeAr].filter(Boolean).join(" ") || null };
  }
  const pb = partBriefOf(part);
  if (!pb) return { ...base, outcome: "needs_clarification", noteAr: null };
  const v = validateBrief(pb, { customerTurns: ctx.customerTurns, assistantQuestion: ctx.assistantQuestion, prior: ctx.prior, semantic: ctx.semantic });
  if (!v.ok) return { ...base, outcome: v.reason === "privacy_refusal" || v.reason === "privacy_clarify" ? "refused_private" : "needs_clarification", noteAr: v.contentAr ?? null };
  const d = discoverCapabilities(researchNeedOf({ request: v.brief.request, brief: v.brief }), registry);
  if (d.status === "blocked") return { ...base, partBrief: v.brief, discovery: d, outcome: "refused_private", noteAr: d.messageAr };
  if (d.status === "unsupported") {
    const unavailable = d.unsupported.length > 0 && d.unsupported.every((u) => u.reason === "provider_unavailable" || u.reason === "not_permitted");
    return { ...base, partBrief: v.brief, discovery: d, outcome: unavailable ? "unavailable" : "unsupported", noteAr: [d.messageAr, d.alternativeAr].filter(Boolean).join(" ") || null };
  }
  if (d.status === "needs_clarification") return { ...base, partBrief: v.brief, discovery: d, outcome: "needs_clarification", noteAr: [d.messageAr, d.alternativeAr].filter(Boolean).join(" ") || null };
  // supported, or partial (a later step of the part is unavailable: its own card asks the reduced scope before any plan or price, as for a single request)
  return { ...base, partBrief: v.brief, discovery: d, outcome: "planned", noteAr: d.status === "partial" ? d.messageAr : null };
}

/** The statuses of the missions of the parts prepared before (the customer's own missions only). */
async function missionStatuses(sb: any, userId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  try {
    const { data } = await sb.from(MISSION_TABLE).select(`id,user_id,status,${ADDON_MARKER_COLUMN}`).in("id", ids);
    for (const row of Array.isArray(data) ? data : []) if (row?.user_id === userId && !hasAddonMarker(row)) out.set(String(row.id), String(row.status));
  } catch { /* unknown: treated as not live */ }
  return out;
}

const AR_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
const arNum = (n: number) => String(n).replace(/\d/g, (d) => AR_DIGITS[Number(d)]);

/**
 * ONE TURN OF A MULTI-PART REQUEST. Every part is judged; each part that can be prepared becomes (or stays) its own mission with its own card; a part prepared before and unchanged keeps its mission (never planned twice); a part the customer
 * removed or changed is withdrawn only while it waits for them (queued, a question, a plan not approved: nothing is held then); an approved part is never touched. Parts that cannot be prepared are said, with why and the alternative, and
 * stay in the brief. Nothing is priced, held, approved or charged here: each card does that, by the existing code, for its own part.
 */
async function groupTurn(input: AgentChatTurnInput, decision: Decision, open: OpenRequest | null, brief: ResearchBrief, parts: ResearchPart[], ctx: BriefTurnContext): Promise<AgentChatTurnResult | null> {
  const { sb } = input;
  const registry = ctx.registry!;
  const judged = parts.slice(0, RESEARCH_GROUP_MAX_PARTS).map((p) => judgePart(p, ctx, registry));
  const overflow = parts.slice(RESEARCH_GROUP_MAX_PARTS);
  // a private component is refused like a typed one when it is the WHOLE request; a private part among public ones is refused alone (the public parts go on)
  if (judged.length > 0 && judged.every((j) => j.outcome === "refused_private")) {
    ctx.outcome = "group_privacy";
    const contentAr = judged.find((j) => j.noteAr)?.noteAr ?? PRIVACY_REFUSAL_AR;
    await writeAnswer(input, contentAr);
    return { ok: false, contentAr, status: 200 };
  }
  const prior = ctx.priorGroup ?? null;
  const priorParts = prior?.parts.filter((p) => p.missionId) ?? [];
  const statuses = await missionStatuses(sb, input.userId, priorParts.map((p) => p.missionId!));
  // the same request read by the trusted parser only when it reads a topic in both (two parts with no topic the parser can read are compared by their words)
  const sameByParser = (x: string, y: string) => { const a = buildRequestContract(x); const b = buildRequestContract(y); return a.topic !== null && b.topic !== null && a.topic.trim() !== "" && sameContract(a, b); };
  const kept = new Map<string, StoredGroupPart>();
  for (const j of judged) {
    if (j.outcome !== "planned" || !j.partBrief) continue;
    const match = priorParts.find((p) => !Array.from(kept.values()).includes(p) && LIVE_STATUSES.has(statuses.get(p.missionId!) ?? "") && samePartRequest(p.request, j.partBrief!.request, sameByParser));
    if (match) kept.set(j.part.key, match);
  }
  const toCreate = judged.filter((j) => j.outcome === "planned" && j.partBrief && !kept.has(j.part.key));
  const keptIds = new Set(Array.from(kept.values()).map((p) => p.missionId));
  const dropped = priorParts.filter((p) => !keptIds.has(p.missionId) && LIVE_STATUSES.has(statuses.get(p.missionId!) ?? ""));
  // nothing changed: the parts are already prepared (an answer to an open card goes to that card, as today)
  if (prior && toCreate.length === 0 && dropped.length === 0 && judged.every((j) => j.outcome === "planned")) {
    if (decision.type === "edit_of_open_request" && open) { ctx.outcome = "group_unchanged_open"; return null; }
    ctx.outcome = "group_unchanged";
    await writeAnswer(input, GROUP_UNCHANGED_AR);
    return { ok: false, contentAr: GROUP_UNCHANGED_AR, status: 200 };
  }
  // withdraw what the customer removed or changed, only while it waits for them (compare-and-set: a part the worker or an approval took meanwhile is left as it is)
  const leftRunning: string[] = [];
  for (const p of dropped) {
    try {
      const upd = await sb.from(MISSION_TABLE).update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", p.missionId).eq("user_id", input.userId).in("status", WITHDRAWABLE).select("id");
      if (!(Array.isArray(upd?.data) && upd.data.length === 1)) leftRunning.push(p.request ?? "");
    } catch { leftRunning.push(p.request ?? ""); }
  }
  // a single unapproved card of the old path above is replaced, as a new request always replaces it
  if (!prior) {
    const previous = await latestMissionOfConversation(sb, input.conversationId);
    if (previous && (await isResearchMission(sb, previous))) {
      try { await sb.from(MISSION_TABLE).update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", previous).eq("user_id", input.userId).in("status", REPLACEABLE); } catch { /* the limit still protects */ }
    }
  }
  // create the new parts' missions, in order (the open-missions limit is the existing one: a part it refuses waits, said)
  const created: Array<{ j: JudgedPart; id: string }> = [];
  const waiting: Array<{ j: JudgedPart; why: string }> = [];
  for (const j of toCreate) {
    const r = await createCustomerMission(sb, { userId: input.userId, text: j.partBrief!.request });
    if (r.ok) created.push({ j, id: r.id });
    else waiting.push({ j, why: r.error });
  }
  const groupId = `grp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const outcomeOf = (j: JudgedPart): StoredGroupPart => {
    const c = created.find((x) => x.j === j);
    const k = kept.get(j.part.key);
    const w = waiting.find((x) => x.j === j);
    return { key: j.part.key, request: j.partBrief?.request ?? j.part.request, missionId: c ? c.id : k ? k.missionId : null, outcome: w ? "waiting" : j.outcome };
  };
  const group: StoredResearchGroup = { v: RESEARCH_GROUP_VERSION, id: groupId, brief: { ...brief, status: created.length + kept.size > 0 ? "ready" : "needs_clarification" }, parts: judged.map(outcomeOf) };

  // the customer's summary: every part with what happens to it (none is silently dropped)
  const lines: string[] = [];
  const total = judged.length + overflow.length;
  lines.push(total > 1 ? `فهمت إن طلبك فيه ${arNum(total)} أجزاء:` : "حدّثنا طلبك:");
  judged.forEach((j, i) => {
    const st = outcomeOf(j);
    const n = `${arNum(i + 1)}) ${j.label}${j.partBrief ? ` «${j.partBrief.request}»` : ""}`;
    if (st.outcome === "planned") lines.push(`${n}: ${kept.has(j.part.key) ? "خطته جاهزة أو بتتجهز في بطاقته أعلاه ومش هتتغير." : "بنجهّز خطته وسعره في بطاقته."}${j.noteAr ? ` ${j.noteAr}` : ""}`);
    else if (st.outcome === "waiting") lines.push(`${n}: مستني؛ ${waiting.find((x) => x.j === j)!.why} وهيتجهّز أول ما تكتب «كمّل» من غير ما تعيد طلبك.`);
    else if (st.outcome === "refused_private") lines.push(`${n}: مش هنجمعه لأنه بيانات خاصة لأفراد.`);
    else if (st.outcome === "needs_clarification") lines.push(`${n}: محتاج توضيح بسيط قبل ما نجهّزه.${j.noteAr ? ` ${j.noteAr}` : ""}`);
    else lines.push(`${n}: ${j.noteAr ?? "مش متاح حاليًا."}`);
  });
  overflow.forEach((p, i) => lines.push(`${arNum(judged.length + i + 1)}) ${partLabelAr(p)}: هيتجهّز بعد الأجزاء اللي فوق؛ اكتب «كمّل».`));
  if (leftRunning.length > 0) lines.push(PREVIOUS_STILL_PLANNING_AR);
  if (created.length + kept.size > 0) lines.push(GROUP_APPROVAL_AR);
  const summary = lines.join("\n");

  const firstPlan = (id: string, j: JudgedPart) => ({ agentMissionId: id, researchBrief: j.partBrief!, researchGroup: group });
  ctx.outcome = `group_${created.length}_created_${kept.size}_kept_${judged.length - created.length - kept.size}_other`;
  if (created.length === 0) {
    await writeAnswer(input, summary, { researchGroup: group });
    return { ok: false, contentAr: summary, status: 200 };
  }
  // the first new part's card goes on this answer; every other new part gets its own assistant message (its own card), written by the server only
  const [first, ...rest] = created;
  const extraMissions: Array<{ id: string; messageId: string; contentAr: string }> = [];
  const now = Date.now();
  const writes: Array<Promise<unknown>> = [
    sb.from("messages").update({ content_ar: summary, plan: firstPlan(first.id, first.j) }).eq("id", input.assistantMsgId),
    sb.from("messages").update({ request_status: "planning" }).eq("id", input.userMsgId),
  ];
  rest.forEach((c, i) => {
    const messageId = randomUUID();
    const contentAr = `الجزء ${arNum(judged.indexOf(c.j) + 1)}: ${c.j.label} «${c.j.partBrief!.request}». ${AGENT_TURN_CONTENT_AR}`;
    extraMissions.push({ id: c.id, messageId, contentAr });
    writes.push(sb.from("messages").insert({ id: messageId, conversation_id: input.conversationId, user_id: input.userId, role: "assistant", content_ar: contentAr, plan: firstPlan(c.id, c.j), created_at: new Date(now + i + 1).toISOString() }));
  });
  try { await Promise.all(writes); } catch (e) { console.warn(`[chat:agent_group_persist_failed] ${String((e as Error)?.message ?? "").slice(0, 80)}`); }
  return { ok: true, missionId: first.id, contentAr: summary, ...(extraMissions.length > 0 ? { extraMissions } : {}) };
}

/**
 * A FOLLOW-UP ON THE OPEN REQUEST in brief mode. The brief holds the WHOLE updated request; the trusted contract of it is compared with the open request's:
 *   - the same request: today's path (a count the customer wrote edits the plan already priced; otherwise the card's editor);
 *   - only the count differs, and the customer wrote it: today's plan edit, priced again by code (no new planning);
 *   - anything else changed (an addition, a correction of the platform, the period, the topic...): the unapproved plan is replaced by a new mission of the whole updated request, planned and priced again; nothing was held, nothing is charged.
 * A question card is answered as today unless the answer changes the platform (or gives the one the request lacked): then the request is restated whole. A request still being planned is withdrawn only while it is still queued (a compare-and-set);
 * once the worker has it, the new request is started next to it and the customer is told plainly that the earlier plan runs only if they approve it.
 */
async function briefEditOfOpen(input: AgentChatTurnInput, decision: Decision, open: OpenRequest, brief: ResearchBrief, contract: ReturnType<typeof buildRequestContract>, ctx: BriefTurnContext): Promise<AgentChatTurnResult | null> {
  const openContract = buildRequestContract(open.requestText ?? "", undefined, { semantic: ctx.semantic });
  const ready = { ...brief, status: "ready" as const };
  if (open.state === "plan_ready") {
    if (sameContract(contract, openContract) || (decision.count !== null && differsOnlyByCount(contract, openContract))) { ctx.outcome = "edit_same_path"; return null; }
    const gated = await capabilityGate(input, brief, ctx);
    if (gated) return gated;
    ctx.outcome = "edit_replaced";
    return startMission(input, brief.request, { brief: ready, contentAr: REQUEST_UPDATED_AR });
  }
  if (open.state === "needs_input") {
    const platformChange = contract.platform !== null && contract.platform !== openContract.platform;
    if (!platformChange) { ctx.outcome = "answer_same_path"; return null; }
    const gated = await capabilityGate(input, brief, ctx);
    if (gated) return gated;
    ctx.outcome = "answer_replaced";
    return startMission(input, brief.request, { brief: ready, contentAr: REQUEST_UPDATED_AR });
  }
  // planning
  if (sameContract(contract, openContract)) { ctx.outcome = "planning_same"; return null; }
  const gated = await capabilityGate(input, brief, ctx);
  if (gated) return gated;
  let withdrawn = false;
  try {
    const upd = await input.sb.from(MISSION_TABLE).update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", open.id).eq("user_id", input.userId).eq("status", "queued").select("id");
    withdrawn = !upd?.error && Array.isArray(upd?.data) && upd.data.length === 1;
  } catch { withdrawn = false; }
  ctx.outcome = withdrawn ? "planning_withdrawn_replaced" : "planning_parallel_replaced";
  return startMission(input, brief.request, { brief: ready, contentAr: withdrawn ? REQUEST_UPDATED_AR : PREVIOUS_STILL_PLANNING_AR });
}
