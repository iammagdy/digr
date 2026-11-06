import { buildAsk, channelNamesOf, type Ask } from "../../src/lib/agentMission/foundation/ask";
import { isOccurrenceAnswer, isRecurringEvent, occurrenceChoiceOf, OCCURRENCE_OPTIONS_AR, OCCURRENCE_QUESTION_AR, OCCURRENCE_YEAR_QUESTION_AR, type Occurrence } from "../../src/lib/agentMission/foundation/occurrence";
import { checkChannelsAgainstWords } from "../../src/lib/agentMission/foundation/understand";
import { buildShapeDigest } from "../../src/lib/modelPlanner/digest";
import { carriedBy, chooseCard, compilePlan, parentInputs, rankedCards, rankedPoolOf, COMPILED_PLATFORMS, type CompileResult } from "../../src/lib/agentMission/foundation/compilePlan";
import { channelAnswerOf, channelEvidenceOf, youtubeChannelChoiceQuestionAr } from "../../src/lib/agentMission/foundation/discovery/channelEvidence";
import { fieldNotesAr, recoverFields, sheetWantsOf, type FieldReport } from "../../src/lib/agentMission/foundation/discovery/fieldRecovery";
import { mediaMarkOf, mediaNotesAr, reelsBasisOf, reelsCandidates, type MediaMark } from "../../src/lib/agentMission/foundation/discovery/media";
import { candidateViewOf, discoveryMarkOf, discoveryNotesAr, pagingOf, type DiscoveryEvaluation, type DiscoveryMark, type SelectCapability } from "../../src/lib/agentMission/foundation/discovery/plan";
import { factsOf, isAboutAndEligible, pageMatchesSource, rankPool } from "../../src/lib/agentMission/foundation/pool";
import { aboutQueryOf, noAboutChoiceOf, noAboutQuestionAr, NO_ABOUT_OPTIONS_AR } from "../../src/lib/agentMission/foundation/topicChoice";
import { NAMED_SHORTFALL_OPTIONS_AR, isNamedShortfallAnswer, namedShortfallChoiceOf, namedShortfallQuestionAr } from "../../src/lib/agentMission/foundation/namedShortfall";
import { YOUTUBE_CHANNEL_QUESTION_AR, matchChannel, youtubeChannelOf, type YoutubeChannelRef } from "../../src/lib/agentMission/foundation/youtubeChannel";
import { INSTAGRAM_ACCOUNT_QUESTION_AR, instagramAccountNoteAr } from "../../src/lib/agentMission/foundation/instagramAccount";
import { budgetOfWords, questionNeeded, type Choices } from "../../src/lib/agentMission/foundation/countChoice";
import { fitToBudget } from "../../src/lib/agentMission/foundation/budgetFit";
import { applyAskEdit, type AskEdit } from "../../src/lib/agentMission/stage2/askCard";
import { questionCardsFor } from "../../src/lib/agentMission/stage2/questionCards";
import { toArabicDigits } from "../../src/lib/arabicDigits";
import { cardOf, cardsFor, CATALOG_ONLY_CAP_USD, mapPage, type ToolCard } from "../../src/lib/agentMission/foundation/toolCards";
import { PARENT_ROLES, REPLY_ROLE } from "../../src/lib/agentMission/foundation/compilePlan";
import type { PricedPlan } from "../../src/lib/agentMission/plan";
import type { MissionPricingSettings } from "../../src/lib/missionPricing";
import type { TregCatalog } from "../../src/lib/treg/catalog";
import { isSocialPlatform, type PlatformFlags, type SocialPlatform } from "../../src/lib/agentMission/redesignFlagTypes";
import { RAW_PATH, type GatewayCallResult } from "./gateway";
import type { AgentStore, CallRow, MissionRecord } from "./types";

/**
 * THE COMPILED PLANNING (docs/FOUNDATION-PLAN.md PR 2a; F1-F5 by code, no model). Only for a platform of COMPILED_PLATFORMS (TikTok, X), and only when that platform's OWN flag
 * is `on`, or `test` for a test account (an unset platform flag, «inherit», keeps today's path: nothing changes by default). Every page is read THROUGH THE GATEWAY passed in
 * (the planning budget, the daily cap, the two-samples-per-source cap of the protected gateway.ts and the call record all apply); nothing here calls a provider by itself.
 */
/** The words of the «no row about the topic» question, per platform. */
const NO_ABOUT_NOUN: Record<string, { one: string; talks: string }> = { tiktok: { one: "فيديو", talks: "يتحدث نصه" }, youtube: { one: "فيديو", talks: "يتحدث نصه" }, x: { one: "تغريدة", talks: "يتحدث نصها" }, facebook: { one: "منشور", talks: "يتحدث نصه" }, instagram: { one: "منشور", talks: "يتحدث نصه" } };

export function compiledPlatformActive(platformFlags: PlatformFlags | undefined, platform: SocialPlatform | null | undefined, isTest: boolean): boolean {
  if (!platform || !(COMPILED_PLATFORMS as ReadonlyArray<string>).includes(platform) || !isSocialPlatform(platform)) return false;
  const own = platformFlags?.[platform];
  return own === "on" || (own === "test" && isTest);
}

export interface CompiledPlanningDeps {
  mission: Pick<MissionRecord, "id" | "request_text" | "answer_text" | "created_at">;
  gateway: { tregCall: (input: { endpoint_id?: unknown; params?: unknown; purpose?: unknown }) => Promise<GatewayCallResult | Record<string, unknown>> };
  store: Pick<AgentStore, "getFile">;
  catalog: Pick<TregCatalog, "byId">;
  pricingSettings?: MissionPricingSettings;
  nowMs: number;
  /** The customer's edit of the card (Stage 2 recompiles with it). */
  edits?: Ask["edits"];
  /** Owner decision 7.4: the account is a TEST account, so a `catalog_only` card may build a stage (within its dollar cap). Absent: never. */
  catalogOnly?: boolean;
  /**
   * THE PAGES ALREADY READ for this mission (its recorded planning calls): after the customer answers a question the planning runs again, and the gateway counts the earlier reads against its two samples of a source (`repeat_sample`), so a pool read a second time would be refused
   * and the plan could not be made. A read whose endpoint and inputs equal a recorded ok call is served from that call's saved page: no new call, no new cost.
   */
  priorCalls?: ReadonlyArray<CallRow>;
  /** F1, the understand step: fills the names of the official channels (a small structured model request); code checks them against the customer's words. Absent: the names are read from the topic. */
  understand?: (input: { request: string; topic: string | null }) => Promise<{ channels: string[]; costUsd: number } | null>;
  /**
   * ROUND 33, CATALOG DISCOVERY: the cards the plan may be built from, the hand-written ones AND the ones derived from the catalog (`discovery/index.ts`, switched on by the `social_discovery` setting for a test account). Absent: the hand-written cards only, exactly as before:
   * nothing below changes for a mission without it.
   */
  cards?: ReadonlyArray<ToolCard>;
  /** ROUND 33: asks the model WHICH of several validated candidate tools serves the request best (it sees only the candidates code validated, and its answer is checked to be one of them); absent or unusable: the best-ranked candidate. */
  selectCapability?: SelectCapability;
  /** ROUND 33: the catalog check of a chain of cards (parents, comments, replies): what makes a chain unusable (an unknown or blocked endpoint, an input the catalog does not declare, a key the parent does not give). Built by the worker with the full catalog and the account's access. */
  chainIssues?: (cards: ReadonlyArray<ToolCard>) => unknown[];
  /** ROUND 34: the catalog's tools of the platform the discovery could not use, with the reason (for the audit mark of every plan). */
  discoveryRejected?: ReadonlyArray<{ endpointId: string; reason: string }>;
  /** Decision 7: the occurrence the customer chose earlier in this mission (the answer of a later question replaces `answer_text`). */
  occurrence?: Occurrence;
  /** ROUND 14, PART B: the production run asks the count and the comments per parent BEFORE any read when the request gives none (`askCount`); a planning made by a test or a tool that does not set it never asks (today's behaviour). `choices` are what the customer chose at those questions, `questionsAsked` how many cards the request has had (at most three), `answerIsChoice` that the current answer is one of them (the request is read without its words). */
  askCount?: boolean;
  choices?: Choices;
  /** STAGE 2 (docs/STAGE-2.md S2, flag DIGER_STAGE2_ASK_CARD, read by the caller): the customer's card edits, applied by code in order after the request is read; a refused edit is skipped. Absent: nothing changes. */
  askEdits?: ReadonlyArray<AskEdit>;
  /** STAGE 2 S5 (DIGER_STAGE2_QUESTION_CARDS, read by the caller): the questions before the plan come from the Stage 2 policy (questionCards.ts), one card at a time. Absent: today's `questionNeeded`. */
  questionCards?: boolean;
  /** STAGE 2 S5: the topic relation the customer chose on the topic-relation card. */
  topicRelation?: "about" | "made_with";
  questionsAsked?: number;
  answerIsChoice?: boolean;
}
export type CompiledPlanning =
  | { kind: "plan"; plan: PricedPlan; ask: Ask; result: Extract<CompileResult, { ok: true }>; reads: { pool: number; exposure: number }; discovery?: DiscoveryMark }
  | { kind: "cannot"; ask: Ask; reason: string; reads: { pool: number; exposure: number } }
  /**
   * LIVE ROUND 7: no video of the pool read (two queries) is about the topic; the customer is asked before approval how to go on. Nothing is priced or held. PR 3, decision 7.5 (`why: "named_shortfall"`): the named Facebook page has fewer
   * deliverable posts in the pool than asked.
   */
  | { kind: "question"; ask: Ask; question: string; options: string[]; reads: { pool: number; exposure: number }; why?: "no_about" | "named_shortfall" | "occurrence" | "occurrence_year" | "count" | "per_parent" | "instagram_account" | "youtube_channel" | "topic_relation" };

/** What the understand step cost (USD), carried on the result so the caller adds it to the mission's model cost (never a charge). */
export type WithCost<T> = T & { llmCostUsd?: number };

/** The pages a parent may be read for at planning beyond the ones it needs (the exposure check replaces an empty parent by the next one). */
const EXPOSURE_EXTRA = 3;
/** ROUND 17: the most pages one listing is walked back through at planning for a period (the gateway's own two samples of a source end the walk earlier today; this only bounds it if that cap ever changes). */
export const LISTING_WALK_MAX_PAGES = 12;

/** The digest the gateway writes for a call's inputs: strings cut at 80 characters (300 for a key that starts with «_»). */
const clipped = (k: string, v: unknown): unknown => (typeof v === "string" ? v.slice(0, k.startsWith("_") ? 300 : 80) : v);
const present = (v: unknown): boolean => v !== undefined && v !== null && v !== "";
const sameInputs = (digest: Record<string, unknown>, params: Record<string, unknown>): boolean => {
  const a = Object.entries(digest).filter(([, v]) => present(v));
  const b = Object.entries(params).filter(([, v]) => present(v));
  return a.length === b.length && b.every(([k, v]) => present(digest[k]) && digest[k] === clipped(k, v));
};

/** Reads the pool and the exposure pages through the gateway, then compiles. */
export async function planByCompiler(deps: CompiledPlanningDeps): Promise<WithCost<CompiledPlanning>> {
  const cost = { usd: 0 };
  const seen: { pages: Array<{ card: ToolCard; page: unknown; nextCursor: string | null; hasMore: boolean | null }>; choice?: DiscoveryMark["selection"]; evaluation?: DiscoveryEvaluation; media?: MediaMark; fields?: FieldReport[] } = { pages: [] };
  let result = await planInner(deps, cost, seen);
  // ROUND 30: a plan made from an account the customer gave (the request named none) says so: the results are that account's, not all of Instagram
  const given = deps.choices?.instagramAccount;
  if (result.kind === "plan" && result.ask.platform === "instagram" && given && result.ask.source.text === given) {
    result = { ...result, plan: { ...result.plan, notes_ar: [...(result.plan.notes_ar ?? []), instagramAccountNoteAr(given)] } };
  }
  // ROUND 35: a request for REELS says, before approval, how the media type is served (a reels-only tool, the tool's media-type filter) or that it is unproven; the mark is kept with the plan whether or not discovery is on
  if (result.kind === "plan" && seen.media) {
    result = { ...result, plan: { ...result.plan, notes_ar: [...(result.plan.notes_ar ?? []), ...mediaNotesAr(seen.media)], compiled: { ...result.plan.compiled!, media: seen.media } } };
  }
  // ROUND 36: the fields the customer named and what the real page showed for each (the unavailable ones are said before approval; the recovered ones keep the path they were read from)
  if (result.kind === "plan" && seen.fields && seen.fields.length > 0) {
    result = { ...result, plan: { ...result.plan, notes_ar: [...(result.plan.notes_ar ?? []), ...fieldNotesAr(seen.fields, result.ask.wants ?? [])], compiled: { ...result.plan.compiled!, fields: seen.fields } } };
  }
  // ROUND 33: a plan whose parents were read by a tool derived from the catalog says so before approval, with what the pages showed about completeness (never «all of the platform»), and keeps the audit mark of the discovery
  // ROUND 34: EVERY PLAN OF A MISSION WITH DISCOVERY ON carries the mark, whichever tool was chosen (a verified tool took part in the same evaluation as the derived ones): the audit evidence that discovery was entered, what was eligible and what was chosen
  const planned = result.kind === "plan" ? result : null;
  if (planned && deps.cards && planned.plan.stages[0]) {
    const platformParents = planned.ask.platform ? PARENT_ROLES[planned.ask.platform] : [];
    const stage = planned.plan.stages.find((s) => deps.cards!.some((c) => c.endpointId === s.endpoint_id && platformParents.includes(c.role))) ?? planned.plan.stages[0];
    const poolCard = deps.cards.find((c) => c.endpointId === stage.endpoint_id);
    if (poolCard) {
      const last = seen.pages[seen.pages.length - 1];
      const hasMore = last ? last.hasMore ?? (last.nextCursor ? true : pagingOf(poolCard) === "declared" ? false : null) : null;
      const mark = discoveryMarkOf(poolCard, { pages: seen.pages.length, rows: stage.planned_rows, hasMore, ...(seen.choice ? { selection: seen.choice } : {}), ...(seen.evaluation ? { evaluation: seen.evaluation } : {}), ...(seen.media ? { media: seen.media } : {}) });
      result = { ...planned, discovery: mark, plan: { ...planned.plan, notes_ar: [...(planned.plan.notes_ar ?? []), ...discoveryNotesAr(poolCard, planned.ask, mark)], compiled: { ...planned.plan.compiled!, discovery: mark } } };
    }
  }
  return cost.usd > 0 ? { ...result, llmCostUsd: cost.usd } : result;
}

async function planInner(deps: CompiledPlanningDeps, cost: { usd: number }, seen: { pages: Array<{ card: ToolCard; page: unknown; nextCursor: string | null; hasMore: boolean | null }>; choice?: DiscoveryMark["selection"]; evaluation?: DiscoveryEvaluation; media?: MediaMark; fields?: FieldReport[] }): Promise<CompiledPlanning> {
  const cardsOpt = deps.cards ? { cards: deps.cards } : {};
  const at = Date.parse(String(deps.mission.created_at ?? ""));
  // THE CUSTOMER'S ANSWER TO THE NAMED-PAGE QUESTION (decision 7.5) and TO THE OCCURRENCE QUESTION (decision 7) are ready answers: they are read as choices and the request is read without their words
  const shortfallChoice = namedShortfallChoiceOf(deps.mission.answer_text);
  const occurrenceAnswer = occurrenceChoiceOf(deps.mission.answer_text);
  const answeredReady = isNamedShortfallAnswer(deps.mission.answer_text) || isOccurrenceAnswer(deps.mission.answer_text) || noAboutChoiceOf(deps.mission.answer_text) !== null || deps.answerIsChoice === true;
  const occurrenceEdit: Occurrence | undefined = occurrenceAnswer && occurrenceAnswer.kind !== "ask_year" ? occurrenceAnswer : deps.occurrence;
  let ask = buildAsk(deps.mission.request_text, answeredReady ? null : deps.mission.answer_text, Number.isFinite(at) ? at : deps.nowMs, { ...(deps.edits ?? {}), ...(occurrenceEdit && !deps.edits?.occurrence ? { occurrence: occurrenceEdit } : {}) });
  // ROUND 14, PART B: what the customer chose at the count questions and the budget (in the request's words or chosen) join the Ask
  const choices = deps.choices ?? {};
  const budget = choices.budget ?? budgetOfWords(deps.mission.request_text) ?? undefined;
  if (choices.count !== undefined && ask.count === null) ask = { ...ask, count: choices.count };
  if (choices.perParent === "all" && ask.comments !== "none") ask = { ...ask, comments: "all" };
  else if (typeof choices.perParent === "number" && ask.comments !== "none") ask = { ...ask, commentsPerParent: choices.perParent };
  if (budget !== undefined) ask = { ...ask, edits: { ...ask.edits, budget } };
  for (const e of deps.askEdits ?? []) { const r = applyAskEdit(ask, e, { nowMs: deps.nowMs }); if (r.ok) ask = r.ask; }
  if (deps.topicRelation && ask.topic.text) ask = { ...ask, topic: { ...ask.topic, relation: deps.topicRelation } };
  const reads = { pool: 0, exposure: 0 };
  // ROUND 30: INSTAGRAM WITH NO ACCOUNT. The only verified parent tool reads the posts of a named public account, so a request that names none is asked ONCE which account to read, before anything is read, held or priced; the account the customer gave
  // (read by code in the run, kept with the other choices) is the Ask's named source, and the topic and the count stay the request's own. A request that already NAMES a source (an account by an Arabic name, no username) is left exactly as it was. No usable answer ends the request honestly (the question is never asked twice). No provider capability is added.
  // ROUND 33: THE CANDIDATE TOOLS of the parents, best first. A tool derived from the catalog stays only if its chain with the comments and replies cards the request needs passes the catalog check (an identifier the next tool cannot take is refused HERE, before any read or hold)
  const rejectedChains: string[] = [];
  const parentCandidates = (a: Ask, from: ReadonlyArray<ToolCard> | undefined = deps.cards): ToolCard[] => {
    const catalogOnlyNow = deps.catalogOnly === true;
    const opt = from ? { cards: from } : {};
    let list = rankedCards(a, "parents", { catalogOnly: catalogOnlyNow, ...opt });
    // ROUND 35: a request for REELS is read only by a tool that proves the media type (a reels-only tool, or the tool's own media-type filter, sent on every call); when none can, the candidates stay as they were and the plan says the type is unproven
    if (a.media === "reels" && a.platform === "instagram") list = reelsCandidates(list).list;
    if (!deps.chainIssues) return list;
    // ROUND 34: the catalog check applies to EVERY candidate, a verified, hand-written tool as much as a derived one: a verified tool takes part in the same evaluation, it is not trusted past what the catalog now says (an endpoint the catalog dropped, an input it no longer declares)
    return list.filter((c) => {
      const repliesCards = a.replies !== "none" && a.platform ? cardsFor(a.platform, REPLY_ROLE[a.platform], { catalogOnly: catalogOnlyNow, ...opt }) : [];
      const comments = a.comments !== "none" ? chooseCard(a, "comments", { catalogOnly: catalogOnlyNow, repliesCards, ...opt }) : null;
      const replies = a.replies !== "none" ? chooseCard(a, "replies", { catalogOnly: catalogOnlyNow, ...opt }) : null;
      const issues = deps.chainIssues!([c, ...(comments ? [comments] : []), ...(replies && comments ? [replies] : [])]);
      if (issues.length > 0) rejectedChains.push(c.endpointId);
      return issues.length === 0;
    });
  };
  if (ask.platform === "instagram" && ask.source.kind !== "named" && chooseCard(ask, "parents", { catalogOnly: deps.catalogOnly === true, ...cardsOpt }) === null) {
    if (choices.instagramAccount) ask = { ...ask, source: { kind: "named", text: choices.instagramAccount } };
    else if (choices.instagramAccountDeclined) return { kind: "cannot", ask, reason: "instagram_account_missing", reads };
    else return { kind: "question", ask, why: "instagram_account", question: INSTAGRAM_ACCOUNT_QUESTION_AR, options: [], reads };
  }
  // ROUND 31: YOUTUBE WITH NO CHANNEL. The verified cards find a channel by name and search INSIDE a channel; none searches all of YouTube, and «<topic> الرسمية» is a guess, not a channel. A request that names no channel and does not ask for the official channels of an event
  // is asked ONCE which channel, before anything is read, held or priced; the answer (read by code, kept with the choices) or the channel named in the request is looked up by the verified channel search and used only if a result carries it. No usable answer ends the request honestly.
  let customerChannel: { ref: YoutubeChannelRef; said: string } | null = null;
  // ROUND 33: a keyword search of YouTube derived from the catalog (`videos.search`, a test account with the discovery switch) reads the videos of a request that names no channel; with it the question is not needed. Without such a candidate nothing changes.
  const searchOnly = (deps.cards ?? []).filter((c) => c.role === "videos.search");
  let keywordSearch = false;
  // ROUND 33: the customer's pick among the channels the evidence could not single out (an official-channel request) is a channel of their own, read as any channel the customer gave
  if (ask.platform === "youtube" && ask.source.kind === "official" && deps.cards !== undefined && choices.youtubeChannel !== undefined) { const ref = youtubeChannelOf(choices.youtubeChannel); if (ref) customerChannel = { ref, said: choices.youtubeChannel }; }
  if (ask.platform === "youtube" && ask.source.kind !== "official" && !ask.edits.channels) {
    const said = choices.youtubeChannel ?? (ask.source.kind === "named" ? ask.source.text : null);
    const ref = said ? youtubeChannelOf(said) : null;
    if (ref && said) customerChannel = { ref, said };
    else if (choices.youtubeChannelDeclined || (ask.source.kind === "named" && ask.source.text)) return { kind: "cannot", ask, reason: "youtube_channel_missing", reads };
    else if (searchOnly.length > 0 && parentCandidates(ask, searchOnly).length > 0) keywordSearch = true;
    else return { kind: "question", ask, why: "youtube_channel", question: YOUTUBE_CHANNEL_QUESTION_AR, options: [], reads };
  }
  // DECISION 7, A RECURRING EVENT with no year or date: «تقصد أنهي مرة؟» before anything is read or held (Facebook, Instagram, YouTube). «حدد سنة» asks for the year in words; a ready answer or a year is the choice.
  if (occurrenceAnswer?.kind === "ask_year") return { kind: "question", ask, why: "occurrence_year", question: OCCURRENCE_YEAR_QUESTION_AR, options: [], reads };
  if (!ask.occurrence && !answeredReady && isRecurringEvent(ask, `${deps.mission.request_text} ${deps.mission.answer_text ?? ""}`)) {
    return { kind: "question", ask, why: "occurrence", question: OCCURRENCE_QUESTION_AR(ask.topic.text ?? ""), options: [OCCURRENCE_OPTIONS_AR.latest, OCCURRENCE_OPTIONS_AR.all, OCCURRENCE_OPTIONS_AR.year], reads };
  }
  // a recurring event whose question was answered earlier (the answer of a later question replaced it) and was not kept: the default, the latest occurrence
  if (!ask.occurrence && answeredReady && isRecurringEvent(ask, deps.mission.request_text)) ask = { ...ask, occurrence: { kind: "latest" } };
  // THE COUNT AND THE COMMENTS PER PARENT (Part B): asked before anything is read, only by the production run (`askCount`), at most three cards in all
  if (deps.askCount === true && deps.questionCards === true) {
    // STAGE 2 S5: the policy's most important card that the compiled planning can ask now (the platform is known here and the occurrence was asked above), one at a time
    const card = questionCardsFor(ask, { requestText: deps.mission.request_text, alreadyAsked: deps.questionsAsked ?? 0 }).find((c) => c.code === "count" || c.code === "per_parent" || c.code === "topic_relation");
    if (card && ask.platform && (COMPILED_PLATFORMS as ReadonlyArray<string>).includes(ask.platform)) return { kind: "question", ask, why: card.code as "count" | "per_parent" | "topic_relation", question: card.questionAr, options: card.options.map((o) => o.labelAr), reads };
  } else if (deps.askCount === true) {
    const q = questionNeeded(ask, choices, deps.questionsAsked ?? 0);
    if (q && ask.platform && (COMPILED_PLATFORMS as ReadonlyArray<string>).includes(ask.platform)) return { kind: "question", ask, why: q.why, question: q.question, options: q.options, reads };
  }
  const recorded = new Set<string>();
  // the candidates the request can be read with, best first: a keyword search for a YouTube request with no channel, a channel's own listing for a named one, else every parent tool of the platform
  const candidatesOf = (a: Ask): ToolCard[] => (keywordSearch ? parentCandidates(a, searchOnly) : a.platform === "youtube" && deps.cards ? parentCandidates(a, deps.cards.filter((c) => c.inputs.source?.kind === "channel_id")) : parentCandidates(a));
  let candidates = candidatesOf(ask);
  let card: ToolCard | null = candidates[0] ?? null;
  // ROUND 33: SEVERAL validated candidates, at least one derived from the catalog: the model chooses among them (it sees only these, and its answer is checked to be one of them); no answer, or one that is not a candidate, leaves the best-ranked
  let selection: DiscoveryMark["selection"] | undefined;
  if (card && deps.selectCapability && candidates.length >= 2) {
    const views = candidates.map((c) => candidateViewOf(c, carriedBy(c, ask).carried, deps.catalog.byId.get(c.endpointId)?.capability ?? null));
    const said = await deps.selectCapability({ request: deps.mission.request_text, topic: ask.topic.text, candidates: views }).catch(() => null);
    if (said) cost.usd += Math.max(0, Number(said.costUsd) || 0);
    const picked = said ? candidates.find((c) => c.endpointId === said.endpointId) : undefined;
    if (picked) { card = picked; selection = { by: "model", candidates: candidates.map((c) => c.endpointId), reason: said!.reason }; }
    else selection = { by: "rank", candidates: candidates.map((c) => c.endpointId) };
  } else if (card && deps.cards) selection = { by: candidates.length === 1 ? "only_candidate" : "rank", candidates: candidates.map((c) => c.endpointId) };
  seen.choice = selection;
  // ROUND 34: the evidence of the evaluation (kept with the plan's mark): every candidate that passed, the catalog's tools of the platform that could not be used and why, and the chains refused before any read
  if (deps.cards && ask.platform) {
    const rejected: Record<string, number> = {};
    for (const r of deps.discoveryRejected ?? []) rejected[r.reason] = (rejected[r.reason] ?? 0) + 1;
    seen.evaluation = { platform: ask.platform, eligible: candidates.map((c) => ({ endpoint_id: c.endpointId, status: c.status, derived: c.derived !== undefined })), rejected, chain_refused: [...new Set(rejectedChains)] };
  }
  // OWNER DECISION 7.4: the calls made with catalog_only cards cost at most CATALOG_ONLY_CAP_USD a mission; a read that would pass it is not made (it counts as a read that did not answer)
  let catalogOnlySpentUsd = 0;
  const read = async (endpointId: string, params: Record<string, unknown>, using?: ToolCard): Promise<{ callId: string; page: unknown; nextCursor: string | null; hasMore: boolean | null } | { failed: true; refused: boolean }> => {
    // A PAGE ALREADY READ for this mission (a re-planning after the customer's answer) is served from its saved page: no call, no cost, and not counted against the gateway's samples
    for (const row of deps.priorCalls ?? []) {
      if ((row.phase ?? "planning") !== "planning" || row.status !== "ok" || row.endpoint_id !== endpointId || recorded.has(row.id) || !sameInputs(row.params_digest ?? {}, params)) continue;
      const callId = String(row.id).split(":").pop()!;
      const saved = await deps.store.getFile(deps.mission.id, RAW_PATH(callId));
      let page: unknown = null;
      try { page = saved === null ? null : JSON.parse(saved); } catch { page = null; }
      if (page === null) continue;
      recorded.add(row.id);
      const endpoint = deps.catalog.byId.get(endpointId);
      const reading = endpoint ? buildShapeDigest(page, endpoint as never).reading : null;
      return { callId, page, nextCursor: reading?.nextCursor ?? null, hasMore: reading?.hasMore ?? null };
    }
    const spend = using && using.status === "catalog_only" ? using.costUsdPerPage : 0;
    if (spend > 0 && catalogOnlySpentUsd + spend > CATALOG_ONLY_CAP_USD + 1e-9) return { failed: true, refused: false };
    catalogOnlySpentUsd += spend;
    const r = (await deps.gateway.tregCall({ endpoint_id: endpointId, params, purpose: deps.mission.request_text })) as Record<string, unknown>;
    if (r.ok !== true) return { failed: true, refused: "refused" in r };
    const raw = await deps.store.getFile(deps.mission.id, RAW_PATH(String(r.call_id)));
    let page: unknown = null;
    try { page = raw === null ? null : JSON.parse(raw); } catch { page = null; }
    return { callId: String(r.call_id), page, nextCursor: (r.next_cursor as string | null) ?? null, hasMore: (r.has_more as boolean | null) ?? null };
  };
  // ROUND 17: A NAMED FACEBOOK PAGE WITH NO TOPIC (live round 14: «منشورين من صفحة قناة العربية آخر ٣ شهور» was refused before any read). The page listing card needs the page's LINK and an Arabic name is not one: ONE read of the keyword search (the page's name as the keyword,
  // the period's days) finds the page by its author's name, word for word (code, never a filter), and its link is what the listing is read by. The customer's own name stays the Ask's source (the verdict of every row is made against it).
  let cardAsk: Ask = ask;
  if (!card && ask.platform === "facebook" && ask.source.kind === "named" && ask.source.text && !ask.topic.text && !/facebook\.com\//i.test(ask.source.text)) {
    const search = cardsFor("facebook", "posts.search", { catalogOnly: deps.catalogOnly === true }).find((c) => c.status === "verified");
    if (search) {
      const found = await read(search.endpointId, { ...(search.inputs.query ? { [search.inputs.query.field]: ask.source.text } : {}), ...(search.inputs.period && ask.period ? { [search.inputs.period.from]: ask.period.from, [search.inputs.period.to]: ask.period.to } : {}) }, search);
      reads.pool += 1;
      if (!("failed" in found)) {
        const hit = mapPage(search, found.page).find((r) => pageMatchesSource(r, ask.source.text!) && typeof r.author_url === "string" && r.author_url !== "");
        const link = hit ? String(hit.author_url).replace(/[?#].*$/, "").replace(/\/+$/, "") : null;
        if (link && /^https?:\/\/(?:www\.|m\.)?facebook\.com\/[A-Za-z0-9._-]+$/i.test(link)) {
          cardAsk = { ...ask, source: { kind: "named", text: link } };
          card = parentCandidates(cardAsk)[0] ?? null;
        }
      }
      if (!card) return { kind: "cannot", ask, reason: "page_not_found", reads };
    }
  }
  // ROUND 33: every candidate was refused by the catalog check of its chain: an Instagram request with no account is still asked for one, as before
  if (!card && ask.platform === "instagram" && ask.source.kind !== "named" && deps.cards && !choices.instagramAccountDeclined) {
    if (!choices.instagramAccount) return { kind: "question", ask, why: "instagram_account", question: INSTAGRAM_ACCOUNT_QUESTION_AR, options: [], reads };
  }
  if (!card) return { kind: "cannot", ask, reason: "no_parent_card", reads };
  const need = Math.max(1, ask.count ?? 10);
  const catalogOnly = deps.catalogOnly === true;
  let fellBackFrom: string | null = null;
  /** The pages the parents were read from, kept for the discovery mark (what the last page said about more results). */
  const track = (c: ToolCard, r: { page: unknown; nextCursor: string | null; hasMore: boolean | null }): void => { seen.pages.push({ card: c, page: r.page, nextCursor: r.nextCursor, hasMore: r.hasMore }); };
  /** A derived card's rows per page, from the first real page (never below one); every other card is returned as it is. */
  const measuredRows = (c: ToolCard, page: unknown): ToolCard => { if (!c.derived) return c; const n = mapPage(c, page).length; return n >= 1 ? { ...c, page: { ...c.page, observedRowsPerPage: n } } : c; };

  /** THE EXPOSURE CHECK and the compile, shared by every platform (decision 7.3): the first comments page of the ranked parents, in order, until enough parents with comments are found; a read the gateway refuses leaves the parent unchecked. */
  const finish = async (poolCard: ToolCard, params: Record<string, unknown>, pages: Array<{ callId: string; page: unknown; card?: ToolCard }>, extra: { counters?: ReadonlyMap<string, number>; channels?: ReadonlyArray<{ id: string; title?: string }>; customerChannel?: { display: string | null } } = {}): Promise<CompiledPlanning> => {
    const exposure = new Map<string, { callId: string | null; page: unknown | null; failed: boolean }>();
    const repliesCards = ask.replies !== "none" ? cardsFor(ask.platform!, "comment.replies", { catalogOnly }) : [];
    const commentsCard = ask.comments !== "none" ? chooseCard(ask, "comments", { catalogOnly, repliesCards }) : null;
    const counterKey = poolCard.counter?.key ?? (extra.counters ? "comments" : null);
    // NOV 6 2026: the customer's answer «أكمل بما وجدتموه كما هو» lets rows that do not name the topic be chosen (marked); otherwise they are never parents, and the exposure check reads only the eligible ones
    const allowUnrelated = noAboutChoiceOf(deps.mission.answer_text) === "use";
    if (commentsCard?.inputs.parent) {
      const ranked = rankedPoolOf({ ask, poolCard, pages, ...(extra.counters ? { counters: extra.counters } : {}), ...(extra.channels ? { channels: extra.channels } : {}), nowMs: deps.nowMs, ...(allowUnrelated ? { allowUnrelated: true } : {}) });
      let withComments = 0;
      for (const row of ranked) {
        if (withComments >= need || reads.exposure >= need + EXPOSURE_EXTRA) break;
        if (counterKey && Number(row[counterKey]) === 0) continue;
        const value = row[commentsCard.inputs.parent.from];
        if (value === undefined || value === null || value === "") continue;
        const r = await read(commentsCard.endpointId, { ...structuredClone(commentsCard.inputs.fixed ?? {}), [commentsCard.inputs.parent.param]: value }, commentsCard);
        reads.exposure += 1;
        if ("failed" in r) { exposure.set(row.id, { callId: null, page: null, failed: true }); withComments += 1; continue; }
        exposure.set(row.id, { callId: r.callId, page: r.page, failed: false });
        if (mapPage(commentsCard, r.page).length > 0) withComments += 1;
      }
    }
    const compileWith = (a: Ask) => compilePlan({
      ask: a, pool: { card: poolCard, params, pages }, exposure: (id) => exposure.get(id), capabilityOf: (id) => deps.catalog.byId.get(id)?.capability ?? null, pricingSettings: deps.pricingSettings, nowMs: deps.nowMs, ...(catalogOnly ? { catalogOnly: true } : {}), ...(ask.media === "reels" && ask.platform === "instagram" && reelsBasisOf(poolCard) !== "unproven" ? { reelsProven: true } : {}),
      ...(extra.counters ? { counters: extra.counters } : {}), ...(extra.channels ? { channels: extra.channels } : {}), ...(extra.customerChannel ? { customerChannel: extra.customerChannel } : {}), ...(shortfallChoice === "only_found" || shortfallChoice === "fill" ? { namedChoice: shortfallChoice } : {}),
      ...(allowUnrelated ? { allowUnrelated: true } : {}),
    });
    const result = compileWith(ask);
    if (!result.ok && result.reason === "named_shortfall") {
      // DECISION 7.5: before approval, nothing priced or held
      return { kind: "question", ask, why: "named_shortfall", question: namedShortfallQuestionAr(ask.source.text ?? "", result.found, result.need, toArabicDigits, ask.topic.text), options: [NAMED_SHORTFALL_OPTIONS_AR.onlyFound, NAMED_SHORTFALL_OPTIONS_AR.fill, NAMED_SHORTFALL_OPTIONS_AR.cancel], reads };
    }
    if (!result.ok && result.reason === "no_relevant_rows") {
      // NOV 6 2026: rows were read and none names the topic: the customer decides before approval, on every platform (the TikTok second query is above); nothing priced or held
      return { kind: "question", ask, why: "no_about", question: noAboutQuestionAr(ask.topic.text ?? "", NO_ABOUT_NOUN[ask.platform!], result.tagOnly > 0), options: [NO_ABOUT_OPTIONS_AR.useAsIs, NO_ABOUT_OPTIONS_AR.change, NO_ABOUT_OPTIONS_AR.cancel], reads };
    }
    if (!result.ok) return { kind: "cannot", ask, reason: result.reason, reads };
    // THE BUDGET IS A HARD CEILING on the hold (Part B): the largest version that fits, priced by the same price function; none fits: the plan is not made and the reason is the budget
    if (ask.edits.budget !== undefined) {
      const fit = fitToBudget(compileWith, ask, ask.edits.budget, need, ask.parentKind === "videos" ? "فيديو" : ask.parentKind === "tweets" ? "تغريدة" : "منشور");
      if (!fit.ok) return { kind: "cannot", ask, reason: "budget_too_small", reads };
      return { kind: "plan", plan: fit.plan, ask: fit.ask, result: fit.result, reads };
    }
    return { kind: "plan", plan: result.plan, ask, result, reads };
  };

  // YOUTUBE: the official channels are resolved first (a channel search by name), then each is read INSIDE (the channel's own videos about the topic): a plain search has no channel input, which is why M18 and M20 once took a video of another channel
  if (ask.platform === "youtube" && !keywordSearch) return customerChannel ? planYoutubeChannel(customerChannel.ref) : planYoutube();

  // F4: THE POOL, the first page of the chosen card (and its next page when the first holds fewer rows than are needed with their spares: the gateway allows two samples of one source)
  let params = parentInputs(card, cardAsk);
  let first = await read(card.endpointId, params, card);
  reads.pool += 1;
  // ROUND 33: A VALID FALLBACK. When the chosen tool's read FAILS (not when the gateway refuses it: a refusal is a limit, never worked around) and another validated candidate of the same role exists, the next-ranked one is read ONCE (the planning budget, the daily cap and the catalog_only cap all apply to that read too); nothing changes for a mission without candidates from the discovery.
  if ("failed" in first && !first.refused && deps.cards) {
    const alt = candidates.find((c) => c.endpointId !== card!.endpointId && c.role === card!.role);
    if (alt) {
      const altParams = parentInputs(alt, cardAsk);
      const r = await read(alt.endpointId, altParams, alt);
      reads.pool += 1;
      if (!("failed" in r)) { fellBackFrom = card.endpointId; card = alt; params = altParams; first = r; if (card.derived) seen.choice = { by: "rank", candidates: candidates.map((c) => c.endpointId), reason: `fallback from ${fellBackFrom}` }; }
    }
  }
  if ("failed" in first) return { kind: "cannot", ask, reason: first.refused ? "pool_refused" : "pool_failed", reads };
  // ROUND 33: a card derived from the catalog does not know how many rows a page holds (the catalog's example is trimmed to one item): the first real page measures it, so the price per row follows what the source really gave
  card = measuredRows(card, first.page);
  track(card, first);
  if (ask.media === "reels" && ask.platform === "instagram") seen.media = mediaMarkOf(card);
  // ROUND 36: THE FIELDS THE CUSTOMER NAMED, checked on the REAL first page just read (no extra call): in the card, recovered from the provider's own key (a card derived from the catalog only), or unavailable (said before approval)
  // NOV 6 2026: the platform's STANDARD parent fields too (Instagram: the account, the date, the likes), checked on the same page
  const sheetWants = sheetWantsOf(ask);
  if (sheetWants.length > 0) { const rec = recoverFields(card, first.page, sheetWants, deps.nowMs); card = rec.card; seen.fields = rec.report; }
  const pages: Array<{ callId: string; page: unknown; card?: ToolCard }> = [{ callId: first.callId, page: first.page }];
  // LIVE ROUND 7: «عن X» on a source whose search also matches hashtags. When no video of the first page has its own text about the topic, the one more read the gateway allows for this source asks the topic with the words of talking about it
  // (built by code from the Ask), and the union of both pages is ranked by the same rule. Only a search with no operators (TikTok); X's query is the quoted words of the text itself.
  const hasAbout = (): boolean => pages.some((p) => mapPage(card, p.page).some((r) => isAboutAndEligible(r, ask)));
  const aboutQuery = card.inputs.query && !card.inputs.query.operators && ask.platform === "tiktok" && noAboutChoiceOf(deps.mission.answer_text) !== "use" ? aboutQueryOf(ask) : null;
  // FACEBOOK'S KEYWORD SEARCH: the pool is two pages, the first and the next by the source's cursor (the two samples the gateway allows of one search tool): a search page holds about 5 posts, far too few to choose the named page's among (decision 7.2)
  // AN ACCOUNT LISTING with a period: the next page is read when the first page's oldest post is still inside the period (the listing has no date input, so the period is reached by paging back)
  const oldestMs = (): number => Math.min(...mapPage(card, first.page).map((r) => Date.parse(String(r.posted_at ?? ""))).filter((t) => Number.isFinite(t)), Infinity);
  // THE POOL OF A LISTING IS AS DEEP AS ITS CARD ALLOWS (live round 10: an account's 12 newest posts were the whole pool, so «the most commented» was the most commented of the last few hours): with no period the next page is read whenever the source has one (the gateway's two samples of a listing,
  // untouched); with a period, only while the first page's oldest post is still inside it
  const listing = card.role === "posts.account" || card.role === "posts.page" || (card.derived !== undefined && card.role === "videos.channel");
  const wantsSecond = card.role === "posts.search" || (listing && (ask.period === null ? ask.order === "most_commented" : oldestMs() >= ask.period.startMs));
  // the next page's value: the gateway's reading of the page, else the card's own cursor path (Instagram's listing keeps it in `next_max_id`, which the catalog does not describe)
  const cursorOf = (r: { page: unknown; nextCursor: string | null }): string | null => {
    if (r.nextCursor) return r.nextCursor;
    let v: unknown = r.page;
    for (const k of card.page.cursor ?? []) { if (v === null || v === undefined || typeof v !== "object") return null; v = (v as Record<string, unknown>)[k]; }
    return typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null;
  };
  if (aboutQuery && card.inputs.query && !hasAbout()) {
    const more = await read(card.endpointId, { ...params, [card.inputs.query.field]: aboutQuery }, card);
    reads.pool += 1;
    if (!("failed" in more)) { pages.push({ callId: more.callId, page: more.page }); track(card, more); }
  } else if ((mapPage(card, first.page).length < need + 2 || wantsSecond) && card.inputs.cursor && cursorOf(first) && first.hasMore !== false) {
    const second = await read(card.endpointId, { ...params, [card.inputs.cursor]: cursorOf(first) }, card);
    reads.pool += 1;
    if (!("failed" in second)) {
      pages.push({ callId: second.callId, page: second.page });
      track(card, second);
      // ROUND 17: A LISTING WITH A PERIOD WALKS BACK by its cursor, checking each row's date (Cairo days, by code), until a post older than the period's first day is read, the source has no more, a read does not answer, or the page limit is reached. It runs inside the planning budget and the gateway's own caps
      // (a read the gateway refuses ends the walk and the card says the period was not reached); no cap is raised here.
      if (listing && ask.period !== null) {
        let last: { page: unknown; nextCursor: string | null; hasMore: boolean | null } = second;
        const oldestOf = (): number => Math.min(...pages.flatMap((p) => mapPage(card, p.page)).map((r) => Date.parse(String(r.posted_at ?? ""))).filter((t) => Number.isFinite(t)), Infinity);
        while (reads.pool < LISTING_WALK_MAX_PAGES && oldestOf() >= ask.period.startMs && cursorOf(last) && last.hasMore !== false) {
          const more = await read(card.endpointId, { ...params, [card.inputs.cursor]: cursorOf(last) }, card);
          reads.pool += 1;
          if ("failed" in more) break;
          pages.push({ callId: more.callId, page: more.page });
          track(card, more);
          last = more;
        }
      }
    }
  }
  // A TEST ACCOUNT (decision 7.4) also reads the second keyword search once (up to 20 posts, 0.06606 USD of the 0.20): its first real response is what makes the card verifiable
  if (catalogOnly && card.role === "posts.search" && card.platform === "facebook") {
    const other = cardsFor("facebook", "posts.search", { catalogOnly: true }).find((c) => c.status === "catalog_only");
    if (other) {
      const r = await read(other.endpointId, parentInputs(other, ask), other);
      reads.pool += 1;
      if (!("failed" in r)) pages.push({ callId: r.callId, page: r.page, card: other });
    }
  }
  // STILL NONE: the customer decides before approval (use what was found, marked; change the request; cancel). Their answer «use» (or an amendment they typed, which changes the request and is read with it) is read at the next planning.
  if (aboutQuery && !hasAbout()) {
    const rows = pages.flatMap((p) => mapPage(card, p.page));
    const hashtagsOnly = rows.some((r) => factsOf(r, ask).topicTier === 1);
    return { kind: "question", ask, why: "no_about", question: noAboutQuestionAr(ask.topic.text ?? "", { one: "فيديو", talks: "يتحدث نصه" }, hashtagsOnly), options: [NO_ABOUT_OPTIONS_AR.useAsIs, NO_ABOUT_OPTIONS_AR.change, NO_ABOUT_OPTIONS_AR.cancel], reads };
  }
  return finish(card, params, pages);

  /** ROUND 31: A CHANNEL THE CUSTOMER GAVE (an id, a handle or a name). The id is used as it is; a handle or a name is looked up with the verified channel search and used ONLY if a result carries it (never «the first result»); then the channel's own videos about the topic are read. */
  async function planYoutubeChannel(ref: YoutubeChannelRef): Promise<CompiledPlanning> {
    const channelsCard = cardsFor("youtube", "channels.search")[0];
    if (!card?.inputs.source) return { kind: "cannot", ask, reason: "no_parent_card", reads };
    let chosen: { id: string; title?: string } | null = null;
    if (ref.kind === "id") chosen = matchChannel(ref, []);
    else {
      if (!channelsCard?.inputs.query) return { kind: "cannot", ask, reason: "no_parent_card", reads };
      const r = await read(channelsCard.endpointId, { [channelsCard.inputs.query.field]: ref.kind === "handle" ? ref.handle : ref.name }, channelsCard);
      reads.pool += 1;
      const rows = "failed" in r ? [] : mapPage(channelsCard, r.page).map((x) => ({ id: String(x.id ?? ""), ...(typeof x.title === "string" ? { title: x.title } : {}), ...(typeof x.handle === "string" ? { handle: x.handle } : {}), ...(typeof x.subscribers === "string" ? { subscribers: x.subscribers } : {}) }));
      if ("failed" in r && r.refused) return { kind: "cannot", ask, reason: "pool_refused", reads };
      // ROUND 33 (discovery): a channel NAMED by the customer is identified from the evidence of the results (every word of the name in a title or handle), never by the order of the results: exactly one candidate is the channel; none or several: the customer picks, shown each candidate's own title, handle and subscribers (a name written in Arabic never matches a channel titled in Latin letters, so «none» is a question, not a failure)
      if (deps.cards && ref.kind === "name") {
        const evidence = channelEvidenceOf(ref.name, rows);
        if (evidence.kind === "ambiguous") return { kind: "question", ask, why: "youtube_channel", question: youtubeChannelChoiceQuestionAr(ref.name, evidence.options), options: evidence.options.map(channelAnswerOf), reads };
        chosen = evidence.kind === "one" ? { id: evidence.channel.id, ...(evidence.channel.title ? { title: evidence.channel.title } : {}) } : null;
      } else chosen = matchChannel(ref, rows);
    }
    if (!chosen) return { kind: "cannot", ask, reason: "youtube_channel_unidentified", reads };
    const base = parentInputs(card, ask);
    const r = await read(card.endpointId, { ...base, [card.inputs.source.param]: chosen.id }, card);
    reads.pool += 1;
    if ("failed" in r) return { kind: "cannot", ask, reason: r.refused ? "pool_refused" : "pool_failed", reads };
    if (mapPage(card, r.page).length === 0) return { kind: "cannot", ask, reason: "no_rows", reads };
    const channelCard = measuredRows(card, r.page);
    track(channelCard, r);
    // the channel as the customer reads it: the Arabic part of its title when it has one
    const arabic = typeof chosen.title === "string" ? chosen.title.split(/\s*[-–—|]\s*/).map((x) => x.trim()).find((x) => /[؀-ۿ]/.test(x) && !/[A-Za-z0-9_]/.test(x)) ?? null : null;
    const display = arabic ?? (ref.kind === "name" && /[؀-ۿ]/.test(ref.name) && !/[A-Za-z0-9_]/.test(ref.name) ? ref.name : null);
    return finish(channelCard, { ...base, [card.inputs.source.param]: chosen.id }, [{ callId: r.callId, page: r.page }], { channels: [chosen], customerChannel: { display } });
  }

  /** YOUTUBE (docs/FOUNDATION-PLAN.md section 4.3): channel names -> channel ids -> each channel's own videos about the topic -> (a test account) the free counter card -> the compiler. */
  async function planYoutube(): Promise<CompiledPlanning> {
    const channelsCard = cardsFor("youtube", "channels.search")[0];
    // F1, THE UNDERSTAND STEP: the model fills which channels are «the official channels» (a small structured request), code keeps only the names the customer's own words contain; nothing usable leaves the names read from the topic
    let names = channelNamesOf(ask);
    if (!ask.edits.channels && ask.source.kind === "official" && deps.understand) {
      const said = await deps.understand({ request: `${deps.mission.request_text}${deps.mission.answer_text && !isOccurrenceAnswer(deps.mission.answer_text) ? ` ${deps.mission.answer_text}` : ""}`, topic: ask.topic.text }).catch(() => null);
      if (said) { cost.usd += Math.max(0, Number(said.costUsd) || 0); const checked = checkChannelsAgainstWords(said.channels, `${deps.mission.request_text} ${ask.topic.text ?? ""}`); if (checked.length > 0) names = checked; }
    }
    if (!channelsCard || !card?.inputs.source || names.length === 0) return { kind: "cannot", ask, reason: "no_parent_card", reads };
    const found: Array<Array<{ id: string; title?: string; handle?: string; subscribers?: string }>> = [];
    for (const name of names) {
      const r = await read(channelsCard.endpointId, { [channelsCard.inputs.query!.field]: name }, channelsCard);
      reads.pool += 1;
      found.push("failed" in r ? [] : mapPage(channelsCard, r.page).map((x) => ({ id: String(x.id), ...(typeof x.title === "string" ? { title: x.title } : {}), ...(typeof x.handle === "string" ? { handle: x.handle } : {}), ...(typeof x.subscribers === "string" ? { subscribers: x.subscribers } : {}) })));
    }
    if (found.every((f) => f.length === 0)) return { kind: "cannot", ask, reason: "pool_failed", reads };
    // ROUND 33 (discovery): ONE official name whose results the evidence cannot single out (none or several carry every word of the name): the customer picks among the candidates' own title, handle and subscribers BEFORE any video is read, held or priced. Every other request reads the channels as it always did.
    if (deps.cards && names.length === 1) {
      const evidence = channelEvidenceOf(names[0], found[0].map((x) => ({ id: x.id, ...(x.title ? { title: x.title } : {}), ...(x.handle ? { handle: x.handle } : {}), ...(x.subscribers ? { subscribers: x.subscribers } : {}) })));
      if (evidence.kind === "ambiguous") return { kind: "question", ask, why: "youtube_channel", question: youtubeChannelChoiceQuestionAr(names[0], evidence.options), options: evidence.options.map(channelAnswerOf), reads };
    }
    // round-robin over the names (each name's first channel, then each name's second): the gateway allows two samples of the in-channel search at planning, so the first channels of every name are read before any second one
    const order: Array<{ id: string; title?: string }> = [];
    for (let rank = 0; order.length < 8; rank += 1) { const before = order.length; for (const f of found) if (f[rank] && !order.some((o) => o.id === f[rank].id)) order.push(f[rank]); if (order.length === before) break; }
    const base = parentInputs(card, ask);
    const pages: Array<{ callId: string; page: unknown }> = [];
    const readChannels: Array<{ id: string; title?: string }> = [];
    let withRows = 0;
    // as many channels as were named (the two clubs, and the league when the customer named it), three at most
    const channelsWanted = Math.max(2, Math.min(3, names.length));
    for (const ch of order) {
      if (withRows >= channelsWanted) break;
      const r = await read(card.endpointId, { ...base, [card.inputs.source.param]: ch.id }, card);
      reads.pool += 1;
      if ("failed" in r) { if (r.refused) break; continue; }
      if (mapPage(card, r.page).length === 0) continue;
      pages.push({ callId: r.callId, page: r.page });
      readChannels.push(ch);
      withRows += 1;
    }
    if (pages.length === 0) return { kind: "cannot", ask, reason: "no_rows", reads };
    // THE COUNTER: no search or channel page has a comment counter; a test account reads the free detail card (up to 50 ids in one call) for the videos the pool ranks first; its answer makes the promise the counters, else the promise stays open
    let counters: Map<string, number> | undefined;
    const counterCard = cardOf("youtube.youtube.video.detail");
    if (catalogOnly && counterCard?.inputs.ids) {
      const ids = rankPool(pages.flatMap((p) => mapPage(card, p.page)), ask, card).slice(0, counterCard.inputs.ids.max).map((r) => r.id);
      const r = await read(counterCard.endpointId, { ...structuredClone(counterCard.inputs.fixed ?? {}), [counterCard.inputs.ids.param]: ids.join(",") }, counterCard);
      reads.pool += 1;
      if (!("failed" in r)) {
        const got = new Map<string, number>();
        for (const row of mapPage(counterCard, r.page)) if (typeof row.comments === "number") got.set(String(row.id), row.comments);
        if (got.size > 0) counters = got;
      }
    }
    return finish(card, { ...base, [card.inputs.source.param]: readChannels[0].id }, pages, { ...(counters ? { counters } : {}), channels: readChannels });
  }
}
