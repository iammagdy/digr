import { normalizeArabic } from "./arabicNormalize";

/**
 * Where a plan's identifying values come from. A model that does not know the account, the post or the link it was asked about writes SOMETHING: «<UNKNOWN>»,
 * «UNKNOWN», «[ID]», «{{tweet_id}}», «xxx», or a number that looks like an id. A closed list of such words can never be complete, and a plausible number passes
 * every list. The rule here is about ORIGIN, not spelling:
 *
 *   every id-like or URL parameter of a plan step must come from
 *     1. the customer's own text (the request, the answers to the questions, a pasted link),
 *     2. a literal the code set (`literals`), or
 *     3. a prior step's output (a reference such as «from_step_1», only in a step that depends on an earlier one);
 *   any other value is NOT sent to the source. The customer is asked ONE plain Arabic question instead, and nothing is priced or held.
 *
 * Pure module: no server imports.
 */

/** A value that is a stand-in for «I do not know»: a bracketed token, a bare marker word, a run of x's or dots, a template slot. Structural, not a closed word list of brackets. */
export function looksLikePlaceholder(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  // a bracketed Latin token: <UNKNOWN> [ID] {{tweet_id}} (value) <tweet_id>; Arabic text in brackets is a real value
  if (/^[<\[{(]{1,2}\s*[A-Za-z_ \-]{0,60}?\s*[>\]})]{1,2}$/.test(text)) return true;
  // a slot inside a longer text: https://x.com/<handle>/status/<id>, ${id}
  if (/\{\{[^}]*\}\}|\$\{[^}]*\}|<[A-Za-z_ \-]{1,40}>/.test(text)) return true;
  // a bare marker word, a run of x's, dots or dashes
  if (/^(?:unknown|unspecified|undefined|null|nan|none|n\/?a|tbd|tba|todo|placeholder|xxx+|\.{2,}|…+|-+|_+)$/i.test(text)) return true;
  return false;
}

const ID_TOKENS = new Set(["id", "ids", "url", "urls", "uri", "link", "links", "handle", "username", "uid", "secuid", "uniqueid", "permalink"]);
/** Parameters that ARE an account by their whole name (the X account job's `channel`); «topPerChannel» is a count, not an account. */
const ACCOUNT_NAMES = new Set(["channel", "channels"]);

/** Splits `tweetId`, `tweet_id`, `video-url`, `postURL` into lower-case tokens. */
function nameTokens(name: string): string[] {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/** A parameter that names a thing the customer must have pointed at: an id, a link, an account. Decided by the LAST word of its name. */
export function isIdLikeParamName(name: string): boolean {
  const tokens = nameTokens(name);
  if (tokens.length === 1 && ACCOUNT_NAMES.has(tokens[0])) return true;
  return tokens.length > 0 && ID_TOKENS.has(tokens[tokens.length - 1]);
}

const REFERENCE = /^\s*(?:from_step_\d+|\$[A-Za-z_{][^\s]*|\{\{[^}]+\}\}|step\d*\.[\w.]+)\s*$/;

/** A value that points at an earlier step's output instead of holding a value. */
export function isStepReference(value: unknown): boolean {
  return typeof value === "string" && REFERENCE.test(value);
}

/** A value reduced to what identifies it: no scheme, no «www.», no leading «@», no query or trailing slash, folded Arabic, lower case. */
export function comparableValue(value: unknown): string {
  return normalizeArabic(String(value ?? ""))
    .replace(/^https?:\/\/(?:www\.|m\.|mobile\.)?/, "")
    .replace(/^@+/, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function comparableText(text: string): string {
  return normalizeArabic(String(text ?? "")).replace(/https?:\/\/(?:www\.|m\.|mobile\.)?/g, "");
}

/** True when the value (or the id inside a link) appears in the customer's text. */
export function valueIsInText(value: unknown, requestText: string): boolean {
  const v = comparableValue(value);
  if (!v || v.length < 2) return false;
  const t = comparableText(requestText);
  if (t.includes(v)) return true;
  // a link written another way («m.», a different query, a trailing part): the last segment that is an id (6+ characters) is what identifies the post
  const lastId = v.split("/").filter((p) => p.length >= 6 && /\d/.test(p)).pop();
  if (lastId && t.includes(lastId)) return true;
  // an id written in the query of a link («story_fbid=1234567890123»): the long digits identify it
  return (normalizeArabic(String(value)).match(/\d{8,}/g) ?? []).some((digits) => t.includes(digits));
}

export type ProvenanceGapReason = "placeholder" | "not_from_customer" | "dangling_reference";
export type ProvenanceGapKind = "link" | "account" | "id";

export interface ProvenanceGap {
  itemIndex: number;
  param: string;
  reason: ProvenanceGapReason;
  kind: ProvenanceGapKind;
}

function kindOf(name: string): ProvenanceGapKind {
  const last = nameTokens(name).pop() || "";
  if (last === "url" || last === "urls" || last === "uri" || last === "link" || last === "links" || last === "permalink") return "link";
  if (last === "handle" || last === "username" || last === "channel" || last === "channels" || last === "uniqueid") return "account";
  return "id";
}

export interface ProvenanceInput {
  /** Everything the customer wrote in this request: the request, the answers to the questions, pasted links. */
  requestText: string;
  /** Values the code set itself (a fixed id the service always uses). */
  literals?: Iterable<string>;
}

interface PlanItemLike {
  params?: Record<string, any>;
  dependsOn?: unknown;
  inputFrom?: unknown;
  [key: string]: any;
}

/** Every id-like or link parameter of every plan item whose value has no origin (see the header). An empty list means the plan may be priced. */
export function findParamProvenanceGaps(items: ReadonlyArray<PlanItemLike> | undefined | null, input: ProvenanceInput): ProvenanceGap[] {
  const literals = new Set([...(input.literals ?? [])].map((l) => comparableValue(l)));
  const gaps: ProvenanceGap[] = [];
  (items ?? []).forEach((item, itemIndex) => {
    const dependent = Boolean(item?.dependsOn && (!Array.isArray(item.dependsOn) || item.dependsOn.length > 0)) || Boolean(item?.inputFrom && (typeof item.inputFrom !== "object" || Object.keys(item.inputFrom as object).length > 0));
    for (const [param, value] of Object.entries(item?.params ?? {})) {
      if (!isIdLikeParamName(param)) continue;
      if (value === undefined || value === null || value === "") continue; // a missing value is the job of the required-field check, not an invented one
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        if (typeof v !== "string" && typeof v !== "number") continue;
        const text = String(v);
        if (isStepReference(text)) {
          if (!dependent) gaps.push({ itemIndex, param, reason: "dangling_reference", kind: kindOf(param) });
          continue;
        }
        if (looksLikePlaceholder(text)) { gaps.push({ itemIndex, param, reason: "placeholder", kind: kindOf(param) }); continue; }
        if (literals.has(comparableValue(text))) continue;
        if (!valueIsInText(text, input.requestText)) gaps.push({ itemIndex, param, reason: "not_from_customer", kind: kindOf(param) });
      }
    }
  });
  return gaps;
}

/** The ONE question the customer is asked for a value with no origin: Arabic only, no field name, no provider word. */
export function provenanceQuestionAr(gap: Pick<ProvenanceGap, "kind">): string {
  if (gap.kind === "link") return "ما الرابط الذي تريد العمل عليه؟ الصقه هنا كما هو.";
  if (gap.kind === "account") return "ما اسم الحساب أو رابطه الذي تقصده؟";
  return "ما الرابط أو الاسم المحدد للعنصر الذي تريد العمل عليه؟";
}

/** The card the chat shows for the first gap. */
export function provenanceQuestionCard(gap: ProvenanceGap): { id: string; text: string; question: string; type: "free"; options: string[]; allowOther: boolean } {
  const text = provenanceQuestionAr(gap);
  return { id: "plan_param_required", text, question: text, type: "free", options: [], allowOther: true };
}
