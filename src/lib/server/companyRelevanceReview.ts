import { z } from "zod";
import { getLlmPricingSettings } from "../../functions/shared/llmClient";
import { resolveProviderKey } from "./providerKeys";
import { EVIDENCE_FIELDS } from "./relevanceEvidence";
import type { CompanyReviewVerdict } from "./relevanceDecision";

/**
 * Claude's structured review of the company rows that passed the deterministic gate, read against the customer's own
 * request. One call per batch of rows, with the SAME request shape the chat client already uses in production:
 * x-api-key + anthropic-version headers, one tool and a forced tool choice, no sampling parameters.
 * Code applies the answer (relevanceDecision.ts); this module only asks and parses.
 */
export type ReviewFailure = string; // "http_<status>" | "timeout" | "network" | "no_key" | "disabled" | "bad_reply" | "time_budget"

export interface ReviewUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  latencyMs: number;
}

export interface CompanyReviewRequest {
  /** The customer's request in their words (cut short). */
  customerRequest: string;
  /** The request's English activity keywords. */
  activityKeywords: string[];
  /** The requested country in English ("Egypt"), or "". */
  country: string;
  rows: Array<{ index: number; row: Record<string, any> }>;
}

export interface CompanyReviewAttempt {
  verdicts: Map<number, CompanyReviewVerdict>;
  usage: ReviewUsage | null;
  failure: ReviewFailure | null;
}

/** One attempt (one call) over one batch of rows. Never throws. */
export type CompanyReviewerFn = (request: CompanyReviewRequest, options: { timeoutMs: number }) => Promise<CompanyReviewAttempt>;

export const REVIEW_BATCH_SIZE = 25;
export const REVIEW_MAX_ROWS = 50;
export const REVIEW_ATTEMPT_TIMEOUT_MS = 10_000;
export const REVIEW_MAX_ATTEMPTS = 3;
const REVIEW_BACKOFF_MS = [2000, 4000, 8000];
const SNIPPET_CHARS = 300;

export const REVIEW_TOOL_NAME = "submit_reviews";

export const REVIEW_TOOL_SCHEMA = {
  type: "object",
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", description: "The row index exactly as given." },
          coreActivity: { type: "string", enum: ["core", "adjacent", "unrelated", "unknown"] },
          countryOk: { type: "string", enum: ["yes", "no", "unknown"] },
          evidence: { type: "string", description: "An EXACT quote from the row's company_name, description, specialties or keywords that shows the activity; empty when there is none." },
          reasonAr: { type: "string", description: "One short Arabic sentence, no emoji." },
        },
        required: ["index", "coreActivity", "countryOk", "evidence", "reasonAr"],
      },
    },
  },
  required: ["reviews"],
} as const;

const RUBRIC = [
  "You review company records returned by a business directory against what the customer actually asked for.",
  "Judge each row ONLY from the fields given. The field source_label is the directory's own category: it is NOT evidence of what the company does.",
  "For each row return:",
  "- coreActivity: \"core\" when the company ITSELF carries out the requested activity as its business (it operates, manufactures, contracts, installs or engineers it); \"adjacent\" when it resells, trades, sources, distributes, repairs, consults on or merely lists such products, or when the activity is only a minor side line; \"unrelated\" when it is a different business; \"unknown\" when the fields do not say enough.",
  "- countryOk: \"yes\", \"no\" or \"unknown\" for the requested country.",
  "- evidence: an EXACT substring copied from the row's company_name, description, specialties or keywords that shows the activity (empty string when there is none).",
  "- reasonAr: one short Arabic sentence, no emoji.",
  "Never guess a \"core\": when in doubt use \"adjacent\" or \"unknown\".",
  `Call ${REVIEW_TOOL_NAME} once with one entry per row.`,
].join("\n");

const VerdictSchema = z.object({
  index: z.number().int().min(0),
  coreActivity: z.enum(["core", "adjacent", "unrelated", "unknown"]),
  countryOk: z.enum(["yes", "no", "unknown"]).default("unknown"),
  evidence: z.string().max(400).default(""),
  reasonAr: z.string().trim().min(1).max(300),
});

/** The tool input to verdicts. Only well-formed entries for the rows asked about count; anything else is ignored. */
export function parseReviewToolInput(input: unknown, allowedIndexes: Set<number>): Map<number, CompanyReviewVerdict> | null {
  const verdicts = new Map<number, CompanyReviewVerdict>();
  const reviews = (input && typeof input === "object" ? (input as any).reviews : undefined) as unknown;
  if (!Array.isArray(reviews)) return null;
  for (const entry of reviews) {
    const parsed = VerdictSchema.safeParse(entry);
    if (!parsed.success || !allowedIndexes.has(parsed.data.index) || verdicts.has(parsed.data.index)) continue;
    verdicts.set(parsed.data.index, parsed.data);
  }
  return verdicts;
}

function clean(value: unknown, max: number): string {
  const text = Array.isArray(value) ? value.filter((v) => typeof v === "string").join(", ") : typeof value === "string" ? value : "";
  return text.replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A short, secret-free summary of one row. The source's own category is labelled so the model cannot mistake it for evidence. */
export function summarizeCompanyRowForReview(row: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of EVIDENCE_FIELDS) {
    const value = clean(row?.[field], SNIPPET_CHARS);
    if (value) out[field] = value;
  }
  const label = clean(row?.industry, 80);
  if (label) out.source_label = label;
  const location = clean(row?.location || row?.address || row?.country, 120);
  if (location) out.location = location;
  const website = clean(row?.website, 120);
  if (website) out.website = website;
  return out;
}

function reviewDisabled(): boolean {
  const flag = (name: string) => (process.env[name] || "").trim().toLowerCase();
  return flag("LLM_PROVIDER") === "fake" || ["false", "0", "off"].includes(flag("LLM_ENABLED")) || flag("LLM_LIVE") === "false";
}

/** The production reviewer: one call, a short timeout, never throws, no sampling parameters. */
export const callClaudeCompanyReviewer: CompanyReviewerFn = async (request, options) => {
  const none = (failure: ReviewFailure, usage: ReviewUsage | null = null): CompanyReviewAttempt => ({ verdicts: new Map(), usage, failure });
  if (request.rows.length === 0) return { verdicts: new Map(), usage: null, failure: null };
  if (reviewDisabled()) return none("disabled");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const started = Date.now();
  try {
    const key = (await resolveProviderKey("anthropic")).key;
    if (!key) return none("no_key");
    const model = (process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL || "claude-haiku-5-5").trim();
    const userContent = JSON.stringify({
      customer_request: clean(request.customerRequest, 400),
      requested_activity_keywords_en: request.activityKeywords.slice(0, 8),
      requested_country: clean(request.country, 60),
      rows: request.rows.map(({ index, row }) => ({ index, ...summarizeCompanyRowForReview(row) })),
    });
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        system: RUBRIC,
        messages: [{ role: "user", content: userContent }],
        tools: [{ name: REVIEW_TOOL_NAME, description: "Submit the review of every row.", input_schema: REVIEW_TOOL_SCHEMA }],
        tool_choice: { type: "tool", name: REVIEW_TOOL_NAME },
      }),
    });
    if (!response.ok) return none(`http_${response.status}`);
    const data: any = await response.json();
    const inputTokens = (Number(data?.usage?.input_tokens) || 0) + (Number(data?.usage?.cache_read_input_tokens) || 0) + (Number(data?.usage?.cache_creation_input_tokens) || 0);
    const outputTokens = Number(data?.usage?.output_tokens) || 0;
    const pricing = getLlmPricingSettings("anthropic", model);
    const costUsd = (inputTokens * pricing.inputCostPerMillion + outputTokens * pricing.outputCostPerMillion) / 1_000_000;
    const usage: ReviewUsage = { inputTokens, outputTokens, costUsd, model, latencyMs: Date.now() - started };
    const toolUse = Array.isArray(data?.content) ? data.content.find((block: any) => block?.type === "tool_use" && block?.name === REVIEW_TOOL_NAME) : null;
    const verdicts = parseReviewToolInput(toolUse?.input, new Set(request.rows.map((r) => r.index)));
    // A reply that arrived (and was billed) but has no usable review keeps its usage, so the spend is visible.
    if (!verdicts) return none("bad_reply", usage);
    return { verdicts, usage, failure: null };
  } catch (err: any) {
    return none(err?.name === "AbortError" ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
};

let injectedReviewer: CompanyReviewerFn | null = null;

/** Test-only: replace the reviewer (null restores the production one). */
export function setCompanyReviewerForTesting(reviewer: CompanyReviewerFn | null): void {
  injectedReviewer = reviewer;
}

export function getCompanyReviewer(): CompanyReviewerFn {
  return injectedReviewer ?? callClaudeCompanyReviewer;
}

let testTiming: { sleep?: (ms: number) => Promise<void>; now?: () => number } | null = null;

/** Test-only: replace the clock and the sleep the runner uses by default (null restores the real ones). */
export function setCompanyReviewTimingForTesting(timing: { sleep?: (ms: number) => Promise<void>; now?: () => number } | null): void {
  testTiming = timing;
}

/** True when a test injected a reviewer. */
export function hasInjectedCompanyReviewer(): boolean {
  return injectedReviewer !== null;
}

/** A failure worth another attempt on the SAME rows (a busy, slow or briefly broken reviewer); anything else will not change. */
export function isRetryableReviewFailure(failure: ReviewFailure): boolean {
  return failure === "timeout" || failure === "network" || failure === "bad_reply" || failure === "http_429" || /^http_5\d\d$/.test(failure);
}

export interface CompanyReviewOutcome {
  verdicts: Map<number, CompanyReviewVerdict>;
  /** The failure of the last attempt of any batch that ended without a usable review, else null. */
  failure: ReviewFailure | null;
  /** Calls made, successful or not. */
  attempts: number;
}

export interface RunCompanyReviewOptions {
  reviewer: CompanyReviewerFn;
  request: CompanyReviewRequest;
  /** Wall-clock time (ms since epoch) by which the whole review must be over. */
  deadlineMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called after EVERY attempt (usage rows are written from here). */
  onAttempt?: (attempt: CompanyReviewAttempt) => Promise<void> | void;
  /** Called before a retry on the same rows (the customer-visible progress note is written from here). */
  onRetry?: (nextAttemptNumber: number, failure: ReviewFailure) => Promise<void> | void;
}

/**
 * Reviews the rows in batches, in parallel. A batch that fails is retried on the SAME rows (never new provider rows), up to
 * REVIEW_MAX_ATTEMPTS calls with a 2/4/8 s backoff, only while the time budget allows another attempt and only for
 * failures that can change. Rows without a usable verdict at the end are the caller's to fail closed.
 */
export async function runCompanyReview(options: RunCompanyReviewOptions): Promise<CompanyReviewOutcome> {
  const now = options.now ?? testTiming?.now ?? Date.now;
  const sleep = options.sleep ?? testTiming?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const rows = options.request.rows.slice(0, REVIEW_MAX_ROWS);
  const batches: CompanyReviewRequest["rows"][] = [];
  for (let i = 0; i < rows.length; i += REVIEW_BATCH_SIZE) batches.push(rows.slice(i, i + REVIEW_BATCH_SIZE));

  const verdicts = new Map<number, CompanyReviewVerdict>();
  let failure: ReviewFailure | null = null;
  let attempts = 0;

  const runBatch = async (batchRows: CompanyReviewRequest["rows"]) => {
    let pending = batchRows;
    let lastFailure: ReviewFailure | null = null;
    for (let attempt = 1; attempt <= REVIEW_MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        const backoff = REVIEW_BACKOFF_MS[attempt - 2] ?? 8000;
        if (now() + backoff + REVIEW_ATTEMPT_TIMEOUT_MS > options.deadlineMs) break;
        await options.onRetry?.(attempt, lastFailure || "unknown");
        await sleep(backoff);
      }
      if (now() + REVIEW_ATTEMPT_TIMEOUT_MS > options.deadlineMs) {
        lastFailure = lastFailure || "time_budget";
        break;
      }
      attempts += 1;
      let result: CompanyReviewAttempt;
      try {
        result = await options.reviewer({ ...options.request, rows: pending }, { timeoutMs: REVIEW_ATTEMPT_TIMEOUT_MS });
      } catch {
        // A reviewer is meant never to throw; if one does, that attempt is a failed attempt, not a crashed job.
        result = { verdicts: new Map(), usage: null, failure: "network" };
      }
      await options.onAttempt?.(result);
      if (result.failure) {
        lastFailure = result.failure;
        if (!isRetryableReviewFailure(result.failure)) break;
        continue;
      }
      for (const [index, verdict] of result.verdicts) verdicts.set(index, verdict);
      // The reply came but left some rows out: ask again about those rows only.
      pending = pending.filter((row) => !verdicts.has(row.index));
      if (pending.length === 0) return null;
      lastFailure = "incomplete_reply";
    }
    return lastFailure;
  };

  const results = await Promise.all(batches.map((batch) => runBatch(batch)));
  for (const result of results) if (result) failure = failure ?? result;
  // Rows beyond the review cap have no verdict: that is also a failure to review them.
  if (options.request.rows.length > REVIEW_MAX_ROWS) failure = failure ?? "too_many_rows";
  return { verdicts, failure, attempts };
}
