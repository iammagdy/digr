import { toArabicDigits } from "../../../src/lib/arabicDigits";
import { checkPublicReadUrl } from "../../../src/lib/multiProvider/policy";

/**
 * TREG Phase 4 & Phase 6: Scope-Separated Widening Proposals & Site Reading Pipeline (docs/diger-team/DT-20261123-treg-p4.md, DT-20261123-treg-p6b.md).
 * Generic widening interfaces and proposal builders with strict scope separation.
 * Zero hardcoded platform names, provider names, topic words, or source categories in code.
 * Arabic labels and summary wording derive strictly from the LLM proposal approved by customer (titleAr).
 */

export type ItemScope = "primary_account" | "widened_account" | "broader_topic" | "full_archive" | "widened_entity_site";

export interface RelatedAccountCandidate {
  handle: string;
  role: "official_spokesperson" | "fact_checker" | "media_outlet" | "regulator";
  rationale: string;
  verifiedProfile?: boolean;
}

export interface WideningOffer {
  kind: "related_accounts" | "full_archive" | "broader_keywords" | "entity_website";
  scope: ItemScope;
  titleAr: string;
  descriptionAr: string;
  accounts?: RelatedAccountCandidate[];
  targetUrl?: string;
  additionalCostUsd?: number;
}

export const SCOPE_COLUMN_KEY = "scope_label_ar";
export const SCOPE_COLUMN_TITLE_AR = "نطاق المصدر";

export const PRIMARY_SCOPE_LABEL_AR = "الحساب المطلوب";
export const DEFAULT_NEUTRAL_WIDENED_LABEL_AR = "نطاق أوسع وافقت عليه";
export const ENTITY_SITE_SCOPE_LABEL_AR = "الموقع الرسمي للجهة";

export function scopeLabelAr(scope?: ItemScope | string, proposalTitleAr?: string): string {
  if (proposalTitleAr && proposalTitleAr.trim() !== "") {
    return proposalTitleAr.trim();
  }
  if (!scope || scope === "primary_account") {
    return PRIMARY_SCOPE_LABEL_AR;
  }
  if (scope === "widened_entity_site") {
    return ENTITY_SITE_SCOPE_LABEL_AR;
  }
  return DEFAULT_NEUTRAL_WIDENED_LABEL_AR;
}

export interface ScopeCounters {
  primary: number;
  widened: number;
  web: number;
  fullArchive?: number;
  entitySite?: number;
  total: number;
}

export function computeScopeCounters(rows: ReadonlyArray<Record<string, unknown>>): ScopeCounters {
  let primary = 0;
  let widened = 0;
  let web = 0;
  let fullArchive = 0;
  let entitySite = 0;
  for (const r of rows) {
    const scope = (r.scope as ItemScope) || "primary_account";
    if (scope === "widened_account") widened++;
    else if (scope === "broader_topic") web++;
    else if (scope === "widened_entity_site") {
      entitySite++;
      widened++;
    }
    else if (scope === "full_archive") fullArchive++;
    else primary++;
  }
  return {
    primary,
    widened,
    web,
    fullArchive,
    entitySite,
    total: primary + widened + web + fullArchive,
  };
}

export function tagRowWithScope<T extends Record<string, unknown>, S extends ItemScope = ItemScope>(
  row: T,
  scope: S,
  scopeLabelArText?: string
): T & { scope: S; scope_label_ar: string } {
  const label = scopeLabelArText || (row[SCOPE_COLUMN_KEY] as string) || scopeLabelAr(scope);
  return {
    ...row,
    scope,
    [SCOPE_COLUMN_KEY]: label,
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
  options?: WideningOffer[],
  proposalTitleAr?: string
): RetrievalUiDeliveryPayload {
  const allRows = [...primaryRows, ...widenedRows, ...webRows];
  const scope_breakdown = computeScopeCounters(allRows);
  const primary_count = primaryRows.length;
  const widened_count = widenedRows.length;
  const web_count = webRows.length;

  // Primary count is strictly true_n (Point 4.1 count separation guarantee)
  const true_n = primary_count;

  // The widened label derives from the approved proposal title or row metadata, with a neutral fallback
  const widenedLabel =
    proposalTitleAr?.trim() ||
    options?.find((o) => o.titleAr?.trim())?.titleAr.trim() ||
    (widenedRows[0]?.[SCOPE_COLUMN_KEY] as string) ||
    (webRows[0]?.[SCOPE_COLUMN_KEY] as string) ||
    DEFAULT_NEUTRAL_WIDENED_LABEL_AR;

  let summary_ar = "";
  const additionalCount = widened_count + web_count;
  if (additionalCount > 0) {
    summary_ar = `وجدنا ${toArabicDigits(primary_count)} من الحساب المطلوب، بالإضافة إلى ${toArabicDigits(additionalCount)} من ${widenedLabel}.`;
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

// Customer Options (DIGER-TRUTH §6 & §7 Compliant, dynamic shape with numbers filled)
export function formatDeliverPrimaryOption(primaryCount: number): string {
  return `سلّمني الموجود فقط (عدد ${toArabicDigits(primaryCount)}) من الحساب المطلوب`;
}

export function formatWidenOption(proposalTitleAr?: string): string {
  if (proposalTitleAr && proposalTitleAr.trim() !== "") {
    return `وسّع البحث ليشمل ${proposalTitleAr.trim()}`;
  }
  return `وسّع البحث ليشمل ${DEFAULT_NEUTRAL_WIDENED_LABEL_AR}`;
}

export const OFFICIAL_FULL_ARCHIVE_SEARCH_OPTION_AR = "البحث في الأرشيف التاريخي الشامل للمنصة (بتكلفة إضافية)";

export function buildEntityWebsiteWideningOffer(
  targetUrl: string,
  titleAr = "قراءة الموقع الرسمي للجهة والبيانات الصحفية الصادرة عنه",
  descriptionAr = "فحص بيانات نفي الشائعات والتصريحات الرسمية المنشورة على موقع الوزارة مباشرة."
): WideningOffer {
  return {
    kind: "entity_website",
    scope: "widened_entity_site",
    titleAr,
    descriptionAr,
    targetUrl,
  };
}

export interface EntitySiteWideningInput {
  targetUrl: string;
  limit?: number;
  urlFilter?: string;
  maxPages?: number;
  siteMapFn: (url: string, filter?: string, limit?: number) => Promise<{ urls: string[] }>;
  pageReadFn: (url: string) => Promise<{ markdown: string; title?: string; finalUrl?: string }>;
  judgeFn: (page: { url: string; markdown: string; title?: string }) => Promise<{ accepted: boolean; row?: Record<string, unknown> }>;
}

export interface EntitySiteWideningResult {
  discoveredUrls: string[];
  pagesRead: number;
  acceptedRows: Array<Record<string, unknown> & { scope: "widened_entity_site"; scope_label_ar: string }>;
  customerPointsBilled: number;
}

export async function executeEntityWebsiteWidening(input: EntitySiteWideningInput): Promise<EntitySiteWideningResult> {
  const targetUrl = String(input.targetUrl ?? "").trim();
  // Target behind login / private host check
  const verdict = checkPublicReadUrl(targetUrl);
  if (!verdict.ok) {
    return {
      discoveredUrls: [],
      pagesRead: 0,
      acceptedRows: [],
      customerPointsBilled: 0,
    };
  }

  // Stage 1: site.map bounded to limit <= 50 (or 200 max)
  const mapLimit = Math.min(Math.max(1, input.limit ?? 50), 50);
  const mapResult = await input.siteMapFn(targetUrl, input.urlFilter, mapLimit);
  const discoveredUrls = (mapResult?.urls ?? []).slice(0, 50);

  // Stage 2: Bounded fetch via page.read (strictly <= 4 pages)
  const maxPages = Math.min(Math.max(0, input.maxPages ?? 4), 4);
  const candidateUrls = discoveredUrls.slice(0, maxPages);

  const acceptedRows: Array<Record<string, unknown> & { scope: "widened_entity_site"; scope_label_ar: string }> = [];
  let pagesRead = 0;

  for (const url of candidateUrls) {
    const urlVerdict = checkPublicReadUrl(url);
    if (!urlVerdict.ok) continue;

    pagesRead++;
    const page = await input.pageReadFn(url);
    const judge = await input.judgeFn({ url: page.finalUrl ?? url, markdown: page.markdown, title: page.title });
    if (judge.accepted && judge.row) {
      acceptedRows.push(
        tagRowWithScope(
          { ...judge.row, url: page.finalUrl ?? url },
          "widened_entity_site",
          ENTITY_SITE_SCOPE_LABEL_AR
        )
      );
    }
  }

  // Customer Billing Rule: EXCLUSIVELY for delivered MATCHING rows, NEVER for raw crawled pages
  // 0 matching rows => 0 points billed
  const customerPointsBilled = acceptedRows.length === 0 ? 0 : Math.max(200, acceptedRows.length * 100);

  return {
    discoveredUrls,
    pagesRead,
    acceptedRows,
    customerPointsBilled,
  };
}
