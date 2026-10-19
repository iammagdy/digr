import { scrubWhiteLabelText } from "../../functions/shared/llmClient";
import type { RelevanceDecision } from "./relevanceValidationLayer";
import { evidenceText, hasActivityEvidence } from "./relevanceEvidence";

/**
 * What Claude's structured review says about ONE company row, against the customer's request.
 * `core` = the company itself carries out the requested activity as its business; `adjacent` = it resells, trades, sources,
 * repairs, consults on or only lists such products (or the activity is a minor side line); `unrelated` = another business;
 * `unknown` = the row does not say enough.
 */
export interface CompanyReviewVerdict {
  index: number;
  coreActivity: "core" | "adjacent" | "unrelated" | "unknown";
  countryOk: "yes" | "no" | "unknown";
  /** An exact quote from the row's own name, description, specialties or keywords. */
  evidence: string;
  reasonAr: string;
}

export type CompanyDecisionCode =
  | "deterministic"
  | "reviewed_match"
  | "review_unavailable"
  | "evidence_not_grounded"
  | "evidence_not_activity"
  | "adjacent_or_unknown"
  | "unrelated"
  | "wrong_country";

export interface CompanyDecision {
  decision: RelevanceDecision;
  reasonAr: string;
  reasonCode: CompanyDecisionCode;
}

const MIN_EVIDENCE_CHARS = 6;

function fold(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when the quote is really in the row's own descriptive text (never in the industry label) and is long enough to mean something. */
export function isGroundedEvidence(evidence: string, row: Record<string, any>): boolean {
  const quote = fold(String(evidence || ""));
  if (quote.length < MIN_EVIDENCE_CHARS) return false;
  return fold(evidenceText(row)).includes(quote);
}

function modelReason(reasonAr: string): string {
  return scrubWhiteLabelText(String(reasonAr || "").replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim()).slice(0, 200);
}

/**
 * Applies a review to the deterministic decision. Code decides, Claude only informs:
 *  - a row the deterministic gate excluded or put in review stays there, whatever Claude says (Claude never promotes);
 *  - a candidate (deterministic match) is delivered ONLY with a review that says `core`, with a quote that is really in the
 *    row's own text and that shows the requested activity; every doubt goes to the labelled review sheet, never charged;
 *  - no usable review of the row (failed, timed out, disabled, row omitted) fails closed: review sheet, never charged.
 */
export function decideCompanyRow(input: {
  deterministic: { decision: RelevanceDecision; reasonAr: string; evidence?: "own_text" };
  verdict: CompanyReviewVerdict | undefined;
  row: Record<string, any>;
  keywords: unknown[];
}): CompanyDecision {
  const { deterministic, verdict, row, keywords } = input;
  if (deterministic.decision !== "match") {
    return { decision: deterministic.decision, reasonAr: deterministic.reasonAr, reasonCode: "deterministic" };
  }
  if (!verdict) {
    return {
      decision: "uncertain",
      reasonAr: "تعذّر التحقق الآلي من ملاءمة هذا السجل؛ أُحيل إلى المراجعة ولم يُحتسب",
      reasonCode: "review_unavailable",
    };
  }
  const reason = modelReason(verdict.reasonAr);
  if (verdict.countryOk === "no") {
    return { decision: "no_match", reasonAr: `${reason} (مراجعة آلية؛ خارج الدولة المطلوبة، استُبعد السجل ولم يُحتسب)`, reasonCode: "wrong_country" };
  }
  if (verdict.coreActivity === "unrelated") {
    return { decision: "no_match", reasonAr: `${reason} (مراجعة آلية؛ نشاط مختلف، استُبعد السجل ولم يُحتسب)`, reasonCode: "unrelated" };
  }
  if (verdict.coreActivity !== "core") {
    return { decision: "uncertain", reasonAr: `${reason} (مراجعة آلية؛ أُحيل السجل للمراجعة ولم يُحتسب)`, reasonCode: "adjacent_or_unknown" };
  }
  if (!isGroundedEvidence(verdict.evidence, row)) {
    return { decision: "uncertain", reasonAr: "لم يثبت نشاط الشركة من وصفها نفسه؛ أُحيل السجل للمراجعة ولم يُحتسب", reasonCode: "evidence_not_grounded" };
  }
  // A quote that does not show the requested activity (a label-like or generic phrase) is not evidence of it, unless the
  // deterministic sector rule itself already rests on the company's own text.
  if (deterministic.evidence !== "own_text" && !hasActivityEvidence({ description: verdict.evidence }, keywords)) {
    return { decision: "uncertain", reasonAr: "الاقتباس من وصف الشركة لا يدل على النشاط المطلوب؛ أُحيل السجل للمراجعة ولم يُحتسب", reasonCode: "evidence_not_activity" };
  }
  return { decision: "match", reasonAr: `${reason} (تحقق آلي من نشاط الشركة)`, reasonCode: "reviewed_match" };
}
