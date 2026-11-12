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
import { briefNumbersAr, contractIsComplete, differsOnlyByCount, parseBrief, sameContract, storedBriefOf, validateBrief, withPartCounts, type ResearchBrief } from "./researchBrief";
import { conditionChanged, conditionDriftOf, droppedRequirementsOf, groundedConditions, sameExecutedConditions, sameExecutedValues, unaccountedRequirements, inventedRequirementOf, type ConditionDrift, type ConditionKind, type ConditionPhrases, partBriefOf, partCardIdOf, partMissionIdOf, partsOf, PART_ID_ATTEMPTS, requirementLabelAr, RESEARCH_GROUP_MAX_PARTS, RESEARCH_GROUP_VERSION, samePartRequest, storedGroupOf, type IntentRequirement, type PartOutcome, type ResearchPart, type StoredGroupPart, type StoredResearchGroup } from "./researchGroup";
import { randomUUID } from "node:crypto";
import { normalizeDigits } from "../arabicDigits";
import { readSettingValue, scopedFlagOn } from "./scopedFlag";
import { buildCapabilityRegistry, chatCapabilityLines, discoverCapabilities, operationLabelAr, PLATFORM_AR, researchNeedOf, CAPABILITY_DISCOVERY_FLAG_KEY, type CapabilityDiscovery, type CapabilityRegistry } from "./capabilities";
import { loadTregCatalog } from "../treg/catalog";
import { blockedEndpointReason } from "../treg/blockList";
import { policyVerdict } from "../treg/dataPolicy";
import { PENDING_MAX_WAITING } from "../requests/expiry";

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
  | { ok: true; missionId: string; contentAr: string; conversationTitle?: string; /** MULTI-OBJECTIVE RESEARCH: the cards of the parts of the same request, each on its own STORED assistant message (only cards whose row is stored). */ extraMissions?: Array<{ id: string; messageId: string; contentAr: string }>; /** The assistant message itself is the summary of the parts and draws no card (every card is in `extraMissions`). */ summaryOnly?: true }
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
    // a request about to be read from the words alone, that names a platform no capability serves (Snapchat): said honestly with what can be collected, never a mission that can only end «unserved» (live evaluation 2026-11-12, O1)
    if (mode.enabled && mode.registry) {
      const d = discoverCapabilities(researchNeedOf({ request: input.message }), mode.registry);
      if (d.status === "unsupported" && d.need.unsupportedPlatform) {
        const contentAr = capabilityLimitReplyAr(d);
        if (contentAr.trim() !== "") {
          console.info(JSON.stringify({ tag: "chat_message_type", type: decision.type, source: decision.source, brief: "words_unsupported_platform" }));
          await writeAnswer(input, contentAr);
          return { ok: false, contentAr, status: 200 };
        }
      }
    }
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
        let group = storedGroupOf(plan, strictBrief);
        // a part's card carries its group as it was before the cards were written; the summary of the same turn carries the group with the true outcome of every card: it wins when it is there
        if (group && "agentMissionId" in plan) {
          const gid = group.id;
          const summary = (data as any[]).find((r) => r?.plan && !("agentMissionId" in r.plan) && r.plan.researchGroup?.id === gid);
          group = (summary && storedGroupOf(summary.plan, strictBrief)) || group;
        }
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
    // a conversation in progress (a brief or a request being prepared) whose message could not be read: never a new mission from a fragment of words («٥٠٠ تعليق والردود كمان», «كمّل»; live evaluation 2026-11-12, E1 and J1);
    // the customer sends it again. An answer to a question card still goes to that card (today's path)
    const nonRequest = decision.type === "greeting_or_small_talk" || decision.type === "service_question" || decision.type === "methodology_request";
    if (!pending && ctx.registry && (ctx.prior !== null || ctx.priorGroup || (open && open.state !== "needs_input")) && !nonRequest) {
      ctx.outcome = "model_unreadable_in_conversation";
      await writeAnswer(input, MODEL_RETRY_AR);
      return { ok: false, contentAr: MODEL_RETRY_AR, status: 200 };
    }
    if (!pending || nonRequest) { ctx.outcome = "model_unavailable"; return null; }
    const joined = `${ctx.prior!.request}، ${input.message}`;
    const privacy = privacyRefusalAr(joined) ?? (contactAskVerdict(joined) === "clarify" ? contactClarifyAr(joined) : null);
    if (privacy) { ctx.outcome = "privacy"; await writeAnswer(input, privacy); return { ok: false, contentAr: privacy, status: 200 }; }
    ctx.outcome = "fallback_joined";
    return startMission(input, joined);
  }
  if (decision.type !== "data_request" && decision.type !== "edit_of_open_request") { ctx.outcome = "not_a_request"; return null; }
  const parsed = decision.brief;
  /**
   * NO MISSION FROM WORDS THAT NAME NO DATA (live evaluation 2026-11-12: «محتاج داتا عن سوق العقارات», «عايز داتا», «اعملي تحليل إحصائي…» became missions when the model's brief was empty, rejected or absent): a NEW request whose brief cannot be used
   * and whose own words name no kind of data the system collects is asked (the model's question when it wrote one, else the code's), never planned from the words. Words that do name a kind (a platform, companies, places, news...)
   * keep today's path.
   */
  const askInsteadOfWords = async (reason: string): Promise<AgentChatTurnResult | null> => {
    if (!ctx.registry || open !== null || decision.type === "edit_of_open_request") return null;
    const words = researchNeedOf({ request: currentMessageOf(ctx) });
    // the words name a kind of data: today's path, unless the MODEL itself said something decisive is missing (live evaluation round 2, D2: «معلومات عن منافسين شركتي»)
    // (and words that give no TOPIC, «تيك توك» alone: live evaluation round 3, S1)
    if (words.privacy === "blocked" || (words.kind !== "unknown" && decision.briefRawStatus !== "needs_clarification" && customerGaveTopic(ctx.customerTurns))) return null;
    // the model's own question, unless the model did not read a request at all (its type was overruled by the keyword rule: its reply answers something else, possibly a refusal)
    const question = (!decision.overruled && decision.reply) || (customerGaveTopic(ctx.customerTurns) ? missingQuestionAr(buildRequestContract(currentMessageOf(ctx))) : TOPIC_QUESTION_AR);
    ctx.outcome = reason;
    await writeAnswer(input, question, ctx.prior ? { researchBrief: { ...ctx.prior, status: "needs_clarification" } } : undefined);
    return { ok: false, contentAr: question, status: 200 };
  };
  // a follow-up with no brief on a request whose parts are already prepared («كمّل», «تمام»): nothing changes, and the customer is told so (live evaluation round 4, J1)
  if (!parsed && ctx.priorGroup && ctx.priorGroup.parts.some((p) => p.missionId)) { ctx.outcome = "group_unchanged_no_brief"; await writeAnswer(input, GROUP_UNCHANGED_AR); return { ok: false, contentAr: GROUP_UNCHANGED_AR, status: 200 }; }
  if (!parsed) { ctx.outcome = "none"; return askInsteadOfWords("none"); }
  // MULTI-OBJECTIVE RESEARCH: a reading of SEVERAL parts that cannot be used as written is never replaced by one mission read from the words (it would silently keep one part and drop the others): the customer continues with one word
  const multiPartUnsafe = async (reason: string): Promise<AgentChatTurnResult> => {
    ctx.outcome = `multi_part_unsafe_${reason}`;
    await writeAnswer(input, MULTI_PART_RETRY_AR, ctx.prior ? keptBriefPlan(ctx, ctx.prior) : undefined);
    return { ok: false, contentAr: MULTI_PART_RETRY_AR, status: 200 };
  };
  const multiPart = ctx.registry !== undefined && (decision.briefParts ?? 0) >= 2;
  // words that name no data are asked first (a model that invented parts the customer never named, M5); only then is a multi-part reading that cannot be used kept from being reduced to the words
  if (!parsed.ok) { ctx.outcome = `schema_${parsed.issue}`; const asked = await askInsteadOfWords(`schema_${parsed.issue}`); if (asked) return asked; if (multiPart) return multiPartUnsafe(`schema_${parsed.issue}`); return null; }
  const v = validateBrief(withPartCounts(parsed.brief), { customerTurns: ctx.customerTurns, assistantQuestion: ctx.assistantQuestion, prior: ctx.prior, semantic: ctx.semantic });
  if (!v.ok) {
    ctx.outcome = `rejected_${v.reason}`;
    // a private component is never planned: the same fixed answer as a typed one
    if (v.contentAr) { await writeAnswer(input, v.contentAr); return { ok: false, contentAr: v.contentAr, status: 200 }; }
    const asked = await askInsteadOfWords(`rejected_${v.reason}`);
    if (asked) return asked;
    if (multiPart) return multiPartUnsafe(v.reason);
    return null;
  }
  // the condition fields the model filled in by itself (a country inferred from a city, a language never said) are cleared before the brief is stored or shown to the model again; the sentences are checked below
  const customerTexts = [...ctx.customerTurns, ctx.prior?.request ?? ""].filter((t) => t.trim() !== "");
  const groundNow = Date.now();
  const brief: ResearchBrief = {
    ...groundedConditions(v.brief, customerTexts, groundNow),
    ...(v.brief.objectives ? { objectives: v.brief.objectives.map((o) => (o.parent === null ? groundedConditions(o, customerTexts, groundNow) : o)) } : {}),
  };
  // MULTI-OBJECTIVE RESEARCH: several first objectives, or a follow-up on the parts prepared before: every part keeps its own existing plan (docs/MULTI-OBJECTIVE-RESEARCH.md)
  const parts = brief.objectives ? partsOf(brief) : [];
  if (ctx.registry && (parts.length >= 2 || (ctx.priorGroup && parts.length >= 1))) {
    // the model still asks something it needs (a genuinely missing requirement): its question, with the whole brief kept
    if (brief.status === "needs_clarification" && decision.reply !== null) {
      ctx.outcome = "group_clarify";
      await writeAnswer(input, decision.reply, keptBriefPlan(ctx, brief));
      return { ok: false, contentAr: decision.reply, status: 200 };
    }
    return groupTurn(input, decision, open, { ...brief, status: "ready" }, parts, ctx);
  }
  // EXACT REQUIREMENTS of the single request: the consolidated sentence must execute the customer's own period, place and language (the same reader the worker executes with); otherwise the customer is asked, never run on another value
  const drift = conditionDriftOf({ partRequest: brief.request, own: { period: brief.period, country: brief.country, language: brief.language }, global: {}, elsewhere: new Set(), customerTexts: [...ctx.customerTurns, ctx.prior?.request ?? ""].filter((t) => t.trim() !== ""), nowMs: Date.now() });
  if (drift) {
    ctx.outcome = `drift_${drift.kind}`;
    const contentAr = conditionDriftAr(drift).replace("الجزء ده", "طلبك");
    await writeAnswer(input, contentAr, { researchBrief: { ...brief, status: "needs_clarification" } });
    return { ok: false, contentAr, status: 200 };
  }
  if (decision.type === "edit_of_open_request" && open) return briefEditOfOpen(input, decision, open, brief, v.contract, ctx);
  // a new research request (or the next step of the discovery): a question while something that matters is missing, else a mission from the WHOLE request
  // a request whose first objective is web, companies, places or people research is complete without a platform (the social contract's completeness says nothing about it): the model's own question is still asked, but the code
  // never asks a platform for it (live evaluation round 5, W1: «مقالات عن الذكاء الاصطناعي في التعليم» was asked «من أنهي منصة؟»)
  // (only when the CUSTOMER's own words name that kind of data, «مقالات»: a model that guessed web research for «what people say» still asks, A1)
  const wordsKind = researchNeedOf({ request: ctx.customerTurns.join(" ") }).kind;
  const nonSocialComplete = wordsKind !== "unknown" && wordsKind !== "social" && (brief.objectives ?? []).some((o) => o.parent === null && o.operation !== "unsupported" && !o.operation.startsWith("social.")) && customerGaveTopic(ctx.customerTurns);
  if (brief.status === "needs_clarification" && !contractIsComplete(v.contract) && !(nonSocialComplete && decision.reply === null)) {
    // the model asked nothing (or its question was blocked by the guard): the code asks what is missing, never a mission read from the words (live evaluation 2026-11-12, A1)
    const question = decision.reply ?? missingQuestionAr(v.contract);
    ctx.outcome = decision.reply === null ? "clarify_code_question" : "clarify";
    await writeAnswer(input, question, { researchBrief: brief });
    return { ok: false, contentAr: question, status: 200 };
  }
  // a request with NO TOPIC the customer gave (only a platform, «تيك توك»): the model may fill one in («عن الموضوع المطلوب»); it is asked, never planned (live evaluation 2026-11-12, S1)
  if (isNewRequest(ctx, open) && !brief.topic && !customerGaveTopic(ctx.customerTurns)) {
    ctx.outcome = "clarify_topic";
    await writeAnswer(input, TOPIC_QUESTION_AR, { researchBrief: { ...brief, status: "needs_clarification" } });
    return { ok: false, contentAr: TOPIC_QUESTION_AR, status: 200 };
  }
  // A NEW REQUEST'S OWN REQUIREMENTS: every number, period, place, language, field and «the replies» the customer wrote in this message must be in the sentence that will be planned; one the model left out is asked, never dropped
  const lostNow = isNewRequest(ctx, open) ? standaloneOnly(droppedRequirementsOf(currentMessageOf(ctx), [brief.request]), currentMessageOf(ctx)) : [];
  if (lostNow.length > 0) {
    ctx.outcome = "requirement_dropped";
    const contentAr = requirementMissingAr(lostNow);
    await writeAnswer(input, contentAr, { researchBrief: { ...brief, status: "needs_clarification" } });
    return { ok: false, contentAr, status: 200 };
  }
  const gated = await capabilityGate(input, brief, ctx);
  if (gated) return gated;
  // the SAME research conversation goes on while its request is still being prepared (queued or planning): the updated whole request replaces it as an update does (withdrawn while still queued, compare-and-set; once the worker
  // has it, said plainly), never a second live card of an older scope next to it, whatever type the model gave the message
  if (open && open.state === "planning" && ctx.prior !== null && decision.type === "data_request") {
    const asUpdate = await briefEditOfOpen(input, { ...decision, type: "edit_of_open_request" }, open, brief, v.contract, ctx);
    if (asUpdate) return asUpdate;
    ctx.outcome = "planning_same_request";
    await writeAnswer(input, PLAN_NOT_READY_AR);
    return { ok: false, contentAr: PLAN_NOT_READY_AR, status: 200 };
  }
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
/** The statuses of a part that EXISTS for the customer (waiting for them, running, or finished with its result: the statuses the worker writes). A finished part is never prepared again by a later turn; a failed, cancelled or expired one is. */
const LIVE_STATUSES = new Set(["queued", "planning", "needs_input", "plan_ready", "approved", "executing", "completed", "unserved"]);
const FINISHED_STATUSES = new Set(["completed", "unserved"]);
const WITHDRAWABLE = ["queued", "needs_input", "plan_ready"];
/** Said when the model's reading of a long request was cut before it ended: nothing is lost, the customer only says «كمّل». */
export const TRUNCATED_AR = "وصلني طلبك بكل أجزائه، لكن تلخيصه طلع أطول من المسموح في رد واحد. اكتب «كمّل» وأنا أكمّل تجهيز كل الأجزاء من غير ما تعيد كتابة طلبك؛ ولن يُخصم شيء قبل اعتمادك.";
/** Said when the model's reading of a request of SEVERAL parts could not be used as written: nothing is prepared from part of it (never one part kept and the others dropped); the customer continues with one word. */
export const MULTI_PART_RETRY_AR = "فهمت إن طلبك فيه أكتر من جزء، ومش هجهّز جزء منه وأسيب الباقي. اكتب «كمّل» وأنا أرتّب كل الأجزاء من غير ما تعيد كتابة طلبك، ولو حابب وضّح كل جزء في سطر لوحده؛ ولن يُخصم شيء قبل اعتمادك.";
/** Said when the model's answer to a message of a conversation in progress could not be read (twice): nothing is prepared from a fragment of the conversation. */
export const MODEL_RETRY_AR = "ما قدرتش أقرا رسالتك دي صح بسبب خلل مؤقت. ابعتها تاني من فضلك؛ طلبك اللي فات محفوظ زي ما هو، ومفيش حاجة اتجهّزت جديدة ولا اتخصم حاجة.";
/** Asked when a request names no topic. */
export const TOPIC_QUESTION_AR = "تمام. عايز نجمع عن أنهي موضوع بالظبط؟ اكتبلي الموضوع أو الكلمات اللي تحب ندوّر بيها.";
/** Asked by code when a request lacks what decides the plan and the model wrote no question (or its question was blocked). */
export function missingQuestionAr(contract: ReturnType<typeof buildRequestContract>): string {
  if (contract.platform === null) return "عشان أجهّز طلبك صح: تحب نجمع كلام الناس من أنهي منصة (تيك توك، إكس، إنستجرام، فيسبوك، يوتيوب)؟ ولا تقصد أخبار ومقالات، أو شركات، أو أماكن وتقييماتها؟";
  return "عشان أجهّز طلبك صح: وضّحلي أكتر، عايز نجمع إيه بالظبط وعن مين أو عن أنهي موضوع (وفي أنهي بلد لو يفرق معاك)؟";
}
/** Asked when the sentence to be planned leaves out something the customer wrote in this message. */
export function requirementMissingAr(lost: IntentRequirement[]): string {
  return `فهمت طلبك، بس ${[...new Set(lost.map(requirementLabelAr))].map((x) => `«${x}»`).join(" و")} اللي كتبته مش ظاهر في الطلب اللي هجهّزه. أضيفه زي ما كتبته؟ ومش هنجهّز ولا هنخصم حاجة قبل ما توضّح وتعتمد.`;
}
/** A new research request: no brief, no group and no open request of this conversation before it (its first message is the whole of what the customer asked). */
/** Words that only say WHERE or WHAT KIND (platforms, collecting verbs, data nouns, fillers): a message made of nothing else gives no topic. */
const NO_TOPIC_WORDS = new Set("عايز عاوز محتاج هات هاتلي جيب جيبلي اجمع اجمعلي ابغي اريد ممكن لو سمحت من فضلك داتا بيانات معلومات تعليقات تعليق كومنتات كومنت منشورات منشور بوستات بوست فيديوهات فيديو تغريدات تغريده ريلز ستوري ستوريز ردود من على عن في علي و تيك توك تيكتوك tiktok انستجرام انستغرام انستا instagram فيسبوك فيس بوك الفيس facebook يوتيوب youtube اكس تويتر twitter x بس كمان برضه بقي يا".split(" "));
function customerGaveTopic(turns: ReadonlyArray<string>): boolean {
  const words = turns.join(" ").replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.some((w) => w.length >= 2 && !NO_TOPIC_WORDS.has(w) && !NO_TOPIC_WORDS.has(w.replace(/^ال/, "")));
}
const isNewRequest = (ctx: BriefTurnContext, open: OpenRequest | null): boolean => ctx.prior === null && !ctx.priorGroup && open === null;
const currentMessageOf = (ctx: BriefTurnContext): string => ctx.customerTurns[ctx.customerTurns.length - 1] ?? "";
/** A number the customer wrote as a NUMBER (standing alone), not a digit inside a word: Arabizi writes letters with digits («3ayez», «7aga»), and a model or product name carries digits that are part of the name only when glued to it. */
function standaloneOnly(lost: IntentRequirement[], message: string): IntentRequirement[] {
  const t = normalizeDigits(message);
  const alone = new Set<number>([...t.matchAll(/(?<![\p{L}\d])(\d+)(?![\p{L}\d])/gu)].map((m) => Number(m[1])));
  return lost.filter((r) => r.kind !== "number" || alone.has(r.n));
}
/** Said when the request's parts are already prepared and nothing changed (a «تمام جهّزهم» or a repetition): nothing new is created. */
export const GROUP_UNCHANGED_AR = "أجزاء طلبك متجهّزة بالفعل، وكل جزء له بطاقته بخطته وسعره. اعتمد الجزء اللي يناسبك من بطاقته، ولن يُخصم شيء قبل اعتمادك.";
/** Said for a part whose card could not be stored: it is not prepared, not claimed, and comes back on the next turn. */
export const CARD_UNSAVED_AR = "ما قدرناش نحفظ بطاقته دلوقتي بسبب مشكلة مؤقتة، فمش هيتجهّز منه حاجة ولا يتخصم عليه حاجة؛ اكتب «كمّل» ونجهّزه من غير ما تعيد طلبك.";
/** Said when nothing of the turn could be stored. */
export const GROUP_NOT_SAVED_AR = "ما قدرناش نحفظ تجهيز أجزاء طلبك دلوقتي بسبب مشكلة مؤقتة، ومفيش حاجة اتجهّزت ولا اتخصم حاجة. اكتب «كمّل» وهنكمّل من غير ما تعيد طلبك.";
/** Said for a part that would push the customer's waiting requests beyond the five kept (the oldest would expire). */
export const WAITING_ROOM_AR = `عندك ${String(PENDING_MAX_WAITING).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)])} طلبات مستنية اعتمادك أو ردّك، وده أقصى عدد يفضل مستني في نفس الوقت؛ اعتمد أو الغي واحد منهم،`;
/** Said for a part beyond the most parts prepared in one message. */
export const PART_LATER_AR = "اتجهّز أقصى عدد من الأجزاء في رسالة واحدة،";
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
function judgePart(part: ResearchPart, ctx: BriefTurnContext, registry: CapabilityRegistry, global: ConditionPhrases = {}): JudgedPart {
  const label = partLabelAr(part);
  const base = { part, partBrief: null, label, discovery: null };
  if (part.unresolved) {
    const d = discoverCapabilities(researchNeedOf({ request: part.request ?? "", brief: { platforms: [], content: [], count: null, objectives: part.objectives } }), registry);
    return { ...base, outcome: "unsupported", noteAr: [d.messageAr, d.alternativeAr].filter(Boolean).join(" ") || null };
  }
  const pb = partBriefOf(part, global);
  if (!pb) return { ...base, outcome: "needs_clarification", noteAr: null };
  const v = validateBrief(pb, { customerTurns: ctx.customerTurns, assistantQuestion: ctx.assistantQuestion, prior: ctx.prior, semantic: ctx.semantic });
  if (!v.ok) return { ...base, outcome: v.reason === "privacy_refusal" || v.reason === "privacy_clarify" ? "refused_private" : "needs_clarification", noteAr: v.contentAr ?? (v.reason === "count_mismatch" && pb.count !== null ? conditionDriftAr({ kind: "count", reason: "contradicts", phrase: String(pb.count) }) : null) };
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
  // EVERY part is judged and stored, whatever their number (at most OBJECTIVES_MAX): a part not prepared in this turn waits, said, and is prepared on a later one; none is ever left out of the stored group
  // a whole-request condition the model ALSO wrote as one part's own condition is that part's, not every part's (live evaluation 2026-11-12, J1: «مصر» of the news part written on the brief too made the TikTok part a question)
  const sameWords = (x: string | null | undefined, y: string | null | undefined) => !!x && !!y && x.replace(/\s+/g, " ").trim() === y.replace(/\s+/g, " ").trim();
  const ownOfSome = (k: "period" | "country" | "language") => parts.length >= 2 && parts.some((p) => sameWords(p.objectives[0]?.[k], brief[k]));
  const global: ConditionPhrases = { period: ownOfSome("period") ? null : brief.period, country: ownOfSome("country") ? null : brief.country, language: ownOfSome("language") ? null : brief.language };
  const judged = parts.map((p) => judgePart(p, ctx, registry, global));
  // a private component is refused like a typed one when it is the WHOLE request; a private part among public ones is refused alone (the public parts go on)
  if (judged.length > 0 && judged.every((j) => j.outcome === "refused_private")) {
    ctx.outcome = "group_privacy";
    const contentAr = judged.find((j) => j.noteAr)?.noteAr ?? PRIVACY_REFUSAL_AR;
    await writeAnswer(input, contentAr);
    return { ok: false, contentAr, status: 200 };
  }
  // THE CUSTOMER'S INTENT ACROSS THE SPLIT: a requirement of the whole request that no part carries is asked (which part it belongs to), never dropped; a requirement a part states that the customer never wrote makes that part a question
  const partTexts = judged.map((j) => j.partBrief?.request ?? j.part.request ?? j.part.objectives.map((o) => o.what ?? "").join(" ").trim());
  const ground = [...ctx.customerTurns, ctx.prior?.request ?? ""];
  for (const j of judged) {
    if (j.outcome !== "planned" || !j.partBrief) continue;
    const invented = inventedRequirementOf(j.partBrief.request, ground);
    if (invented) { j.outcome = "needs_clarification"; j.noteAr = intentInventedAr(invented); }
  }
  // EXACT REQUIREMENTS: the values each part's sentence would execute are the customer's (the same reader the worker executes with); a part that would run another period, place, language or number, lose a condition of the whole
  // request or of its own, carry one the customer gave another part, or collect comments without the replies its sentence asks is asked, never created
  const customerTexts = [...ground, ...(ctx.priorGroup?.parts.map((p) => p.request ?? "") ?? [])].filter((t) => t.trim() !== "");
  const nowMs = Date.now();
  const kindsOf = (o: ConditionPhrases): ConditionKind[] => [...(o.period ? ["period" as const] : []), ...(o.country ? ["place" as const] : []), ...(o.language ? ["language" as const] : [])];
  const globalKinds = new Set(kindsOf(global));
  for (const j of judged) {
    if (j.outcome !== "planned" || !j.partBrief) continue;
    const root = j.part.objectives[0];
    const ownKinds = new Set(kindsOf(root));
    const elsewhere = new Set<ConditionKind>(judged.filter((x) => x !== j).flatMap((x) => kindsOf(x.part.objectives[0])).filter((k) => !ownKinds.has(k) && !globalKinds.has(k)));
    const social = j.part.objectives.find((x) => x.platform);
    const repliesWithoutObjective = buildRequestContract(j.partBrief.request).replies !== "none" && social?.platform !== "x" && !j.part.objectives.some((x) => x.operation === "social.replies");
    const drift = conditionDriftOf({ partRequest: j.partBrief.request, own: root, global, elsewhere, customerTexts, nowMs, repliesWithoutObjective });
    if (drift) { j.outcome = "needs_clarification"; j.noteAr = conditionDriftAr(drift); }
  }
  if (partTexts.every((t) => t !== "")) {
    // a part asked about its own conditions still accounts for them (the question names them; nothing of it is created meanwhile)
    const covering = judged.map((j, i) => (j.outcome === "needs_clarification" ? [partTexts[i], j.part.objectives[0].period, j.part.objectives[0].country, j.part.objectives[0].language, j.part.objectives[0].count ? String(j.part.objectives[0].count) : null].filter(Boolean).join(" ") : partTexts[i]));
    // what the model's whole request states, AND (for a new request) what the customer's own message states: neither may be dropped by the split
    const fromCustomer = isNewRequest(ctx, open) ? standaloneOnly(droppedRequirementsOf(currentMessageOf(ctx), covering), currentMessageOf(ctx)) : [];
    const fromModel = droppedRequirementsOf(brief.request, covering);
    const both = [...fromModel, ...fromCustomer.filter((r) => !fromModel.some((m) => JSON.stringify(m) === JSON.stringify(r)))];
    const lost = unaccountedRequirements(both, judged.filter((j) => j.outcome === "needs_clarification").map((j) => j.partBrief?.request ?? j.part.request ?? ""));
    if (lost.length > 0) {
      // nothing is prepared until the customer says where it belongs (a part that also states something they never wrote is asked in the same answer)
      ctx.outcome = "group_intent_dropped";
      const contentAr = [intentDroppedAr(lost), ...judged.filter((j) => j.outcome === "needs_clarification" && j.partBrief && j.noteAr).map((j) => `«${j.partBrief!.request}»: ${j.noteAr}`)].join("\n");
      await writeAnswer(input, contentAr, keptBriefPlan(ctx, brief));
      return { ok: false, contentAr, status: 200 };
    }
  }
  const prior = ctx.priorGroup ?? null;
  // a request that grows into several parts while its single mission waits (the customer adds «وكمان تقييمات …»): that mission is the first part prepared before, matched like any part (kept when unchanged, withdrawn while it waits
  // when changed), never left live next to a second copy of itself (live evaluation 2026-11-12, K6)
  const openAsPart = !prior && open !== null && ctx.prior !== null && open.state !== "needs_input" && (await isResearchMission(sb, open.id));
  const priorParts = prior?.parts.filter((p) => p.missionId) ?? (openAsPart ? [{ key: "open", request: open!.requestText ?? null, missionId: open!.id, outcome: "planned" as PartOutcome }] : []);
  const [statuses, cards] = await Promise.all([missionStatuses(sb, input.userId, priorParts.map((p) => p.missionId!)), cardsOfConversation(sb, input.conversationId)]);
  // the same request read by the trusted parser only when it reads a topic in both (two parts with no topic the parser can read are compared by their words)
  // and only when both EXECUTE the same values (a corrected period, place, language or number is a changed part, never a kept one)
  const matchNow = Date.now();
  const sameByParser = (x: string, y: string) => { const a = buildRequestContract(x); const b = buildRequestContract(y); return a.topic !== null && b.topic !== null && a.topic.trim() !== "" && sameContract(a, b) && sameExecutedValues(x, y, matchNow); };
  const kept = new Map<string, StoredGroupPart>();
  for (const j of judged) {
    if (j.outcome !== "planned" || !j.partBrief) continue;
    const match = priorParts.find((p) => !Array.from(kept.values()).includes(p) && LIVE_STATUSES.has(statuses.get(p.missionId!) ?? "") && samePartRequest(p.request, j.partBrief!.request, sameByParser));
    if (match) kept.set(j.part.key, match);
  }
  const toCreate = judged.filter((j) => j.outcome === "planned" && j.partBrief && !kept.has(j.part.key));
  const keptIds = new Set(Array.from(kept.values()).map((p) => p.missionId));
  const dropped = priorParts.filter((p) => !keptIds.has(p.missionId) && LIVE_STATUSES.has(statuses.get(p.missionId!) ?? ""));
  // a kept part whose card was never saved (an earlier write failed): its card is written now, for the SAME mission (an unreadable conversation: assumed saved, so a card is never doubled)
  const keptWithoutCard = judged.filter((j) => kept.has(j.part.key) && cards !== null && !cards.has(kept.get(j.part.key)!.missionId!));
  // nothing changed: the parts are already prepared (an answer to an open card goes to that card, as today)
  if (prior && toCreate.length === 0 && dropped.length === 0 && keptWithoutCard.length === 0 && judged.every((j) => j.outcome === "planned")) {
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
  // a single unapproved card of the old path above is replaced, as a new request always replaces it (unless it was matched above as this request's own first part)
  if (!prior && !openAsPart) {
    const previous = await latestMissionOfConversation(sb, input.conversationId);
    if (previous && (await isResearchMission(sb, previous))) {
      try { await sb.from(MISSION_TABLE).update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", previous).eq("user_id", input.userId).in("status", REPLACEABLE); } catch { /* the limit still protects */ }
    }
  }
  // place the new parts, in order: each part's mission id is derived from the part, so a retried or concurrent turn meets the mission another turn created and adopts it (never a second one). The open-missions and hourly limits are
  // the existing ones: a part they refuse waits, said, and so does every later part of this turn (they would be refused too); at most RESEARCH_GROUP_MAX_PARTS new missions per turn
  // and the existing expiry keeps at most PENDING_MAX_WAITING requests waiting for the customer (it ends the OLDEST beyond them): a new part is created only while there is room, so preparing a later part never expires an earlier one;
  // without room a part may still adopt its own existing mission
  const placed = new Map<string, { id: string; own: boolean }>();
  const waiting = new Map<string, string>();
  let stop: string | null = null;
  let fresh = 0;
  let room = toCreate.length > 0 ? await waitingRoom(sb, input.userId) : null;
  for (const j of toCreate) {
    if (stop !== null) { waiting.set(j.part.key, stop); continue; }
    const mayCreate = fresh < RESEARCH_GROUP_MAX_PARTS && (room === null || room > 0);
    const r = await placePart(sb, input, j.partBrief!.request, mayCreate);
    if (r.ok) { placed.set(j.part.key, { id: r.id, own: r.created }); if (r.created) { fresh += 1; if (room !== null) room -= 1; } continue; }
    if (r.status === 0) { waiting.set(j.part.key, fresh >= RESEARCH_GROUP_MAX_PARTS ? PART_LATER_AR : WAITING_ROOM_AR); continue; }
    if (r.status === 422) { j.outcome = "refused_private"; continue; }
    waiting.set(j.part.key, r.error);
    if (r.status === 429) stop = r.error;
  }

  // THE CARDS: one stored assistant message per part, its id derived from its mission (a second write of the same card is refused by the primary key). Each write's own result is checked: a card is said saved only when its row
  // exists. A part whose card could not be saved is withdrawn when this turn created it (nothing is held before approval), and waits for the next turn, said; it is never claimed prepared.
  const groupId = `grp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const unsaved = new Set<string>();
  const withdrawnUnsaved = new Set<string>();
  const missionOf = (j: JudgedPart): string | null => placed.get(j.part.key)?.id ?? kept.get(j.part.key)?.missionId ?? null;
  const partOf = (j: JudgedPart): StoredGroupPart => {
    const k = j.part.key;
    const outcome: PartOutcome = waiting.has(k) || unsaved.has(k) ? "waiting" : j.outcome;
    // a part that waits for a limit has no mission; an unsaved part this turn withdrew keeps none either (the next turn places it again); one that could not be withdrawn, or that another turn created, keeps its mission, so
    // the next turn writes ITS card instead of creating another
    return { key: k, request: j.partBrief?.request ?? j.part.request, missionId: waiting.has(k) || withdrawnUnsaved.has(k) ? null : missionOf(j), outcome };
  };
  const groupNow = (): StoredResearchGroup => {
    const anyPrepared = judged.some((j) => partOf(j).outcome === "planned");
    return { v: RESEARCH_GROUP_VERSION, id: groupId, brief: { ...brief, status: anyPrepared ? "ready" : "needs_clarification" }, parts: judged.map(partOf) };
  };
  const toWrite = judged.filter((j) => placed.has(j.part.key) || keptWithoutCard.includes(j));
  const cardGroup = groupNow();
  const savedCards: Array<{ j: JudgedPart; id: string; messageId: string; contentAr: string }> = [];
  const now = Date.now();
  for (const [i, j] of toWrite.entries()) {
    const missionId = missionOf(j)!;
    const contentAr = `الجزء ${arNum(judged.indexOf(j) + 1)}: ${j.label} «${j.partBrief!.request}». ${AGENT_TURN_CONTENT_AR}`;
    const existing = cards?.get(missionId);
    if (existing) { savedCards.push({ j, id: missionId, messageId: existing.messageId, contentAr: existing.contentAr || contentAr }); continue; }
    const messageId = partCardIdOf(missionId);
    const saved = await saveCard(sb, input, { id: messageId, conversation_id: input.conversationId, user_id: input.userId, role: "assistant", content_ar: contentAr, plan: { agentMissionId: missionId, researchBrief: j.partBrief!, researchGroup: cardGroup }, created_at: new Date(now + i + 1).toISOString() });
    if (saved) { savedCards.push({ j, id: missionId, messageId, contentAr }); continue; }
    unsaved.add(j.part.key);
    console.warn(`[chat:agent_group_card_unsaved] ${missionId}`);
    if (placed.get(j.part.key)?.own && (await withdrawUnsaved(sb, input.userId, missionId))) withdrawnUnsaved.add(j.part.key);
  }

  // the customer's summary: every part with what happens to it (none is silently dropped)
  const lines: string[] = [];
  lines.push(judged.length > 1 ? `فهمت إن طلبك فيه ${arNum(judged.length)} أجزاء:` : "حدّثنا طلبك:");
  judged.forEach((j, i) => {
    const st = partOf(j);
    const n = `${arNum(i + 1)}) ${j.label}${j.partBrief ? ` «${j.partBrief.request}»` : j.part.request ? ` «${j.part.request}»` : ""}`;
    const keptStatus = kept.has(j.part.key) ? statuses.get(kept.get(j.part.key)!.missionId!) ?? "" : "";
    if (st.outcome === "planned") lines.push(`${n}: ${FINISHED_STATUSES.has(keptStatus) ? "اتنفّذ قبل كده ونتيجته في بطاقته، ومش هنجهّزه تاني." : kept.has(j.part.key) && !keptWithoutCard.includes(j) ? "خطته جاهزة أو بتتجهز في بطاقته ومش هتتغير." : "بنجهّز خطته وسعره في بطاقته."}${j.noteAr ? ` ${j.noteAr}` : ""}`);
    else if (st.outcome === "waiting") lines.push(`${n}: مستني؛ ${unsaved.has(j.part.key) ? CARD_UNSAVED_AR : `${waiting.get(j.part.key)} وهيتجهّز أول ما تكتب «كمّل» من غير ما تعيد طلبك.`}`);
    else if (st.outcome === "refused_private") lines.push(`${n}: مش هنجمعه لأنه بيانات خاصة لأفراد.`);
    else if (st.outcome === "needs_clarification") lines.push(`${n}: محتاج توضيح بسيط قبل ما نجهّزه.${j.noteAr ? ` ${j.noteAr}` : ""}`);
    else lines.push(`${n}: ${j.noteAr ?? "مش متاح حاليًا."}`);
  });
  // the parts the customer removed and that were withdrawn are said (live evaluation round 3, K7: «شيل الأخبار» was done, but not said)
  const withdrawnNow = dropped.filter((p) => !leftRunning.includes(p.request ?? "") && p.request);
  if (withdrawnNow.length > 0) lines.push(`النسخة السابقة من ${withdrawnNow.map((p) => `«${p.request}»`).join(" و")} اتلغت (اتشالت أو اتعدّلت بحسب رسالتك)، ومش هيتجهّز منها حاجة.`);
  if (leftRunning.length > 0) lines.push(PREVIOUS_STILL_PLANNING_AR);
  if (savedCards.length > 0 || judged.some((j) => partOf(j).outcome === "planned")) lines.push(GROUP_APPROVAL_AR);
  const summary = lines.join("\n");
  const group = groupNow();
  const createdNow = Array.from(placed.values()).filter((p) => p.own).length;
  ctx.outcome = `group_${createdNow}_created_${kept.size}_kept_${savedCards.length}_cards_${unsaved.size}_unsaved_${judged.length - placed.size - kept.size}_other`;

  // the summary is written LAST, with the true outcome of every card; it carries the group the next turn reads (a failed write is retried once, and said in the log: the cards above it are stored either way)
  const summarySaved = await saveSummary(sb, input, summary, group, savedCards.length > 0);
  if (!summarySaved) console.warn("[chat:agent_group_summary_unsaved]");
  if (savedCards.length === 0) {
    if (!summarySaved && (placed.size > 0 || keptWithoutCard.length > 0)) return { ok: false, contentAr: GROUP_NOT_SAVED_AR, status: 200 };
    return { ok: false, contentAr: summary, status: 200 };
  }
  return { ok: true, missionId: savedCards[0].id, contentAr: summary, summaryOnly: true, extraMissions: savedCards.map((c) => ({ id: c.id, messageId: c.messageId, contentAr: c.contentAr })) };
}

/** The assistant cards of this conversation, by the mission they draw (the latest rows; null when they cannot be read: callers then never write a second card). */
async function cardsOfConversation(sb: any, conversationId: string): Promise<Map<string, { messageId: string; contentAr: string }> | null> {
  try {
    const { data, error } = await sb.from("messages").select("id,plan,content_ar").eq("conversation_id", conversationId).eq("role", "assistant").order("created_at", { ascending: false }).limit(100);
    if (error || !Array.isArray(data)) return null;
    const out = new Map<string, { messageId: string; contentAr: string }>();
    for (const row of data) { const id = row?.plan?.agentMissionId; if (typeof id === "string" && !out.has(id)) out.set(id, { messageId: String(row.id), contentAr: String(row.content_ar ?? "") }); }
    return out;
  } catch { return null; }
}

/** The statuses a part's mission may be ADOPTED in by another turn of the same request (it exists and is still the customer's to approve or running); a finished or withdrawn one is never reused: the part takes its next id. */
const ADOPTABLE = new Set(["queued", "planning", "needs_input", "plan_ready", "approved", "executing"]);
async function missionRowOf(sb: any, id: string): Promise<{ status: string; userId: string } | null | undefined> {
  try {
    const { data, error } = await sb.from(MISSION_TABLE).select("id,user_id,status").eq("id", id).maybeSingle();
    if (error) return undefined;
    return data ? { status: String(data.status), userId: String(data.user_id) } : null;
  } catch { return undefined; }
}

/**
 * The mission of ONE part: the first of the part's derived ids that is free (created now, with the existing limits and privacy check) or that already holds this customer's live mission of the same part (ADOPTED: a retried or
 * concurrent turn of the same request). Never two live missions for one part of one conversation.
 */
async function placePart(sb: any, input: AgentChatTurnInput, request: string, mayCreate: boolean): Promise<{ ok: true; id: string; created: boolean } | { ok: false; status: number; error: string }> {
  const adoptable = (row: { status: string; userId: string } | null | undefined) => !!row && row.userId === input.userId && ADOPTABLE.has(row.status);
  for (let n = 0; n < PART_ID_ATTEMPTS; n += 1) {
    const id = partMissionIdOf(input.userId, input.conversationId, request, n);
    const row = await missionRowOf(sb, id);
    if (row) { if (adoptable(row)) return { ok: true, id, created: false }; continue; }
    // no room for a new one now (status 0: the caller says why); an existing one was adopted above
    if (!mayCreate) return { ok: false, status: 0, error: "" };
    const r = await createCustomerMission(sb, { userId: input.userId, text: request, id });
    if (r.ok) return { ok: true, id, created: true };
    // another turn created it between the read and the insert (the primary key refused ours), or a limit counted it: adopted when it is live
    if (r.conflict || r.status === 429) {
      const again = await missionRowOf(sb, id);
      if (adoptable(again)) return { ok: true, id, created: false };
      if (r.conflict) continue;
    }
    return { ok: false, status: r.status, error: r.error };
  }
  return { ok: false, status: 500, error: "تعذّر بدء المهمة الآن. حاول بعد قليل؛ لم يُخصم شيء." };
}

/**
 * How many more requests may wait for this customer before the existing expiry (`requests/expiry.ts`, PENDING_MAX_WAITING) ends the oldest: the research missions that wait for them or will soon (queued, planning, a question, a
 * plan). Null when it cannot be read (the existing limits still apply).
 */
async function waitingRoom(sb: any, userId: string): Promise<number | null> {
  try {
    const { data, error } = await sb.from(MISSION_TABLE).select(`id,status,job_id,${ADDON_MARKER_COLUMN}`).eq("user_id", userId).in("status", ["queued", "planning", "needs_input", "plan_ready"]).limit(500);
    if (error || !Array.isArray(data)) return null;
    return Math.max(0, PENDING_MAX_WAITING - data.filter((r: any) => !hasAddonMarker(r) && !r?.job_id).length);
  } catch { return null; }
}

/** Whether exactly this part's card is stored (the insert's own answer was an error: a duplicate key of another turn's identical card, or an answer lost after the write). */
async function cardStored(sb: any, input: AgentChatTurnInput, messageId: string, missionId: string): Promise<boolean> {
  try {
    const { data, error } = await sb.from("messages").select("id,role,conversation_id,user_id,plan").eq("id", messageId).maybeSingle();
    return !error && !!data && data.role === "assistant" && data.conversation_id === input.conversationId && data.user_id === input.userId && data.plan?.agentMissionId === missionId;
  } catch { return false; }
}
/** Writes one part's card and says whether it is stored: a database answer carrying an error counts as a failure exactly like a thrown one. */
async function saveCard(sb: any, input: AgentChatTurnInput, row: { id: string; plan: { agentMissionId: string; researchBrief: ResearchBrief; researchGroup: StoredResearchGroup } } & Record<string, unknown>): Promise<boolean> {
  let failed = false;
  try { const r = await sb.from("messages").insert(row); failed = !!r?.error; } catch { failed = true; }
  return failed ? cardStored(sb, input, row.id, row.plan.agentMissionId) : true;
}
/** Withdraws a part's mission whose card could not be stored, while it still waits for the customer (compare-and-set; nothing is held before approval). True when it was withdrawn. */
async function withdrawUnsaved(sb: any, userId: string, missionId: string): Promise<boolean> {
  try {
    const upd = await sb.from(MISSION_TABLE).update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", missionId).eq("user_id", userId).in("status", WITHDRAWABLE).select("id");
    return !upd?.error && Array.isArray(upd?.data) && upd.data.length === 1;
  } catch { return false; }
}
/** Writes the summary (and the group the next turn reads) on this turn's assistant message; checked, retried once. The customer's message ends «planning» while a card is shown, else «completed». */
async function saveSummary(sb: any, input: AgentChatTurnInput, summary: string, group: StoredResearchGroup, withCards: boolean): Promise<boolean> {
  let saved = false;
  for (let attempt = 0; attempt < 2 && !saved; attempt += 1) {
    try {
      const r = await sb.from("messages").update({ content_ar: summary, plan: { researchGroup: group } }).eq("id", input.assistantMsgId).select("id");
      saved = !r?.error && Array.isArray(r?.data) && r.data.length === 1;
    } catch { saved = false; }
  }
  try { await sb.from("messages").update({ request_status: withCards ? "planning" : "completed" }).eq("id", input.userMsgId); } catch { /* the cards are what the customer acts on */ }
  return saved;
}

/** What a clarification of a multi-part request stores: the earlier group with the updated brief (so the next turn still knows which parts it prepared), or the brief alone. */
function keptBriefPlan(ctx: BriefTurnContext, brief: ResearchBrief): { researchGroup: StoredResearchGroup } | { researchBrief: ResearchBrief } {
  const asked = { ...brief, status: "needs_clarification" as const };
  return ctx.priorGroup ? { researchGroup: { ...ctx.priorGroup, brief: asked } } : { researchBrief: asked };
}

const DRIFT_LABEL_AR: Record<ConditionKind, string> = { period: "الفترة", place: "المكان", language: "لغة المحتوى", count: "العدد", replies: "الردود" };
/** Asked when a part (or the single request) would execute another value than the customer's own words, or lose or borrow a condition. */
export function conditionDriftAr(d: ConditionDrift): string {
  if (d.kind === "replies") return "انت طلبت الردود كمان، والجزء ده هيجمع التعليقات من غير ردودها؛ نضيف الردود؟";
  const label = `شرط ${DRIFT_LABEL_AR[d.kind]}`;
  if (d.kind === "count" && d.phrase) d = { ...d, phrase: d.phrase.replace(/\d/g, (x) => "٠١٢٣٤٥٦٧٨٩"[Number(x)]) };
  // a condition the customer never wrote is never quoted to them as theirs
  if (d.invented) return `الجزء ده فيه ${label}${d.phrase ? ` «${d.phrase}»` : ""} انت ما ذكرتهوش؛ نجهّزه من غيره ولا تقصده؟`;
  const yours = d.phrase ? ` («${d.phrase}»)` : "";
  if (d.reason === "missing") return `${label} اللي كتبته${yours} مش ظاهر في الجزء ده؛ ينطبق عليه ولا لأ؟`;
  if (d.reason === "other_part") return `${label} اللي في الجزء ده انت قلته لجزء تاني؛ ينطبق على الجزء ده كمان ولا لأ؟`;
  return d.phrase ? `الجزء ده اتكتب بـ${label} مختلف عن اللي كتبته${yours}؛ نجهّزه على اللي كتبته ولا تقصد حاجة تانية؟` : `الجزء ده اتكتب بـ${label} مش زي اللي في كلامك؛ تقصد أنهي؟`;
}

const quoteList = (xs: string[]): string => xs.map((x) => `«${x}»`).join(" و");
/** Asked when the whole request states a requirement no part carries: which part it belongs to (nothing is prepared until then). */
export function intentDroppedAr(lost: IntentRequirement[]): string {
  return `فهمت طلبك وأجزاءه، بس ${quoteList([...new Set(lost.map(requirementLabelAr))])} اللي في طلبك مش واضح يخص أنهي جزء. تقصده لكل الأجزاء ولا لجزء معيّن؟ ومش هنجهّز ولا هنخصم حاجة قبل ما توضّح وتعتمد.`;
}
/** Asked when a part's sentence states a requirement the customer never wrote. */
export function intentInventedAr(r: IntentRequirement): string {
  return `جملة الجزء ده فيها ${quoteList([requirementLabelAr(r)])} وانت ما ذكرتهوش؛ تحب نضيفه ولا نجهّزه من غيره؟`;
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
  // THE EXECUTED VALUES, not only whether a condition is stated: «آخر شهر» → «آخر أسبوع» or «الغردقة» → «شرم الشيخ» is a changed request (live evaluation 2026-11-12, K1: the contract said «the same» and the correction waited)
  const editNow = Date.now();
  const sameConditions = sameExecutedConditions(brief.request, open.requestText ?? "", editNow);
  if (open.state === "plan_ready") {
    if (sameConditions && (sameContract(contract, openContract) || (decision.count !== null && differsOnlyByCount(contract, openContract)))) { ctx.outcome = "edit_same_path"; return null; }
    const gated = await capabilityGate(input, brief, ctx);
    if (gated) return gated;
    ctx.outcome = "edit_replaced";
    return startMission(input, brief.request, { brief: ready, contentAr: REQUEST_UPDATED_AR });
  }
  if (open.state === "needs_input") {
    const platformChange = contract.platform !== null && contract.platform !== openContract.platform;
    // an answer ADDS what the question asked; a message that CHANGES a condition the request already states is a correction of the request, restated whole
    if (!platformChange && !conditionChanged(open.requestText ?? "", brief.request, editNow)) { ctx.outcome = "answer_same_path"; return null; }
    const gated = await capabilityGate(input, brief, ctx);
    if (gated) return gated;
    ctx.outcome = "answer_replaced";
    return startMission(input, brief.request, { brief: ready, contentAr: REQUEST_UPDATED_AR });
  }
  // planning
  // the numbers too («خليهم ١٠٠ بس» while the plan is being prepared: K3); a count edit of a READY plan is the plan editor's (above)
  if (sameContract(contract, openContract) && sameConditions && sameExecutedValues(brief.request, open.requestText ?? "", editNow)) { ctx.outcome = "planning_same"; return null; }
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
