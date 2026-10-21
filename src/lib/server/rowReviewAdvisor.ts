import { z } from "zod";
import { getLlmPricingSettings } from "../../functions/shared/llmClient";
import { resolveProviderKey } from "./providerKeys";
import type { RelevanceDecision } from "./relevanceValidationLayer";
import { DEFAULT_PRICING_SETTINGS, type PricingSettings } from "../../functions/shared/quotes";
import { chargeForUnits } from "../recordPricing";

/**
 * Claude's advisory review of the rows a source returned, read against the customer's own request.
 *
 * Advisory means exactly this: the verdict can only make delivery STRICTER. A row the deterministic gate matched and
 * Claude doubts moves to the labelled review sheet (not delivered, not charged). A row the deterministic gate excluded
 * or put in review stays where it is, whatever Claude says. Claude can therefore never raise the delivered count or the
 * charge, and a failed, slow or malformed review changes nothing.
 */
export interface AdvisoryVerdict {
  verdict: RelevanceDecision;
  reasonAr: string;
}

export interface RowReviewReason {
  index: number;
  decision: RelevanceDecision;
  reasonAr: string;
}

export interface AdvisoryUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  latencyMs: number;
}

export type AdvisoryFailureCode =
  | "timeout"
  | "network"
  | "no_key"
  | "disabled"
  | "bad_reply"
  | `http_${number}`;

export interface AdvisoryResult {
  verdicts: Map<number, AdvisoryVerdict>;
  usage: AdvisoryUsage | null;
  failure?: AdvisoryFailureCode | null;
  /** Why the model stopped writing (`end_turn`, `max_tokens`, ...), when the call got an answer: proves a truncated reply. */
  stopReason?: string | null;
  /** A short, secret-free note about a failure (the provider's error type), never row content. */
  detail?: string | null;
}

export interface RowAdvisoryInput {
  /** What the customer asked for, in their words. */
  customerRequest: string;
  /** What kind of rows: companies, people, posts, comments, videos. */
  kind: string;
  /** Rows the deterministic gate matched, in order; the index is the position in the worker's list. */
  rows: Array<{ index: number; row: Record<string, any> }>;
  /** The most this call may wait for the reply, in ms (never above ADVISORY_TIMEOUT_MS): the caller shortens it near its own deadline. */
  timeoutMs?: number;
}

export type RowAdvisorFn = (input: RowAdvisoryInput) => Promise<AdvisoryResult>;

const ADVISORY_MAX_ROWS = 40;
/**
 * Room for the reply: an Arabic verdict with its reason is about 100 tokens, so a fixed 1,200 cut the reply of a page of 20 rows
 * in the middle (an unreadable reply, recorded as a failure with no tokens). Room for every row, plus a margin.
 */
export function advisoryMaxTokens(rows: number): number {
  return Math.min(6000, Math.max(1200, 300 + Math.max(1, rows) * 160));
}
/**
 * How long one review call may take. The calls of 25 rows measured 5 to 8 s on production, and 2 of 8 were cut at the old 8 s limit;
 * a cut call is a review that never happened, so the limit leaves room (the caller still shortens it near its own deadline).
 */
export const ADVISORY_TIMEOUT_MS = 20_000;
const SNIPPET_CHARS = 220;

const ReviewItemSchema = z.object({
  index: z.number().int().min(0),
  verdict: z.enum(["match", "no_match", "uncertain"]),
  reasonAr: z.string().trim().optional(),
});

/** A reason is a short sentence; a long or missing one never makes the whole reply unreadable. */
const MAX_REASON_CHARS = 200;
const DEFAULT_REASON_AR: Record<RelevanceDecision, string> = {
  match: "مطابق لموضوع الطلب",
  no_match: "غير مطابق لموضوع الطلب",
  uncertain: "غير مؤكد من نص السجل وحده",
};

const FIELD_ORDER = [
  "company_name", "name", "contact_name", "job_title", "title", "industry", "location", "country", "address",
  "description", "text", "comment_text", "video_caption", "video_title", "caption", "website", "hashtags", "channel_name", "comments_sample",
];

/** A short, secret-free summary of one row: the fields a reviewer needs, each cut short. */
export function summarizeRowForReview(row: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FIELD_ORDER) {
    const value = row?.[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim().replace(/\s+/g, " ").slice(0, SNIPPET_CHARS);
  }
  return out;
}

function stripControl(text: string): string {
  return text.replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The model's text reply to verdicts. Anything that is not valid JSON with a list of reviews yields no verdicts; inside a valid
 * list every readable review counts on its own, so one long reason or one malformed item cannot throw away the other rows' verdicts.
 */
export function parseAdvisoryReply(text: string): Map<number, AdvisoryVerdict> {
  const verdicts = new Map<number, AdvisoryVerdict>();
  const json = /\{[\s\S]*\}/.exec(text || "")?.[0];
  if (!json) return verdicts;
  try {
    const reviews = JSON.parse(json)?.reviews;
    if (!Array.isArray(reviews)) return verdicts;
    for (const raw of reviews.slice(0, ADVISORY_MAX_ROWS * 2)) {
      const item = ReviewItemSchema.safeParse(raw);
      if (!item.success) continue;
      const reason = stripControl(item.data.reasonAr || "").slice(0, MAX_REASON_CHARS) || DEFAULT_REASON_AR[item.data.verdict];
      verdicts.set(item.data.index, { verdict: item.data.verdict, reasonAr: reason });
    }
  } catch {
    // malformed reply: advisory only, ignored
  }
  return verdicts;
}

function buildPrompt(input: RowAdvisoryInput): string {
  const rows = input.rows.slice(0, ADVISORY_MAX_ROWS).map(({ index, row }) => ({ index, ...summarizeRowForReview(row) }));
  return [
    "You review rows returned by a data source against what the customer actually asked for.",
    `Customer request (Arabic): "${stripControl(input.customerRequest).slice(0, 400)}"`,
    `Kind of rows: ${input.kind}`,
    "For each row decide: \"match\" (clearly what the customer asked for), \"no_match\" (clearly something else: another activity, another country, another topic), or \"uncertain\" (borderline or not enough information).",
    ...(/video-list/i.test(input.kind) ? [
      "Each row is a VIDEO found by a topic search (its title or description with hashtags, its channel, and a few of its comments). The customer wants the comments under videos ABOUT that topic.",
      "\"match\" only if the video itself is about the topic. A video about another subject that merely shares a word with the topic is \"no_match\".",
      "If the request names a country, a video about another country's clubs, league, team or events (for example a Spanish club for a request about Egypt) is \"no_match\"; a video about the requested country's football, clubs, league, team or players is a match.",
      "A video with no description: judge from its channel and its sample comments; if they do not settle it, answer \"uncertain\".",
      "Never judge a video by how its comments are worded: short comments such as thanks, laughter or a reaction are normal under an on-topic video.",
    ] : /^social-|post|comment|video/i.test(input.kind) ? [
      "The customer asked for posts, comments or videos ABOUT a topic. \"match\" only if the text itself is about that topic.",
      "A text about another subject that merely shares a word with the topic is \"no_match\". An empty text is \"no_match\". A reply or comment that only agrees or reacts (for example \"agreed\", \"true\", an emoji) says nothing about the topic: \"uncertain\".",
      "For a comment, the video title is context only, never evidence by itself that the comment is about the topic.",
      "If the request names a country, a text about another country's clubs, league, team or events (for example a Spanish club for a request about Egypt) is not a match for that request.",
    ] : []),
    "Judge only from the row's own fields. Never guess a match. Give a short Arabic reason (at most twelve words, no emoji).",
    "Reply with ONLY JSON: {\"reviews\":[{\"index\":0,\"verdict\":\"match\"|\"no_match\"|\"uncertain\",\"reasonAr\":\"...\"}]}",
    "Rows:",
    JSON.stringify(rows),
  ].join("\n");
}

/** The production advisor: one small call, short timeout, never throws. */
export const callClaudeRowAdvisor: RowAdvisorFn = async (input) => {
  const empty = (failure: AdvisoryFailureCode | null = null): AdvisoryResult => ({
    verdicts: new Map(),
    usage: null,
    failure,
  });
  if (input.rows.length === 0) return empty(null);
  if ((process.env.LLM_PROVIDER || "").trim().toLowerCase() === "fake" || (process.env.LLM_ENABLED || "").trim().toLowerCase() === "false" || (process.env.LLM_LIVE || "").trim().toLowerCase() === "false") return empty("disabled");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(ADVISORY_TIMEOUT_MS, Number(input.timeoutMs) || ADVISORY_TIMEOUT_MS)));
  const started = Date.now();
  try {
    const key = (await resolveProviderKey("anthropic")).key;
    if (!key) return empty("no_key");
    const model = (process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL || "claude-haiku-5-5").trim();
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: controller.signal,
      body: JSON.stringify({ model, max_tokens: advisoryMaxTokens(input.rows.length), messages: [{ role: "user", content: buildPrompt(input) }] }),
    });
    if (!response.ok) {
      let detail: string | null = null;
      try {
        const body: any = await response.json();
        detail = [body?.error?.type, body?.error?.message].filter((part) => typeof part === "string").join(": ").replace(/\s+/g, " ").slice(0, 160) || null;
      } catch {
        detail = null;
      }
      return { ...empty(`http_${response.status}`), detail };
    }
    const data: any = await response.json();
    const text = Array.isArray(data?.content) ? data.content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
    const inputTokens = Number(data?.usage?.input_tokens) || 0;
    const outputTokens = Number(data?.usage?.output_tokens) || 0;
    const pricing = getLlmPricingSettings("anthropic", model);
    const costUsd = (inputTokens * pricing.inputCostPerMillion + outputTokens * pricing.outputCostPerMillion) / 1_000_000;
    const verdicts = parseAdvisoryReply(text);
    const failure: AdvisoryFailureCode | null = verdicts.size === 0 && input.rows.length > 0 ? "bad_reply" : null;
    const stopReason = typeof data?.stop_reason === "string" ? data.stop_reason : null;
    return { verdicts, usage: { inputTokens, outputTokens, costUsd, model, latencyMs: Date.now() - started }, failure, stopReason, detail: failure === "bad_reply" ? `reply_chars=${text.length}` : null };
  } catch (err: any) {
    const isTimeout = err?.name === "AbortError" || controller.signal.aborted;
    return empty(isTimeout ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
};

let injectedAdvisor: RowAdvisorFn | null = null;

/** Test-only: replace the advisor (null restores the production one). */
export function setRowAdvisorForTesting(advisor: RowAdvisorFn | null): void {
  injectedAdvisor = advisor;
}

export function getRowAdvisor(): RowAdvisorFn {
  return injectedAdvisor ?? callClaudeRowAdvisor;
}

export interface AdvisoryApplication<T extends RowReviewReason> {
  reviews: T[];
  /** matched rows the advisory moved to review */
  demoted: number;
}

/**
 * Applies the advisory to the deterministic decisions. Only a deterministic "match" can change, and only to "uncertain":
 * the row goes to the review sheet, with Claude's reason added, and is neither delivered nor charged.
 */
export function applyAdvisoryToReviews<T extends RowReviewReason>(reviews: T[], verdicts: Map<number, AdvisoryVerdict>): AdvisoryApplication<T> {
  let demoted = 0;
  const next = reviews.map((review) => {
    if (review.decision !== "match") return review;
    const advisory = verdicts.get(review.index);
    if (!advisory || advisory.verdict === "match") return review;
    demoted += 1;
    return { ...review, decision: "uncertain" as RelevanceDecision, reasonAr: `${advisory.reasonAr} (مراجعة آلية؛ أُحيل السجل للمراجعة ولم يُحتسب)`.slice(0, 400) };
  });
  return { reviews: next, demoted };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Posts and comments: the review is a condition of delivery (fail closed), within a cost cap per job.                  */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Rows sent to the reviewer in one call: small enough that its reply always fits the reply limit. */
export const SOCIAL_REVIEW_ROWS_PER_CALL = 25;

/** The share of a job's revenue the automatic review of its rows may spend (owner decision, "Option 3"). */
export const REVIEW_BUDGET_SHARE = 0.2;

/**
 * What one review call of a full batch (SOCIAL_REVIEW_ROWS_PER_CALL rows) costs at most, in USD: the measured average of a relevance
 * review call (0.0047 USD). A call that would take the job's review spend past its budget is not started (see `reviewSocialRows`).
 */
export const REVIEW_CALL_COST_ESTIMATE_USD = 0.0047;

/** The least a job's review budget can be (owner decision): one full review call, so even a very small job can confirm up to 25 doubtful rows. */
export const REVIEW_MIN_BUDGET_USD = REVIEW_CALL_COST_ESTIMATE_USD;

/**
 * What the automatic review of one job may spend, in USD: 20% of the job's revenue, and never less than one full review call (REVIEW_MIN_BUDGET_USD). The revenue is the job's expected charge, ceil(target
 * records x unit price), in points, computed here by code (never by the model), at 0.10 EGP a point and 55 EGP a dollar. Rounded DOWN
 * to a millionth of a dollar so the budget never exceeds the share. A row the review cannot cover inside the budget is not delivered
 * and not charged (fail closed); it is the reviewer's cost only and never changes what the customer pays, which stays
 * ceil(delivered x unit price).
 */
export function socialReviewCapUsd(targetMax: number, unitPricePoints: number, settings: Pick<PricingSettings, "usdToEgp" | "creditValueEgp"> = DEFAULT_PRICING_SETTINGS): number {
  const revenuePoints = chargeForUnits(Math.max(1, Math.floor(Number(targetMax) || 1)), Number(unitPricePoints));
  if (!(revenuePoints > 0) || !(settings.usdToEgp > 0)) return 0;
  const revenueUsd = (revenuePoints * settings.creditValueEgp) / settings.usdToEgp;
  const share = Math.floor(revenueUsd * REVIEW_BUDGET_SHARE * 1_000_000 + 1e-6) / 1_000_000;
  return Math.max(REVIEW_MIN_BUDGET_USD, share);
}

/** Once the job's review budget is used up, a job whose accepted share of the rows seen so far is below this stops (see `reviewStopForLowYield`). */
export const LOW_YIELD_ACCEPTED_BELOW = 0.1;

/**
 * Stop rule for a job whose review spend has used its budget (the budget cannot pay for even one more row) AND whose acceptance is low:
 * fewer than 10% of the rows seen so far were accepted. Then nothing more is reviewed and nothing more is delivered: the rows of the page
 * wait in the review sheet (not delivered, not charged) and the job stops buying pages. A job with unknown history (a running record from
 * before the counts were kept: `rowsSeen` undefined) or no rows seen yet is never stopped by it, and a job that still has budget, or one
 * that accepts at least 10% of what it sees, is untouched. Pure: the numbers come from the running record, never from the model.
 */
export function reviewStopForLowYield(input: { spentUsd: number; budgetUsd: number; rowsSeen: number | undefined; accepted: number }): boolean {
  const seen = input.rowsSeen;
  if (typeof seen !== "number" || !(seen > 0)) return false;
  const budgetUsedUp = input.budgetUsd - input.spentUsd < REVIEW_CALL_COST_ESTIMATE_USD / SOCIAL_REVIEW_ROWS_PER_CALL;
  return budgetUsedUp && input.accepted / seen < LOW_YIELD_ACCEPTED_BELOW;
}

export const REVIEW_STOPPED_LOW_YIELD_REASON_AR = "توقّف التحقق الآلي لهذا الطلب لأن نسبة السجلات المطابقة بقيت منخفضة جداً بعد بلوغ حدّه المسموح؛ وُضع السجل في شيت المراجعة ولم يُحتسب";

export type SocialReviewStop = "failed" | "cap" | "deadline";

export interface SocialReviewAttempt {
  rows: number;
  usage: AdvisoryUsage | null;
  failure: AdvisoryFailureCode | null;
  stopReason: string | null;
  detail: string | null;
}

export interface SocialReviewOutcome {
  verdicts: Map<number, AdvisoryVerdict>;
  attempts: SocialReviewAttempt[];
  /** Spent by this chunk's calls, USD. */
  costUsd: number;
  /** Matched rows nobody reviewed (a failed call, the cap, the deadline): they cannot be delivered. */
  unreviewed: number[];
  stoppedBy: SocialReviewStop | null;
}

/**
 * Reviews the matched rows of a page in small batches, one call each, until the budget or the time is used. A batch whose reply
 * cannot be read leaves its rows unreviewed (never «matched by default»). Never throws.
 */
export async function reviewSocialRows(input: {
  advisor: RowAdvisorFn;
  customerRequest: string;
  kind: string;
  rows: Array<{ index: number; row: Record<string, any> }>;
  budgetUsd: number;
  /**
   * What a full batch call costs at most (USD). When set, a call that would take the spend past `budgetUsd` is not started (so the
   * budget is a ceiling, not a level the last call may cross); the rows of that batch stay unreviewed. Unset: a call starts while the
   * spend is under the budget.
   */
  callCostEstimateUsd?: number;
  /** Epoch ms after which no new call is started. */
  deadlineMs?: number;
  now?: () => number;
}): Promise<SocialReviewOutcome> {
  const now = input.now ?? Date.now;
  const outcome: SocialReviewOutcome = { verdicts: new Map(), attempts: [], costUsd: 0, unreviewed: [], stoppedBy: null };
  let halted = false;
  let dearestCallPerRowUsd = 0;
  const estimatePerRowUsd = Math.max(0, Number(input.callCostEstimateUsd) || 0) / SOCIAL_REVIEW_ROWS_PER_CALL;
  for (let start = 0; start < input.rows.length; start += SOCIAL_REVIEW_ROWS_PER_CALL) {
    const batch = input.rows.slice(start, start + SOCIAL_REVIEW_ROWS_PER_CALL);
    const nextCallUsd = estimatePerRowUsd > 0 ? Math.max(estimatePerRowUsd, dearestCallPerRowUsd) * batch.length : 0;
    const stop: SocialReviewStop | null =
      halted ? "failed"
      : outcome.costUsd >= input.budgetUsd || outcome.costUsd + nextCallUsd > input.budgetUsd ? "cap"
      : input.deadlineMs !== undefined && now() >= input.deadlineMs ? "deadline"
      : null;
    if (stop) {
      outcome.stoppedBy ||= stop;
      outcome.unreviewed.push(...batch.map((entry) => entry.index));
      continue;
    }
    let result: AdvisoryResult;
    try {
      // Near the caller's deadline the call is given only the time that is left (plus the reserve the caller keeps after it), never more than the limit.
      const timeoutMs = input.deadlineMs !== undefined ? Math.max(3000, Math.min(ADVISORY_TIMEOUT_MS, input.deadlineMs - now() + 6000)) : undefined;
      result = await input.advisor({ customerRequest: input.customerRequest, kind: input.kind, rows: batch, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    } catch {
      result = { verdicts: new Map(), usage: null, failure: "network" };
    }
    outcome.attempts.push({ rows: batch.length, usage: result.usage, failure: result.failure ?? null, stopReason: result.stopReason ?? null, detail: result.detail ?? null });
    outcome.costUsd += Math.max(0, result.usage?.costUsd ?? 0);
    dearestCallPerRowUsd = Math.max(dearestCallPerRowUsd, Math.max(0, result.usage?.costUsd ?? 0) / Math.max(1, batch.length));
    let missing = 0;
    for (const entry of batch) {
      const verdict = result.verdicts.get(entry.index);
      if (verdict) outcome.verdicts.set(entry.index, verdict);
      else { missing += 1; outcome.unreviewed.push(entry.index); }
    }
    if (missing > 0) outcome.stoppedBy ||= "failed";
    // A reviewer that answered nothing readable is not asked again for the next batch of the same page.
    if (result.failure && result.verdicts.size === 0) halted = true;
  }
  return outcome;
}

export const UNREVIEWED_REASON_AR = "تعذّر التحقق الآلي من ملاءمة هذا السجل لموضوع الطلب؛ أُحيل للمراجعة ولم يُحتسب";

/**
 * Strict application for posts and comments: a deterministic match is delivered only when the review says «match». A doubt, a
 * «no match» or no verdict at all moves the row to the labelled review sheet (not delivered, not charged). The review can never
 * turn an excluded or reviewed-out row into a delivered one, so the delivered count and the charge can only go down.
 */
export function applyStrictAdvisory<T extends RowReviewReason>(
  reviews: T[],
  verdicts: Map<number, AdvisoryVerdict>,
  options: { only?: (review: T) => boolean } = {},
): AdvisoryApplication<T> & { unreviewed: number } {
  let demoted = 0;
  let unreviewed = 0;
  const next = reviews.map((review) => {
    if (review.decision !== "match") return review;
    // Only the rows the caller sent to the review are subject to it; the others were never in doubt.
    if (options.only && !options.only(review)) return review;
    const advisory = verdicts.get(review.index);
    if (advisory?.verdict === "match") return review;
    demoted += 1;
    if (!advisory) {
      unreviewed += 1;
      return { ...review, decision: "uncertain" as RelevanceDecision, reasonAr: UNREVIEWED_REASON_AR };
    }
    return { ...review, decision: "uncertain" as RelevanceDecision, reasonAr: `${advisory.reasonAr} (مراجعة آلية؛ أُحيل السجل للمراجعة ولم يُحتسب)`.slice(0, 400) };
  });
  return { reviews: next, demoted, unreviewed };
}

let strictSocialReviewForTests = false;
/** Test-only: switch the strict review of posts and comments on for a worker run that uses the mock provider. */
export function setStrictSocialReviewForTesting(on: boolean): void {
  strictSocialReviewForTests = on;
}
export const strictSocialReviewForcedByTests = (): boolean => strictSocialReviewForTests;
