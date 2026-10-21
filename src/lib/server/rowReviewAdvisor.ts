import { z } from "zod";
import { getLlmPricingSettings } from "../../functions/shared/llmClient";
import { resolveProviderKey } from "./providerKeys";
import type { RelevanceDecision } from "./relevanceValidationLayer";
import { maxPagesForJob } from "./providerCallCaps";
import { normalizeText, stemToken, topicStems } from "./topicMatch";

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
  /** How many characters the reply had, when the call got an answer (never its text). */
  replyChars?: number;
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
  /** The room for the reply, in tokens, when the caller wants other than the default of the kind (a retry asks for more). */
  maxTokens?: number;
}

export type RowAdvisorFn = (input: RowAdvisoryInput) => Promise<AdvisoryResult>;

const ADVISORY_MAX_ROWS = 40;
/**
 * Room for the reply: an Arabic verdict with its reason is about 100 tokens, so a fixed 1,200 cut the reply of a page of 20 rows
 * in the middle (an unreadable reply, recorded as a failure with no tokens). Room for every row, plus a margin.
 */
export function advisoryMaxTokens(rows: number, verdictOnly = false): number {
  // A verdict alone should take 20 tokens a row, but a live call of 20 rows used 1,000 tokens and was cut at the old limit (21 Oct 2026):
  // the limit is a ceiling the call is only billed up to, so it is generous.
  if (verdictOnly) return VERDICT_ONLY_MAX_TOKENS;
  return Math.min(6000, Math.max(1200, 300 + Math.max(1, rows) * 160));
}

/** The room for a verdict-only reply, whatever the number of rows (a call has at most SOCIAL_REVIEW_ROWS_PER_CALL). */
export const VERDICT_ONLY_MAX_TOKENS = 4000;
/** The room a retry asks for: more than the first call had, so a retry never repeats the same request. */
export const RETRY_MAX_TOKENS = 6000;
/** A retry covers the rows still without a verdict, in calls of at most this many rows (and at most half of the call that failed). */
export const RETRY_BATCH_ROWS = 10;

/** A failure worth one more try: the call timed out, the network failed, the reply was unreadable, or the service was busy or down. Not a missing key or a disabled reviewer. */
export function isRetryableFailure(failure: string | null | undefined): boolean {
  return failure === "timeout" || failure === "network" || failure === "bad_reply" || failure === "http_429" || /^http_5\d\d$/.test(String(failure || ""));
}

/**
 * Posts, comments and videos are reviewed on the verdict alone: the model returns {index, verdict} and no reason (the reason is the
 * output of a row, and output tokens are most of a review's cost); the code writes the standard Arabic reason for the review sheet.
 */
export const isVerdictOnlyKind = (kind: string): boolean => /^social-|post|comment|video/i.test(kind);
/**
 * How long one review call may take. The calls of 25 rows measured 5 to 8 s on production, and 2 of 8 were cut at the old 8 s limit;
 * a cut call is a review that never happened, so the limit leaves room (the caller still shortens it near its own deadline).
 */
export const ADVISORY_TIMEOUT_MS = 20_000;
const SNIPPET_CHARS = 220;
/** The text of a post, comment or video sent to the model is cut to this many characters (companies and people keep SNIPPET_CHARS). */
export const REVIEW_SNIPPET_CHARS = 160;
/** What is kept of a long text whose words of the request all lie beyond the cut: the start, then a window around the first of those words. */
const FOCUS_HEAD_CHARS = 90;
const FOCUS_WINDOW_CHARS = 66;

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

/**
 * The words of the customer's request that a text must be judged on: the topic's stems and the country named in «الدولة المطلوبة: X», as stems.
 * A text cut short must never lose them all, because the verdict rests on them.
 */
export function focusStemsOf(customerRequest: string): Set<string> {
  const stems = new Set(topicStems(String(customerRequest || "")));
  const country = /الدولة المطلوبة\s*:\s*([^\s]+)/.exec(String(customerRequest || ""))?.[1];
  if (country) for (const token of normalizeText(country).split(" ").filter(Boolean)) stems.add(stemToken(token));
  return stems;
}

/** The words of a text with their positions, so a window can be taken around one of them. */
function wordsWithOffsets(text: string): Array<{ stem: string; at: number; end: number }> {
  const words: Array<{ stem: string; at: number; end: number }> = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const at = match.index ?? 0;
    for (const token of normalizeText(match[0]).split(" ").filter(Boolean)) words.push({ stem: stemToken(token), at, end: at + match[0].length });
  }
  return words;
}

/**
 * A text cut to `limit` characters for the model. When the first `limit` characters hold no word of the request and a later part does, the cut
 * keeps the start and a window around the first such word instead, so the model is never asked about a text without the words it is asked about.
 */
export function trimTextForReview(value: string, focus: Set<string> | null = null, limit = SNIPPET_CHARS): string {
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  if (!focus || focus.size === 0) return head;
  const words = wordsWithOffsets(text);
  // a word the cut would split in two does not count as kept
  if (words.some((word) => word.end <= limit && focus.has(word.stem))) return head;
  const later = words.find((word) => word.end > limit && focus.has(word.stem));
  if (!later) return head;
  const start = Math.max(FOCUS_HEAD_CHARS, later.at - 20);
  return `${text.slice(0, FOCUS_HEAD_CHARS)} … ${text.slice(start, start + FOCUS_WINDOW_CHARS)}`;
}

/** A short, secret-free summary of one row: the fields a reviewer needs, each cut short. */
export function summarizeRowForReview(row: Record<string, any>, options: { limit?: number; focus?: Set<string> | null } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FIELD_ORDER) {
    const value = row?.[key];
    if (typeof value === "string" && value.trim()) out[key] = trimTextForReview(value, options.focus ?? null, options.limit ?? SNIPPET_CHARS);
  }
  return out;
}

function stripControl(text: string): string {
  return text.replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
}

/** The complete one-level objects of a reply that is cut off or damaged as a whole: `{"index":3,"verdict":"match"}` survives, the half-written last one does not. */
function salvageReviewItems(text: string): unknown[] {
  const items: unknown[] = [];
  for (const match of String(text || "").matchAll(/\{[^{}]*\}/g)) {
    try {
      const raw = JSON.parse(match[0]);
      if (raw && typeof raw === "object" && "index" in raw && "verdict" in raw) items.push(raw);
    } catch {
      // a damaged object: its row simply has no verdict
    }
  }
  return items;
}

/**
 * The model's text reply to verdicts. A reply that is valid JSON with a list of reviews is read as such; one that is cut off (the output
 * limit) or damaged as a whole is SALVAGED: every complete {"index":N,"verdict":"..."} item in it counts, and the rows with no item have no
 * verdict (they are held, never matched by default). Inside a list every readable review counts on its own, so one long reason or one
 * malformed item cannot throw away the other rows' verdicts.
 */
export function parseAdvisoryReply(text: string, options: { verdictOnly?: boolean } = {}): Map<number, AdvisoryVerdict> {
  const verdicts = new Map<number, AdvisoryVerdict>();
  const json = /\{[\s\S]*\}/.exec(text || "")?.[0];
  let reviews: unknown[] | null = null;
  if (json) {
    try {
      const parsed = JSON.parse(json)?.reviews;
      if (!Array.isArray(parsed)) return verdicts;
      reviews = parsed;
    } catch {
      reviews = null;
    }
  }
  for (const raw of (reviews ?? salvageReviewItems(text)).slice(0, ADVISORY_MAX_ROWS * 2)) {
    const item = ReviewItemSchema.safeParse(raw);
    if (!item.success) continue;
    // Verdict-only: whatever reason the model added is ignored; the standard Arabic reason of the verdict is used.
    const reason = (options.verdictOnly ? "" : stripControl(item.data.reasonAr || "").slice(0, MAX_REASON_CHARS)) || DEFAULT_REASON_AR[item.data.verdict];
    verdicts.set(item.data.index, { verdict: item.data.verdict, reasonAr: reason });
  }
  return verdicts;
}

function buildPrompt(input: RowAdvisoryInput): string {
  // Posts, comments and videos are cut to REVIEW_SNIPPET_CHARS (keeping a window on the request's own words when they come late); companies and people are not.
  const cut = isVerdictOnlyKind(input.kind) ? { limit: REVIEW_SNIPPET_CHARS, focus: focusStemsOf(input.customerRequest) } : {};
  const rows = input.rows.slice(0, ADVISORY_MAX_ROWS).map(({ index, row }) => ({ index, ...summarizeRowForReview(row, cut) }));
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
    ...(isVerdictOnlyKind(input.kind) ? [
      "Judge only from the row's own fields. Never guess a match. Do not explain: no reasons, no notes, no other text.",
      "Reply with ONLY this JSON, compact on a single line with no spaces, no markdown fence, nothing before it and nothing after it, one item per row in the order of the rows: {\"reviews\":[{\"index\":0,\"verdict\":\"match\"|\"no_match\"|\"uncertain\"}]}",
    ] : [
      "Judge only from the row's own fields. Never guess a match. Give a short Arabic reason (at most twelve words, no emoji).",
      "Reply with ONLY JSON: {\"reviews\":[{\"index\":0,\"verdict\":\"match\"|\"no_match\"|\"uncertain\",\"reasonAr\":\"...\"}]}",
    ]),
    "Rows:",
    JSON.stringify(rows),
  ].join("\n");
}

/** The production advisor: one small call, short timeout, never throws. */
/** The reply room one call asks for: the caller's (a retry's), else the default of the kind and the number of rows. */
export const requestedMaxTokens = (input: Pick<RowAdvisoryInput, "kind" | "rows" | "maxTokens">): number =>
  Number(input.maxTokens) > 0 ? Math.min(8000, Math.floor(Number(input.maxTokens))) : advisoryMaxTokens(input.rows.length, isVerdictOnlyKind(input.kind));

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
      body: JSON.stringify({ model, max_tokens: requestedMaxTokens(input), messages: [{ role: "user", content: buildPrompt(input) }] }),
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
    const verdicts = parseAdvisoryReply(text, { verdictOnly: isVerdictOnlyKind(input.kind) });
    const failure: AdvisoryFailureCode | null = verdicts.size === 0 && input.rows.length > 0 ? "bad_reply" : null;
    const stopReason = typeof data?.stop_reason === "string" ? data.stop_reason : null;
    return { verdicts, usage: { inputTokens, outputTokens, costUsd, model, latencyMs: Date.now() - started }, failure, stopReason, detail: failure === "bad_reply" ? `reply_chars=${text.length}` : null, replyChars: text.length };
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

/**
 * What one review call of a full batch (SOCIAL_REVIEW_ROWS_PER_CALL rows) costs at most, in USD. Measured on production on 21 Oct 2026:
 * a verdict-only call of 20 rows took 3,325 tokens in and 1,000 out and cost 0.00666 USD, which is 0.0083 USD for 25 rows (the earlier
 * 0.0047 was measured on calls of 15 rows with reasons). A call that would take the job's review spend past its budget is not started
 * (see `reviewSocialRows`).
 */
export const REVIEW_CALL_COST_ESTIMATE_USD = 0.0083;

/** The least a job's review budget can be (owner decision): one full review call, so even a very small job can confirm up to 25 doubtful rows. */
export const REVIEW_MIN_BUDGET_USD = REVIEW_CALL_COST_ESTIMATE_USD;

/**
 * The most the automatic review of ONE job may spend, in USD: the hard ceiling. Owner decision of 22 Oct 2026: review cost above a job's revenue
 * is accepted until the platform is established, so the budget no longer follows the revenue. It is changed HERE and nowhere else.
 */
export const REVIEW_JOB_CEILING_USD = 0.15;

/** Rows a page of posts or comments holds (X: 20); with the page cap it gives the number of rows a job can collect. */
export const REVIEW_PAGE_ROWS = 20;

/** The most rows a job of this size can collect: the pages its page cap allows, full. Every one of them can be reviewed within the budget below, up to the ceiling. */
export function collectableRows(targetMax: number): number {
  return maxPagesForJob(Math.max(1, Math.floor(Number(targetMax) || 1)), REVIEW_PAGE_ROWS, "feed") * REVIEW_PAGE_ROWS;
}

/**
 * What the automatic review of one job may spend, in USD: enough to review every row the job can collect (REVIEW_CALL_COST_ESTIMATE_USD for
 * each SOCIAL_REVIEW_ROWS_PER_CALL rows), never more than REVIEW_JOB_CEILING_USD and never less than one full review call (REVIEW_MIN_BUDGET_USD).
 * Computed by code (never by the model), rounded DOWN to a millionth of a dollar. A job with no valid price has no review budget at all (fail
 * closed). A row the review cannot cover inside the budget is not delivered and not charged (fail closed); it is the reviewer's cost only and
 * never changes what the customer pays, which stays ceil(delivered x unit price).
 */
export function socialReviewCapUsd(targetMax: number, unitPricePoints: number): number {
  if (!(Number(unitPricePoints) > 0)) return 0;
  const everyRowUsd = (collectableRows(targetMax) * REVIEW_CALL_COST_ESTIMATE_USD) / SOCIAL_REVIEW_ROWS_PER_CALL;
  const budget = Math.min(REVIEW_JOB_CEILING_USD, Math.max(REVIEW_MIN_BUDGET_USD, everyRowUsd));
  return Math.floor(budget * 1_000_000 + 1e-6) / 1_000_000;
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

export const REVIEW_STOPPED_LOW_YIELD_REASON_AR = "توقّف التحقق الآلي لهذا الطلب لأن نسبة السجلات المطابقة بقيت منخفضة جداً بعد بلوغ حدّه المسموح؛ وُضع السجل في ورقة «غير مراجَع» ولم يُحتسب";

export type SocialReviewStop = "failed" | "cap" | "deadline";

export interface SocialReviewAttempt {
  rows: number;
  usage: AdvisoryUsage | null;
  failure: AdvisoryFailureCode | null;
  stopReason: string | null;
  detail: string | null;
  /** The room for the reply this call asked for, in tokens. */
  maxTokens: number;
  /** How many characters the reply had (null when the call got no answer). */
  replyChars: number | null;
  /** True for a call that repeats rows that had no verdict. */
  retry: boolean;
  /** How many rows of this call have no verdict after it. */
  missing: number;
}

export interface SocialReviewOutcome {
  verdicts: Map<number, AdvisoryVerdict>;
  attempts: SocialReviewAttempt[];
  /** Spent by this chunk's calls, USD. */
  costUsd: number;
  /** Matched rows nobody reviewed (a failed call, the cap, the deadline): they cannot be delivered. */
  unreviewed: number[];
  /** The part of `unreviewed` that was left out only because the review budget was used up (not a failure): they go to the «غير مراجَع» sheet. */
  unreviewedByCap: number[];
  stoppedBy: SocialReviewStop | null;
}

/**
 * Reviews the matched rows of a page in small batches, one call each, until the budget or the time is used. A reply that is cut off or
 * damaged gives the verdicts of its complete items (see `parseAdvisoryReply`); the rows still without a verdict are tried ONCE more, only
 * those, in calls of at most RETRY_BATCH_ROWS rows (and at most half of the call that failed) with more room for the reply, so a retry never
 * repeats the request that failed and never asks again for a row that has a verdict. A row with no verdict after that is not delivered
 * (never «matched by default»). A missing key, a disabled reviewer and a refused request are not retried. Never throws.
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
  const verdicts = new Map<number, AdvisoryVerdict>();
  const attempts: SocialReviewAttempt[] = [];
  const stops: SocialReviewStop[] = [];
  const capped = new Set<number>();
  const timedOut = new Set<number>();
  /** Rows that may be tried once more, with the size of the call in which they got no verdict. */
  const retryable = new Map<number, number>();
  let costUsd = 0;
  let halted = false;
  let haltedSize = 0;
  let haltedRetryable = false;
  let dearestCallPerRowUsd = 0;
  const estimatePerRowUsd = Math.max(0, Number(input.callCostEstimateUsd) || 0) / SOCIAL_REVIEW_ROWS_PER_CALL;

  /** One call on `batch`, or the reason none was made. */
  const runBatch = async (batch: typeof input.rows, retry: boolean): Promise<{ stop: SocialReviewStop | null; result?: AdvisoryResult }> => {
    const nextCallUsd = estimatePerRowUsd > 0 ? Math.max(estimatePerRowUsd, dearestCallPerRowUsd) * batch.length : 0;
    const stop: SocialReviewStop | null =
      halted ? "failed"
      : costUsd >= input.budgetUsd || costUsd + nextCallUsd > input.budgetUsd ? "cap"
      : input.deadlineMs !== undefined && now() >= input.deadlineMs ? "deadline"
      : null;
    if (stop) return { stop };
    let result: AdvisoryResult;
    try {
      // Near the caller's deadline the call is given only the time that is left (plus the reserve the caller keeps after it), never more than the limit.
      const timeoutMs = input.deadlineMs !== undefined ? Math.max(3000, Math.min(ADVISORY_TIMEOUT_MS, input.deadlineMs - now() + 6000)) : undefined;
      result = await input.advisor({ customerRequest: input.customerRequest, kind: input.kind, rows: batch, ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(retry ? { maxTokens: RETRY_MAX_TOKENS } : {}) });
    } catch {
      result = { verdicts: new Map(), usage: null, failure: "network" };
    }
    costUsd += Math.max(0, result.usage?.costUsd ?? 0);
    dearestCallPerRowUsd = Math.max(dearestCallPerRowUsd, Math.max(0, result.usage?.costUsd ?? 0) / Math.max(1, batch.length));
    let missing = 0;
    for (const entry of batch) {
      const verdict = result.verdicts.get(entry.index);
      if (verdict) verdicts.set(entry.index, verdict);
      else missing += 1;
    }
    attempts.push({
      rows: batch.length, usage: result.usage, failure: result.failure ?? null, stopReason: result.stopReason ?? null, detail: result.detail ?? null,
      maxTokens: requestedMaxTokens({ kind: input.kind, rows: batch, ...(retry ? { maxTokens: RETRY_MAX_TOKENS } : {}) }), replyChars: result.replyChars ?? null, retry, missing,
    });
    return { stop: null, result };
  };
  const retryableCall = (result: AdvisoryResult) => !result.failure || isRetryableFailure(result.failure);

  // First pass: calls of SOCIAL_REVIEW_ROWS_PER_CALL rows. A reviewer that answered nothing readable is not asked again for the next batch of the same page.
  for (let start = 0; start < input.rows.length; start += SOCIAL_REVIEW_ROWS_PER_CALL) {
    const batch = input.rows.slice(start, start + SOCIAL_REVIEW_ROWS_PER_CALL);
    const run = await runBatch(batch, false);
    if (run.stop) {
      stops.push(run.stop);
      for (const entry of batch) {
        if (run.stop === "cap") capped.add(entry.index);
        else if (run.stop === "deadline") timedOut.add(entry.index);
        else if (haltedRetryable) retryable.set(entry.index, haltedSize);
      }
      continue;
    }
    const result = run.result!;
    let missing = 0;
    for (const entry of batch) {
      if (verdicts.has(entry.index)) continue;
      missing += 1;
      if (retryableCall(result)) retryable.set(entry.index, batch.length);
    }
    if (missing > 0) stops.push("failed");
    if (result.failure && result.verdicts.size === 0) { halted = true; haltedSize = batch.length; haltedRetryable = isRetryableFailure(result.failure); }
  }

  // Retry pass: only the rows still without a verdict, once.
  const toRetry = input.rows.filter((entry) => retryable.has(entry.index) && !verdicts.has(entry.index));
  if (toRetry.length > 0) {
    halted = false;
    const failedSize = Math.max(...toRetry.map((entry) => retryable.get(entry.index)!));
    const size = Math.min(RETRY_BATCH_ROWS, Math.max(1, Math.ceil(failedSize / 2)));
    for (let start = 0; start < toRetry.length; start += size) {
      const batch = toRetry.slice(start, start + size);
      const run = await runBatch(batch, true);
      if (run.stop) {
        stops.push(run.stop);
        for (const entry of batch) {
          if (run.stop === "cap") capped.add(entry.index);
          else if (run.stop === "deadline") timedOut.add(entry.index);
        }
        continue;
      }
      // a retry that gets nothing readable is not followed by more retries
      if (run.result!.failure && run.result!.verdicts.size === 0) halted = true;
    }
  }

  const unreviewed = input.rows.filter((entry) => !verdicts.has(entry.index)).map((entry) => entry.index);
  const stillFailed = unreviewed.some((index) => !capped.has(index) && !timedOut.has(index));
  return {
    verdicts,
    attempts,
    costUsd,
    unreviewed,
    unreviewedByCap: unreviewed.filter((index) => capped.has(index)),
    stoppedBy: stops.find((stop) => stop !== "failed" || stillFailed) ?? null,
  };
}

export const UNREVIEWED_REASON_AR = "تعذّر التحقق الآلي من ملاءمة هذا السجل لموضوع الطلب؛ أُحيل للمراجعة ولم يُحتسب";

/** Why a row is in the «غير مراجَع» sheet: the review budget of the job was used up before this row was reached. */
export const UNREVIEWED_BY_BUDGET_REASON_AR = "لم تتم مراجعة هذا السجل آلياً لأن التحقق بلغ الحد المسموح لهذا الطلب؛ لم يُحتسب ولم يدخل ضمن الملف المُسلَّم";

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
