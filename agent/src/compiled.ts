import { buildAsk, channelNamesOf, type Ask } from "../../src/lib/agentMission/foundation/ask";
import { isOccurrenceAnswer, isRecurringEvent, occurrenceChoiceOf, OCCURRENCE_OPTIONS_AR, OCCURRENCE_QUESTION_AR, OCCURRENCE_YEAR_QUESTION_AR, type Occurrence } from "../../src/lib/agentMission/foundation/occurrence";
import { checkChannelsAgainstWords } from "../../src/lib/agentMission/foundation/understand";
import { buildShapeDigest } from "../../src/lib/modelPlanner/digest";
import { chooseCard, compilePlan, parentInputs, rankedPoolOf, COMPILED_PLATFORMS, type CompileResult } from "../../src/lib/agentMission/foundation/compilePlan";
import { factsOf, isAboutAndEligible, rankPool } from "../../src/lib/agentMission/foundation/pool";
import { aboutQueryOf, noAboutChoiceOf, noAboutQuestionAr, NO_ABOUT_OPTIONS_AR } from "../../src/lib/agentMission/foundation/topicChoice";
import { NAMED_SHORTFALL_OPTIONS_AR, isNamedShortfallAnswer, namedShortfallChoiceOf, namedShortfallQuestionAr } from "../../src/lib/agentMission/foundation/namedShortfall";
import { budgetOfWords, questionNeeded, type Choices } from "../../src/lib/agentMission/foundation/countChoice";
import { fitToBudget } from "../../src/lib/agentMission/foundation/budgetFit";
import { toArabicDigits } from "../../src/lib/arabicDigits";
import { cardOf, cardsFor, CATALOG_ONLY_CAP_USD, mapPage, type ToolCard } from "../../src/lib/agentMission/foundation/toolCards";
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
  /** Decision 7: the occurrence the customer chose earlier in this mission (the answer of a later question replaces `answer_text`). */
  occurrence?: Occurrence;
  /** ROUND 14, PART B: the production run asks the count and the comments per parent BEFORE any read when the request gives none (`askCount`); a planning made by a test or a tool that does not set it never asks (today's behaviour). `choices` are what the customer chose at those questions, `questionsAsked` how many cards the request has had (at most three), `answerIsChoice` that the current answer is one of them (the request is read without its words). */
  askCount?: boolean;
  choices?: Choices;
  questionsAsked?: number;
  answerIsChoice?: boolean;
}
export type CompiledPlanning =
  | { kind: "plan"; plan: PricedPlan; ask: Ask; result: Extract<CompileResult, { ok: true }>; reads: { pool: number; exposure: number } }
  | { kind: "cannot"; ask: Ask; reason: string; reads: { pool: number; exposure: number } }
  /**
   * LIVE ROUND 7: no video of the pool read (two queries) is about the topic; the customer is asked before approval how to go on. Nothing is priced or held. PR 3, decision 7.5 (`why: "named_shortfall"`): the named Facebook page has fewer
   * deliverable posts in the pool than asked.
   */
  | { kind: "question"; ask: Ask; question: string; options: string[]; reads: { pool: number; exposure: number }; why?: "no_about" | "named_shortfall" | "occurrence" | "occurrence_year" | "count" | "per_parent" };

/** What the understand step cost (USD), carried on the result so the caller adds it to the mission's model cost (never a charge). */
export type WithCost<T> = T & { llmCostUsd?: number };

/** The pages a parent may be read for at planning beyond the ones it needs (the exposure check replaces an empty parent by the next one). */
const EXPOSURE_EXTRA = 3;

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
  const result = await planInner(deps, cost);
  return cost.usd > 0 ? { ...result, llmCostUsd: cost.usd } : result;
}

async function planInner(deps: CompiledPlanningDeps, cost: { usd: number }): Promise<CompiledPlanning> {
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
  const reads = { pool: 0, exposure: 0 };
  // DECISION 7, A RECURRING EVENT with no year or date: «تقصد أنهي مرة؟» before anything is read or held (Facebook, Instagram, YouTube). «حدد سنة» asks for the year in words; a ready answer or a year is the choice.
  if (occurrenceAnswer?.kind === "ask_year") return { kind: "question", ask, why: "occurrence_year", question: OCCURRENCE_YEAR_QUESTION_AR, options: [], reads };
  if (!ask.occurrence && !answeredReady && isRecurringEvent(ask, `${deps.mission.request_text} ${deps.mission.answer_text ?? ""}`)) {
    return { kind: "question", ask, why: "occurrence", question: OCCURRENCE_QUESTION_AR(ask.topic.text ?? ""), options: [OCCURRENCE_OPTIONS_AR.latest, OCCURRENCE_OPTIONS_AR.all, OCCURRENCE_OPTIONS_AR.year], reads };
  }
  // a recurring event whose question was answered earlier (the answer of a later question replaced it) and was not kept: the default, the latest occurrence
  if (!ask.occurrence && answeredReady && isRecurringEvent(ask, deps.mission.request_text)) ask = { ...ask, occurrence: { kind: "latest" } };
  // THE COUNT AND THE COMMENTS PER PARENT (Part B): asked before anything is read, only by the production run (`askCount`), at most three cards in all
  if (deps.askCount === true) {
    const q = questionNeeded(ask, choices, deps.questionsAsked ?? 0);
    if (q && ask.platform && (COMPILED_PLATFORMS as ReadonlyArray<string>).includes(ask.platform)) return { kind: "question", ask, why: q.why, question: q.question, options: q.options, reads };
  }
  const recorded = new Set<string>();
  const card = chooseCard(ask, "parents", { catalogOnly: deps.catalogOnly === true });
  if (!card) return { kind: "cannot", ask, reason: "no_parent_card", reads };
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
  const need = Math.max(1, ask.count ?? 10);
  const catalogOnly = deps.catalogOnly === true;

  /** THE EXPOSURE CHECK and the compile, shared by every platform (decision 7.3): the first comments page of the ranked parents, in order, until enough parents with comments are found; a read the gateway refuses leaves the parent unchecked. */
  const finish = async (poolCard: ToolCard, params: Record<string, unknown>, pages: Array<{ callId: string; page: unknown; card?: ToolCard }>, extra: { counters?: ReadonlyMap<string, number>; channels?: ReadonlyArray<{ id: string; title?: string }> } = {}): Promise<CompiledPlanning> => {
    const exposure = new Map<string, { callId: string | null; page: unknown | null; failed: boolean }>();
    const repliesCards = ask.replies !== "none" ? cardsFor(ask.platform!, "comment.replies", { catalogOnly }) : [];
    const commentsCard = ask.comments !== "none" ? chooseCard(ask, "comments", { catalogOnly, repliesCards }) : null;
    const counterKey = poolCard.counter?.key ?? (extra.counters ? "comments" : null);
    if (commentsCard?.inputs.parent) {
      const ranked = rankedPoolOf({ ask, poolCard, pages, ...(extra.counters ? { counters: extra.counters } : {}), ...(extra.channels ? { channels: extra.channels } : {}), nowMs: deps.nowMs });
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
      ask: a, pool: { card: poolCard, params, pages }, exposure: (id) => exposure.get(id), capabilityOf: (id) => deps.catalog.byId.get(id)?.capability ?? null, pricingSettings: deps.pricingSettings, nowMs: deps.nowMs, ...(catalogOnly ? { catalogOnly: true } : {}),
      ...(extra.counters ? { counters: extra.counters } : {}), ...(extra.channels ? { channels: extra.channels } : {}), ...(shortfallChoice === "only_found" || shortfallChoice === "fill" ? { namedChoice: shortfallChoice } : {}),
    });
    const result = compileWith(ask);
    if (!result.ok && result.reason === "named_shortfall") {
      // DECISION 7.5: before approval, nothing priced or held
      return { kind: "question", ask, why: "named_shortfall", question: namedShortfallQuestionAr(ask.source.text ?? "", result.found, result.need, toArabicDigits, ask.topic.text), options: [NAMED_SHORTFALL_OPTIONS_AR.onlyFound, NAMED_SHORTFALL_OPTIONS_AR.fill, NAMED_SHORTFALL_OPTIONS_AR.cancel], reads };
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
  if (ask.platform === "youtube") return planYoutube();

  // F4: THE POOL, the first page of the chosen card (and its next page when the first holds fewer rows than are needed with their spares: the gateway allows two samples of one source)
  const params = parentInputs(card, ask);
  const first = await read(card.endpointId, params, card);
  reads.pool += 1;
  if ("failed" in first) return { kind: "cannot", ask, reason: first.refused ? "pool_refused" : "pool_failed", reads };
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
  const listing = card.role === "posts.account" || card.role === "posts.page";
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
    if (!("failed" in more)) pages.push({ callId: more.callId, page: more.page });
  } else if ((mapPage(card, first.page).length < need + 2 || wantsSecond) && card.inputs.cursor && cursorOf(first) && first.hasMore !== false) {
    const second = await read(card.endpointId, { ...params, [card.inputs.cursor]: cursorOf(first) }, card);
    reads.pool += 1;
    if (!("failed" in second)) pages.push({ callId: second.callId, page: second.page });
  }
  // A TEST ACCOUNT (decision 7.4) also reads the second keyword search once (up to 20 posts, 0.06606 USD of the 0.20): its first real response is what makes the card verifiable
  if (catalogOnly && card.role === "posts.search") {
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
    const found: Array<Array<{ id: string; title?: string }>> = [];
    for (const name of names) {
      const r = await read(channelsCard.endpointId, { [channelsCard.inputs.query!.field]: name }, channelsCard);
      reads.pool += 1;
      found.push("failed" in r ? [] : mapPage(channelsCard, r.page).map((x) => ({ id: String(x.id), ...(typeof x.title === "string" ? { title: x.title } : {}) })));
    }
    if (found.every((f) => f.length === 0)) return { kind: "cannot", ask, reason: "pool_failed", reads };
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
