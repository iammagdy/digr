import { toArabicDigits } from "../../../src/lib/arabicDigits";

/**
 * TREG Phase 4: Scope-Separated Widening Proposals (docs/diger-team/DT-20261123-treg-p4.md).
 * Generic widening interfaces and proposal builders with strict scope separation.
 * Zero hardcoded platform names, provider names, or query words in code.
 */

export type ItemScope = "primary_account" | "widened_account" | "broader_topic" | "full_archive";

export interface RelatedAccountCandidate {
  handle: string;
  role: "official_spokesperson" | "fact_checker" | "media_outlet" | "regulator";
  rationale: string;
  verifiedProfile?: boolean;
}

export interface WideningOffer {
  kind: "related_accounts" | "full_archive" | "broader_keywords";
  scope: ItemScope;
  titleAr: string;
  descriptionAr: string;
  accounts?: RelatedAccountCandidate[];
  additionalCostUsd?: number;
}

export const SCOPE_LABEL_AR: Readonly<Record<ItemScope, string>> = {
  primary_account: "الحساب المطلوب",
  widened_account: "حسابات قريبة / جهات رسمية",
  broader_topic: "أخبار ومواقع",
  full_archive: "أرشيف شامل",
} as const;

export const SCOPE_COLUMN_KEY = "scope_label_ar";
export const SCOPE_COLUMN_TITLE_AR = "نطاق المصدر";

export function scopeLabelAr(scope: ItemScope | string | undefined): string {
  if (scope && scope in SCOPE_LABEL_AR) {
    return SCOPE_LABEL_AR[scope as ItemScope];
  }
  return SCOPE_LABEL_AR.primary_account;
}

export interface ScopeCounters {
  primary: number;
  widened: number;
  web: number;
  fullArchive?: number;
  total: number;
}

export function computeScopeCounters(rows: ReadonlyArray<Record<string, unknown>>): ScopeCounters {
  let primary = 0;
  let widened = 0;
  let web = 0;
  let fullArchive = 0;
  for (const r of rows) {
    const scope = (r.scope as ItemScope) || "primary_account";
    if (scope === "widened_account") widened++;
    else if (scope === "broader_topic") web++;
    else if (scope === "full_archive") fullArchive++;
    else primary++;
  }
  return {
    primary,
    widened,
    web,
    fullArchive,
    total: primary + widened + web + fullArchive,
  };
}

export function tagRowWithScope<T extends Record<string, unknown>>(
  row: T,
  scope: ItemScope
): T & { scope: ItemScope; scope_label_ar: string } {
  return {
    ...row,
    scope,
    scope_label_ar: scopeLabelAr(scope),
  };
}

export interface ProfileValidationResult {
  exists: boolean;
  verified?: boolean;
}

export async function validateCandidateAccount(
  candidate: RelatedAccountCandidate,
  profileLookup: (handle: string) => Promise<ProfileValidationResult | boolean>
): Promise<RelatedAccountCandidate | null> {
  try {
    const res = await profileLookup(candidate.handle);
    if (typeof res === "boolean") {
      return res ? candidate : null;
    }
    if (!res || !res.exists) return null;
    return {
      ...candidate,
      ...(res.verified !== undefined ? { verifiedProfile: res.verified } : {}),
    };
  } catch {
    return null;
  }
}

export async function filterValidatedCandidates(
  candidates: ReadonlyArray<RelatedAccountCandidate>,
  profileLookup: (handle: string) => Promise<ProfileValidationResult | boolean>
): Promise<RelatedAccountCandidate[]> {
  const results: RelatedAccountCandidate[] = [];
  for (const c of candidates) {
    const validated = await validateCandidateAccount(c, profileLookup);
    if (validated) results.push(validated);
  }
  return results;
}

export interface RetrievalUiDeliveryPayload {
  true_n: number;
  primary_count: number;
  widened_count: number;
  web_count?: number;
  summary_ar: string;
  scope_breakdown: ScopeCounters;
  options?: WideningOffer[];
}

export function buildRetrievalUiDeliveryPayload(
  primaryRows: ReadonlyArray<Record<string, unknown>>,
  widenedRows: ReadonlyArray<Record<string, unknown>> = [],
  webRows: ReadonlyArray<Record<string, unknown>> = [],
  options?: WideningOffer[]
): RetrievalUiDeliveryPayload {
  const allRows = [...primaryRows, ...widenedRows, ...webRows];
  const scope_breakdown = computeScopeCounters(allRows);
  const primary_count = primaryRows.length;
  const widened_count = widenedRows.length;
  const web_count = webRows.length;

  // Primary count is strictly true_n (Point 4.1 count separation guarantee)
  const true_n = primary_count;

  let summary_ar = "";
  if (widened_count > 0) {
    summary_ar = `وجدنا ${toArabicDigits(primary_count)} من الحساب المطلوب، بالإضافة إلى ${toArabicDigits(widened_count)} من حسابات التحقق والجهات الرسمية ذات الصلة.`;
  } else if (web_count > 0) {
    summary_ar = `وجدنا ${toArabicDigits(primary_count)} من الحساب المطلوب، بالإضافة إلى ${toArabicDigits(web_count)} من الأخبار ومواقع الويب.`;
  } else {
    summary_ar = `وجدنا ${toArabicDigits(primary_count)} من الحساب المطلوب.`;
  }

  return {
    true_n,
    primary_count,
    widened_count,
    web_count,
    summary_ar,
    scope_breakdown,
    options,
  };
}

// Verbatim Arabic Customer Options (DIGER-TRUTH §6 & §7 Compliant)
export function formatDeliverPrimaryOption(primaryCount: number): string {
  return `سلّمني الموجود فقط (عدد ${toArabicDigits(primaryCount)}) من الحساب المطلوب`;
}

export const WIDEN_TO_RELATED_ACCOUNTS_OPTION_AR = "وسّع البحث ليشمل حسابات التحقق والجهات الصحية الرسمية ذات الصلة";
export const OFFICIAL_FULL_ARCHIVE_SEARCH_OPTION_AR = "البحث في الأرشيف التاريخي الشامل للمنصة (بتكلفة إضافية)";
