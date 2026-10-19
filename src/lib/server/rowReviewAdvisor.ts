import { z } from "zod";
import { getLlmPricingSettings } from "../../functions/shared/llmClient";
import { resolveProviderKey } from "./providerKeys";
import type { RelevanceDecision } from "./relevanceValidationLayer";

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
}

export interface RowAdvisoryInput {
  /** What the customer asked for, in their words. */
  customerRequest: string;
  /** What kind of rows: companies, people, posts, comments, videos. */
  kind: string;
  /** Rows the deterministic gate matched, in order; the index is the position in the worker's list. */
  rows: Array<{ index: number; row: Record<string, any> }>;
}

export type RowAdvisorFn = (input: RowAdvisoryInput) => Promise<AdvisoryResult>;

const ADVISORY_MAX_ROWS = 40;
const ADVISORY_TIMEOUT_MS = 8000;
const SNIPPET_CHARS = 220;

const VerdictSchema = z.object({
  reviews: z.array(z.object({
    index: z.number().int().min(0),
    verdict: z.enum(["match", "no_match", "uncertain"]),
    reasonAr: z.string().trim().min(1).max(200),
  })).max(ADVISORY_MAX_ROWS),
});

const FIELD_ORDER = [
  "company_name", "name", "contact_name", "job_title", "title", "industry", "location", "country", "address",
  "description", "text", "comment_text", "video_caption", "video_title", "caption", "website",
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

/** The model's text reply to verdicts. Anything that is not valid JSON in the expected shape yields no verdicts. */
export function parseAdvisoryReply(text: string): Map<number, AdvisoryVerdict> {
  const verdicts = new Map<number, AdvisoryVerdict>();
  const json = /\{[\s\S]*\}/.exec(text || "")?.[0];
  if (!json) return verdicts;
  try {
    const parsed = VerdictSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return verdicts;
    for (const review of parsed.data.reviews) verdicts.set(review.index, { verdict: review.verdict, reasonAr: stripControl(review.reasonAr) });
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
    "Judge only from the row's own fields. Never guess a match. Give a short Arabic reason (one sentence, no emoji).",
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
  const timer = setTimeout(() => controller.abort(), ADVISORY_TIMEOUT_MS);
  const started = Date.now();
  try {
    const key = (await resolveProviderKey("anthropic")).key;
    if (!key) return empty("no_key");
    const model = (process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL || "claude-haiku-5-5").trim();
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: controller.signal,
      body: JSON.stringify({ model, max_tokens: 1200, messages: [{ role: "user", content: buildPrompt(input) }] }),
    });
    if (!response.ok) return empty(`http_${response.status}`);
    const data: any = await response.json();
    const text = Array.isArray(data?.content) ? data.content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
    const inputTokens = Number(data?.usage?.input_tokens) || 0;
    const outputTokens = Number(data?.usage?.output_tokens) || 0;
    const pricing = getLlmPricingSettings("anthropic", model);
    const costUsd = (inputTokens * pricing.inputCostPerMillion + outputTokens * pricing.outputCostPerMillion) / 1_000_000;
    const verdicts = parseAdvisoryReply(text);
    const failure: AdvisoryFailureCode | null = verdicts.size === 0 && input.rows.length > 0 ? "bad_reply" : null;
    return { verdicts, usage: { inputTokens, outputTokens, costUsd, model, latencyMs: Date.now() - started }, failure };
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
