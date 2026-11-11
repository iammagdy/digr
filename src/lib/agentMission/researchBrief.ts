import { normalizeDigits, toArabicDigits } from "../arabicDigits";
import { NUMBER_WORDS_SRC, numberOfWord } from "./arabicNumberWords";
import { contactAskVerdict, contactClarifyAr, privacyRefusalAr } from "./guardRules";
import { buildRequestContract, platformsNamedIn, type RequestContract } from "./requestContract";

/**
 * THE RESEARCH BRIEF (consolidated mission, docs/AGENT-UNDERSTANDING-V1.md). The chat model leads the discovery conversation and, in the SAME call that already names the type of every message (no extra call), proposes a structured,
 * revisable brief of what the customer wants: the whole request in one clear sentence (every turn merged, corrections applied) and the fields it understood.
 *
 * THE MODEL INTERPRETS; THE BACKEND DECIDES. This module is the backend's side, pure (no database, no network, no clock):
 *   - `parseBrief`: a strict, versioned schema. Only the fields below are kept; their types and values are checked; unknown fields are DROPPED (named in `unknown`, never executed).
 *   - `validateBrief`: what may become a mission. The consolidated request
 *       1. is refused or clarified by the SAME privacy rules as a typed message (guardRules.ts): a private component never enters a request, whatever the model wrote;
 *       2. carries no NUMBER the customer did not write (a quantity, a year, a day): the model cannot invent or change a count;
 *       3. names no PLATFORM the customer (or the question they answered) did not name;
 *       4. says, when read by the TRUSTED contract parser (the one the worker plans from), what the model says it understood: the platforms, the count, comments and replies. If the words the worker will read would silently drop or change
 *          something the model understood, the brief is rejected and the conversation falls back to today's path (nothing is guessed).
 * The model never sets a price, a balance, a hold, an approval, a provider or a stage: the request goes through the normal planner, the plan and its price are shown, and only the «اعتمد» button approves.
 * Nothing here stores or logs the customer's words; a rejection is a reason CODE.
 */
export const RESEARCH_BRIEF_VERSION = 1 as const;
export const BRIEF_PLATFORMS = ["tiktok", "x", "instagram", "facebook", "youtube"] as const;
export const BRIEF_CONTENT = ["posts", "videos", "comments", "replies", "tweets", "accounts", "companies", "people", "places", "reviews"] as const;
export const BRIEF_STATUSES = ["ready", "needs_clarification"] as const;
export type BriefPlatform = (typeof BRIEF_PLATFORMS)[number];
export type BriefContent = (typeof BRIEF_CONTENT)[number];
export type BriefStatus = (typeof BRIEF_STATUSES)[number];

export interface ResearchBrief {
  v: typeof RESEARCH_BRIEF_VERSION;
  status: BriefStatus;
  /** The whole research request, in the customer's language, every turn merged and every correction applied. */
  request: string;
  platforms: BriefPlatform[];
  content: BriefContent[];
  /** The number the customer wrote, or null. */
  count: number | null;
  topic: string | null;
  /** In the customer's own words («آخر شهر»): the values are computed by code (semantic/conditions.ts), never by the model. */
  period: string | null;
  country: string | null;
  language: string | null;
}

export const BRIEF_REQUEST_MIN = 3;
export const BRIEF_REQUEST_MAX = 1000;
const FIELD_MAX = 120;
const KNOWN_FIELDS = new Set(["status", "request", "platforms", "content", "count", "topic", "period", "country", "language", "v"]);

export type ParsedBrief = { ok: true; brief: ResearchBrief; unknown: string[] } | { ok: false; issue: string };

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t === "" ? null : t.slice(0, max);
};
const listOf = <T extends string>(v: unknown, allowed: readonly T[]): T[] | null => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const e of v) {
    const k = typeof e === "string" ? e.trim().toLowerCase() : "";
    if (!(allowed as readonly string[]).includes(k)) return null; // an unsupported value is never mapped to a supported one
    if (!out.includes(k as T)) out.push(k as T);
  }
  return out;
};

/** The brief the model proposed, checked against the schema. Never throws. */
export function parseBrief(raw: unknown): ParsedBrief {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, issue: "not_an_object" };
  const o = raw as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !KNOWN_FIELDS.has(k)).sort();
  if (o.v !== undefined && o.v !== RESEARCH_BRIEF_VERSION) return { ok: false, issue: "version" };
  const status = typeof o.status === "string" && (BRIEF_STATUSES as readonly string[]).includes(o.status) ? (o.status as BriefStatus) : null;
  if (!status) return { ok: false, issue: "status" };
  const request = text(o.request, BRIEF_REQUEST_MAX + 1);
  if (!request) return { ok: false, issue: "request_missing" };
  const platforms = listOf(o.platforms, BRIEF_PLATFORMS);
  if (!platforms) return { ok: false, issue: "platforms" };
  const content = listOf(o.content, BRIEF_CONTENT);
  if (!content) return { ok: false, issue: "content" };
  let count: number | null = null;
  if (o.count !== undefined && o.count !== null && o.count !== "") {
    const n = Number(normalizeDigits(String(o.count)));
    if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000) return { ok: false, issue: "count" };
    count = n;
  }
  return {
    ok: true,
    unknown,
    brief: { v: RESEARCH_BRIEF_VERSION, status, request, platforms, content, count, topic: text(o.topic, FIELD_MAX), period: text(o.period, FIELD_MAX), country: text(o.country, FIELD_MAX), language: text(o.language, FIELD_MAX) },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// GROUNDING
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const NUMBER_WORD_RE = new RegExp(`(?<![ء-ي])(?:[وب]?)(${NUMBER_WORDS_SRC})(?![ء-ي])`, "g");

/** Every whole number a text writes: in digits (Arabic-Indic or Latin, with or without a thousands mark) and in words («مية», «عشرين»). */
export function numbersWritten(raw: string): Set<number> {
  const t = normalizeDigits(String(raw ?? "")).replace(/(\d)[,٬](?=\d{3}\b)/g, "$1");
  const out = new Set<number>();
  for (const m of t.match(/\d+/g) ?? []) { const n = Number(m); if (Number.isSafeInteger(n)) out.add(n); }
  for (const m of t.matchAll(NUMBER_WORD_RE)) { const n = numberOfWord(m[1]); if (n !== null) out.add(n); }
  return out;
}

export interface BriefContext {
  /** Everything the customer typed in this conversation that the brief may draw on (oldest first), the current message last. */
  customerTurns: string[];
  /** The assistant's last message (the question the customer is answering), or null. A platform it named counts as named. */
  assistantQuestion?: string | null;
  /** The brief already validated on an earlier turn, or null: its request is already grounded. */
  prior?: ResearchBrief | null;
  /** The semantic flag for this account (the same reader the worker uses), so the consistency check reads the request as the worker will. */
  semantic?: boolean;
}

export type BriefRejection =
  | "privacy_refusal"
  | "privacy_clarify"
  | "request_length"
  | "number_not_written"
  | "platform_not_named"
  | "platform_mismatch"
  | "count_mismatch"
  | "comments_dropped"
  | "replies_dropped";

export type ValidatedBrief =
  | { ok: true; brief: ResearchBrief; contract: RequestContract }
  | { ok: false; reason: BriefRejection; /** a privacy answer for the customer (privacy_refusal / privacy_clarify only) */ contentAr?: string };

/**
 * What may become a mission (see the header). The privacy check comes first: a consolidated request that the guard would refuse is refused, and one it would clarify is clarified, exactly as if the customer had typed it.
 */
export function validateBrief(brief: ResearchBrief, ctx: BriefContext): ValidatedBrief {
  const request = brief.request.replace(/\s+/g, " ").trim();
  const refusal = privacyRefusalAr(request);
  if (refusal) return { ok: false, reason: "privacy_refusal", contentAr: refusal };
  if (contactAskVerdict(request) === "clarify") return { ok: false, reason: "privacy_clarify", contentAr: contactClarifyAr(request) };
  if (request.length < BRIEF_REQUEST_MIN || request.length > BRIEF_REQUEST_MAX) return { ok: false, reason: "request_length" };

  const groundText = [...ctx.customerTurns, ctx.prior?.request ?? ""].join("\n");
  const written = numbersWritten(groundText);
  for (const n of numbersWritten(request)) if (!written.has(n)) return { ok: false, reason: "number_not_written" };
  if (brief.count !== null && !written.has(brief.count)) return { ok: false, reason: "number_not_written" };

  const named = new Set<string>([...platformsNamedIn(groundText), ...platformsNamedIn(String(ctx.assistantQuestion ?? ""))]);
  const inRequest = platformsNamedIn(request);
  for (const p of [...inRequest, ...brief.platforms]) if (!named.has(p)) return { ok: false, reason: "platform_not_named" };

  // consistency: the words the worker will read say what the model understood (nothing silently dropped or changed)
  const contract = buildRequestContract(request, undefined, { semantic: ctx.semantic === true });
  const fieldsPlatforms = [...brief.platforms].sort();
  if (fieldsPlatforms.length > 0 || inRequest.length > 0) {
    if (JSON.stringify(fieldsPlatforms) !== JSON.stringify(inRequest)) return { ok: false, reason: "platform_mismatch" };
    if (fieldsPlatforms.length === 1 && contract.platform !== fieldsPlatforms[0]) return { ok: false, reason: "platform_mismatch" };
  }
  if (brief.count !== null && !numbersWritten(request).has(brief.count)) return { ok: false, reason: "count_mismatch" };
  // X has no comments stage in the contract: «تعليقات إكس» is stated by the plan as replies, not dropped here
  if (brief.content.includes("comments") && contract.comments === "none" && contract.platform !== "x") return { ok: false, reason: "comments_dropped" };
  if (brief.content.includes("replies") && contract.replies === "none") return { ok: false, reason: "replies_dropped" };
  return { ok: true, brief: { ...brief, request }, contract };
}

/**
 * Whether the trusted parser already reads a COMPLETE social request from the words (a platform, a topic, and what to collect): the plan can be prepared, so a further question would be redundant (the planner itself asks the count or a
 * condition when one is genuinely needed, and the card shows the scope and the price before anything is held).
 */
export function contractIsComplete(contract: RequestContract): boolean {
  return contract.platform !== null && contract.topic !== null && contract.topic.trim() !== "" && (contract.parentKind !== null || contract.comments !== "none" || contract.replies !== "none" || contract.source.named);
}

/**
 * Whether two requests ask for the same thing apart from the number of items (a plan edit of the count only is applied to the plan already priced, by the code that already does it). Compared on the trusted contract.
 */
export function differsOnlyByCount(a: RequestContract, b: RequestContract): boolean {
  const strip = (c: RequestContract) => JSON.stringify({ ...c, count: null });
  return strip(a) === strip(b) && a.count !== b.count;
}

/** Whether two requests ask for the same thing (the trusted contract of each). */
export function sameContract(a: RequestContract, b: RequestContract): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The numbers a reply may repeat in brief mode: the ones the customer wrote in this conversation (in Arabic-Indic digits, as replies are written). */
export function briefNumbersAr(ctx: Pick<BriefContext, "customerTurns" | "prior">): string[] {
  return [...numbersWritten([...ctx.customerTurns, ctx.prior?.request ?? ""].join("\n"))].map((n) => toArabicDigits(n));
}

/** A brief stored on an assistant message (`messages.plan.researchBrief`), read back with the same schema (a broken or old value is null). */
export function storedBriefOf(plan: unknown): ResearchBrief | null {
  const raw = (plan as { researchBrief?: unknown } | null | undefined)?.researchBrief;
  const parsed = parseBrief(raw);
  return parsed.ok && parsed.unknown.length === 0 ? parsed.brief : null;
}
