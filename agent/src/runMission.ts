import { isCompanyStage } from "../../src/lib/agentMission/entities";
import { getBalance } from "../../src/lib/supabase/ledger";
import { createJobCallBudget } from "../../src/lib/server/callBudget";
import { stage2Enabled } from "../../src/lib/agentMission/stage2/flags";
import { topicRelationAnswerOf } from "../../src/lib/agentMission/stage2/questionCards";
import { readAskEdits } from "./stage2/askEdits";
import { markStage2TestAccount } from "./stage2/testMarker";
import type { CallRecorder, FetchFn } from "../../src/lib/server/multiProvider/adapterTypes";
import type { TregCallOptions, TregCallResult } from "../../src/functions/shared/tregClient";
import type { commitTregSpend } from "../../src/lib/server/tregCallRecord";
import type { TregCatalog } from "../../src/lib/treg/catalog";
import type { AccountAccess } from "../../src/lib/treg/dataPolicy";
import {
  AGENT_ERROR_REQUEUES_MAX, AGENT_EXECUTION_LLM_BUDGET_FLOOR_USD, AGENT_EXECUTION_LLM_BUDGET_SHARE, AGENT_MEMORY_REQUEUES_MAX, AGENT_PHASE_STARTS_MAX, AGENT_RESTART_REQUEUES_MAX, AGENT_EXECUTION_MAX_TURNS, AGENT_EXECUTION_WALL_MS, AGENT_PLANNING_LLM_BUDGET_USD,
  AGENT_PLANNING_MAX_TURNS, AGENT_PLANNING_NUDGES_MAX, AGENT_PLANNING_WALL_MS, AGENT_PRICING_BASIS, AGENT_EXECUTION_CONTINUE_ROUNDS, AGENT_SOURCE_MEASURE_WINDOW_MS,
} from "../../src/lib/agentMission/constants";
import { executionBudgetUsd, reviewBudgetUsdFor, reviewCeilingUsdFor } from "../../src/lib/agentMission/price";
import { MISSION_PRICING_SETTING_KEY, normalizeMissionPricingSettings } from "../../src/lib/missionPricing";
import { planningBudgetFacts } from "../../src/lib/agentMission/planningBudget";
import { sourceHealth, statsFromCalls } from "../../src/lib/agentMission/sourceRanking";
import { loadRegistryArtifact, minLevelFor, routingFactsOf } from "../../src/lib/agentMission/capabilities/routingFacts";
import { classifyNoCardEnd, noCardSentenceAr, refusalSentenceAr } from "../../src/lib/agentMission/refusal";
import { parentCountsOf, parentsBelowShare } from "../../src/lib/agentMission/parents";
import { unbilledLineAr } from "../../src/lib/agentMission/billableRows";
import { planningJudge, topicVariants } from "./researchJudge";
import { executionSpecFor, readJudged, researchSpecFor, type ResearchSpec } from "./researchSpec";
import type { StoredCustomerWords } from "../../src/lib/agentMission/customerWords";
import { ensureOwned, isOwnershipError } from "./ownership";
import { compensateFreeRerun } from "../../src/lib/agentMission/freeRerun";
import { customerPlanView, namesAreWritten, requestedRowsOf, type PricedPlan } from "../../src/lib/agentMission/plan";
import { topLevelFactsOf } from "../../src/lib/agentMission/repliesCard";
import { toArabicDigits } from "../../src/lib/arabicDigits";
import { RELEVANCE_REASON_LIST, type RelevanceReason } from "../../src/lib/agentMission/relevance";
import { FILTER_REASONS, isEnabled, type FilterReason } from "../../src/lib/agentMission/filters";
import { holdValueUsd } from "../../src/lib/server/callBudget";
import { AcceptedCompanies, COMPANY_UNCERTAIN_KEY, qualityResultLineAr, storedCompanyEvidence } from "../../src/lib/agentMission/companyQuality";
import { executionPageReuse } from "./pageReuse";
import type { ModelDriver } from "./driver";
import { createGateway } from "./gateway";
import { createWebGateway, type ProviderKeyFn } from "./webGateway";
import type { WorkerSpendGate } from "./spendGateWiring";
import { spendGateOf, withMissionSpendGate } from "./spendGateKeys";
import { loadSystemPrompt } from "./prompt";
import { anyWebAvailable, NO_WEB, resolveWebAvailability } from "../../src/lib/agentMission/webAvailability";
import { PLANNING_NUDGE } from "./nudge";
import { readRunState, updateRunState, type RunState } from "./runState";
import { MAILBOX_LISTER_CAPABILITIES, PEOPLE_OF_COMPANY_CAPABILITIES, isPeopleOfCompanyStep, understoodPeopleOf } from "../../src/lib/agentMission/childSources";
import { isContactSource } from "../../src/lib/agentMission/contacts";
import { buildTools, newRunState, recoverCompanyPeoplePlan, socialRedesignActive, type ToolContext, type ToolSpec } from "./tools";
import { getLastRecoveryDiagnostic, isCompaniesOnlyChoice, isPeopleRetryChoice, sanitizeCapIssuesForAdmin, type RecoveryDiagnostic, type UnderstoodCompaniesSummary } from "./companyPeopleRecovery";
import { applySnapshot, readPlanningState, resumeNoteOf, snapshotOf, writePlanningState } from "./planningState";
import { ItemStore, newWriterId, type ItemSnapshot, type StopReason } from "./items/itemStore";
import { createLiveWriter, liveSheetOn, writeDoneSnapshotSafely } from "./stage2/liveWriter";
import { mirrorLegacyFiles } from "./items/mirror";
import { runEngine } from "./engine/run";
import { WEB_SOURCE_IDS } from "../../src/lib/agentMission/sources";
import { createSourceGateway, stageDispatchOf, stageScopeOf, verifiedCallMaxUsdOf } from "./engine/sourceGateway";
import { readPlatformFlagsOf, readRedesignFlags } from "../../src/lib/agentMission/redesignFlags";
import { CLARIFY_OPTIONS_AR, CLARIFY_QUESTION_AR, PLATFORM_OPTIONS_AR, PLATFORM_QUESTION_AR, UNCLEAR_END_AR, legacyRouteOf, platformOptionOf, withPlatformChoice } from "../../src/lib/agentMission/platformQuestion";
import { askedTextOf, buildRequestContract, platformsNamedIn } from "../../src/lib/agentMission/requestContract";
import { briefNumbersAr, objectivesIssue, validateBrief, type ResearchBrief } from "../../src/lib/agentMission/researchBrief";
import { decideTurn } from "../../src/lib/agentMission/conversationModel";
import { readSemanticNormalizationFlag } from "../../src/lib/agentMission/semantic/flag";
import { sealFinalPrice } from "../../src/lib/agentMission/finalPrice";
import { accountIsTest, anyRedesignFlag, fallbackStageOf, redesignStagesOf } from "./redesign";
import { compiledPlatformActive, planByCompiler } from "./compiled";
import { planCompaniesByCodeIfOn } from "../../src/lib/agentMission/stage3/b2bPlanning";
import { b2bContactCells, b2bEngineOn, b2bFlagSet, b2bLimitLines, createAttemptLog } from "../../src/lib/agentMission/stage3/b2bEngine";
import { isSocialPlatform } from "../../src/lib/agentMission/redesignFlagTypes";
import { modelPlanningForTests } from "../../src/lib/agentMission/testSeam";
import { SOCIAL_NOT_OFFERED_AR } from "../../src/lib/agentMission/foundation/namedShortfall";
import { blockedEndpointReason } from "../../src/lib/treg/blockList";
import { policyVerdict } from "../../src/lib/treg/dataPolicy";
import { buildCapabilityRegistry, capabilitySelectionOf, chatCapabilityLines, discoverCapabilities, limitationLinesAr, mixedPartsAr, operationLabelAr, plannerCapabilitySection, readCapabilityDiscoveryFlag, readMultiStageEngineFlag, readRegistryRouterFlag, readWebViaTregFlag, researchNeedOf, scopeAnchorBody, scopeAnchorOf, SCOPE_ANCHOR_FOLDER, verifyApprovedScope, type CapabilityDiscovery, type ResearchNeed, type ScopeAnchor } from "../../src/lib/agentMission/capabilities";
import { namedShortfallChoiceOf } from "../../src/lib/agentMission/foundation/namedShortfall";
import { promiseShortfallAr, repliesShortfallAr } from "./repliesShortfall";
import { TOPIC_OPTIONS_AR, topicMeaningOf, topicQuestionAr } from "../../src/lib/agentMission/topicMeaning";
import { noAboutChoiceOf } from "../../src/lib/agentMission/foundation/topicChoice";
import { occurrenceChoiceOf } from "../../src/lib/agentMission/foundation/occurrence";
import { pageNotFoundAr } from "../../src/lib/agentMission/foundation/namedShortfall";
import { YOUTUBE_CHANNEL_DECLINED_AR, YOUTUBE_CHANNEL_UNIDENTIFIED_AR, youtubeChannelOf } from "../../src/lib/agentMission/foundation/youtubeChannel";
import { INSTAGRAM_ACCOUNT_DECLINED_AR, instagramAccountOf } from "../../src/lib/agentMission/foundation/instagramAccount";
import { SOURCE_CANCELLED_AR, SOURCE_DECLINED_AR, sourceAnswerOf } from "../../src/lib/agentMission/foundation/sourceScope";
import { searchScopeEndAr } from "../../src/lib/agentMission/foundation/searchScope";
import { buildAsk } from "../../src/lib/agentMission/foundation/ask";
import { BUDGET_QUESTION_AR, BUDGET_TOO_SMALL_AR, choiceAnswerOf, type Choices } from "../../src/lib/agentMission/foundation/countChoice";
import { parseChannels, understandChannelsPrompt, UNDERSTAND_SYSTEM } from "../../src/lib/agentMission/foundation/understand";
import { llmCostFromUsage } from "./llmCost";
import { AGENT_PLANNING_BUDGET_CAP_USD, MODEL_HAIKU } from "../../src/lib/agentMission/constants";
import { cardsWithDiscovery, chainCheckerFor, discoveryActive, modelSelector } from "../../src/lib/agentMission/foundation/discovery";
import { promisedTotalOf } from "../../src/lib/agentMission/promisedNumbers";
import { reportedPlan, withPromiseCaps, withRepliesJudged } from "../../src/lib/agentMission/repliesCard";
import { publicPlanOf } from "../../src/lib/agentMission/overLimit";
import { LLM_PLANNER_MAX_SAMPLES_PER_SOURCE, llmPlannerOn, runLlmPlanning } from "./llmPlanner/run";
import type { Understanding } from "./llmPlanner/planner";
import { runContactEnrichment } from "./engine/contacts";
import { runNamesStep } from "./namesAr";

import { runInSandbox } from "./sandbox";
import { trackRun, untrackRun } from "./sessions";
import { childShortfallClauseAr, namedSourceTruthAr, shortfallClauseAr, shortfallFromStopAr, stageTruthBodyAr, zeroDeliveryReasonAr, type ZeroDeliveryFacts } from "./finalize";
import { namedAuthorVerdict } from "../../src/lib/agentMission/foundation/pool";
import { createReviewer, readReviewState, type ReviewCall } from "./review";
import type { TokenUsage } from "./llmCost";
import { buildExcludedAdminCsv, buildMissionFiles, type CompanyMailboxes, type ExcludedRow } from "./workbook";
import { storeFirstVersion } from "./stage4/firstVersion";
import { isPeopleStage, mailboxesOf } from "../../src/lib/agentMission/people";
import { availableContactAnswerNote } from "../../src/lib/agentMission/contactQuestion";
import { missionFactsOf } from "./methodology";
import { advanceMissionDelivery, inspectMissionDelivery, type DeliveryReceipt } from "./missionSettlement";
import { GENERIC_ITEM_NOUN, itemNounOf, itemNounOfPlan } from "../../src/lib/agentMission/itemNoun";
import type { AgentStore, CallRow, MissionRecord } from "./types";
import type { SandboxResult } from "./sandbox";
import { loadApprovedExclusion, withCustomerExclusion, type ReadMissionExclusion } from "./customerExclusion";
import { loadApprovedPriorDelivery, priorDeliveryForPlanning, withPriorDelivery, type ReadDeliveredMissions, type ReadPriorDeliveryCard } from "./priorDelivery";
import { conversationSourceIdOf, type ReadConversationMissions } from "./conversationSource";
import { priorDeliveryMatcherOf } from "../../src/lib/agentMission/priorDelivery";
import type { ExclusionMatcher } from "../../src/lib/agentMission/customerExclusion";
import type { MissionNoticeFacts, MissionNoticeKind } from "../../src/lib/agentMission/notices";

export interface RunnerDeps {
  store: AgentStore;
  /** True once ANOTHER worker owns this run's mission (ownership.ts): the run's writes are refused and its error recovery writes nothing (the new owner owns the row). */
  leaseLost?: () => boolean;
  /** The worker that claimed this run's mission (ownership.ts ensureOwned reads the row against it before every settlement). */
  ownerId?: string;
  /** Revokes this run's ownership: its writes are refused and its model run is stopped. */
  revokeOwnership?: () => void;
  /** Supabase client (money functions, spend recording, sensitive audit). */
  client: any;
  catalog: TregCatalog;
  driver: ModelDriver;
  recorder: CallRecorder;
  models: { planning: string; execution: string };
  resolveAccess: (userId: string) => Promise<AccountAccess>;
  token?: string;
  commit?: typeof commitTregSpend;
  call?: (options: TregCallOptions) => Promise<TregCallResult>;
  sandbox?: (code: string, inputs: Record<string, unknown>) => Promise<SandboxResult>;
  /** Tells the customer how the mission ended (an in-site notice and an e-mail). Must not throw; absent in tests that do not look at it. */
  notify?: (input: { userId: string; missionId: string; jobId: string | null; kind: MissionNoticeKind; facts: MissionNoticeFacts }) => Promise<unknown>;
  /** The provider's key from the encrypted key store (the site's own resolver); with it the agent gets the page parsers, the web search and scrape, and people search. Absent: those tools are not offered. */
  providerKey?: ProviderKeyFn;
  /** The HTTP transport of the web gateway (tests pass a fake: no real call). */
  fetchFn?: FetchFn;
  /** The model call that reviews uncertain rows (a small request to the model API, no SDK process). Absent (tests, no key): uncertain rows are not delivered. */
  reviewCall?: ReviewCall;
  /** LLM-FIRST PLANNER: the planning model (one forced structured call per question; agent/src/llmPlanner/model.ts). Absent (tests, no key): the planner does not run and the earlier paths plan. */
  plannerModel?: import("./llmPlanner/planner").PlannerModel;
  systemPromptFile?: string;
  /** Carry out a plan whose stages all have an execution recipe with the code engine, no model session (default true). false: the model carries every mission out (through the same item store). */
  engine?: boolean;
  /** The pause before the one delayed review retry (tests pass a fake that does not wait). */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** UNIFIED CAPABILITY DISCOVERY (capability_discovery_v1 only): the web providers' daily caps in USD from the admin's provider limits (0 = spend nothing). Absent (tests): unknown, and the call recorder still refuses a call over the cap. */
  providerDailyCaps?: () => Promise<Partial<Record<"firecrawl" | "contextdev", number>>>;
  /**
   * PHASE 2 (capability_discovery_v1 only): TREG's own daily cap and what each provider has ALREADY spent today (provider_costs, read only), so a provider whose cap is used up is not planned on. Absent or failing (tests, a read error):
   * unknown, and the call recorder still refuses a call over the cap. A value that could not be read is left out, never guessed.
   */
  providerToday?: () => Promise<{ tregDailyCapUsd?: number; spentTodayUsd: Partial<Record<"treg" | "firecrawl" | "contextdev", number | null>> }>;
  /** LLM-FIRST OBJECTIVES (capability_discovery_v1 only): the research brief the chat stored with this mission's card (`messages.plan.researchBrief`, written by the server only), read back with its schema. Absent (tests that do not need it): none. */
  readMissionBrief?: (missionId: string, userId: string) => Promise<ResearchBrief | null>;
  /** P0 (15 Nov 2026): the customer's OWN messages the chat server stored with this mission's card (`messages.plan.customerWords`, written by code). Absent, or none stored: the mission's text stands for them. */
  readMissionWords?: (missionId: string, userId: string) => Promise<StoredCustomerWords | null>;
  /** P0 (15 Nov 2026): the earlier missions the chat recorded on this mission's card because the customer asked not to receive delivered items again (`messages.plan.priorDelivery`, server-written). Absent: none. */
  readPriorDeliveryCard?: ReadPriorDeliveryCard;
  /** P0 (15 Nov 2026): the earlier missions of this mission's conversation (same customer), to carry a source identifier the customer already confirmed (conversationSource.ts). Absent: never carried. */
  readConversationMissions?: ReadConversationMissions;
  /** P0: of those, the ones of this customer that completed and delivered, with the stages their file was built from. */
  readDeliveredMissions?: ReadDeliveredMissions;
  /** PHASE 5.3 (`customer_exclusion_files_v1` only): the exclusion list the chat stored on this mission's card (`messages.plan.customerExclusion`, server-written), read back with its digest. Absent (tests that do not need it): none. */
  readMissionExclusion?: ReadMissionExclusion;
  /**
   * ROUND 62: the hard spend gate (agent/src/spendGateWiring.ts). Absent (DIGER_SPEND_GATE unset or off, and every test that does not ask for it): no
   * gateway, model run or review changes at all. Present: every TREG and web call reserves its bound and every model request goes through the model gate.
   */
  spendGate?: WorkerSpendGate;
}

/** ROUND 62: the model gate of one model run of this mission (every planning turn, every execution round); nothing when the gate is off. */
function modelGateOf(deps: RunnerDeps, missionId: string): { modelGate?: ReturnType<WorkerSpendGate["modelGateFor"]> } {
  return deps.spendGate && deps.spendGate.active(missionId) ? { modelGate: deps.spendGate.modelGateFor(missionId) } : {};
}

/** The two answers of the reduced-scope card (UNIFIED CAPABILITY DISCOVERY): the customer chooses, nothing is planned or held before. */
export const CAPABILITY_SCOPE_OPTIONS_AR = ["نعم، اجمع المتاح فقط", "لا، ألغِ الطلب"] as const;
const CAPABILITY_SCOPE_YES = /^\s*(?:نعم|ايوه|أيوه|ايوة|أيوة|تمام|موافق|ماشي|اوك|أوك|ok|yes)(?![ء-ي\w])|اجمع المتاح/i;
/** The mission ends honestly before any planning call: what no available capability can do, and the feasible alternative (nothing was held). */
export const capabilityEndAr = (d: CapabilityDiscovery): string => [d.messageAr, d.alternativeAr ? `${d.alternativeAr} اكتب طلبك بالنطاق الذي يناسبك في رسالة جديدة.` : null, "لم يُخصم منك شيء."].filter((x): x is string => typeof x === "string" && x.trim() !== "").join(" ");

/** The server's anchor of this mission's approved scope (selection.ts `ScopeAnchor`): the LATEST file of the mission's create-only anchor folder (the listing reads the database, never a stale CDN copy). A failed read throws: execution never
 *  runs a plan it could not check. */
export async function capabilityAnchorOf(store: AgentStore, missionId: string): Promise<ScopeAnchor> {
  const files = (await store.listFiles(missionId, SCOPE_ANCHOR_FOLDER)).filter((f) => f.name.endsWith(".json"));
  if (files.length === 0) return { required: false, digest: null };
  const latest = files[files.length - 1].name;
  const body = await store.getFile(missionId, latest);
  return scopeAnchorOf(body ?? "unreadable");
}

/** Writes the anchor (create-only: a new name each time, sortable by time). A failure throws: a plan with a record is never shown without its anchor. */
async function writeCapabilityAnchor(store: AgentStore, missionId: string, digest: string | null): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    const name = `${SCOPE_ANCHOR_FOLDER}/${String(Date.now()).padStart(15, "0")}_${i}.json`;
    const r = await store.putNewStrict(missionId, name, scopeAnchorBody(digest), "application/json");
    if (r.created) return;
  }
  throw new Error("capability anchor not written");
}

const AR_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
/**
 * THE OUTCOME OF EACH OBJECTIVE of an approved multi-stage plan (docs/MULTI-OBJECTIVE-RESEARCH.md): each delivering stage, named by the operation its record validated, with what the file holds against what was approved: delivered, partial or
 * none. Null for a plan with a single delivering stage (the mission's own status says it). Counts only; never a provider name.
 */
export function objectiveOutcomesLineAr(plan: PricedPlan, deliveredByStage: Record<string, number>): string | null {
  const ar = (n: number) => String(Math.max(0, Math.round(n))).replace(/\d/g, (d) => AR_DIGITS[Number(d)]);
  const rec = new Map((plan.capability_selection?.stages ?? []).map((x) => [x.stage_key, x]));
  const stages = plan.stages.filter((st) => st.deliver);
  if (stages.length < 2) return null;
  const parts = stages.map((st) => {
    const got = Number(deliveredByStage[st.key] ?? 0);
    const op = rec.get(st.key)?.operation ?? null;
    // the stage's own title on the card (checked customer text); the validated operation's name when the title is empty
    const label = st.title_ar?.trim() ? st.title_ar.trim() : op ? operationLabelAr(op, null) : st.key;
    const outcome = got <= 0 ? "لم يُسلَّم منه شيء، ولم تدفع عنه" : got >= st.planned_rows ? "سُلّم كاملًا" : "سُلّم جزئيًا، ولا تدفع إلا عن المسلَّم";
    return `${label}: ${ar(got)} من ${ar(st.planned_rows)} (${outcome})`;
  });
  return `نتيجة كل هدف من طلبك: ${parts.join("؛ ")}.`;
}

/**
 * THE REDUCED SCOPE IS ASKED before any plan or price (a step no capability serves, or the non-social part of a mixed request): a step is never dropped or replaced silently. Returns true when the mission stops here (asked, or cancelled by the
 * customer's «لا»); false when the customer accepted the reduced scope and planning goes on.
 */
async function askReducedScope(deps: RunnerDeps, mission: MissionRecord, question: string): Promise<boolean> {
  const { store } = deps;
  const note = await readRunState(store, mission.id);
  if (note.capabilityScope === "accepted") return false;
  if (note.capabilityScope === "asked") {
    if (!CAPABILITY_SCOPE_YES.test(String(mission.answer_text ?? ""))) {
      await store.updateMission(mission.id, { status: "cancelled", ...clear });
      await store.addEvent(mission.id, { kind: "result", message_ar: "أُلغيت هذه المهمة ولم يُخصم شيء؛ اكتب طلبك المعدّل في رسالة جديدة إن أردت." });
      return true;
    }
    await updateRunState(store, mission.id, (r) => ({ ...r, capabilityScope: "accepted" }), deps.log);
    return false;
  }
  await updateRunState(store, mission.id, (r) => ({ ...r, capabilityScope: "asked" }), deps.log);
  await store.updateMission(mission.id, { status: "needs_input", question_ar: question, plan_public: { question_options: [...CAPABILITY_SCOPE_OPTIONS_AR] } as any, ...clear });
  await store.addEvent(mission.id, { kind: "question", message_ar: question });
  return true;
}

/**
 * LLM-FIRST OBJECTIVES IN THE WORKER (docs/LLM-FIRST-OBJECTIVES.md): the brief the chat validated and stored with THIS mission's card, when it is the brief of exactly these words, its objectives still pass the structure and grounding check
 * against this mission's own words, and the customer has not since changed the request by answering a question (a reduced-scope «yes» changes nothing). Otherwise null: the words are read, as before. Never throws.
 */
async function missionObjectivesBrief(
  deps: RunnerDeps,
  mission: MissionRecord,
  note: { capabilityScope?: string },
  options: { capabilityLines?: string[]; semantic?: boolean } = {},
): Promise<{ brief: ResearchBrief; revisedByAnswer: boolean } | null> {
  if (!deps.readMissionBrief) return null;
  try {
    const brief = await deps.readMissionBrief(mission.id, mission.user_id);
    if (!brief?.objectives || brief.objectives.length === 0) return null;
    const norm = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").trim();
    if (norm(brief.request) !== norm(mission.request_text)) return null;
    const named = new Set<string>(platformsNamedIn(`${mission.request_text} ${mission.answer_text ?? ""}`));
    if (mission.answer_text && !(note.capabilityScope && CAPABILITY_SCOPE_YES.test(String(mission.answer_text)))) {
      // Keep stored LLM objectives across clarifying answers (country/field/count) unless the existing chat LLM brief builder drops or changes them.
      const refined = await decideTurn({
        message: mission.answer_text,
        balancePoints: null,
        open: { id: mission.id, state: "needs_input", questionAr: mission.question_ar ?? null, requestText: mission.request_text },
        brief: {
          enabled: true,
          soFar: brief,
          numbersAr: briefNumbersAr({ customerTurns: [mission.request_text, mission.answer_text], prior: brief }),
          ...(options.capabilityLines && options.capabilityLines.length > 0 ? { capabilityLines: options.capabilityLines } : {}),
        },
      }).catch(() => null);
      if (refined?.brief?.ok) {
        const checked = validateBrief(refined.brief.brief, {
          customerTurns: [mission.request_text, mission.answer_text],
          assistantQuestion: mission.question_ar ?? null,
          prior: brief,
          semantic: options.semantic === true,
        });
        if (checked.ok && checked.brief.objectives && checked.brief.objectives.length > 0 && !objectivesIssue(checked.brief, named)) {
          return { brief: checked.brief, revisedByAnswer: true };
        }
      }
      if (objectivesIssue(brief, named)) { deps.log?.(`objectives_not_used ${mission.id}`); return null; }
      return { brief, revisedByAnswer: false };
    }
    if (objectivesIssue(brief, named)) { deps.log?.(`objectives_not_used ${mission.id}`); return null; }
    return { brief, revisedByAnswer: false };
  } catch { return null; }
}

/**
 * Derives capability-discovery need directly from the worker LLM planner's structured
 * `r.understanding` when `llm_planner_v1` is active (zero stored brief, zero extra model calls,
 * zero keyword lists).
 */
export function needFromPlannerUnderstanding(
  baseNeed: ResearchNeed,
  understanding: Understanding,
  opts: {
    understoodPeople: ReturnType<typeof understoodPeopleOf>;
    understoodCompanies?: UnderstoodCompaniesSummary;
    forceCompaniesOnly: boolean;
    isRecoveryRetry: boolean;
  },
): ResearchNeed {
  const steps = understanding.steps ?? [];
  const hasCompanyContacts = steps.some((s) => s.capability === "company.contacts" || MAILBOX_LISTER_CAPABILITIES.has(s.capability));
  const hasCompanyPhone = steps.some((s) => s.capability === "company.contacts");
  const hasCompanyStep =
    Boolean(opts.understoodCompanies) ||
    steps.some((s) => s.parent === null && (s.platform === "companies" || s.capability.startsWith("companies.")));
  const hasPlaceStep = steps.some((s) => s.platform === "places" || s.capability.startsWith("places."));
  const hasReviewStep = steps.some((s) => s.capability === "places.reviews" || s.capability === "apps.reviews");
  const hasAppStep = steps.some((s) => s.platform === "apps" || s.capability.startsWith("apps."));
  const hasWebStep = steps.some((s) => s.platform === "web" || s.capability.startsWith("web."));
  const hasPeopleStep = steps.some((s) => s.platform === "people" || isPeopleOfCompanyStep(s));
  const understoodCount =
    opts.understoodCompanies?.expected_rows ??
    (typeof understanding.companies_count === "number" && Number.isInteger(understanding.companies_count) && understanding.companies_count >= 1
      ? understanding.companies_count
      : null);
  const count = baseNeed.count ?? understoodCount;
  const conditions = {
    period: baseNeed.conditions.period || steps.some((s) => s.period !== null),
    country: baseNeed.conditions.country || steps.some((s) => Boolean(s.country)),
    language: baseNeed.conditions.language || steps.some((s) => Boolean(s.language)),
  };
  const topic = baseNeed.topic ?? opts.understoodCompanies?.topic ?? null;

  if (opts.forceCompaniesOnly) {
    const kind = baseNeed.kind === "unknown" && (hasCompanyStep || baseNeed.people) ? "companies" : baseNeed.kind;
    return { ...baseNeed, kind, people: false, count, conditions, topic };
  }

  if (opts.understoodPeople || opts.isRecoveryRetry) {
    const kind = baseNeed.kind === "social" || baseNeed.kind === "mixed" ? baseNeed.kind : "companies";
    const email = baseNeed.contacts.email || hasCompanyContacts;
    const phone = baseNeed.contacts.phone || hasCompanyPhone;
    return {
      ...baseNeed,
      kind,
      people: true,
      contacts: { email, phone },
      websites: baseNeed.websites || email || phone,
      count,
      conditions,
      topic,
    };
  }

  if (hasCompanyStep || hasCompanyContacts) {
    const kind = baseNeed.kind === "unknown" ? "companies" : baseNeed.kind;
    const email = baseNeed.contacts.email || hasCompanyContacts;
    const phone = baseNeed.contacts.phone || hasCompanyPhone;
    return {
      ...baseNeed,
      kind,
      people: false,
      contacts: { email, phone },
      websites: baseNeed.websites || email || phone,
      count,
      conditions,
      topic,
    };
  }

  if (baseNeed.kind === "unknown") {
    const kind = hasPlaceStep ? "places" : hasAppStep ? "apps" : hasPeopleStep ? "people" : hasWebStep ? "web" : baseNeed.kind;
    if (kind !== baseNeed.kind) {
      return { ...baseNeed, kind, reviews: baseNeed.reviews || hasReviewStep, count, conditions, topic };
    }
  }

  return { ...baseNeed, count, conditions, topic };
}

/**
 * P0 (15 Nov 2026): THE MISSION'S RESEARCH SPEC (researchSpec.ts), made from the customer's own messages stored with the card. Planning asks for it (once per run, only for a research topic); execution reads the stored one, so both judge
 * against the same criterion. A failed read of the stored messages leaves the mission's own text standing for them (never a guess).
 */
async function missionResearchSpec(deps: RunnerDeps, store: AgentStore, mission: MissionRecord): Promise<{ spec: ResearchSpec; costUsd: number }> {
  const words = deps.readMissionWords ? await deps.readMissionWords(mission.id, mission.user_id).catch(() => null) : null;
  const got = await researchSpecFor({ call: deps.reviewCall, store, mission, storedWords: words, fallbackSubject: mission.request_text, log: deps.log });
  // the spec as the admin reads it (internal event: the criterion, its alternatives and its near misses; counts only for the rest); recorded when it was made now, not when a stored one was read
  if (got.costUsd > 0 || got.spec.by === "words") await store.addEvent(mission.id, { kind: "call", message_ar: specEventAr(got.spec), counts: { spec_by_model: got.spec.by === "model" ? 1 : 0, spec_any_of: got.spec.anyOf.length, spec_not_relevant: got.spec.notRelevant.length } }).catch(() => undefined);
  return got;
}
const specEventAr = (spec: ResearchSpec): string => {
  const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);
  if (spec.by !== "model") return "قياس داخلي: مواصفة البحث من كلمات العميل وحدها؛ لم يُعطِ النموذج مواصفة صالحة.";
  return cut(`قياس داخلي: مواصفة البحث. المقصود: ${cut(spec.criterion, 300)}. البدائل: ${spec.anyOf.map((a) => cut(a, 120)).join("؛ ")}.${spec.notRelevant.length > 0 ? ` لا يدخل: ${spec.notRelevant.map((a) => cut(a, 120)).join("؛ ")}.` : ""}`, 1090);
};
/**
 * The spec the execution judges with: the one planning stored for exactly this mission's inputs, else the customer's words alone (never a spec of other inputs). Only for a plan with a research topic judged by meaning (`judge: "model"`):
 * the review of any other plan (a sector, a name) is unchanged.
 */
async function executionResearchSpec(deps: RunnerDeps, store: AgentStore, mission: MissionRecord, plan: PricedPlan): Promise<ResearchSpec | null> {
  if (!plan.stages.some((s) => s.relevance?.judge === "model")) return null;
  const stored = deps.readMissionWords ? await deps.readMissionWords(mission.id, mission.user_id).catch(() => null) : null;
  return executionSpecFor(store, mission, stored);
}

/** The least time the contact finder steps may take after the stages, even when the stages used the mission's whole wall time (a lookup is about a second per person). */
const CONTACT_STEP_MIN_WALL_MS = 5 * 60_000;
const sum = (calls: CallRow[], phase: CallRow["phase"]) => calls.filter((c) => c.phase === phase).reduce((n, c) => n + (Number(c.cost_usd) || 0), 0);
const lastSeq = (calls: CallRow[]) => calls.reduce((n, c) => Math.max(n, Number(/call_(\d+)$/.exec(c.id)?.[1] ?? 0)), 0);
const lastOut = async (store: AgentStore, missionId: string): Promise<number> => {
  // outputs continue their numbering after a restart: the highest number in the mission's own `out/` folder (the listing reads the database, so it is exact right after a write)
  const listed = await store.listFiles(missionId, "out").catch(() => []);
  return listed.reduce((n, f) => Math.max(n, Number(/^out\/out_(\d+)\.json$/.exec(f.name)?.[1] ?? 0)), 0);
};

function savedCallsNote(calls: CallRow[]): string {
  const rows = calls.filter((c) => c.status === "ok" || c.status === "empty").map((c) => `- ${c.id.split(":").pop()}: endpoint ${c.endpoint_id}, params ${JSON.stringify(c.params_digest)}, ${c.rows_returned ?? 0} rows, ${c.phase}`);
  return rows.length ? `Pages ALREADY saved for this mission (use them with run_code before paying for the same data again):\n${rows.join("\n")}` : "No page is saved yet.";
}

/** The planning run ended with a plain end (not a limit, a crash or a restart) and said nothing the system can use: no plan, no question, no ending. */
export const endedSilently = (output: { stop?: string; error?: string }, state: { proposedPlan: unknown; question: unknown; finish: unknown }): boolean => output.stop === "end" && !output.error && !state.proposedPlan && !state.question && !state.finish;


/** Everything the agent is told at the start of a PLANNING run. */
export function planningPrompt(mission: MissionRecord, calls: CallRow[], resumeNote = ""): string {
  const followAnswer = availableContactAnswerNote(mission.answer_text);
  const answer = mission.answer_text ? `\n\nYou asked the customer one question and they answered: «${mission.answer_text}». Do not ask again.${followAnswer ? ` ${followAnswer}` : ""}` : "";
  return `The customer's mission (Arabic):\n«${mission.request_text}»${answer}\n\n${savedCallsNote(calls)}${resumeNote ? `\n\n${resumeNote}` : ""}\n\nPlan it now.`;
}

/** Everything the agent is told at the start of an EXECUTION run: the approved plan (internal view) and what is already saved. */
export function executionPrompt(mission: MissionRecord, plan: PricedPlan, calls: CallRow[], saved: Record<string, number>): string {
  const stages = plan.stages.map((s) => ({ key: s.key, title: s.title_ar, endpoint_id: s.endpoint_id, parent_key: s.parent_key, per_parent_rows: s.per_parent_rows ?? null, deliver: s.deliver, rows_approved: s.planned_rows, rows_saved_so_far: saved[s.key] ?? 0, columns: s.columns, measured_by: s.measured_by, how: s.how_ar ?? null }));
  return `The customer's mission (Arabic):\n«${mission.request_text}»\n\nThe APPROVED plan (carry it out):\n${JSON.stringify({ summary: plan.summary_ar, stages }, null, 1)}\n\n${savedCallsNote(calls)}\n\nCollect, save the final rows stage by stage with save_rows, then finish.`;
}

const clear = { worker_id: null, lease_until: null } as const;
/** DT-20261117-06 M5 (D-0031, K-2): the customer texts of the mission paths that ended with no settlement: no failure word, no Latin letter, no referral, and no money claim the code has not confirmed. */
const MISSION_NOT_STARTED_AR = "تعذّر بدء تنفيذ طلبك لأن خطته المعتمدة أو حجزه غير مكتمل لدينا، ولم يُسلَّم منه شيء.";
const settlementPendingAr = (rows: number): string => `تعذّر إتمام تسوية طلبك آليًا، لذلك لم يتحدد بعد عدد المسلَّم من ${toArabicDigits(rows)} المطلوبة ولا قيمة الخصم.`;

/**
 * PUTS A MISSION BACK IN THE QUEUE: a mission that holds a reserve goes back to «approved» with everything it saved, planning goes back to «queued», with no worker and no lease so any worker takes it.
 * `cause` is why: "memory" (the worker stopped the run at the dyno's hard limit) or "error" (the run ended with an exception); each has its own count (run_state.json) and its own limit, after which this returns false and
 * the caller ends the mission honestly. The count is a note: if it cannot be saved the in-process copy still stops a loop.
 */
type RequeueCause = "memory" | "error" | "restart";
const REQUEUE_LIMIT: Record<RequeueCause, number> = { memory: AGENT_MEMORY_REQUEUES_MAX, error: AGENT_ERROR_REQUEUES_MAX, restart: AGENT_RESTART_REQUEUES_MAX };
const REQUEUE_COUNTER: Record<RequeueCause, keyof Pick<RunState, "memoryRequeues" | "errorRequeues" | "restartRequeues">> = { memory: "memoryRequeues", error: "errorRequeues", restart: "restartRequeues" };
const REQUEUE_MESSAGE_AR: Record<RequeueCause, string> = {
  memory: "تأجّلت مهمتك قليلًا بسبب ضغط على الخدمة، وستُستأنف تلقائيًا من حيث وصلت.",
  error: "تعثّرت الخطوة الأخيرة مؤقتًا، وستُستأنف مهمتك تلقائيًا من حيث وصلت.",
  restart: "أُعيد تشغيل الخدمة أثناء العمل على مهمتك، وستُستأنف تلقائيًا من حيث وصلت.",
};

/**
 * A RUN THE PLATFORM CUT SHORT: the worker was told to stop (SIGTERM at a deploy: `output.stop === "restart"`), or the model's own process died with that signal (exit code 143, or 137 for SIGKILL) before the worker's handler could say so. It is
 * never the customer's request that failed: the mission goes back to the queue (planning) or to «approved» with everything it saved (execution), and the next worker takes it.
 */
export const endedByRestart = (output: { stop?: string; error?: string }): boolean =>
  output.stop === "restart" || (output.stop === "error" && /exited with code (?:143|137)\b|\bSIGTERM\b|\bSIGKILL\b|terminated by signal/i.test(String(output.error ?? "")));

/**
 * PUTS A MISSION BACK IN THE QUEUE: a mission that holds a reserve goes back to «approved» with everything it saved, planning goes back to «queued», with no worker and no lease so any worker takes it.
 * `cause` is why: "memory" (the worker stopped the run at the dyno's hard limit), "restart" (the platform restarted the worker) or "error" (the run ended with an exception); each has its own count (run_state.json) and its own limit, after which this returns false and
 * the caller ends the mission honestly. The count is a note: if it cannot be saved the in-process copy still stops a loop.
 */
async function requeue(deps: RunnerDeps, mission: MissionRecord, status: "queued" | "approved", patch: Record<string, unknown>, cause: RequeueCause): Promise<boolean> {
  const state = await readRunState(deps.store, mission.id);
  const counter = REQUEUE_COUNTER[cause];
  const max = REQUEUE_LIMIT[cause];
  if (state[counter] >= max) return false;
  const next = await updateRunState(deps.store, mission.id, (s) => ({ ...s, [counter]: s[counter] + 1 }), deps.log);
  await deps.store.updateMission(mission.id, { ...patch, status, worker_id: null, lease_until: null });
  const n = next[counter];
  await deps.store.addEvent(mission.id, { kind: "system", message_ar: REQUEUE_MESSAGE_AR[cause], counts: { requeued: n } });
  deps.log?.(`requeue_${cause} ${mission.id} -> ${status} (${n} of ${max})`);
  return true;
}

/** The customer's notice (in-site and e-mail); never lets a failed notice change the mission. */
async function tell(deps: RunnerDeps, mission: MissionRecord, jobId: string | null, kind: MissionNoticeKind, facts: MissionNoticeFacts): Promise<void> {
  try { await deps.notify?.({ userId: mission.user_id, missionId: mission.id, jobId, kind, facts }); } catch (e) { deps.log?.(`notice_failed ${mission.id} ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
}

/**
 * ONE MODEL TURN OF A PLANNING RUN, stored as an internal event (S1 item 0.4, docs/REDESIGN-PLAN.md F10): the turn number, THIS turn's tokens and the worker's memory at that moment. Counts only: no model text, no provider name. Never throws.
 */
async function recordTurn(deps: RunnerDeps, missionId: string, t: { turn: number; usage: TokenUsage }): Promise<void> {
  try {
    await deps.store.addEvent(missionId, { kind: "call", message_ar: "قياس داخلي لدور واحد من أدوار النموذج.", counts: {
      turn_n: t.turn, turn_in: t.usage.input_tokens ?? 0, turn_out: t.usage.output_tokens ?? 0, turn_cache_read: t.usage.cache_read_input_tokens ?? 0, turn_cache_write: t.usage.cache_creation_input_tokens ?? 0,
      turn_rss_mb: Math.max(1, Math.round(process.memoryUsage().rss / 1_048_576)),
    } });
  } catch (e) {
    deps.log?.(`turn_not_recorded ${missionId} ${shortMessage(e)}`);
  }
}
/**
 * THE TOKENS OF A RUN, stored as an INTERNAL event of the mission (the admin page reads it; the customer never does): the agent's input, output, cache-read and cache-write tokens of this phase, the model review's
 * own tokens, and the model cost in millionths of a dollar. This is the account the cost audit checks the recorded cost against. Never throws.
 */
async function recordTokens(deps: RunnerDeps, missionId: string, phase: 0 | 1, usage: TokenUsage | undefined, review: { inputTokens: number; outputTokens: number; calls: number }, llmUsd: number): Promise<void> {
  try {
    const u = usage ?? {};
    await deps.store.addEvent(missionId, { kind: "call", message_ar: "قياس داخلي لاستهلاك النموذج في هذه الخطوة.", counts: {
      tok_phase: phase, tok_in: u.input_tokens ?? 0, tok_out: u.output_tokens ?? 0, tok_cache_read: u.cache_read_input_tokens ?? 0, tok_cache_write: u.cache_creation_input_tokens ?? 0,
      tok_review_in: review.inputTokens, tok_review_out: review.outputTokens, tok_review_calls: review.calls, llm_micro_usd: Math.round(llmUsd * 1_000_000),
    } });
  } catch (e) {
    deps.log?.(`tokens_not_recorded ${missionId} ${shortMessage(e)}`);
  }
}
/**
 * THE REPORT OF THE CHECK OF ITEMS: stored as an internal event per stage (found, new, duplicates, looked at, accepted by rule and on what basis, accepted by the model, left out per reason, still pending, never looked at, the review's
 * extension) and the excluded items as an admin-only CSV. Every number is read from the item store's snapshot. The customer's files never hold an excluded item. Never throws.
 */
async function recordChecks(deps: RunnerDeps, missionId: string, plan: PricedPlan, store: AgentStore, snap: ItemSnapshot): Promise<{ pending: number; stop: "budget" | "failed" | null; languageLeftOut: number; lastUnusable: string; failedCalls: number }> {
  let pendingTotal = 0;
  let languageLeftOut = 0;
  let stop: "budget" | "failed" | null = null;
  let lastUnusable = "";
  let failedCalls = 0;
  try {
    const review = await readReviewState(store, missionId);
    stop = review.stop;
    lastUnusable = review.lastUnusable;
    failedCalls = review.failedCalls;
    const excludedByStage: Record<string, ExcludedRow[]> = {};
    for (const [i, s] of plan.stages.entries()) {
      const c = snap.counts(s.key);
      const asRow = (it: { id: string; reason?: string; row: Record<string, unknown> | null }): ExcludedRow => ({ id: it.id, reason: it.reason as RelevanceReason | FilterReason, row: it.row ?? {} });
      const listed = [...snap.excludedItems(s.key), ...snap.pendingItems(s.key)].filter((it) => it.row && it.reason && (RELEVANCE_REASON_KEYS as readonly string[]).includes(it.reason)).map(asRow);
      if (listed.length > 0) excludedByStage[s.key] = listed;
      pendingTotal += c.pending;
      if (s.deliver) languageLeftOut += c.excludedByReason.filter_language ?? 0;
      if (!s.relevance && !(s.filters ?? []).some(isEnabled)) continue;
      const counts: Record<string, number> = { chk_stage: i + 1, chk_examined: c.checked, chk_by_rule: c.acceptedByRule, chk_by_model: c.acceptedByModel, chk_excluded: c.excludedRelevance, chk_pending: c.pending, chk_review_extended: review.extended ? 1 : 0, chk_found: c.found, chk_new: c.new, chk_dup: c.duplicates, chk_unchecked: c.unchecked, chk_saved: c.saved };
      for (const [b, n] of Object.entries(c.acceptedByRuleBasis)) counts[`chk_rule_${b}`] = n ?? 0;
      for (const [r, n] of Object.entries(c.excludedByReason)) if ((RELEVANCE_REASON_KEYS as readonly string[]).includes(r)) counts[`chk_ex_${r}`] = n ?? 0;
      await store.addEvent(missionId, { kind: "call", message_ar: "تقرير داخلي لفحص العناصر في هذه المرحلة.", counts });
    }
    const csv = buildExcludedAdminCsv(plan, excludedByStage);
    if (csv) await store.putFile(missionId, "admin/excluded.csv", csv, "text/csv");
  } catch (e) {
    deps.log?.(`checks_not_recorded ${missionId} ${shortMessage(e)}`);
  }
  return { pending: pendingTotal, stop, languageLeftOut, lastUnusable, failedCalls };
}
const RELEVANCE_REASON_KEYS = [...RELEVANCE_REASON_LIST, ...FILTER_REASONS] as const;

/**
 * THE COMPANIES' OWN E-MAILS: the rows of a people stage that were not people (a role or generic mailbox, a row with no person's name: people.ts) were kept with their reason and their address. They go to the sheet of the companies, one cell per company
 * (workbook.ts); here they are gathered by company, in the order the source gave them, each address once. Only what the log recorded: never an address that was not in a row.
 */
export function companyMailboxesOf(plan: PricedPlan, snap: ItemSnapshot): CompanyMailboxes {
  const out: CompanyMailboxes = {};
  for (const s of plan.stages) {
    if (s.parent_key === null || !isPeopleStage(s)) continue;
    // only the stage whose rows ARE the companies: a mailbox found for a PERSON (a step under a people stage) is not a company e-mail
    const parentStage = plan.stages.find((p) => p.key === s.parent_key);
    if (!parentStage || isPeopleStage(parentStage)) continue;
    const byParent = out[s.parent_key] ?? (out[s.parent_key] = new Map());
    for (const it of snap.excludedItems(s.key)) {
      if (it.reason !== "not_a_person" || !it.row) continue;
      const parentId = String(it.row.parent_id ?? "").trim();
      if (!parentId) continue;
      const have = byParent.get(parentId) ?? [];
      for (const email of mailboxesOf(it.row, s.columns)) if (!have.includes(email)) have.push(email);
      if (have.length > 0) byParent.set(parentId, have);
    }
  }
  return out;
}
/** True when a text carries a number (Latin or Arabic-Indic digits): a model note with one is dropped, so a count in a text always comes from the data. */
export const HAS_NUMBER = /[0-9٠-٩]/;

/** Why fewer items than requested were delivered, in plain Arabic and with no number: the review's limit or a failure when rows were waiting for it, else that the sources gave no more matching items. */
export function shortfallReasonAr(checked: { pending: number; stop: "budget" | "failed" | null }): string {
  if (checked.pending > 0 && checked.stop === "failed") return "لم يكتمل العدد المطلوب لأن المراجعة الآلية تعذّر الوصول إليها لبعض ما وُجد، فلم يُسلَّم ما لم يُراجَع، ولم يُخصم إلا مقابل ما سُلّم.";
  if (checked.pending > 0) return "لم يكتمل العدد المطلوب لأن المراجعة الآلية بلغت حدّها المسموح لهذه المهمة قبل فحص كل ما وُجد، فلم يُسلَّم ما لم يُراجَع، ولم يُخصم إلا مقابل ما سُلّم.";
  return "لم يكتمل العدد المطلوب لأن هذا كل ما وُجد مطابقًا لطلبك ضمن حدود المصادر والميزانية، ولم يُخصم إلا مقابل ما سُلّم.";
}

const shortMessage = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 120);

/** The planning run of a compiled plan: no model was asked, nothing was spent on one. */
const COMPILED_RUN: Awaited<ReturnType<ModelDriver["run"]>> = { llmCostUsd: 0, turns: 0, stop: "end" };

/** A planning that cannot be completed ends here, honestly: nothing was held, the customer is told once. */
async function endPlanningUnserved(deps: RunnerDeps, mission: MissionRecord, error: string): Promise<void> {
  await deps.store.updateMission(mission.id, { status: "failed", error: error.slice(0, 300), ...clear });
  await deps.store.addEvent(mission.id, { kind: "result", message_ar: "تعذّر على الوكيل إعداد خطة لهذا الطلب؛ لم يُحجز أي رصيد." });
  await tell(deps, mission, null, "failed", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false });
}

export async function runPlanning(deps: RunnerDeps, mission: MissionRecord): Promise<void> {
  // ROUND 62: with the spend gate on, this mission's direct model requests (review.ts) are gated; off: deps unchanged
  deps = withMissionSpendGate(deps, mission.id);
  const { store } = deps;
  const model = deps.models.planning;
  // a mission whose planning has started too many times (it keeps failing or keeps killing its worker) ends honestly instead of looping
  const started = await updateRunState(store, mission.id, (r) => ({ ...r, planningStarts: r.planningStarts + 1 }), deps.log);
  if (started.planningStarts > AGENT_PHASE_STARTS_MAX) { await endPlanningUnserved(deps, mission, `planning started ${started.planningStarts} times`); return; }
  await store.updateMission(mission.id, { planning_model: model, error: null });
  await store.addEvent(mission.id, { kind: "system", message_ar: started.planningStarts > 1 ? "استأنف الوكيل دراسة طلبك من حيث توقّف." : "بدأ الوكيل دراسة طلبك." });
  // PR-1.2: THE SETTINGS, read ONCE for the whole planning run, and the flag `semantic_normalization_v1` taken from them (OFF unless the owner set it; never from the customer). The same boolean reads the request at every place below that builds its contract, and goes to the
  // compiler, so the platform decision, the route and the plan's parameters can never disagree about it. The stored plan is what execution runs, so the worker does not read the request again there.
  const settings = (await store.readSettings().catch(() => ({}))) as Record<string, unknown>;
  const semantic = readSemanticNormalizationFlag(settings, mission.user_id);
  // ROUND 25 (live msn_04afab34…): THE PLATFORM THE CUSTOMER CHOSE at «من أنهي منصة؟» is kept in the run note, because the answer of the next card (the count) REPLACES `answer_text`; the request is read with it for the whole mission,
  // so the count answer no longer drops the platform (it did: the third run saw no platform and went to the legacy model path, one paid search, then «مصادرنا لا تخدم»)
  {
    const note = await readRunState(store, mission.id);
    const tapped = platformOptionOf(mission.answer_text);
    const noPlatformOfItsOwn = buildRequestContract(mission.request_text, undefined, { semantic }).platform === null;
    const platformChoice = noPlatformOfItsOwn ? (tapped ?? note.platformAnswer ?? null) : null;
    if (tapped && noPlatformOfItsOwn && note.platformAnswer !== tapped) await updateRunState(store, mission.id, (r) => ({ ...r, platformAnswer: tapped }), deps.log);
    if (platformChoice) mission = withPlatformChoice(mission, platformChoice);
  }
  const calls = await store.listCalls(mission.id);
  const access = await deps.resolveAccess(mission.user_id);
  const counter = { seq: lastSeq(calls) };
  const requestForBudget = askedTextOf(mission);
  // THE MEASUREMENT AND THE HEALTH OF THE SOURCES, read from the recorded calls of all missions (read only; planning never waits on it): the ranking the planner gets is computed from them
  const planningNow = Date.now();
  const sourceStats = statsFromCalls(await store.recentCalls(planningNow - AGENT_SOURCE_MEASURE_WINDOW_MS).catch(() => []));
  // THE PLANNING BUDGET is the base figure, or what one minimal sample per stage costs on the platform's sources, under a hard cap (planningBudget.ts): decided by code from the customer's words and the catalog, never by the model
  const budgetFacts = planningBudgetFacts(requestForBudget, { catalog: deps.catalog, access, stats: sourceStats, now: planningNow });
  const budget = createJobCallBudget({ ceilingUsd: budgetFacts.budgetUsd, spentUsd: sum(calls, "planning") });
  deps.log?.(`planning_budget ${mission.id} base=${budgetFacts.baseUsd} budget=${budgetFacts.budgetUsd} cap=${budgetFacts.capUsd} stages=${budgetFacts.stages.map((s) => `${s.role}:${s.sourceId ?? "none"}:${s.callUsd.toFixed(5)}:reserve=${s.reserveUsd}`).join("|")}`);
  const gateway = createGateway({ store, client: deps.client, missionId: mission.id, userId: mission.user_id, jobId: null, phase: "planning", access, catalog: deps.catalog, budget, recorder: deps.recorder, commit: deps.commit, call: deps.call, token: deps.token, defaultPurpose: mission.request_text, counter, priorCalls: calls, stats: sourceStats, stageBudget: { stages: budgetFacts.stages.length, budgetUsd: budgetFacts.budgetUsd, reservesUsd: budgetFacts.stages.filter((s) => s.role !== "parent" && s.role !== "only").map((s) => s.reserveUsd) }, ...spendGateOf(deps, mission.id) });
  // THE WEB TOOLS ONLY WHEN THE WORKER HAS A KEY FOR THEM (webAvailability.ts): a tool that would only be refused is not offered, not listed, not named in the prompt
  const webAvailable = deps.providerKey ? await resolveWebAvailability(deps.providerKey) : NO_WEB;
  deps.log?.(`web_tools ${mission.id} firecrawl=${webAvailable.firecrawl} contextdev=${webAvailable.contextdev}`);
  // (round 53) the same two booleans for the ADMIN, in the database: production had 71 web calls refused «no key» on Oct 29-30 and none offered since, although the keys are stored; whether the deployed worker can
  // reach Firecrawl and Context.dev is now provable per mission (never a key, never shown to the customer)
  if (deps.providerKey) await store.addEvent(mission.id, { kind: "call", message_ar: "قياس داخلي للمشرف: توفر مصادر الويب لهذا التخطيط.", counts: { adm_web_firecrawl: webAvailable.firecrawl ? 1 : 0, adm_web_contextdev: webAvailable.contextdev ? 1 : 0 } }).catch(() => undefined);
  const web = deps.providerKey && anyWebAvailable(webAvailable) ? createWebGateway({ store, missionId: mission.id, jobId: null, phase: "planning", budget, recorder: deps.recorder, providerKey: deps.providerKey, fetchFn: deps.fetchFn, counter, ...spendGateOf(deps, mission.id) }) : undefined;
  const state = newRunState(await lastOut(store, mission.id));
  const pricingSettings = normalizeMissionPricingSettings(settings[MISSION_PRICING_SETTING_KEY]);
  // LLM-FIRST PLANNER (owner direction, 15 Nov 2026; agent/src/llmPlanner): the planning model reads the customer's own words, chooses the catalog's tools and writes their inputs; code checks them against the catalog,
  // reads one real page per step and prices. It runs BEFORE every word rule below, for every platform the catalog serves; company and people research goes on to its own live-proven path. Switch `llm_planner_v1` (on unless set false).
  // (with the hard spend gate active for this mission the planner does not run: its long structured requests are not on the gate's reviewed call path; production runs with the gate unset)
  // DT-20261118-03 PR-7: the request's STRUCTURE as the planner understood it (a people step under a companies step) reaches catalog_search of the path below
  let understoodPeople: ReturnType<typeof understoodPeopleOf> = null;
  let peopleRoleTitleAr: string | null = null;
  let understoodCompanies: UnderstoodCompaniesSummary | undefined;
  let plannerUnderstanding: Understanding | null = null;
  // the planner ran and answered (a plan, a question, a hand-over, or a failure to read it): the agent path below is never allowed to ask the customer (DT-20261119-03 R2)
  let plannerRan = false;
  if (deps.plannerModel && llmPlannerOn(settings) && !(deps.spendGate && deps.spendGate.active(mission.id))) {
    const words = deps.readMissionWords ? await deps.readMissionWords(mission.id, mission.user_id).catch(() => null) : null;
    const llmBefore = Number((await store.getMission(mission.id))?.planning_llm_usd ?? mission.planning_llm_usd ?? 0);
    let r: Awaited<ReturnType<typeof runLlmPlanning>> | null = null;
    try {
      // its own planning budget (the cap of every planning), not the word-sized stage reserves of the earlier paths: the model decides the steps
      const llmGateway = createGateway({ maxSamplesPerSource: LLM_PLANNER_MAX_SAMPLES_PER_SOURCE, store, client: deps.client, missionId: mission.id, userId: mission.user_id, jobId: null, phase: "planning", access, catalog: deps.catalog, budget: createJobCallBudget({ ceilingUsd: AGENT_PLANNING_BUDGET_CAP_USD, spentUsd: sum(calls, "planning") }), recorder: deps.recorder, commit: deps.commit, call: deps.call, token: deps.token, defaultPurpose: mission.request_text, counter, priorCalls: calls, stats: sourceStats, ...spendGateOf(deps, mission.id) });
      r = await runLlmPlanning({ mission, store, gateway: llmGateway, ...(web ? { web, webAvailable } : {}), catalog: deps.catalog, access, model: deps.plannerModel, words, pricingSettings, availablePoints: async () => { const balance = await getBalance(deps.client, mission.user_id).catch(() => null); return typeof balance === "number" && Number.isFinite(balance) ? Math.max(0, Math.floor(balance)) : null; }, now: Date.now(), ...(deps.log ? { log: deps.log } : {}) });
    } catch (e) {
      deps.log?.(`llm_planner_error ${mission.id} ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
    if (r) {
      const llmUsd = Number((llmBefore + r.costUsd).toFixed(6));
      deps.log?.(`llm_planner ${mission.id} kind=${r.kind}${r.kind === "cannot" ? ` detail=${r.detail}` : ""} usd=${r.costUsd.toFixed(4)}`);
      plannerRan = true;
      if (r.understanding) {
        plannerUnderstanding = r.understanding;
        understoodPeople = understoodPeopleOf(r.understanding.steps, r.understanding.people_of_companies, r.understanding.companies_count);
        peopleRoleTitleAr = r.understanding.people_of_companies?.title_ar ?? null;
        const compStep = r.understanding.steps.find((s) => !s.parent);
        if (compStep) {
          understoodCompanies = {
            title_ar: compStep.title_ar,
            topic: compStep.topic ?? null,
            search_terms: compStep.search_terms ?? [],
            country: compStep.country ?? null,
            expected_rows: (compStep.count && !compStep.count.all ? compStep.count.total : null) ?? r.understanding.companies_count ?? null,
          };
        }
      }
      if (r.understanding) await store.addEvent(mission.id, { kind: "call", message_ar: toArabicDigits(`قياس داخلي: فهم النموذج للطلب: ${r.understanding.understanding_ar.replace(/[A-Za-z@_/:.]+/g, " ")}`).replace(/\s+/g, " ").slice(0, 900), counts: { llm_planner: 1, steps: r.understanding.steps.length, questions: r.asked } }).catch(() => undefined);
      if (r.kind === "plan") {
        let plan = r.plan;
        plan = await withCustomerExclusion({ plan, mission, store, settings, read: deps.readMissionExclusion });
        const priorDelivery = await priorDeliveryForPlanning({ mission, store, ...(deps.readPriorDeliveryCard ? { readCard: deps.readPriorDeliveryCard } : {}), ...(deps.readDeliveredMissions ? { readMissions: deps.readDeliveredMissions } : {}) }).catch(() => null);
        plan = await withPriorDelivery(plan, mission.id, store, priorDelivery);
        await store.updateMission(mission.id, { planning_llm_usd: llmUsd, ...clear, status: "plan_ready", plan: plan as any, plan_public: publicPlanOf(plan) as any, unit_price_points: plan.price.unitPricePoints, reserved_points: plan.price.reservePoints });
        await store.addEvent(mission.id, { kind: "plan", message_ar: plan.summary_ar, counts: { stages: plan.stages.length, rows: plan.price.deliveredRows, unit_points_x1000: Math.round(plan.price.unitPricePoints * 1000), reserve_points: plan.price.reservePoints } });
        deps.log?.(`plan_ready ${mission.id} ${JSON.stringify(customerPlanView(plan).price)}`);
        return;
      }
      if (r.kind === "question") {
        await store.updateMission(mission.id, { planning_llm_usd: llmUsd, ...clear, status: "needs_input", question_ar: r.question_ar, plan_public: { question_options: r.options_ar } as any });
        await store.addEvent(mission.id, { kind: "question", message_ar: r.question_ar });
        return;
      }
      if (r.detail === "model_cannot" || r.detail === "no_step_served") {
        const sentence = `${r.reason_ar.trim() !== "" ? r.reason_ar.trim().replace(/[.،\s]*$/u, ".") : "لم نجد مصدرًا متاحًا الآن يعطي ما طلبته."} لم يُخصم منك شيء.`;
        await store.updateMission(mission.id, { planning_llm_usd: llmUsd, ...clear, status: "unserved", summary_ar: sentence });
        await store.addEvent(mission.id, { kind: "result", message_ar: sentence });
        await tell(deps, mission, null, "unserved", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false });
        return;
      }
      // handed over (company or people research), the model could not be read, or too many questions: the earlier path plans, with this cost already counted
      await store.updateMission(mission.id, { planning_llm_usd: llmUsd }).catch(() => undefined);
    }
  }
  // THE REDESIGN FLAGS (S1 item 0.1): read once at the start of the run; every one is off unless the owner switched it
  const redesign = { flags: readRedesignFlags(settings), isTest: await accountIsTest(store, mission.user_id), platformFlags: readPlatformFlagsOf(settings), platform: buildRequestContract(mission.request_text, mission.answer_text, { semantic }).platform };
  // PR B (round 18), ONE PATH FOR SOCIAL: a request on TikTok, X, Instagram, Facebook or YouTube is planned by the plan compiler or not at all. The platform's own switch decides: «تشغيل» (and «تجريبي» for a test account) = the compiled path; «إيقاف» (or no value) = the platform is NOT OFFERED:
  // the customer is told so honestly BEFORE any planning call (no source is read, no model is paid, nothing is held). There is no model-planned social pipeline any more, and no fallback to it.
  const compiledActive = compiledPlatformActive(redesign.platformFlags, redesign.platform, redesign.isTest);
  if (isSocialPlatform(redesign.platform) && !compiledActive && !modelPlanningForTests()) {
    await store.updateMission(mission.id, { status: "unserved", summary_ar: SOCIAL_NOT_OFFERED_AR, ...clear });
    await store.addEvent(mission.id, { kind: "call", message_ar: "قياس داخلي: منصة اجتماعية غير مفعّلة، لم يُجرَ أي تخطيط.", counts: { compiled: 0, social_not_offered: 1 } }).catch(() => undefined);
    await store.addEvent(mission.id, { kind: "result", message_ar: SOCIAL_NOT_OFFERED_AR });
    await tell(deps, mission, null, "unserved", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false });
    return;
  }
  // UNIFIED CAPABILITY DISCOVERY (docs/UNIFIED-CAPABILITY-DISCOVERY.md), only when `capability_discovery_v1` is on for this account (off: null, and the planning below is exactly what it was). Read from the local catalog, the web sources, the
  // account's policy, the providers' keys and caps: NO provider call and no model call. The social compiled path keeps its own cards (its plan is recorded against the discovery); the model-planned path may plan only validated capabilities.
  let discovery: CapabilityDiscovery | null = null;
  let planMission: MissionRecord = mission;
  const initialRunState = await readRunState(store, mission.id);
  const isRecoveryRetry = initialRunState.peopleRecoveryAsked === true && isPeopleRetryChoice(mission.answer_text);
  const plannerDecidedCompaniesOnly =
    Boolean(mission.answer_text) &&
    !isRecoveryRetry &&
    plannerRan &&
    !understoodPeople;
  const forceCompaniesOnly =
    (initialRunState.peopleRecoveryAsked === true && isCompaniesOnlyChoice(mission.answer_text)) ||
    plannerDecidedCompaniesOnly;
  if (readCapabilityDiscoveryFlag(settings, mission.user_id)) {
    const caps = deps.providerDailyCaps ? await deps.providerDailyCaps().catch(() => undefined) : undefined;
    const today = deps.providerToday ? await deps.providerToday().catch(() => undefined) : undefined;
    // PHASE 4, switch `registry_router` (OFF): the router ranks and filters with the reviewed registry (verification levels, Diger's measured yield, runtime health) and the hand ToolCards are part of the registry
    const routerOn = readRegistryRouterFlag(settings, mission.user_id);
    const registry = buildCapabilityRegistry(deps.catalog, { isAllowed: (id) => !blockedEndpointReason(id) && policyVerdict(id, access).allowed, webKeys: deps.providerKey ? webAvailable : NO_WEB, ...(caps ? { dailyCapUsd: caps } : {}), ...(today ? { spentTodayUsd: today.spentTodayUsd, ...(typeof today.tregDailyCapUsd === "number" ? { tregDailyCapUsd: today.tregDailyCapUsd } : {}) } : {}), ...(routerOn ? { handCards: true, extendedFamilies: true } : {}) });
    const routing = routerOn ? routingFactsOf(loadRegistryArtifact(), { minLevel: minLevelFor(redesign.isTest), healthOf: (id) => sourceHealth(sourceStats.get(id), planningNow).state }) : undefined;
    // ORDER 08: When llm_planner_v1 is ON and the worker planner ran, discovery comes from r.understanding (NO stored brief, NO chat/worker decideTurn refinement).
    // The stored brief path remains active ONLY when the planner is off or did not run (rollback compatibility).
    const plannerOnActive = llmPlannerOn(settings) && plannerRan;
    const objectiveResult = plannerOnActive
      ? null
      : await missionObjectivesBrief(deps, mission, initialRunState, { capabilityLines: chatCapabilityLines(registry), semantic });
    const objectiveBriefRaw = objectiveResult?.brief ?? null;
    const objectiveBrief =
      forceCompaniesOnly && objectiveBriefRaw?.objectives && objectiveBriefRaw.objectives.some((o) => o.operation !== "people.discover")
        ? { ...objectiveBriefRaw, objectives: objectiveBriefRaw.objectives.filter((o) => o.operation !== "people.discover") }
        : objectiveBriefRaw;
    if (objectiveResult?.revisedByAnswer) planMission = { ...mission, request_text: objectiveResult.brief.request, answer_text: null };
    // PHASE 2, switch `web_via_treg` (OFF): a companies chain whose websites no companies source documents gains the official-website step reached through the TREG gateway (companies → official website → contacts)
    const rawNeed = researchNeedOf({ request: planMission.request_text, answer: planMission.answer_text, semantic, ...(objectiveBrief ? { brief: objectiveBrief } : {}), ...(routerOn ? { extendedFamilies: true } : {}) });
    const effectiveNeed = plannerOnActive && plannerUnderstanding
      ? needFromPlannerUnderstanding(rawNeed, plannerUnderstanding, { understoodPeople, understoodCompanies, forceCompaniesOnly, isRecoveryRetry })
      : rawNeed;
    const discovered = discoverCapabilities(effectiveNeed, registry, { enrichWebsites: readWebViaTregFlag(settings, mission.user_id), ...(routing ? { routing } : {}) });
    const remainingStages = forceCompaniesOnly ? discovered.stages.filter((s) => s.stage.operation !== "people.discover") : discovered.stages;
    const effectiveDiscovery: CapabilityDiscovery = forceCompaniesOnly && remainingStages.length !== discovered.stages.length
      ? {
          ...discovered,
          stages: remainingStages,
          status: remainingStages.length > 0 && remainingStages.every((s) => s.eligible.length > 0) ? "supported" : discovered.status,
        }
      : discovered;
    discovery = effectiveDiscovery;
    await store.addEvent(mission.id, { kind: "call", message_ar: "قياس داخلي: اكتشاف المصادر القادرة على الطلب.", counts: { capability_discovery: 1, stages: effectiveDiscovery.stages.length, eligible: effectiveDiscovery.stages.reduce((n, s) => n + s.eligible.length, 0), unsupported: effectiveDiscovery.unsupported.length, limitations: effectiveDiscovery.limitations.length } }).catch(() => undefined);
    deps.log?.(`capability_discovery ${mission.id} status=${effectiveDiscovery.status} ${effectiveDiscovery.stages.map((s) => `${s.stage.key}:${s.selected ?? "none"}`).join("|")}`);
    // social data and another kind in one request reach the social compiler, which plans social data only: the other part is never cut silently; the customer is asked first (as for a step no capability serves)
    if (compiledActive && effectiveDiscovery.need.kind === "mixed") {
      const asked = await askReducedScope(deps, mission, `${mixedPartsAr(effectiveDiscovery)} نجهّز الآن جزء وسائل التواصل فقط بخطته وسعره، والجزء الآخر تكتبه في رسالة جديدة؟`);
      if (asked) return;
    }
    if (!compiledActive) {
      if (effectiveDiscovery.status === "blocked" || effectiveDiscovery.status === "unsupported") {
        const sentence = capabilityEndAr(effectiveDiscovery);
        await store.updateMission(mission.id, { status: "unserved", summary_ar: sentence, ...clear });
        await store.addEvent(mission.id, { kind: "result", message_ar: sentence });
        await tell(deps, mission, null, "unserved", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false });
        return;
      }
      if (effectiveDiscovery.status === "partial" && (await askReducedScope(deps, mission, [effectiveDiscovery.messageAr, effectiveDiscovery.alternativeAr].filter(Boolean).join(" ")))) return;
    }
  }
  // ROUND 25: THE LEGACY MODEL-PLANNED PATH TAKES ONLY COMPANIES OR PLACES (platformQuestion.ts). A request with no platform that looks like social data gets the platform card «من أنهي منصة؟»; anything else unclear gets ONE clarifying card. Both come BEFORE any model turn or
  // provider call; nothing is held or charged and no notice is sent for a question. A second unclear answer ends the request honestly with no paid call (never «مصادرنا لا تخدم», and an unanswered card is never ended here).
  // with capability discovery on, a request whose data operations code recognized (companies, places, people, the public web) is routed by the discovery above, not by the keyword route: the public web reaches the planner with its validated web capabilities
  const routedByDiscovery = discovery !== null && discovery.need.kind !== "unknown" && discovery.status !== "needs_clarification";
  if (!modelPlanningForTests() && redesign.platform === null && !routedByDiscovery) {
    const route = legacyRouteOf(mission.request_text, mission.answer_text);
    if (route !== "legacy") {
      const note = await readRunState(store, mission.id);
      const platformAsked = note.platformAsked ?? 0;
      const clarifyAsked = note.clarifyAsked ?? 0;
      if (route === "platform_question" && platformAsked === 0 && clarifyAsked === 0) {
        await updateRunState(store, mission.id, (r) => ({ ...r, platformAsked: (r.platformAsked ?? 0) + 1 }), deps.log);
        await store.updateMission(mission.id, { status: "needs_input", question_ar: PLATFORM_QUESTION_AR, plan_public: { question_options: [...PLATFORM_OPTIONS_AR] } as any, ...clear });
        await store.addEvent(mission.id, { kind: "question", message_ar: PLATFORM_QUESTION_AR });
        return;
      }
      if (clarifyAsked === 0) {
        await updateRunState(store, mission.id, (r) => ({ ...r, clarifyAsked: (r.clarifyAsked ?? 0) + 1 }), deps.log);
        await store.updateMission(mission.id, { status: "needs_input", question_ar: CLARIFY_QUESTION_AR, plan_public: { question_options: [...CLARIFY_OPTIONS_AR] } as any, ...clear });
        await store.addEvent(mission.id, { kind: "question", message_ar: CLARIFY_QUESTION_AR });
        return;
      }
      await store.updateMission(mission.id, { status: "unserved", summary_ar: UNCLEAR_END_AR, ...clear });
      await store.addEvent(mission.id, { kind: "call", message_ar: "قياس داخلي: طلب غير واضح بعد سؤالين، لم يُجرَ أي تخطيط.", counts: { compiled: 0, unclear: 1 } }).catch(() => undefined);
      await store.addEvent(mission.id, { kind: "result", message_ar: UNCLEAR_END_AR });
      await tell(deps, mission, null, "unserved", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false });
      return;
    }
  }
  const calledPlanningEps = new Set(calls.filter((c) => (c.phase ?? "planning") === "planning").map((c) => c.endpoint_id));
  const discoveryPeople = discovery?.stages.find((s) => s.stage.operation === "people.discover");
  const untriedEligiblePeople = (discoveryPeople?.eligible ?? []).filter((e) => !calledPlanningEps.has(e.id)).map((e) => e.id);
  const retryGuidance = isRecoveryRetry
    ? `\n\nThe customer chose to retry finding company decision-makers. ${untriedEligiblePeople.length > 0 ? `Untried eligible people sources to try now: ${untriedEligiblePeople.join(", ")}.` : "No remaining untried eligible people sources exist; propose a companies-only plan from saved company evidence or finish cleanly."}`
    : forceCompaniesOnly
      ? "\n\nThe customer chose to continue with companies only. Propose a companies-only plan using the saved companies evidence without a people stage."
      : "";
  const capabilityPrompt = (discovery && !compiledActive && discovery.stages.length > 0 ? `\n\n${plannerCapabilitySection(discovery)}` : "") + retryGuidance;
  const ctx: ToolContext = { redesign, phase: "planning", mission: planMission, plan: null, store, gateway, web, webAvailable, catalog: deps.catalog, access, state, sandbox: deps.sandbox, log: deps.log, pricingSettings, stats: sourceStats, now: planningNow, ...(forceCompaniesOnly ? { forceCompaniesOnly: true } : {}), ...(isRecoveryRetry ? { isRecoveryRetry: true } : {}), ...(understoodPeople ? { peopleOfCompanies: true, understoodPeople } : {}), ...(peopleRoleTitleAr ? { peopleRoleTitleAr } : {}), ...(understoodCompanies ? { understoodCompanies } : {}), ...(plannerRan ? { plannerRan: true } : {}), ...(discovery && !compiledActive && discovery.stages.length > 0 ? { capabilities: discovery } : {}) };
  // AN AMBIGUOUS TOPIC IS ASKED BEFORE PLANNING (S8, owner decision; redesigned mode only): «فيديوهات الذكاء الاصطناعي» may mean videos that TALK ABOUT it or videos MADE WITH it; «عن X» means about and «معمول بـ X» means made with, so only the request that says neither is asked, by code, with two ready answers,
  // before any source is read or any model is paid for (the customer's answer is read with the request and decides the meaning)
  if (socialRedesignActive(ctx) && !mission.answer_text) {
    const meaning = topicMeaningOf(mission.request_text);
    if (meaning.kind === "ambiguous" && meaning.topic) {
      const question = topicQuestionAr(meaning.topic);
      await store.updateMission(mission.id, { status: "needs_input", question_ar: question, plan_public: { question_options: TOPIC_OPTIONS_AR(meaning.topic) } as any, ...clear });
      await store.addEvent(mission.id, { kind: "question", message_ar: question });
      return;
    }
  }
  // the model cost of earlier runs of this phase (a requeue, a takeover): this run adds to it, and every model message checkpoints the running total, so a run that is killed still leaves its cost on the mission
  const baseLlm = Number((await store.getMission(mission.id))?.planning_llm_usd ?? mission.planning_llm_usd ?? 0);
  let llmBase = baseLlm;
  const checkpoint = async ({ costUsd }: { costUsd: number }) => { try { await store.updateMission(mission.id, { planning_llm_usd: Number((llmBase + costUsd).toFixed(6)) }); } catch { /* a lost checkpoint never stops a run */ } };
  // THE PLANNING CHECKPOINT (S1 item 1.11, redesigned mode only): what an earlier, stopped run of this planning learned is restored, and after every tool the state is saved again, so a restart or the memory guard no longer throws the run away
  const checkpointOn = (ctx.redesign !== undefined && anyRedesignFlag(ctx.redesign.flags, ctx.redesign.platformFlags)) || readCapabilityDiscoveryFlag(settings, mission.user_id);
  let resumeNote = "";
  let lastNote: string | null = null;
  if (checkpointOn) {
    const earlier = await readPlanningState(store, mission.id);
    if (earlier) { applySnapshot(state, earlier); resumeNote = resumeNoteOf(earlier); lastNote = earlier.summary_ar; }
  }
  const toolsOf = (): ToolSpec[] => (checkpointOn ? buildTools(ctx).map((t) => ({ ...t, handler: async (a: Record<string, unknown>) => { const r = await t.handler(a); if (t.name === "report_progress" && typeof a.message_ar === "string") lastNote = a.message_ar; await writePlanningState(store, mission.id, snapshotOf(state, lastNote), deps.log); return r; } })) : buildTools(ctx));
  const runOnce = async (userPrompt: string): Promise<Awaited<ReturnType<ModelDriver["run"]>>> => {
    try {
      return await deps.driver.run({ phase: "planning", missionId: mission.id, systemPrompt: loadSystemPrompt("planning", deps.systemPromptFile, { web: Boolean(web) }), userPrompt, tools: toolsOf(), state, model, maxTurns: AGENT_PLANNING_MAX_TURNS, maxBudgetUsd: AGENT_PLANNING_LLM_BUDGET_USD, wallMs: AGENT_PLANNING_WALL_MS, onUsage: checkpoint, onTurn: (t) => recordTurn(deps, mission.id, t), ...modelGateOf(deps, mission.id) });
    } catch (e) {
      return { llmCostUsd: 0, turns: 0, stop: "error", error: String((e as Error)?.message ?? e).slice(0, 300) } as Awaited<ReturnType<ModelDriver["run"]>>;
    }
  };
  // THE COMPILED PATH (docs/FOUNDATION-PLAN.md PR 2a): TikTok and X, and only when that platform's OWN flag is `on` (or `test` for a test account), are planned by the plan compiler,
  // by code, with no model: the pool and the exposure check are read through this run's gateway (every cap applies). A request it cannot compile ends with one of the honest classes
  // below, never on the model's path (F6). With the platform flags unset, as today, this is null and the planning below is exactly what it was.
  // THE ANSWER TO THE «NO VIDEO IS ABOUT THE TOPIC» QUESTION (live round 7, topicChoice.ts): «change my request» and «cancel» end this mission before anything is read (nothing was held, nothing is charged); «use them as they are» is read by the compiled planning below
  const noAboutChoice = compiledActive ? noAboutChoiceOf(mission.answer_text) : null;
  // PR 3, decision 7.5 (Facebook, a named page with too few posts): «cancel» ends the mission the same way, before anything is read
  const shortfallChoice = compiledActive ? namedShortfallChoiceOf(mission.answer_text) : null;
  if (noAboutChoice === "cancel" || noAboutChoice === "change" || shortfallChoice === "cancel") {
    const sentence = noAboutChoice !== "change" ? "أُلغيت هذه المهمة ولم يُخصم شيء." : "أُلغيت هذه المهمة ولم يُخصم شيء؛ اكتب طلبك المعدّل في رسالة جديدة.";
    await store.updateMission(mission.id, { status: "cancelled", ...clear });
    await store.addEvent(mission.id, { kind: "result", message_ar: sentence });
    return;
  }
  // DECISION 7 (a recurring event): the occurrence the customer chose is kept in the mission's run note, because the answer of a later question (the Facebook page question) replaces `answer_text`
  let occurrence = compiledActive ? (await readRunState(store, mission.id)).occurrence : undefined;
  const occurrenceAnswer = compiledActive ? occurrenceChoiceOf(mission.answer_text) : null;
  if (occurrenceAnswer && occurrenceAnswer.kind !== "ask_year") { occurrence = occurrenceAnswer; await updateRunState(store, mission.id, (r) => ({ ...r, occurrence: occurrenceAnswer }), deps.log); }
  // F1, THE UNDERSTAND STEP: one small structured model request that names the official channels of a YouTube request (code checks every name against the customer's words); its cost comes from the API's usage and is added to the mission's model cost (never a charge)
  const understand = deps.reviewCall ? async (input: { request: string; topic: string | null }): Promise<{ channels: string[]; costUsd: number } | null> => {
    const got = await deps.reviewCall!({ model: MODEL_HAIKU, system: UNDERSTAND_SYSTEM, user: understandChannelsPrompt(input.request, input.topic), maxTokens: 200 });
    return got ? { channels: parseChannels(got.text) ?? [], costUsd: llmCostFromUsage(MODEL_HAIKU, got.usage) } : null;
  } : undefined;
  // ROUND 14, PART B: the count, the comments per parent and the budget the customer chose are kept in the run note (each answer replaces `answer_text`); a pending question's answer is read here, before the planning
  const prior = compiledActive ? await readRunState(store, mission.id) : null;
  let choices: Choices = prior?.choices ?? {};
  let answerIsChoice = false;
  // STAGE 2 S5 (docs/STAGE-2.md): the question cards of the Stage 2 policy, only when DIGER_STAGE2_QUESTION_CARDS is on for this account; the topic-relation card's answer is kept in the run note
  const stage2Questions = compiledActive && stage2Enabled("DIGER_STAGE2_QUESTION_CARDS", redesign.isTest);
  let topicRelation = stage2Questions ? prior?.topicRelation : undefined;
  if (stage2Questions && prior?.stage2Pending === "topic_relation") {
    const rel = topicRelationAnswerOf(mission.answer_text);
    if (rel) {
      answerIsChoice = true;
      topicRelation = rel;
      await updateRunState(store, mission.id, (r) => { const { stage2Pending: _p, ...rest } = r; void _p; return { ...rest, topicRelation: rel }; }, deps.log);
    }
  }
  // ROUND 30 (Instagram, no account): the customer's answer to «which account» is read by code: an account (username or link) is kept with the choices, anything else is kept as «declined» (the request then ends, it is never asked twice);
  // either way the answer's words are not part of the request (its topic and count stay as written)
  if (compiledActive && prior?.pending === "instagram_account") {
    const handle = instagramAccountOf(mission.answer_text);
    answerIsChoice = true;
    choices = { ...choices, ...(handle ? { instagramAccount: handle } : { instagramAccountDeclined: true }) };
    await updateRunState(store, mission.id, (r) => { const { pending: _p, ...rest } = r; void _p; return { ...rest, choices }; }, deps.log);
  } else if (compiledActive && prior?.pending === "source_id") {
    // P0, 14 NOV 2026 (the general source rule, sourceScope.ts): the answer to the source question is read by code, on every platform: an identifier (the plan is scoped to it), the explicit choice to search without the source, or
    // a cancellation; anything else ends the request honestly (never asked twice). The answer's words are never part of the request (its topic, period and count stay the customer's own)
    const said = sourceAnswerOf(mission.answer_text);
    answerIsChoice = true;
    if (said?.kind === "cancel") {
      await store.updateMission(mission.id, { status: "cancelled", ...clear });
      await store.addEvent(mission.id, { kind: "result", message_ar: SOURCE_CANCELLED_AR });
      return;
    }
    const named = said?.kind === "widen" ? buildAsk(mission.request_text, null, Date.parse(String(mission.created_at ?? "")) || Date.now()).source : null;
    const name = named && named.kind === "named" ? named.text : null;
    choices = { ...choices, ...(said?.kind === "id" ? { sourceId: said.id } : said?.kind === "widen" ? { sourceWiden: true, ...(name ? { sourceName: name } : {}) } : { sourceDeclined: true }) };
    await updateRunState(store, mission.id, (r) => { const { pending: _p, ...rest } = r; void _p; return { ...rest, choices }; }, deps.log);
  } else if (compiledActive && prior?.pending === "youtube_channel") {
    // ROUND 31 (YouTube, no channel): the answer is a channel (kept as the customer's cleaned words) or none (kept as «declined»); its words are not part of the request
    const ref = youtubeChannelOf(mission.answer_text);
    answerIsChoice = true;
    choices = { ...choices, ...(ref ? { youtubeChannel: String(mission.answer_text).replace(/\s+/g, " ").trim().slice(0, 120) } : { youtubeChannelDeclined: true }) };
    await updateRunState(store, mission.id, (r) => { const { pending: _p, ...rest } = r; void _p; return { ...rest, choices }; }, deps.log);
  } else if (compiledActive && prior?.pending === "conditions") {
    // PR-1.3 (flag on only): the answer to the question about a period, a country or a language is kept with the choices (a later question's answer replaces `answer_text`); the conditions reader takes it from there and its words are not part of the request
    answerIsChoice = true;
    const said = String(mission.answer_text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    choices = { ...choices, conditionsAnswer: [choices.conditionsAnswer, said].filter((x): x is string => Boolean(x)).join(" ").slice(-400) };
    await updateRunState(store, mission.id, (r) => { const { pending: _p, ...rest } = r; void _p; return { ...rest, choices }; }, deps.log);
  } else if (compiledActive && choices.youtubeChannel !== undefined && String(mission.answer_text ?? "").replace(/\s+/g, " ").trim().slice(0, 120) === choices.youtubeChannel) {
    answerIsChoice = true;
  } else if (compiledActive && choices.instagramAccount !== undefined && instagramAccountOf(mission.answer_text) === choices.instagramAccount) {
    // a planning that starts again after the answer was read (a restart, a later question): the same answer is still not part of the request
    answerIsChoice = true;
  } else if (compiledActive && !prior?.pending && (choices.sourceId !== undefined || choices.sourceWiden === true) && sourceAnswerOf(mission.answer_text) !== null) {
    // a planning that starts again after the account answer was read (a restart, a later question): the same answer is still not part of the request
    answerIsChoice = true;
  }
  if (compiledActive && prior?.pending && prior.pending !== "instagram_account" && prior.pending !== "youtube_channel" && prior.pending !== "conditions" && prior.pending !== "source_id") {
    const parsed = choiceAnswerOf(mission.answer_text, prior.pending);
    if (parsed) {
      answerIsChoice = true;
      if (parsed.kind === "ask_budget") {
        // «حدد ميزانية بالنقاط»: the next card asks for the number (a typed answer)
        await updateRunState(store, mission.id, (r) => ({ ...r, pending: "budget", questionsAsked: (r.questionsAsked ?? 0) + 1 }), deps.log);
        await store.addEvent(mission.id, { kind: "call", message_ar: "قياس داخلي: سؤال قبل الخطة، الميزانية بالنقاط.", counts: { adm_flag: 0 } }).catch(() => undefined);
        await store.updateMission(mission.id, { status: "needs_input", question_ar: BUDGET_QUESTION_AR, plan_public: { question_options: [] } as any, ...clear });
        await store.addEvent(mission.id, { kind: "question", message_ar: BUDGET_QUESTION_AR });
        return;
      }
      choices = { ...choices, ...(parsed.kind === "count" ? { count: parsed.n } : parsed.kind === "budget" ? { budget: parsed.points } : { perParent: parsed.n }) };
      await updateRunState(store, mission.id, (r) => { const { pending: _p, ...rest } = r; void _p; return { ...rest, choices }; }, deps.log);
    }
  }
  // P0 (15 Nov 2026, msn_5abbc68352f31fa31d56): a source the customer already identified in this conversation (same name, an earlier mission of theirs) is not asked again; a failed read asks as before
  if (compiledActive && !prior?.pending && choices.sourceId === undefined && choices.sourceWiden !== true && choices.sourceDeclined !== true && deps.readConversationMissions) {
    const carried = await conversationSourceIdOf({ mission, store, read: deps.readConversationMissions }).catch(() => null);
    if (carried) {
      choices = { ...choices, sourceId: carried.id };
      await updateRunState(store, mission.id, (r) => ({ ...r, choices }), deps.log);
      await store.addEvent(mission.id, { kind: "call", message_ar: "قياس داخلي: معرّف المصدر من مهمة سابقة في المحادثة نفسها.", counts: { source_carried: 1 } }).catch(() => undefined);
    }
  }
  // STAGE 2 (docs/STAGE-2.md S2): the customer's card edits (create-only objects of the mission's folder), only when DIGER_STAGE2_ASK_CARD is on for this account; unset (today), none is read
  // STAGE 2: a TEST account's mission is marked for the site when some Stage 2 flag says «test» (unset or «on»: nothing is written)
  await markStage2TestAccount(store, mission.id, redesign.isTest);
  const askEdits = compiledActive && stage2Enabled("DIGER_STAGE2_ASK_CARD", redesign.isTest) ? await readAskEdits(store, mission.id) : [];
  // ROUND 33, CATALOG DISCOVERY: with the `social_discovery` switch on `test` and a TEST account, the compiler may also build the parents from a tool derived from the catalog (validated against the catalog and against its comments and replies cards); the model may choose among the validated
  // candidates. Everything else about the mission (the gateway, the price, the hold, the approval, the engine) is what it was.
  const discovered = compiledActive && redesign.platform && discoveryActive(settings, redesign.isTest) ? cardsWithDiscovery(deps.catalog, redesign.platform, access) : null;
  const selectCapability = discovered && deps.reviewCall ? modelSelector(async ({ system, user, maxTokens }) => { const got = await deps.reviewCall!({ model: MODEL_HAIKU, system, user, maxTokens }); return got ? { text: got.text, costUsd: llmCostFromUsage(MODEL_HAIKU, got.usage) } : null; }) : undefined;
  // P0 (15 Nov 2026): «without repeating what was delivered»: the identities of what the conversation's earlier missions delivered (verified as this customer's), read BEFORE the plan is built so a planning sample never
  // chooses or counts one of them; a read that fails throws (the existing error path retries the planning): the customer's requirement is never silently dropped
  const priorDelivery = await priorDeliveryForPlanning({ mission, store, ...(deps.readPriorDeliveryCard ? { readCard: deps.readPriorDeliveryCard } : {}), ...(deps.readDeliveredMissions ? { readMissions: deps.readDeliveredMissions } : {}) });
  const compiled = compiledActive ? await planByCompiler({ mission, gateway, store, catalog: deps.catalog, pricingSettings, ...(priorDelivery && priorDelivery.items > 0 ? { delivered: priorDeliveryMatcherOf(priorDelivery) } : {}), ...(discovered ? { cards: discovered.cards, chainIssues: chainCheckerFor(deps.catalog, access), discoveryRejected: discovered.rejected.map((r) => ({ endpointId: r.endpointId, reason: r.reason })), ...(selectCapability ? { selectCapability } : {}) } : {}), nowMs: planningNow, priorCalls: calls, ...(askEdits.length > 0 ? { askEdits } : {}), ...(stage2Questions ? { questionCards: true, ...(topicRelation ? { topicRelation } : {}) } : {}), ...(understand ? { understand } : {}), ...(occurrence ? { occurrence } : {}), ...(redesign.isTest ? { catalogOnly: true } : {}), askCount: true, choices, questionsAsked: prior?.questionsAsked ?? 0, answerIsChoice, ...(semantic ? { semantic: true } : {}), ...(deps.reviewCall ? { judge: planningJudge(deps.reviewCall, `${mission.request_text}${mission.answer_text ? ` — ${mission.answer_text}` : ""}`, { answer: mission.answer_text }), variants: topicVariants(deps.reviewCall), spec: () => missionResearchSpec(deps, store, mission) } : {}) }) : null;
  // THE QUESTION BEFORE APPROVAL (live round 7): no video of the two pages read is about the topic; the plan is not made, the customer chooses (the same needs_input card as the topic question)
  if (compiled?.kind === "question") {
    // every question card counts toward the three a request may have; a count or comments question also waits for its answer
    await updateRunState(store, mission.id, (r) => ({ ...r, questionsAsked: (r.questionsAsked ?? 0) + 1, ...(compiled.why === "count" || compiled.why === "per_parent" || compiled.why === "instagram_account" || compiled.why === "youtube_channel" || compiled.why === "conditions" || compiled.why === "source_id" ? { pending: compiled.why } : {}), ...(compiled.why === "topic_relation" ? { stage2Pending: "topic_relation" as const } : {}) }), deps.log);
    await store.addEvent(mission.id, { kind: "call", message_ar: compiled.why === "named_shortfall" ? "قياس داخلي: سؤال قبل الخطة، منشورات الصفحة المسمّاة أقل من المطلوب." : compiled.why === "occurrence" || compiled.why === "occurrence_year" ? "قياس داخلي: سؤال قبل الخطة، الحدث يتكرر ولم تُحدَّد سنة." : compiled.why === "conditions" ? "قياس داخلي: سؤال قبل الخطة، فترة أو دولة أو لغة في الطلب تحتاج توضيحًا." : compiled.why === "no_about" ? "قياس داخلي: سؤال قبل الخطة، لا شيء في ما قُرئ يتحدث عن الموضوع." : compiled.why === "source_id" ? "قياس داخلي: سؤال قبل الخطة، المصدر المسمّى يحتاج معرّفه." : `قياس داخلي: سؤال قبل الخطة (${compiled.why}).`, counts: { compiled: 0, question: 1, pool_reads: compiled.reads.pool, exposure_reads: compiled.reads.exposure } }).catch(() => undefined);
    await store.updateMission(mission.id, { status: "needs_input", question_ar: compiled.question, plan_public: { question_options: compiled.options } as any, ...(compiled.llmCostUsd ? { planning_llm_usd: Number((Number((await store.getMission(mission.id))?.planning_llm_usd ?? mission.planning_llm_usd ?? 0) + compiled.llmCostUsd).toFixed(6)) } : {}), ...clear });
    await store.addEvent(mission.id, { kind: "question", message_ar: compiled.question });
    return;
  }
  if (compiled) {
    await store.addEvent(mission.id, { kind: "call", message_ar: "قياس داخلي: خطة مبنية بالكود.", counts: { compiled: compiled.kind === "plan" ? 1 : 0, pool_reads: compiled.reads.pool, exposure_reads: compiled.reads.exposure } }).catch(() => undefined);
    // ROUND 34: the internal record that the catalog discovery was entered for this plan (the full mark is kept with the plan: `compiled.discovery`)
    if (compiled.kind === "plan" && compiled.discovery) {
      const d = compiled.discovery;
      await store.addEvent(mission.id, { kind: "call", message_ar: `قياس داخلي: قُيّمت مصادر الدليل لخطوة ${d.role}، والمختار ${d.endpoint_id}.`, counts: { discovery: 1, eligible: d.evaluation?.eligible.length ?? 0, rejected: Object.values(d.evaluation?.rejected ?? {}).reduce((a, b) => a + b, 0), chain_refused: d.evaluation?.chain_refused.length ?? 0, selected_derived: d.derived ? 1 : 0, selected_by_model: d.selection?.by === "model" ? 1 : 0 } }).catch(() => undefined);
    }
    if (compiled.kind === "plan") state.proposedPlan = compiled.plan;
    else state.finish = { outcome: "cannot_serve", summary_ar: compiled.reason === "budget_too_small" ? BUDGET_TOO_SMALL_AR : compiled.reason === "page_not_found" ? pageNotFoundAr(compiled.ask.source.text) : "", kind: compiled.reason === "no_rows" || compiled.reason === "no_parent_with_children" || compiled.reason === "page_not_found" ? "empty" : "unsupported" };
  }
  // STAGE 3, PART A (docs/STAGE-3.md S3): a companies and decision-makers request is planned BY CODE (stage3/b2bPlanning.ts, verified cards only, priced by the existing function, no read, no model) only when
  // DIGER_STAGE3_COMPANIES is on for this account; the helper reads the flag first and gives null when it is off (unset: always), so the planning below is exactly today's. A request it does not plan keeps today's path.
  const b2b = compiled ? null : planCompaniesByCodeIfOn({ requestText: askedTextOf(mission), isTestAccount: redesign.isTest, catalog: deps.catalog, access, stats: sourceStats, now: planningNow, pricingSettings });
  if (b2b && !(b2b.ok === false && b2b.reason === "not_b2b")) {
    await store.addEvent(mission.id, { kind: "call", message_ar: b2b.ok ? "قياس داخلي: خطة شركات مبنية بالكود." : "قياس داخلي: لم تُبنَ خطة الشركات بالكود، فبقيت الطريقة الحالية.", counts: { b2b_compiled: b2b.ok ? 1 : 0 } }).catch(() => undefined);
    if (b2b.ok) state.proposedPlan = b2b.plan;
  }
  let output = compiled ? { ...COMPILED_RUN, llmCostUsd: compiled.llmCostUsd ?? 0 } : b2b?.ok ? COMPILED_RUN : await runOnce(planningPrompt(planMission, calls, resumeNote) + capabilityPrompt);
  if (!compiled && !b2b?.ok) await recordTokens(deps, mission.id, 0, output.usage, { inputTokens: 0, outputTokens: 0, calls: 0 }, output.llmCostUsd);
  // A RUN THAT ENDED WITH NO PLAN, NO QUESTION AND NO ENDING while the sources gave it real rows (live 2026-10-29: Facebook videos, after the customer answered the question, the planner tried two unavailable web searches and stopped): it is asked once more, told to
  // build the plan from what it holds. Never a limit of ours: the run's stop was a plain end, with no budget, turn or time limit reached.
  for (let nudge = 0; nudge < AGENT_PLANNING_NUDGES_MAX && endedSilently(output, state); nudge += 1) {
    llmBase += output.llmCostUsd;
    const fresh = await store.listCalls(mission.id);
    if (!fresh.some((c) => (c.phase ?? "planning") === "planning" && c.status === "ok" && Number(c.rows_returned ?? 0) > 0)) break;
    output = await runOnce(`${planningPrompt(planMission, fresh, resumeNote)}${capabilityPrompt}\n\n${PLANNING_NUDGE}`);
    await recordTokens(deps, mission.id, 0, output.usage, { inputTokens: 0, outputTokens: 0, calls: 0 }, output.llmCostUsd);
  }
  const llm = Number(llmBase + output.llmCostUsd);
  const base = { planning_llm_usd: Number(llm.toFixed(6)), ...clear };
  if (output.stop === "memory" && !state.proposedPlan && !state.question && !state.finish && await requeue(deps, mission, "queued", { planning_llm_usd: base.planning_llm_usd }, "memory")) return;
  // a deploy restarted the worker while the planning ran (its model process ended with SIGTERM, exit code 143): the planning starts again on the next worker, it is never answered as «a limit of ours»
  if (endedByRestart(output) && !state.proposedPlan && !state.question && !state.finish && await requeue(deps, mission, "queued", { planning_llm_usd: base.planning_llm_usd }, "restart")) return;

  let forceClassifyFromCalls = false;
  const singleRejectionEnd = (state.planRejections?.count ?? 0) === 1 && output.stop === "end" && !state.finish;
  const shouldRecoverSdkStop = !state.proposedPlan && !state.question && !compiled && (!state.finish || state.finishOrigin === "code_forced_cap");
  let recoveryDiag: RecoveryDiagnostic | null = null;
  let recoveryQuestionDiag: RecoveryDiagnostic | null = null;
  if (shouldRecoverSdkStop) {
    const existing = await store.getMission(mission.id).catch(() => null);
    if (!existing || (existing.status !== "plan_ready" && !existing.plan && (!existing.worker_id || existing.worker_id === mission.worker_id))) {
      const recovered = await recoverCompanyPeoplePlan(ctx, deps.log);
      if (!singleRejectionEnd && (recovered.kind === "sources_unavailable" || recovered.kind === "own_limit")) forceClassifyFromCalls = true;
      if (recovered.kind === "question" && recovered.diagnostic) {
        recoveryQuestionDiag = recovered.diagnostic;
      } else if (recovered.kind !== "plan" && recovered.kind !== "question") {
        recoveryDiag = recovered.diagnostic ?? getLastRecoveryDiagnostic(mission.id) ?? { reason: `recovery_${recovered.kind}`, issueCodes: [] };
      }
    } else if (!state.proposedPlan && !state.question) {
      recoveryDiag = { reason: existing.status === "plan_ready" || existing.plan ? "skipped_existing_plan" : "skipped_worker_mismatch", issueCodes: [] };
    }
  } else if (!state.proposedPlan && !state.question && !compiled) {
    const prevDiag = getLastRecoveryDiagnostic(mission.id);
    if (prevDiag && prevDiag.reason !== "not_people_request") {
      recoveryDiag = { reason: `skipped_after_${prevDiag.reason}`, issueCodes: prevDiag.issueCodes, ...(prevDiag.capIssues ? { capIssues: prevDiag.capIssues } : {}) };
    } else if (understoodPeople) {
      recoveryDiag = { reason: `skipped_${state.finishOrigin ?? "model_finish"}`, issueCodes: [] };
    }
  }

  if (state.proposedPlan) {
    // THE CARD HOLDS THE FINAL PRICE (S1 live findings fix 3, redesigned mode only): a stored price that is not the one pricing function's number over the final stages is replaced before the card exists
    let plan = state.proposedPlan;
    if (socialRedesignActive(ctx)) {
      const sealed = sealFinalPrice(plan, pricingSettings);
      plan = sealed.plan;
      if (sealed.drift) await store.addEvent(mission.id, { kind: "call", message_ar: "قياس داخلي: صُحّح سعر الخطة قبل عرضها.", counts: { price_sealed: 1, rows_before: sealed.drift.rowsBefore, rows_after: sealed.drift.rowsAfter, reserve_before: sealed.drift.reserveBefore, reserve_after: sealed.drift.reserveAfter } }).catch(() => undefined);
    }
    // UNIFIED CAPABILITY DISCOVERY: the plan shown with its price carries the record of the exact capability each stage executes (checked again before execution) and, on the model-planned and companies paths, the limitations said before approval
    if (discovery) {
      const limits = compiled ? [] : limitationLinesAr(discovery);
      plan = { ...plan, ...(limits.length > 0 ? { notes_ar: [...new Set([...(plan.notes_ar ?? []), ...limits])] } : {}), capability_selection: capabilitySelectionOf(plan, discovery, { limitationsShown: !compiled }) };
      const rec = plan.capability_selection!;
      // the server's own mark that this plan must carry this record (a removed or replaced record is refused at execution); written BEFORE the plan is shown, and a failure stops here (the mission is retried by the existing error path)
      await writeCapabilityAnchor(store, mission.id, rec.digest);
      await store.addEvent(mission.id, { kind: "call", message_ar: "قياس داخلي: سُجّلت المصادر المعتمدة لكل خطوة مع الخطة.", counts: { capability_record: 1, from_discovery: rec.stages.filter((x) => x.source === "discovery").length, by_code: rec.stages.filter((x) => x.source === "code").length } }).catch(() => undefined);
    } else if (started.planningStarts > 1) {
      // a later planning of a mission whose earlier plan was made through discovery (the switch was turned off since): this plan has no record, and the anchor says so (only a re-planning reads the folder; a first planning has no anchor)
      try { if ((await capabilityAnchorOf(store, mission.id)).required) await writeCapabilityAnchor(store, mission.id, null); } catch (e) { deps.log?.(`capability_anchor_not_cleared ${mission.id} ${String((e as Error)?.message ?? e).slice(0, 80)}`); }
    }
    // PHASE 5.3: the customer's exclusion list (switch ON for the account and a list on the card only; otherwise the same plan object): copied to the private folder and pinned on the plan before it is shown
    plan = await withCustomerExclusion({ plan, mission, store, settings, read: deps.readMissionExclusion });
    // P0: what earlier missions of the conversation delivered, excluded at the customer's request: pinned on the plan (private copy + digest) before it is shown
    plan = await withPriorDelivery(plan, mission.id, store, priorDelivery);
    await store.updateMission(mission.id, { ...base, status: "plan_ready", plan: plan as any, plan_public: publicPlanOf(plan) as any, unit_price_points: plan.price.unitPricePoints, reserved_points: plan.price.reservePoints });
    await store.addEvent(mission.id, { kind: "plan", message_ar: plan.summary_ar, counts: { stages: plan.stages.length, rows: plan.price.deliveredRows, unit_points_x1000: Math.round(plan.price.unitPricePoints * 1000), reserve_points: plan.price.reservePoints } });
    deps.log?.(`plan_ready ${mission.id} ${JSON.stringify(customerPlanView(plan).price)}`);
  } else if (state.question) {
    await store.updateMission(mission.id, { ...base, status: "needs_input", question_ar: state.question });
    if (recoveryQuestionDiag) {
      const recKey = `issue_rec_${recoveryQuestionDiag.reason}`.replace(/[^a-z0-9_]/g, "_").slice(0, 40);
      const recIssueCounts = Object.fromEntries(
        recoveryQuestionDiag.issueCodes
          .map((c) => c.replace(/[^a-z0-9_]/g, "_"))
          .filter(Boolean)
          .slice(0, 12)
          .map((c) => [`issue_${c}`.slice(0, 40), 1]),
      );
      await store.addEvent(mission.id, {
        kind: "call",
        message_ar: "علامة داخلية للمشرف: تعذّر استخدام مصادر مسؤولي الشركات غير المعتمدة، طُلب توضيح العميل.",
        counts: { adm_flag: 1, [recKey]: 1, ...recIssueCounts },
      }).catch(() => undefined);
      deps.log?.(`company_people_recovery_diagnostic ${mission.id} reason=${recoveryQuestionDiag.reason}${recoveryQuestionDiag.issueCodes.length ? ` issues=${recoveryQuestionDiag.issueCodes.join(",")}` : ""}${recoveryQuestionDiag.capIssues?.length ? ` cap_issues=${recoveryQuestionDiag.capIssues.join(" | ")}` : ""}`);
    }
  } else {
    // ROUND 25: a mission that already shows a plan (a stale run racing the card) is never closed as unserved or failed: the stored plan stays for the customer to approve
    const current = await store.getMission(mission.id).catch(() => null);
    if (current && (current.status === "plan_ready" || current.plan)) {
      deps.log?.(`no_card_kept_plan ${mission.id}`);
      // ROUND 56: the lease is cleared only on a row that is still THIS run's (its worker, not yet approved or executing): a stale run must never take the worker and the lease off a mission another worker now executes (a running row with no lease is never claimed again)
      if (current.worker_id === mission.worker_id && (current.status === "planning" || current.status === "plan_ready")) await store.updateMission(mission.id, { ...clear }).catch(() => undefined);
      return;
    }
    // NO CARD: exactly one of four honest classes, decided by code from what the planning really did (src/lib/agentMission/refusal.ts), never from the model's own words
    const planningCalls = await store.listCalls(mission.id);
    const verdict = classifyNoCardEnd({ claim: state.finish?.kind ?? (state.finish ? "unsupported" : null), endedWithoutAnswer: !state.finish && !forceClassifyFromCalls, stop: output.error ? `${output.stop}: ${output.error}` : String(output.stop ?? ""), calls: planningCalls, ...(state.planRejections ? { planRejections: state.planRejections } : {}), ...(understoodPeople ? { peopleAsked: true, peopleEndpointIds: new Set(deps.catalog.endpoints.filter((e) => e.capability && PEOPLE_OF_COMPANY_CAPABILITIES.has(e.capability)).map((e) => e.id)) } : {}) });
    const issueCategories = state.planRejections?.lastCategories ?? [];
    const finishOrigin: "model_finish" | "code_forced_cap" | "sdk_stop" = !state.finish ? "sdk_stop" : (state.finishOrigin ?? "model_finish");
    deps.log?.(`no_card ${mission.id} class=${verdict.cls} reason=${verdict.reason} origin=${finishOrigin}${issueCategories.length ? ` issues=${issueCategories.join(",")}` : ""}`);
    const capIssues = sanitizeCapIssuesForAdmin(recoveryDiag?.capIssues ?? [], 2);
    const postRunState = await readRunState(store, mission.id).catch(() => ({} as RunState));
    const honestRetryOrCompaniesEnd =
      postRunState.peopleRecoveryAsked === true &&
      (isPeopleRetryChoice(mission.answer_text) || isCompaniesOnlyChoice(mission.answer_text));
    if (honestRetryOrCompaniesEnd) {
      const honestSentence = "جُرّبت مصادر المديرين المتاحة حاليًا ولم تتوفر بيانات كافية؛ ولم يُحجز أو يُخصم أي رصيد.";
      await store.updateMission(mission.id, { ...base, status: "unserved", summary_ar: honestSentence });
      await store.addEvent(mission.id, { kind: "result", message_ar: honestSentence });
      await tell(deps, mission, null, "unserved", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false, cause: "empty" });
    } else if (verdict.cls === "internal") {
      // OUR failure: nothing was held; the admin is flagged (the mission's error and an internal event), the customer is told it was ours
      const issueCounts = Object.fromEntries(
        Object.entries(state.planRejections?.categories ?? {})
          .filter(([k, v]) => /^[a-z_]{1,40}$/.test(k) && typeof v === "number" && v > 0)
          .map(([k, v]) => [`issue_${k}`, v]),
      );
      const capDetail = capIssues.length > 0 ? `cap_issues=${capIssues.join("; ")}` : "";
      const detailParts = [output.error, capDetail].filter((x): x is string => Boolean(x && x.trim() !== ""));
      await store.updateMission(mission.id, { ...base, status: "failed", summary_ar: noCardSentenceAr(verdict), error: `admin: planning_failed class=internal reason=${verdict.reason}${detailParts.length ? ` detail=${detailParts.join(" | ")}` : ""}`.slice(0, 300) });
      await store.addEvent(mission.id, { kind: "call", message_ar: "علامة للمشرف: تعذّر التخطيط من جانبنا.", counts: { adm_flag: 1, [`finish_${finishOrigin}`]: 1, ...issueCounts } });
      await store.addEvent(mission.id, { kind: "result", message_ar: noCardSentenceAr(verdict) });
      await tell(deps, mission, null, "failed", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false, cause: "internal" });
    } else {
      // ROUND 30: no usable Instagram account was given: the honest sentence says what the source can do (an account's posts), not the general «our sources do not serve this»
      // P0 (15 Nov 2026): a search that gave no plan says WHAT was searched and what it gave (searchScope.ts), never «we searched the available sources and nothing matches»
      const own = compiled?.kind === "cannot" ? (compiled.reason === "no_topic" ? NO_TOPIC_END_AR : compiled.reason === "no_rows" && compiled.scope ? searchScopeEndAr(compiled.scope) : compiled.reason === "instagram_account_missing" ? INSTAGRAM_ACCOUNT_DECLINED_AR : compiled.reason === "source_missing" || compiled.reason === "source_unenforceable" ? SOURCE_DECLINED_AR : compiled.reason === "youtube_channel_missing" ? YOUTUBE_CHANNEL_DECLINED_AR : compiled.reason === "youtube_channel_unidentified" ? YOUTUBE_CHANNEL_UNIDENTIFIED_AR : null) : null;
      const sentence = own ?? refusalSentenceAr(verdict.cls as "unsupported" | "empty_source");
      await store.updateMission(mission.id, { ...base, status: "unserved", summary_ar: sentence });
      await store.addEvent(mission.id, { kind: "result", message_ar: sentence });
      await tell(deps, mission, null, "unserved", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false, ...(verdict.cls === "empty_source" ? { cause: "empty" as const } : {}) });
    }
    if (recoveryDiag && recoveryDiag.reason !== "not_people_request") {
      const recKey = `issue_rec_${recoveryDiag.reason}`.replace(/[^a-z0-9_]/g, "_").slice(0, 40);
      const recIssueCounts = Object.fromEntries(
        recoveryDiag.issueCodes
          .map((c) => c.replace(/[^a-z0-9_]/g, "_"))
          .filter(Boolean)
          .slice(0, 12)
          .map((c) => [`issue_${c}`.slice(0, 40), 1]),
      );
      await store.addEvent(mission.id, {
        kind: "call",
        message_ar: "علامة داخلية للمشرف: تعذّر أو تخطّى استرداد خطة الشركات والأشخاص.",
        counts: { adm_flag: 1, [recKey]: 1, ...recIssueCounts },
      }).catch(() => undefined);
      deps.log?.(`company_people_recovery_diagnostic ${mission.id} reason=${recoveryDiag.reason}${recoveryDiag.issueCodes.length ? ` issues=${recoveryDiag.issueCodes.join(",")}` : ""}${capIssues.length ? ` cap_issues=${capIssues.join(" | ")}` : ""}`);
    }
  }
}

/** What the model is told when a round ended while matching items were still needed and a source had more: carry on, the numbers are the store's. */
export function continuationPrompt(mission: MissionRecord, plan: PricedPlan, calls: CallRow[], saved: Record<string, number>): string {
  return `${executionPrompt(mission, plan, calls, saved)}\n\nYour last round ended before the approved volume was reached, and a source still has pages. Carry on from where you stopped (collect_pages with the same inputs resumes; never start a source again), save, and finish only when the volume is reached, the source ends, or a call is refused.`;
}

export async function runExecution(deps: RunnerDeps, mission: MissionRecord): Promise<void> {
  // ROUND 62: with the spend gate on, this mission's direct model requests (review.ts) are gated; off: deps unchanged
  deps = withMissionSpendGate(deps, mission.id);
  const { store } = deps;
  const model = deps.models.execution;
  const plan = mission.plan;
  const reserve = Number(mission.reserved_points);
  const unit = Number(mission.unit_price_points);
  if (!plan || !mission.job_id || !(reserve > 0) || !(unit > 0)) {
    await store.updateMission(mission.id, { status: "failed", error: "the mission has no approved plan or reserve", summary_ar: MISSION_NOT_STARTED_AR, ...clear });
    await store.addEvent(mission.id, { kind: "result", message_ar: MISSION_NOT_STARTED_AR });
    return;
  }
  if (await resumeExecutionDelivery(deps, mission, plan, reserve)) return;
  const started = await updateRunState(store, mission.id, (r) => ({ ...r, executionStarts: r.executionStarts + 1 }), deps.log);
  if (started.executionStarts > AGENT_PHASE_STARTS_MAX) {
    const stuck = (await store.getMission(mission.id)) ?? mission;
    await settleExecution(deps, mission, plan, reserve, { llm: Number(stuck.execution_llm_usd ?? 0), executionTregUsd: Number(stuck.execution_treg_usd ?? 0), summary: null, outputError: `execution started ${started.executionStarts} times` });
    return;
  }
  // UNIFIED CAPABILITY DISCOVERY: the STORED approved plan must still execute exactly the capabilities AND the parameters recorded when it was shown and priced (or last edited by the customer before approval); a stage added, switched to another
  // capability, or whose counts / filters / pins / pages changed after that is never run (nothing is called, the hold is released whole by the existing settlement)
  const scope = verifyApprovedScope(plan, deps.catalog, await capabilityAnchorOf(store, mission.id));
  if (!scope.ok) {
    await store.addEvent(mission.id, { kind: "call", message_ar: "علامة داخلية للمشرف: الخطة المخزنة لا تطابق المصادر المعتمدة، فلم يُنفَّذ شيء.", counts: { adm_flag: 1, scope_issues: scope.issues.length } }).catch(() => undefined);
    await settleExecution(deps, mission, plan, reserve, { llm: Number(mission.execution_llm_usd ?? 0), executionTregUsd: Number(mission.execution_treg_usd ?? 0), summary: null, outputError: `admin: approved_scope_changed ${scope.issues.slice(0, 6).join(",")}`.slice(0, 300) });
    return;
  }
  // PHASE 5.3: a plan approved WITH the customer's exclusion list never runs without exactly that list (whatever the switch says now): a missing or altered copy stops here, nothing is called, and the hold is released
  // whole by the existing settlement
  let exclusion: ExclusionMatcher | undefined;
  if (plan.customer_exclusion?.applies) {
    const loaded = await loadApprovedExclusion(store, mission.id, plan.customer_exclusion);
    if (!loaded) {
      await store.addEvent(mission.id, { kind: "call", message_ar: "علامة داخلية للمشرف: تعذّر تحميل ملف الاستبعاد المعتمد، فلم يُنفَّذ شيء.", counts: { adm_flag: 1 } }).catch(() => undefined);
      await settleExecution(deps, mission, plan, reserve, { llm: Number(mission.execution_llm_usd ?? 0), executionTregUsd: Number(mission.execution_treg_usd ?? 0), summary: null, outputError: "admin: customer_exclusion_unavailable" });
      return;
    }
    exclusion = loaded;
  }
  // P0: a plan approved with «nothing delivered before, again» never runs without exactly that snapshot (fail closed: nothing is called, the hold is released whole)
  let priorDelivered: import("../../src/lib/agentMission/priorDelivery").PriorDeliveryMatcher | undefined;
  if (plan.prior_delivery && plan.prior_delivery.items > 0) {
    const loaded = await loadApprovedPriorDelivery(store, mission.id, plan.prior_delivery);
    if (!loaded) {
      await store.addEvent(mission.id, { kind: "call", message_ar: "علامة داخلية للمشرف: تعذّر تحميل قائمة ما سُلّم سابقًا المعتمدة مع الخطة، فلم يُنفَّذ شيء.", counts: { adm_flag: 1 } }).catch(() => undefined);
      await settleExecution(deps, mission, plan, reserve, { llm: Number(mission.execution_llm_usd ?? 0), executionTregUsd: Number(mission.execution_treg_usd ?? 0), summary: null, outputError: "admin: prior_delivery_unavailable" });
      return;
    }
    priorDelivered = loaded;
  }
  await store.updateMission(mission.id, { execution_model: model, error: null });
  await store.addEvent(mission.id, { kind: "system", message_ar: "اعتُمدت الخطة وبدأ الوكيل التنفيذ." });
  const calls = await store.listCalls(mission.id);
  const access = await deps.resolveAccess(mission.user_id);
  const budget = createJobCallBudget({ ceilingUsd: executionBudgetUsd(reserve), spentUsd: sum(calls, "execution") });
  const counter = { seq: lastSeq(calls) };
  const gateway = createGateway({ store, client: deps.client, missionId: mission.id, userId: mission.user_id, jobId: mission.job_id, phase: "execution", access, catalog: deps.catalog, budget, recorder: deps.recorder, commit: deps.commit, call: deps.call, token: deps.token, defaultPurpose: mission.request_text, counter, ...spendGateOf(deps, mission.id) });
  const webAvailable = deps.providerKey ? await resolveWebAvailability(deps.providerKey) : NO_WEB;
  const web = deps.providerKey && anyWebAvailable(webAvailable) ? createWebGateway({ store, missionId: mission.id, jobId: mission.job_id, phase: "execution", budget, recorder: deps.recorder, providerKey: deps.providerKey, fetchFn: deps.fetchFn, counter, pageReuse: executionPageReuse(mission, plan, () => items), ...spendGateOf(deps, mission.id) }) : undefined;
  const state = newRunState(await lastOut(store, mission.id));
  // THE REVIEW of uncertain rows: a small model request per batch, within 20% of the mission's revenue (rows beyond it are not delivered and not charged); its tokens and cost are counted from the API's own answer
  const reviewBudgetUsd = plan.price.reviewBudgetUsd ?? reviewBudgetUsdFor(plan.price.maxChargePoints);
  const researchSpec = deps.reviewCall ? await executionResearchSpec(deps, store, mission, plan).catch(() => null) : null;
  const reviewer = deps.reviewCall ? createReviewer({ call: deps.reviewCall, store, missionId: mission.id, requestText: `${mission.request_text}${mission.answer_text ? ` — ${mission.answer_text}` : ""}`, ...(researchSpec ? { spec: researchSpec, answer: mission.answer_text, known: await readJudged(store, mission.id, researchSpec.sig) } : {}), budgetUsd: reviewBudgetUsd, ceilingUsd: reviewCeilingUsdFor(reserve), log: deps.log }) : undefined;
  const reviewBefore = await readReviewState(store, mission.id);
  // THE ONE ITEM STORE: every item the engine or the model saves goes through it; a resumed mission continues from its log
  const items = await ItemStore.open(store, mission.id, { legacyStages: plan.stages.map((s) => s.key) });
  const ctx: ToolContext = { phase: "execution", mission, plan, store, gateway, web, webAvailable, catalog: deps.catalog, access, state, sandbox: deps.sandbox, review: reviewer, items, ...(exclusion ? { exclusion } : {}), ...(priorDelivered ? { priorDelivered } : {}) };
  const savedBefore = Object.fromEntries(plan.stages.map((s) => [s.key, items.counts(s.key).accepted]));
  const llmBudget = Math.max(AGENT_EXECUTION_LLM_BUDGET_FLOOR_USD, holdValueUsd(reserve, AGENT_PRICING_BASIS) * AGENT_EXECUTION_LLM_BUDGET_SHARE);
  const baseLlm = Number((await store.getMission(mission.id))?.execution_llm_usd ?? mission.execution_llm_usd ?? 0);
  const checkpoint = async ({ costUsd }: { costUsd: number }) => {
    try {
      const reviewNow = reviewer ? Math.max(0, (await reviewer.state()).spentUsd - reviewBefore.spentUsd) : 0;
      await store.updateMission(mission.id, { execution_llm_usd: Number((baseLlm + costUsd + reviewNow).toFixed(6)) });
    } catch { /* a lost checkpoint never stops a run */ }
  };
  const deadlineMs = Date.now() + AGENT_EXECUTION_WALL_MS;
  // (assigned on every path below: the engine run, the model run, or both with per-stage dispatch)
  let output!: Awaited<ReturnType<ModelDriver["run"]>>;
  const engineOn = deps.engine !== false && plan.stages.every((s) => s.engine !== undefined);
  // THE REDESIGN (S1): which stages run the redesigned engine (flag active for this account AND every recipe built by code); recorded as an internal event only when some flag is switched on, so with every flag off the mission's events are exactly as they were
  const redesignSettings = (await store.readSettings().catch(() => ({}))) as Record<string, unknown>;
  const redesignFlags = readRedesignFlags(redesignSettings);
  const platformFlags = readPlatformFlagsOf(redesignSettings);
  const redesignIsTest = await accountIsTest(store, mission.user_id);
  const redesignStages = redesignStagesOf(plan, redesignFlags, redesignIsTest, platformFlags);
  // THE SILENT FALLBACK, NAMED (docs/ROOT-CAUSE.md, cause 3): beside `pipe_new`, the number of the first stage whose recipe was not built by code when the flag was active for this mission
  const fallbackStage = redesignStages.size === 0 ? fallbackStageOf(plan, redesignFlags, redesignIsTest, platformFlags) : null;
  if (anyRedesignFlag(redesignFlags, platformFlags)) await store.addEvent(mission.id, { kind: "call", message_ar: "قياس داخلي للمسار الذي شغّل المهمة.", counts: { pipe_new: redesignStages.size > 0 ? 1 : 0, ...(fallbackStage !== null ? { fallback_stage: fallbackStage } : {}) } }).catch(() => undefined);
  // STAGE 2 S6 (docs/STAGE-2.md): the live sheet, only when DIGER_STAGE2_LIVE_SHEET is on for this account (unset: null, and the engine's events are written exactly as before)
  const live = (await liveSheetOn(async () => redesignIsTest)) ? createLiveWriter({ store, missionId: mission.id, plan, items, writerId: newWriterId(), log: deps.log }) : null;
  // PHASE 5, switch `multi_stage_engine` (OFF; agent/src/engine/sourceGateway.ts): pages go through the provider-neutral SourceGateway (the stage's stored scope, then the TREG or the web gateway), saved rows carry their source
  // and call as internal marks, and a plan with SOME stages without a recipe runs those with one on the engine first (per-stage dispatch) and leaves the rest to the model. Off (always, today): null, and nothing below changes.
  const multiStage = deps.engine !== false && readMultiStageEngineFlag(redesignSettings, mission.user_id);
  const dispatch = multiStage && !engineOn ? stageDispatchOf(plan) : null;
  const engineStages = dispatch && dispatch.engine.length > 0 ? new Set(dispatch.engine) : null;
  // A PLAN THAT READS A DIRECT WEB TOOL (Firecrawl, Context.dev: the LLM planner offers them beside the catalog's tools) runs through the provider-neutral SourceGateway, whatever `multi_stage_engine` says: the TREG gateway
  // alone cannot call them. Its stored scope and the job's budget hold exactly as for any stage.
  const usesDirectWeb = plan.stages.some((s) => [s.engine?.endpoint_id, ...(s.engine?.alternatives ?? []).map((a) => a.endpoint_id)].some((id) => typeof id === "string" && WEB_SOURCE_IDS.has(id)));
  const sources = multiStage || (usesDirectWeb && web) ? createSourceGateway({ gateway, ...(web ? { web } : {}), scope: stageScopeOf(plan), budget, maxCallUsd: verifiedCallMaxUsdOf(deps.catalog) }) : undefined;
  if (multiStage) await store.addEvent(mission.id, { kind: "call", message_ar: "قياس داخلي: توزيع المراحل على المحرك.", counts: { multi_stage: 1, engine_stages: engineOn ? plan.stages.length : engineStages?.size ?? 0, model_stages: engineOn ? 0 : dispatch?.model.length ?? plan.stages.length } }).catch(() => undefined);
  if (engineOn || engineStages) {
    // THE MODEL PLANNED, CODE EXECUTES: every stage has a recipe the plan check proved, so no model session is started at all (the only model call left is the small review of items the rule cannot decide)
    const tracked = trackRun(mission.id);
    try {
      const outcome = await runEngine({ items, store, plan: withPromiseCaps(plan), missionId: mission.id, gateway, ...(exclusion ? { exclusion } : {}), ...(priorDelivered ? { priorDelivered } : {}), sandbox: deps.sandbox ?? ((code, inputs) => runInSandbox(code, inputs)), reviewer, addEvent: live ? (e) => live.addEvent(e, () => store.addEvent(mission.id, e)) : (e) => store.addEvent(mission.id, e), deadlineMs, shouldStop: () => tracked.reason.value, ...(redesignStages.size > 0 ? { redesignStages } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}), log: deps.log, ...(sources ? { sources, provenance: true } : {}), ...(engineStages ? { onlyStages: engineStages } : {}) });
      output = { llmCostUsd: 0, turns: 0, stop: outcome.aborted ?? "end" };
    } finally {
      untrackRun(tracked);
      if (live) await live.flush();
    }
  }
  if (!engineOn && (!engineStages || output.stop === "end")) {
    // the model carries the mission out (a plan whose stages have no proven recipe), still through the one item store. A round that ends while matching items are still needed and a source has more is followed by another round.
    output = { llmCostUsd: 0, turns: 0, stop: "end", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    for (let round = 0; round <= AGENT_EXECUTION_CONTINUE_ROUNDS; round += 1) {
      state.terminal = false;
      const saved = Object.fromEntries(plan.stages.map((s) => [s.key, items.counts(s.key).accepted]));
      let r: Awaited<ReturnType<ModelDriver["run"]>>;
      try {
        r = await deps.driver.run({ phase: "execution", missionId: mission.id, systemPrompt: loadSystemPrompt("execution", deps.systemPromptFile, { web: Boolean(web) }), userPrompt: round === 0 && !engineStages ? executionPrompt(mission, plan, calls, savedBefore) : continuationPrompt(mission, plan, await store.listCalls(mission.id), saved), tools: buildTools(ctx), state, model, maxTurns: AGENT_EXECUTION_MAX_TURNS, maxBudgetUsd: llmBudget, wallMs: AGENT_EXECUTION_WALL_MS, onUsage: checkpoint, ...modelGateOf(deps, mission.id) });
      } catch (e) {
        r = { llmCostUsd: 0, turns: 0, stop: "error", error: String((e as Error)?.message ?? e).slice(0, 300) } as Awaited<ReturnType<ModelDriver["run"]>>;
      }
      output = { ...r, llmCostUsd: output.llmCostUsd + r.llmCostUsd, turns: output.turns + r.turns, usage: sumUsage(output.usage, r.usage) };
      const short = plan.stages.some((s) => s.deliver && items.counts(s.key).accepted < s.planned_rows) && [...state.moreAvailable.values()].some(Boolean);
      if (r.stop !== "end" || r.error || state.finish || !short || Date.now() >= deadlineMs) break;
    }
  }
  // the model cost of this run = the agent's own run + the review calls it made (a requeued or killed run's cost is already on the mission through the checkpoints and the review state)
  const reviewAfter = await readReviewState(store, mission.id);
  const reviewSpent = Math.max(0, reviewAfter.spentUsd - reviewBefore.spentUsd);
  const llm = Number(baseLlm + output.llmCostUsd + reviewSpent);
  await recordTokens(deps, mission.id, 1, output.usage, { inputTokens: reviewAfter.inputTokens - reviewBefore.inputTokens, outputTokens: reviewAfter.outputTokens - reviewBefore.outputTokens, calls: reviewAfter.calls - reviewBefore.calls }, output.llmCostUsd + reviewSpent);
  if (output.stop === "memory" && !state.finish && await requeue(deps, mission, "approved", { execution_llm_usd: Number(llm.toFixed(6)), execution_treg_usd: Number(budget.spentUsd().toFixed(6)) }, "memory")) return;
  if (endedByRestart(output) && !state.finish && await requeue(deps, mission, "approved", { execution_llm_usd: Number(llm.toFixed(6)), execution_treg_usd: Number(budget.spentUsd().toFixed(6)) }, "restart")) return;

  // THE CONTACT FINDER STEPS (plan.contact_steps, contactFinders.ts): every delivered person is looked up for the e-mail and phone cells, within the job's call budget and the step's priced amount. It fills CELLS of persons already stored: no row is added, so the settlement below counts what it always counted.
  // STAGE 3, PART B (docs/STAGE-3.md S4): only when DIGER_STAGE3_COMPANIES is on for the account, every lookup is recorded per row and column and the contact cells follow the fallthrough (b2bEngine.ts); off (unset: always), null and nothing changes
  const b2bAttempts = b2bEngineOn(redesignIsTest) ? createAttemptLog() : null;
  if (plan.contact_steps && plan.contact_steps.length > 0 && output.stop === "end" && !output.error) {
    try {
      const enrichment = await runContactEnrichment({ items, store, plan, missionId: mission.id, requestText: mission.request_text, gateway, addEvent: (e) => store.addEvent(mission.id, e), budget, deadlineMs: Math.max(deadlineMs, Date.now() + CONTACT_STEP_MIN_WALL_MS), log: deps.log, ...(b2bAttempts ? { attempts: b2bAttempts } : {}), ...(multiStage ? { provenance: true } : {}) });
      deps.log?.(`contact_steps ${mission.id} email=${enrichment.filled.email} phone=${enrichment.filled.phone} unverified=${enrichment.filled.unverified} looked=${enrichment.looked} skipped=${enrichment.skipped} spent=${enrichment.spentUsd.toFixed(6)} stopped=${enrichment.stopped ?? "no"}`);
    } catch (e) { deps.log?.(`contact_steps_failed ${mission.id} ${String((e as Error)?.message ?? e).slice(0, 120)}`); /* a lookup that breaks never stops the settlement: the people are delivered with the cells as they are */ }
  }
  // STAGE 3, PART B: every contact cell still without a value gets «غير متوفر» (every tool of its chain answered with nothing) or «لم يكتمل البحث» (refused, failed, not tried). CELLS only: no row is added or removed
  if (b2bAttempts) {
    try {
      const ops = b2bContactCells(plan, Object.fromEntries(plan.stages.map((s) => [s.key, items.acceptedRows(s.key)])), b2bAttempts);
      if (ops.length > 0) { await items.commit(ops); for (const k of new Set(ops.map((o) => o.stage))) await items.mirror(k); }
    } catch (e) { deps.log?.(`b2b_cells_failed ${mission.id} ${String((e as Error)?.message ?? e).slice(0, 120)}`); /* the cells stay as the steps left them */ }
  }

  // THE ARABIC SPELLING OF THE DECISION MAKERS' NAMES (namesAr.ts, owner decision 3 of audit 2026-11): ONE small batched request for the whole mission, after the people are final. It fills a cell of each person's row (`name_ar`), decides no row, no count and no money; a failed or unusable answer leaves the English names.
  // Its cost comes from the API's own usage and is part of the mission's model cost (the plan's price carries its estimate, plan.ts NAMES_STEP_USD_PER_PERSON); it is NOT a charge: the settlement below is untouched.
  let namesCostUsd = 0;
  if (deps.reviewCall && output.stop === "end" && !output.error && plan.stages.some((s) => namesAreWritten(s))) {
    try {
      const names = await runNamesStep({ items, plan, call: deps.reviewCall, log: deps.log });
      namesCostUsd = names.costUsd;
      deps.log?.(`names ${mission.id} calls=${names.calls} named=${names.named} cost=${names.costUsd.toFixed(6)}`);
    } catch (e) { deps.log?.(`names_failed ${mission.id} ${String((e as Error)?.message ?? e).slice(0, 120)}`); /* a name that cannot be spelled stays as the source gave it */ }
  }

  await settleExecution(deps, mission, plan, reserve, {
    llm: Number(llm + namesCostUsd),
    executionTregUsd: budget.spentUsd(),
    summary: state.finish?.summary_ar ?? null,
    outputError: output.error ?? null,
    memory: items,
    markMissingCells: b2bEngineOn(redesignIsTest) || redesignStages.size > 0 || plan.compiled?.by === "compiler" || anyRedesignFlag(redesignFlags, platformFlags) || readCapabilityDiscoveryFlag(redesignSettings, mission.user_id),
  });
}

const sumUsage = (a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage => ({
  input_tokens: (a?.input_tokens ?? 0) + (b?.input_tokens ?? 0), output_tokens: (a?.output_tokens ?? 0) + (b?.output_tokens ?? 0),
  cache_read_input_tokens: (a?.cache_read_input_tokens ?? 0) + (b?.cache_read_input_tokens ?? 0), cache_creation_input_tokens: (a?.cache_creation_input_tokens ?? 0) + (b?.cache_creation_input_tokens ?? 0),
});

type ExecutionEnd = {
  llm: number;
  executionTregUsd: number;
  summary: string | null;
  outputError: string | null;
  memory?: ItemStore;
  markMissingCells?: boolean;
};

function dedupeCompanyStages(plan: PricedPlan, snap: Pick<ItemSnapshot, "acceptedRows">, rowsByStage: Record<string, Record<string, unknown>[]>) {
  const droppedByStage = new Map<string, Set<string>>();
  for (const s of plan.stages) {
    const parentDrops = s.parent_key ? droppedByStage.get(s.parent_key) : undefined;
    const companies = isCompanyStage(s) ? new AcceptedCompanies() : null;
    if (!companies && !parentDrops) continue;
    const dropped = new Set<string>();
    const rows = [];
    for (const row of snap.acceptedRows(s.key)) {
      if (parentDrops?.has(String(row.parent_id))) {
        dropped.add(String(row.id));
        continue;
      }
      if (!companies) { rows.push(row); continue; }
      const evidence = storedCompanyEvidence(row, s);
      const decision = companies.inspect(evidence);
      if (decision === "duplicate_company" || decision === "company_identity_conflict") {
        dropped.add(String(row.id));
        continue;
      }
      companies.add(evidence);
      rows.push(decision === "possible" ? { ...row, [COMPANY_UNCERTAIN_KEY]: "yes" } : row);
    }
    if (dropped.size > 0) droppedByStage.set(s.key, dropped);
    rowsByStage[s.key] = s.deliver ? rows.slice(0, s.planned_rows) : rows;
  }
}

async function prepareExecutionDelivery(deps: RunnerDeps, mission: MissionRecord, plan: PricedPlan, a: ExecutionEnd) {
  const { store } = deps;
  const fresh = (await store.getMission(mission.id)) ?? mission;
  const spent = Number((fresh.planning_treg_usd ?? 0) + a.executionTregUsd);
  // Read the saved log only during the initial preparation. A storage fault leaves the durable finalization journal in control.
  const log = await ItemStore.open(store, mission.id, { legacyStages: plan.stages.map((s) => s.key) });
  const snap = log.snapshotOfMemory();
  const flags: string[] = [];
  const rowsByStage: Record<string, Array<Record<string, unknown>>> = {};
  // THE PROMISE FOR COMMENTS AND REPLIES TOGETHER (S5): each of the two stages was read up to the total; the delivery is counted up to it
  // the plan as the customer approved it (the delivery contract compares the promised number with the card's)
  const approvedPlan = plan;
  plan = withPromiseCaps(plan);
  for (const s of plan.stages) rowsByStage[s.key] = snap.acceptedRows(s.key, s.deliver ? s.planned_rows : undefined);
  if (plan.stages.some((s) => isCompanyStage(s))) dedupeCompanyStages(plan, snap, rowsByStage);
  plan = reportedPlan(plan, Object.fromEntries(plan.stages.map((s) => [s.key, rowsByStage[s.key].length])));
  // S9: replies that promised no number (all the replies of the chosen comments) are judged against the reply counters of the comments that were delivered; the estimate they were priced from stays only in the price
  const openKeys = new Set(plan.stages.filter((s) => s.replies_open || s.children_open).map((s) => s.key));
  const hadOpenReplies = openKeys.size > 0;
  const openEstimate = plan.stages.filter((s) => openKeys.has(s.key)).reduce((n, s) => n + s.planned_rows, 0);
  if (hadOpenReplies) plan = withRepliesJudged(plan, rowsByStage, (k) => { const st = snap.stage(k).stop; return !st || st === "source_exhausted"; });
  const openGap = openEstimate - plan.stages.filter((s) => openKeys.has(s.key)).reduce((n, s) => n + s.planned_rows, 0);
  const builtCount = plan.stages.filter((s) => s.deliver).reduce((n, s) => n + rowsByStage[s.key].length, 0);
  if (a.memory) for (const s of plan.stages) if (a.memory.counts(s.key).accepted !== snap.counts(s.key).accepted) flags.push("memory_differs_from_store");

  // WHAT WAS LEFT OUT goes to the admin only (a CSV in the mission's own folder, never in the customer's files), with the report of the check
  const checked = await recordChecks(deps, mission.id, plan, store, snap);
  await mirrorLegacyFiles(log, store, plan);
  let workbook: Awaited<ReturnType<typeof buildMissionFiles>> | null = null;
  let qualityLine: string | null = null;
  let parentFixedRows = 0;
  if (builtCount > 0) {
    let incompleteCells: Array<{ stage: string; rowId: string; column: string }> = [];
    if (plan.contact_steps && plan.contact_steps.length > 0) {
      try {
        const rawInc = await store.getFile(mission.id, "contacts/incomplete_cells.json");
        if (rawInc) incompleteCells = JSON.parse(rawInc);
      } catch { /* internal display metadata only */ }
    }
    // STAGE 3, PART B: each contact column's gap, read from the cells of these very rows, joins «حدود هذا التسليم» only when DIGER_STAGE3_COMPANIES is on for the account (unset: no line, the file as it was)
    const b2bLines = b2bFlagSet() && b2bEngineOn(await accountIsTest(store, mission.user_id)) ? b2bLimitLines(plan, rowsByStage) : [];
    const built = await buildMissionFiles(plan, rowsByStage, missionFactsOf({
        requestText: mission.request_text,
        customerWords: (await executionResearchSpec(deps, store, mission, plan).catch(() => null))?.customerWords ?? null,
        plan,
        snap,
        reviewStop: checked.stop,
        ...(incompleteCells.length > 0 ? { incompleteCells } : {}),
      }),
      companyMailboxesOf(plan, snap),
      {
        ...(hadOpenReplies ? { repliesJudged: true } : {}),
        approvedPlan,
        ...(b2bLines.length > 0 ? { extraLimitLines: b2bLines } : {}),
        ...(incompleteCells.length > 0 ? { incompleteCells } : {}),
        ...(a.markMissingCells ? { markMissingCells: true } : {}),
      },
    );
    workbook = built;
    qualityLine = qualityResultLineAr(built.companyQuality);
    // THE DELIVERY CONTRACT (round 14): what it found is recorded for the admin; the file only had its DESCRIPTION completed (a limits line, a precision cell, a mark cell), never a row or a value
    if (built.contract.violations.length > 0) {
      const by = (rule: string) => built.contract.violations.filter((v) => v.rule === rule).length;
      const said = built.contract.completed.map((c) => (c.kind === "limit_line" ? `سطر في الحدود: ${c.text}` : c.kind === "precision" ? "خلية دقة التاريخ" : `علامة «${c.header}»`)).slice(0, 6).join(" | ");
      flags.push("delivery_contract");
      await store.addEvent(mission.id, { kind: "call", message_ar: `علامة داخلية للمشرف: ملف صُحّح وصفه تلقائيًا؛ ما اكتمل: ${said || "لا شيء (مخالفة للتقرير فقط)"}`.slice(0, 1000), counts: { adm_flag: 1, adm_contract: 1, adm_r1: by("R1"), adm_r2: by("R2"), adm_r3: by("R3"), adm_r4: by("R4"), adm_completed: built.contract.completed.length } });
    }
    if (built.parentFixes.length > 0) { parentFixedRows = built.parentFixes.reduce((n, f) => n + f.rows, 0); flags.push("parent_column_fixed"); deps.log?.(`parent_column_fixed ${mission.id} ${built.parentFixes.map((f) => `${f.stage_key}.${f.column}<-${f.parent_field}x${f.rows}`).join(",")}`); }
  }
  return {
    plan, approvedPlan, snap, flags, rowsByStage, hadOpenReplies, openGap, builtCount, checked, qualityLine, parentFixedRows,
    preparation: { workbook, notes: { date: new Date().toISOString(), llm: a.llm, executionTregUsd: a.executionTregUsd, summary: a.summary, outputError: a.outputError, costUsd: spent } },
  };
}

async function markDeliveryPending(deps: RunnerDeps, mission: MissionRecord, plan: PricedPlan): Promise<void> {
  await ensureOwned(deps, mission.id);
  const message = settlementPendingAr(plan.price.deliveredRows);
  await deps.store.updateMission(mission.id, { status: "failed", error: "admin: settlement_retries_exhausted", summary_ar: message, ...clear });
  await deps.store.addEvent(mission.id, { kind: "result", message_ar: message });
}

async function acknowledgeDelivery(deps: RunnerDeps, mission: MissionRecord, plan: PricedPlan, reserve: number, receipt: DeliveryReceipt): Promise<void> {
  const { store } = deps;
  if (receipt.mission_id !== mission.id || receipt.job_id !== mission.job_id) throw new Error("delivery receipt does not match mission");
  const physical = receipt.physical_units;
  const releasedWithoutSnapshot = !receipt.snapshot_sha;
  const top = topLevelFactsOf(plan, receipt.counts ?? {});
  const partial = physical > 0 && physical - top.repliesDelivered < requestedRowsOf(plan) - top.repliesPlanned;
  const partialMessage = "تم تسليم مهمتك بعدد أقل من المطلوب";
  const message = releasedWithoutSnapshot
    ? "تعذّر إكمال المهمة؛ رجع لمحفظتك كاملًا ولم يُخصم أي رصيد."
    : partial ? `${partialMessage}.` : physical > 0 ? "اكتملت المهمة." : "لم يُسلَّم أي شيء.";
  await ensureOwned(deps, mission.id);
  const freeRerun = mission.created_by && mission.created_by !== mission.user_id
    ? await compensateFreeRerun(deps.client, { missionId: mission.id, chargedPoints: receipt.charged_credits })
    : null;
  const free = freeRerun !== null && freeRerun.status !== "not_free" && freeRerun.status !== "failed";
  await store.updateMission(mission.id, {
    status: releasedWithoutSnapshot ? "failed" : physical > 0 ? "completed" : "unserved",
    delivered_units: physical, charged_points: receipt.charged_credits,
    files: receipt.files?.length ? receipt.files : null, summary_ar: message,
    ...(receipt.notes ? {
      execution_llm_usd: Number(receipt.notes.llm.toFixed(6)),
      execution_treg_usd: Number(receipt.notes.executionTregUsd.toFixed(6)),
    } : {}),
    error: releasedWithoutSnapshot ? "admin: delivery_unavailable" : receipt.notes?.outputError ?? null,
    ...clear,
  });
  if (receipt.unbilled?.total) await store.addEvent(mission.id, { kind: "result", message_ar: unbilledLineAr(receipt.unbilled.total, receipt.unbilled.kinds) });
  await store.addEvent(mission.id, { kind: "result", message_ar: message, counts: {
    delivered: physical, charged_points: receipt.charged_credits,
    ...Object.fromEntries(plan.stages.map((stage, i) => [`stage_${i + 1}_rows`, receipt.counts?.[stage.key] ?? 0])),
  } });
  const noticeKind = releasedWithoutSnapshot ? "failed" : physical <= 0 ? "unserved" : partial ? "partial" : "completed";
  await tell(deps, mission, mission.job_id, noticeKind, {
    delivered: physical, planned: plan.price.deliveredRows, chargedPoints: receipt.charged_credits,
    releasedPoints: receipt.refunded_credits, reservedPoints: reserve, noun: itemNounOfPlan(plan).singular, hasJob: true,
    ...(free ? { free: true } : {}), ...(partial ? { shortfallClauseAr: partialMessage } : {}),
  });
  if (receipt.csv_path && physical > 0) await storeFirstVersion({ store, log: deps.log }, { missionId: mission.id, userId: mission.user_id });
}

/** Returns false only once the database proves that finalization has never started. */
async function resumeExecutionDelivery(deps: RunnerDeps, mission: MissionRecord, plan: PricedPlan, reserve: number): Promise<boolean> {
  const status = await inspectMissionDelivery(deps, mission);
  if (status.kind === "not_started") return false;
  if (status.kind === "error") {
    if (status.error === "unbound_money") await markDeliveryPending(deps, mission, plan);
    return true;
  }
  const result = status.kind === "receipt" ? status : await advanceMissionDelivery(deps, mission);
  if (result === "exhausted") await markDeliveryPending(deps, mission, plan);
  else if (result !== "parked") await acknowledgeDelivery(deps, mission, plan, reserve, result.receipt);
  return true;
}

async function settleExecution(deps: RunnerDeps, mission: MissionRecord, plan: PricedPlan, reserve: number, a: ExecutionEnd): Promise<void> {
  const { store } = deps;
  const built: { context?: Awaited<ReturnType<typeof prepareExecutionDelivery>> } = {};
  const result = await advanceMissionDelivery(deps, mission, async () => {
    built.context = await prepareExecutionDelivery(deps, mission, plan, a);
    return built.context.preparation;
  });
  if (result === "parked") return;
  if (result === "exhausted") {
    await markDeliveryPending(deps, mission, plan);
    return;
  }
  const { receipt } = result;
  if (!built.context || !receipt.snapshot_sha) {
    await acknowledgeDelivery(deps, mission, plan, reserve, receipt);
    return;
  }
  const { approvedPlan, snap, flags, rowsByStage, hadOpenReplies, openGap, builtCount, checked, qualityLine, parentFixedRows } = built.context;
  plan = built.context.plan;
  const jobId = receipt.job_id;
  const llm = a.llm;
  const delivered = receipt.physical_units;
  const fileCount = delivered;
  const fileByStage = receipt.counts ?? {};
  const files = receipt.files ?? [];
  const unbilled = receipt.unbilled ?? { total: 0, kinds: [] };
  const settled = { chargedPoints: receipt.charged_credits, releasedPoints: receipt.refunded_credits };
  const noun = itemNounOfPlan(plan);
  if (fileCount !== builtCount) flags.push("file_differs_from_store");
  await ensureOwned(deps, mission.id);
  await writeDoneSnapshotSafely({ store, missionId: mission.id, plan: approvedPlan, filePlan: plan, snap, requestText: mission.request_text, reviewStop: checked.stop, resultPath: receipt.csv_path ?? null, mailboxesOf: companyMailboxesOf, isTest: () => accountIsTest(store, mission.user_id), log: deps.log });
  // A FREE RE-RUN BY THE DIGER TEAM (src/lib/agentMission/freeRerun.ts): what the settlement charged is given back at once, through the existing admin grant (one request id per mission, so
  // never twice), and the notice says the mission was free. An ordinary mission is «not_free» and nothing happens. Never throws and never changes the settlement; a failed grant is logged and
  // the admin page grants it again (same request id).
  // only a mission an admin created can be one (a customer's own mission is never looked up)
  // MULTI-OBJECTIVE RESEARCH (capability_discovery_v1 plans only): every objective of the approved plan gets its own explicit outcome, counted from the file (never claimed complete when one objective fell short)
  if (qualityLine && delivered > 0) await store.addEvent(mission.id, { kind: "result", message_ar: qualityLine });
  // D-0117: what was delivered but not charged, said once, before the final summary (also when nothing is charged and the hold returns whole)
  if (unbilled.total > 0) {
    flags.push("people_without_contact_unbilled");
    await store.addEvent(mission.id, { kind: "result", message_ar: unbilledLineAr(unbilled.total, unbilled.kinds) });
    await store.addEvent(mission.id, { kind: "call", message_ar: "علامة داخلية للمشرف: أشخاص بلا إيميل أو تليفون لم يُحتسبوا.", counts: { adm_flag: 1, adm_unbilled: unbilled.total } });
  }
  if (approvedPlan.capability_selection) {
    const line = objectiveOutcomesLineAr(approvedPlan, fileByStage);
    if (line) await store.addEvent(mission.id, { kind: "result", message_ar: line });
  }
  const freeRerun = mission.created_by && mission.created_by !== mission.user_id ? await compensateFreeRerun(deps.client, { missionId: mission.id, chargedPoints: settled.chargedPoints }) : null;
  if (freeRerun?.status === "failed") deps.log?.(`free_rerun_refund_failed ${mission.id} ${freeRerun.reason}`);
  const isFreeRerun = freeRerun !== null && freeRerun.status !== "not_free" && freeRerun.status !== "failed";
  if (flags.length > 0) {
    await store.addEvent(mission.id, { kind: "call", message_ar: "علامة داخلية للمشرف: أرقام المهمة لا تتطابق تمامًا.", counts: { adm_flag: 1, adm_store: builtCount, adm_file: fileCount, adm_memory: a.memory ? plan.stages.filter((s) => s.deliver).reduce((n, s) => n + a.memory!.counts(s.key).accepted, 0) : -1, ...(parentFixedRows > 0 ? { adm_parent_fixed: parentFixedRows } : {}) } });
    deps.log?.(`settle_flags ${mission.id} ${flags.join(",")}`);
  }
  // ONE SOURCE OF TRUTH for the numbers: the counts and the money are stated by code, from the count of the file and the real settlement; the stored summary is the model's note (kept only when it has no number in it, so it can
  // never disagree with the count) or, when no model carried the mission out, a sentence built here; for a shortfall, the honest reason from the stop reason the run RECORDED (never a number, never «صف» or «سجل»)
  // THE TARGET is what the customer approved and what the charge is settled against; THE REQUEST is what they asked for (the same number unless the model proposed fewer, with a reason the card showed): a delivery below the request is never «complete»
  // THE REPLIES COME IN ADDITION (replies.ts): the customer's number counts the videos and the top-level comments; the replies are an estimate bought on top, so a delivery is complete or partial by the top-level rows alone (fewer replies than estimated is never a shortfall)
  const tl = topLevelFactsOf(plan, fileByStage);
  const deliveredTop = Math.max(0, delivered - tl.repliesDelivered);
  const target = plan.price.deliveredRows - tl.repliesPlanned - openGap;
  const requested = requestedRowsOf(plan) - tl.repliesPlanned;
  const internalStage = delivered <= 0 ? plan.stages.find((s) => snap.stage(s.key).stop === "internal_error") : undefined;
  if (internalStage) flags.push("engine_zero_ingest");
  // THE MODEL REVIEW COULD NOT ANSWER AND NOTHING WAS DELIVERED: items were found and are still waiting for a verdict that never came. That is OUR failure (live, 2026-10-31: 50 companies pending, all six review answers unusable, and the customer was told no
  // source serves the request). Failed, flagged for the admin with the first words of the unusable answer, told to the customer as ours; the hold is released whole as for any zero delivery.
  const reviewFailedOurs = !internalStage && delivered <= 0 && checked.stop === "failed" && checked.pending > 0;
  if (reviewFailedOurs) flags.push("review_failed");
  const ourFailure = Boolean(internalStage) || reviewFailedOurs;
  const note = a.summary && !HAS_NUMBER.test(a.summary) ? a.summary.trim() : "";
  const shortStage = plan.stages.find((s) => s.deliver && s.replies_of === undefined && snap.counts(s.key).accepted < s.planned_rows);
  // the reason is about the stage that fell short: the language rule only ever applies to a stage of top-level items (a child stage is delivered raw), and a child stage that fell short while its parents were read says so
  const parentOfShort = shortStage && shortStage.parent_key !== null ? plan.stages.find((p) => p.key === shortStage.parent_key) : undefined;
  const childShareClause = (() => {
    if (!shortStage || !parentOfShort) return null;
    const isFillTotal = shortStage.engine?.fill_total_across_parents === true && shortStage.per_parent_rows === undefined;
    if (!isFillTotal && parentsBelowShare(plan, shortStage.key, rowsByStage) <= 0) return null;
    const pNoun = itemNounOf(parentOfShort.title_ar);
    const cNoun = itemNounOf(shortStage.title_ar);
    const epCap = deps.catalog.byId.get(shortStage.endpoint_id)?.capability ?? "";
    const withArticle = (w: string) => (w.startsWith("ال") ? w : `ال${w}`);
    if (isPeopleStage(shortStage) || PEOPLE_OF_COMPANY_CAPABILITIES.has(epCap)) {
      const targetRole = cNoun.key === GENERIC_ITEM_NOUN.key || cNoun.key === pNoun.key ? "مديرًا" : cNoun.tamyiz;
      return `لأن بعض ${withArticle(pNoun.plural)} لم نجد لها ${targetRole} مطابقًا في المصادر`;
    }
    if (MAILBOX_LISTER_CAPABILITIES.has(epCap) || isContactSource(shortStage.endpoint_id) || cNoun.key === pNoun.key || cNoun.key === GENERIC_ITEM_NOUN.key) {
      return `لأن بعض ${withArticle(pNoun.plural)} لم نجد لها بيانات تواصل منشورة`;
    }
    return childShortfallClauseAr(pNoun.singular, pNoun.plural, cNoun.plural, isFillTotal);
  })();
  const checkedForShort = {
    ...checked,
    // THE SHORT STAGE'S OWN waiting items (live A1/A2: ten surplus companies a review never needed made the PEOPLE stage's shortfall «the review ran out»)
    pending: shortStage ? snap.counts(shortStage.key).pending : checked.pending,
    languageLeftOut: shortStage && shortStage.parent_key === null ? snap.counts(shortStage.key).excludedByReason.filter_language ?? 0 : 0,
    childShare: childShareClause,
  };
  // NOTHING DELIVERED: the reason is stated from what the run recorded for the delivered stages (found, left out per reason, waiting for a review, why it stopped), never from the model's note and never a guess
  const deliveredStages = plan.stages.filter((s) => s.deliver);
  const zeroFacts: ZeroDeliveryFacts = {
    found: deliveredStages.reduce((n, s) => n + snap.counts(s.key).new, 0),
    excludedByReason: deliveredStages.reduce<Record<string, number>>((acc, s) => { for (const [k, n] of Object.entries(snap.counts(s.key).excludedByReason)) acc[k] = (acc[k] ?? 0) + (n ?? 0); return acc; }, {}),
    pending: deliveredStages.reduce((n, s) => n + snap.counts(s.key).pending, 0), reviewStop: checked.stop, stop: deliveredStages.length > 0 ? snap.stage(deliveredStages[0].key).stop : null,
  };
  // WHAT THE SHORT STAGE FOUND AND LEFT OUT, from its recorded counts, when our own row rules left out what the source gave (never «the source gave no more» for rows it did give)
  const shortCounts = shortStage ? snap.counts(shortStage.key) : null;
  const shortTruth = shortStage && shortCounts ? stageTruthBodyAr({ found: shortCounts.found, duplicates: shortCounts.duplicates, delivered: shortCounts.accepted, excludedByReason: shortCounts.excludedByReason as Record<string, number>, pending: shortCounts.pending, reviewStop: checked.stop, stop: snap.stage(shortStage.key).stop, people: isPeopleStage(shortStage), noun: itemNounOf(shortStage.title_ar) }) : null;
  const shortClause = shortTruth ? `إذ ${shortTruth}` : shortfallClauseAr(shortStage ? snap.stage(shortStage.key).stop : null, checkedForShort);
  // THE SOURCE ENDED BEFORE THE PROMISE (S6): the promise for the comments and replies is the platform's counters; when every tool ended short of it, the text says so with the real numbers
  const promiseStages = plan.stages.filter((x) => x.deliver && x.promise_total !== undefined);
  const promiseLine = !ourFailure && delivered > 0 && promiseStages.length > 0
    ? promiseShortfallAr({ delivered: promiseStages.reduce((n, x) => n + rowsByStage[x.key].length, 0), promised: Math.max(...promiseStages.map((x) => x.promise_total!)), stops: promiseStages.map((x) => snap.stage(x.key).stop) })
    : "";
  const reason = promiseLine ? promiseLine : ourFailure ? INTERNAL_FAILURE_AR
    : delivered > 0 && deliveredTop < target ? (shortTruth ? `لم يكتمل العدد المطلوب ${shortClause}، ولم يُخصم إلا مقابل ما سُلّم.` : shortfallFromStopAr(shortStage ? snap.stage(shortStage.key).stop : null, checkedForShort))
    : delivered > 0 && deliveredTop < requested ? loweredTargetAr(plan)
    : delivered <= 0 ? zeroDeliveryReasonAr(zeroFacts) : "";
  // THE REPLIES' OWN SHORTFALL (S2 item 5): the replies stage is never the «short stage» (a delivery is complete or partial by its top-level rows), so a gap made of replies was told as fewer comments or not at all; its true reason is said from the replies stage's recorded stop
  const repliesStage = plan.stages.find((s) => s.deliver && s.replies_of !== undefined);
  // (redesigned missions only: the replies stage of a plan built by code carries `built_by: "code"`; an old-pipeline mission keeps its text byte for byte)
  const repliesLine = !ourFailure && !promiseLine && delivered > 0 && repliesStage?.engine?.built_by === "code" ? repliesShortfallAr({ planned: tl.repliesPlanned, delivered: tl.repliesDelivered, stop: snap.stage(repliesStage.key).stop, review: { pending: 0, stop: null }, withMoney: reason === "" }) : "";
  // P0, 14 NOV 2026: delivered items that are not the named source's are said to the customer (the file's mark alone was not enough: msn_dd7c2e9c131b8783bf2e closed «completed» with every item marked «غير مطابق»)
  const namedText = typeof plan.compiled?.source_text === "string" && plan.compiled.conditions?.named === true ? plan.compiled.source_text : null;
  const namedParent = namedText && !ourFailure ? plan.stages.find((s) => s.deliver && s.parent_key === null) : undefined;
  const namedRows = namedParent ? rowsByStage[namedParent.key] ?? [] : [];
  const namedLine = namedParent && namedText ? namedSourceTruthAr({ source: namedText, delivered: namedRows.length, notFromSource: namedRows.filter((r) => namedAuthorVerdict(r as Record<string, unknown>, (isSocialPlatform(String(plan.compiled?.platform ?? "")) ? plan.compiled!.platform : null) as Parameters<typeof namedAuthorVerdict>[1], namedText) === false).length }) : null;
  if (namedLine) flags.push("named_source_mismatch");
  const summary = (ourFailure ? reason : [note, reason, repliesLine, namedLine ?? ""].filter(Boolean).join(" ")).slice(0, 1100);
  const unusableWords = checked.lastUnusable ? checked.lastUnusable.replace(/\s+/g, " ").slice(0, 120) : "";
  const adminFlag = flags.length > 0 ? `admin: ${[...new Set(flags)].join(", ")}${internalStage ? ` stage=${internalStage.key} source_rows=${snap.stage(internalStage.key).sourceRows}` : ""}${reviewFailedOurs ? ` pending=${checked.pending} review_failed_calls=${checked.failedCalls} unusable="${unusableWords}"` : ""}` : null;
  await ensureOwned(deps, mission.id);
  await store.updateMission(mission.id, {
    status: ourFailure ? "failed" : delivered > 0 ? "completed" : "unserved", delivered_units: delivered, ...(hadOpenReplies ? { plan_public: customerPlanView(plan) as any } : {}), charged_points: settled.chargedPoints, summary_ar: summary || null, files: files.length ? files : null,
    execution_llm_usd: Number(llm.toFixed(6)), execution_treg_usd: Number(a.executionTregUsd.toFixed(6)), error: ourFailure ? adminFlag : a.outputError ?? adminFlag, ...clear,
  });
  if (internalStage) await store.addEvent(mission.id, { kind: "call", message_ar: "علامة داخلية للمشرف: أعطى المصدر عناصر ولم يُحفظ أي منها.", counts: { adm_flag: 1, adm_store: 0, adm_file: 0, adm_source_rows: snap.stage(internalStage.key).sourceRows } });
  if (reviewFailedOurs) await store.addEvent(mission.id, { kind: "call", message_ar: "علامة داخلية للمشرف: تعذّرت مراجعة العناصر آليًا فلم يُسلَّم شيء.", counts: { adm_flag: 1, adm_pending: checked.pending, adm_review_failed_calls: checked.failedCalls } });
  // the rows of a stage as the customer receives them: a delivered stage's count in the FILE (its own sheet); a stage that is not delivered (an intermediate one) keeps the items saved
  const stageRowsOf = (s: PricedPlan["stages"][number]): number => (s.deliver ? (fileByStage[s.key] ?? 0) : rowsByStage[s.key].length);
  await store.addEvent(mission.id, { kind: "result", message_ar: summary || (delivered > 0 ? "اكتملت المهمة." : "لم يُسلَّم أي شيء."), counts: { delivered, charged_points: settled.chargedPoints, ...Object.fromEntries(plan.stages.map((s, i) => [`stage_${i + 1}_rows`, stageRowsOf(s)])), ...parentCountsOf(plan, rowsByStage) } });
  const noticeKind: MissionNoticeKind = ourFailure ? "failed" : delivered <= 0 ? "unserved" : deliveredTop < requested ? "partial" : "completed";
  const noticeStages = plan.stages
    .filter((s) => s.deliver && s.replies_of === undefined)
    .map((s) => {
      const ep = deps.catalog.byId.get(s.endpoint_id);
      const epCap = ep?.capability ?? "";
      const people = isPeopleStage(s) || PEOPLE_OF_COMPANY_CAPABILITIES.has(epCap);
      const contacts = !people && (MAILBOX_LISTER_CAPABILITIES.has(epCap) || isContactSource(s.endpoint_id));
      const deliveredRows = fileByStage[s.key] ?? 0;
      return {
        titleAr: s.title_ar,
        delivered: deliveredRows,
        planned: s.planned_rows,
        parentKey: s.parent_key,
        isPeople: people,
        isContacts: contacts,
        ...(epCap ? { capability: epCap } : {}),
        ...(ep?.platform ? { platform: ep.platform } : {}),
      };
    });
  await tell(deps, mission, jobId, noticeKind, { delivered, planned: promisedTotalOf(plan, Object.fromEntries(plan.stages.map((s) => [s.key, rowsByStage[s.key].length])), hadOpenReplies).promised, chargedPoints: settled.chargedPoints, releasedPoints: settled.releasedPoints, reservedPoints: reserve, noun: noun.singular, hasJob: true, ...(noticeStages.length > 0 ? { stages: noticeStages } : {}), ...(isFreeRerun ? { free: true } : {}), ...(ourFailure ? { cause: "internal" as const } : delivered <= 0 ? { cause: "empty" as const } : {}), ...(delivered > 0 && deliveredTop < target ? { shortfallClauseAr: shortClause } : delivered > 0 && deliveredTop < requested ? { shortfallClauseAr: loweredTargetClauseAr(plan) } : {}) });
  // STAGE 4, S1 (behind DIGER_STAGE4_VERSIONS): version 1 of the delivered file, AFTER the file is stored and the mission is settled and told. Never throws, never changes the mission, never touches a money value (agent/src/stage4/firstVersion.ts).
  if (receipt.csv_path && delivered > 0 && !ourFailure) await storeFirstVersion({ store, log: deps.log }, { missionId: mission.id, userId: mission.user_id });
}

/**
 * P0 (15 Nov 2026, msn_8824508f840f703dee69): the request reached the planner with nothing to search for (no topic, no source). It is OUR reading that failed, never the sources: said as it is, before any call, nothing held or charged.
 */
export const NO_TOPIC_END_AR = "لم نستطع أن نحدد من رسالتك ما الذي نبحث عنه بالضبط (الموضوع أو الحساب)، فلم نرسل أي بحث ولم نجهّز خطة ولم يُخصم منك شيء. اكتب طلبك كاملًا في رسالة واحدة: المنصة، والموضوع، والحساب إن أردت، والعدد، والفترة.";
/** What the customer is told when the source gave items and our own mapping stored none: it was OUR failure, never «nothing was found». No number: the money line says the rest. */
export const INTERNAL_FAILURE_AR = "تعذّر استكمال تنفيذ طلبك في الوقت الحالي، وليس لأن المصدر خالٍ من النتائج. لم يُخصم منك شيء، وأُبلغ فريقنا بالأمر ليراجعه.";
const loweredTargetClauseAr = (plan: PricedPlan): string => (plan.quantity?.reason_ar ? `لأن ${plan.quantity.reason_ar.replace(/[.،\s]+$/, "")}` : "لأن الخطة التي اعتمدتها كانت بعدد أقل من المطلوب");
/** The sentence of a delivery that met the approved target when the target was lower than the request. */
export const loweredTargetAr = (plan: PricedPlan): string => `سُلّم العدد الذي اعتمدته في الخطة، وهو أقل مما طلبت ${loweredTargetClauseAr(plan)}.`;

const shortError = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 300);

/**
 * WHAT HAPPENS WHEN A RUN ENDS WITH AN EXCEPTION (or ends without leaving the mission in any state): the mission must never stay «planning» / «executing» under a worker that is no longer running it.
 *  - planning (nothing was held): back to «queued» (counted, at most AGENT_ERROR_REQUEUES_MAX times), then one honest Arabic message;
 *  - execution (a reserve is held): back to «approved» with everything it saved (counted), then settled with what is saved through the existing settlement functions, the rest of the hold released.
 * Every step here is guarded: if even this fails, the mission is simply not renewed (the worker only renews missions it runs), its lease ends and another run takes it over.
 */
export async function recoverFromError(deps: RunnerDeps, mission: MissionRecord, error: unknown): Promise<void> {
  const { store } = deps;
  const message = shortError(error);
  deps.log?.(`mission_error ${mission.id} ${message.slice(0, 200)}`);
  try {
    const fresh = (await store.getMission(mission.id)) ?? mission;
    if (fresh.status !== "planning" && fresh.status !== "executing") return; // the run had already moved it on: nothing is left leased
    if (fresh.status === "planning") {
      if (await requeue(deps, fresh, "queued", { error: message }, "error")) return;
      await endPlanningUnserved(deps, fresh, message);
      return;
    }
    const plan = fresh.plan;
    const reserve = Number(fresh.reserved_points);
    const unit = Number(fresh.unit_price_points);
    if (!plan || !fresh.job_id || !(reserve > 0) || !(unit > 0)) return;
    if (await resumeExecutionDelivery(deps, fresh, plan, reserve)) return;
    if (await requeue(deps, fresh, "approved", { error: message }, "error")) return;
    await settleExecution(deps, fresh, plan, reserve, { llm: Number(fresh.execution_llm_usd ?? 0), executionTregUsd: Number(fresh.execution_treg_usd ?? 0), summary: null, outputError: message });
  } catch (e) {
    deps.log?.(`recovery_failed ${mission.id} ${shortError(e).slice(0, 120)}`);
  }
}

/**
 * THE ONE ENTRY POINT OF THE WORKER FOR A CLAIMED MISSION: runs the phase its status names, and whatever happens (an exception, or a run that returns without leaving the mission in any state) the mission ends in a clean
 * state (recoverFromError). Never throws.
 */
export async function runMissionSafely(deps: RunnerDeps, mission: MissionRecord): Promise<void> {
  try {
    if (mission.status === "planning") await runPlanning(deps, mission);
    else if (mission.status === "executing") await runExecution(deps, mission);
    else return;
  } catch (e) {
    if (deps.leaseLost?.()) { deps.log?.(`lease_lost_stop ${mission.id}: no recovery, another worker owns it`); return; }
    // ownership could not be established (ownership.ts): nothing is written; the lease runs out and the claim gives the mission to a worker that resumes and settles it
    if (isOwnershipError(e)) { deps.log?.(`ownership_stop ${mission.id} ${shortError(e).slice(0, 160)}: no recovery write, the lease path takes it over`); return; }
    await recoverFromError(deps, mission, e);
    return;
  }
  if (deps.leaseLost?.()) { deps.log?.(`lease_lost_stop ${mission.id}: no recovery, another worker owns it`); return; }
  try {
    const after = await deps.store.getMission(mission.id);
    // the run returned but left the mission «planning» / «executing» under this worker: that is a lease nobody works on
    if (after && (after.status === "planning" || after.status === "executing") && after.worker_id === mission.worker_id) await recoverFromError(deps, after, "the run ended without a result");
  } catch (e) {
    deps.log?.(`post_run_check_failed ${mission.id} ${shortError(e).slice(0, 120)}`);
  }
}
