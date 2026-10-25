import { pageChannelOfItem, pageHandleOf } from "./planMethodSteps";
import { isSocialCapabilitySlug, validateSocialParams } from "./socialSources";
import { planCountLineAr } from "./planCounts";
import {
  COUNTRY_REQUIRED_AR,
  detectCountryFromText,
  INDUSTRY_REQUIRED_AR,
  planActivityLabelAr,
  socialContentTopicFromTitle,
} from "./planParameters";

/** The job title a customer sees for the provider's English title word; the stored params keep the provider value. */
const ROLE_TITLE_AR: Record<string, string> = {
  director: "مدير",
  manager: "مدير",
  ceo: "الرئيس التنفيذي",
  cfo: "المدير المالي",
  cto: "المدير التقني",
  coo: "مدير التشغيل",
  "general manager": "مدير عام",
  chairman: "رئيس مجلس الإدارة",
  founder: "مؤسس",
  owner: "مالك",
};

export function roleTitleDisplayAr(title: string): string {
  const key = String(title || "").trim().toLowerCase();
  return ROLE_TITLE_AR[key] || title;
}

export interface PlanScopeChip {
  label: string;
  value: string;
}

const countryNamesAr = new Intl.DisplayNames(["ar"], { type: "region" });

function resolveCountryAr(val: unknown): string {
  const text = String(val ?? "").trim();
  if (isMissingText(text)) return COUNTRY_REQUIRED_AR;
  const detected = detectCountryFromText(text);
  if (detected?.arabicLabel) return detected.arabicLabel;
  if (/^[A-Z]{2}$/i.test(text)) {
    try {
      const ar = countryNamesAr.of(text.toUpperCase());
      if (ar && ar.toUpperCase() !== text.toUpperCase()) return ar;
    } catch {
      // fallback
    }
  }
  return text;
}

/**
 * Converts English digits (0-9) to Arabic-Indic digits (٠-٩).
 */
export function toArabicDigits(val: number | string): string {
  const digits = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
  return String(val).replace(/[0-9]/g, (d) => digits[Number(d)]);
}

/** The strings a failed lookup leaves behind: they are missing values, never content. */
const MISSING_TOKEN = /^\s*(?:undefined|null|nan)?\s*$/i;
const MISSING_TOKEN_IN_TEXT = /(?:^|[\s،,:؛(«"'])(?:undefined|null|NaN)(?=$|[\s،,.:؛)»"'!؟?])/;

/** True for an empty or whitespace string and for the words «undefined», «null», «NaN»: a value that was never found. */
export function isMissingText(val: unknown): boolean {
  return typeof val !== "string" || MISSING_TOKEN.test(val);
}

/** True when a customer-facing sentence carries one of those words as a value («… في undefined»). */
export function containsMissingToken(text: unknown): boolean {
  return typeof text === "string" && MISSING_TOKEN_IN_TEXT.test(text);
}

/**
 * A customer-facing sentence without a value that was never found: «… في undefined» loses the dangling phrase. A builder should
 * leave the phrase out itself; this is the last line of defence before a message is saved or a card is drawn.
 */
export function stripMissingValueWords(text: string): string {
  const original = String(text ?? "");
  // Nothing to remove: the text, with its line breaks, is returned exactly as it came.
  if (!/(?:^|[\s،,:؛(«"'])(?:undefined|null|NaN)(?=$|[\s،,.:؛)»"'!؟?])/.test(original)) return original;
  return original
    .replace(/\s+(?:في|من|على|إلى|حول|بـ?)\s+(?:undefined|null|NaN)(?=$|[\s،,.:؛)»"'!؟?])/g, "")
    .replace(/(?:^|(?<=[\s،,:؛(«"']))(?:undefined|null|NaN)(?=$|[\s،,.:؛)»"'!؟?])/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * A quote whose customer-facing texts carry no missing-value word. Applied where a quote is created and again where a stored one
 * is drawn, so an old card saved with «في undefined» reads cleanly without the stored row being touched.
 */
export function scrubQuoteTexts<T extends { summaryAr?: string; methodologyNotes?: string }>(quote: T): T {
  const clean = (text: unknown) => (typeof text === "string" ? stripMissingValueWords(text) : text);
  return {
    ...quote,
    ...(typeof quote.summaryAr === "string" ? { summaryAr: clean(quote.summaryAr) as string } : {}),
    ...(typeof quote.methodologyNotes === "string" ? { methodologyNotes: clean(quote.methodologyNotes) as string } : {}),
  };
}

/** A string that says something: not empty, not a missing-value word, not a «يلزم تحديد» placeholder. */
function usableText(val: unknown): boolean {
  return typeof val === "string" && !isMissingText(val) && !/يلزم تحديد/.test(val) && !BROKEN_FIELD.test(val);
}

/** A value made only of the leftovers of a card label («ال المطلوب مطلوب»): a stranded article, or «المطلوب» next to «مطلوب». */
const BROKEN_FIELD = /(?:^|\s)ال(?=\s|$)|المطلوب[ةه]?\s+مطلوب/u;

function hasPlaceholderText(val: unknown): boolean {
  if (typeof val === "string") {
    return /يلزم تحديد/.test(val) || (MISSING_TOKEN.test(val) && val.trim().length > 0);
  }
  if (Array.isArray(val)) {
    return val.some(hasPlaceholderText);
  }
  if (val && typeof val === "object") {
    return Object.values(val).some(hasPlaceholderText);
  }
  return false;
}

/**
 * Evaluates whether a plan's items have missing required parameters (scope gaps).
 * Pure function, shared client/server.
 * Returns array of gap codes: "country" | "industry" | "title" | "social_params" | "placeholder" | "empty_plan".
 */
export function quoteScopeGaps(
  items: Array<{
    capabilitySlug?: string;
    endpointId?: string;
    slug?: string;
    params?: Record<string, any>;
    targetVolumeMax?: number;
    [key: string]: any;
  }> | undefined | null
): string[] {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return ["empty_plan"];
  }

  const gaps: string[] = [];

  for (const item of items) {
    // 1. Placeholder check: any param string matching /يلزم تحديد/ -> placeholder
    if (hasPlaceholderText(item.params) || hasPlaceholderText((item as any).query)) {
      gaps.push("placeholder");
    }

    const slug = String(item.capabilitySlug || item.endpointId || item.slug || "").toLowerCase();
    const params = item.params || {};
    const query = (params.query && typeof params.query === "object" ? params.query : (item as any).query) || {};

    const isCompany = /compan|b2b/i.test(slug);
    const isPeople = slug.includes("people");
    const isSocial = isSocialCapabilitySlug(item.capabilitySlug || slug);

    if (isCompany) {
      // company -> needs query.location.include[0] non-empty AND (query.industry.include or query.keyword.include)
      const locInclude = query.location?.include;
      const hasLocation =
        Array.isArray(locInclude)
          ? locInclude.length > 0 && usableText(locInclude[0])
          : (usableText(params.location)) ||
            (usableText(params.country));

      if (!hasLocation) {
        gaps.push("country");
      }

      const indInclude = query.industry?.include;
      const kwInclude = query.keyword?.include || query.keywords?.include;
      const hasIndustry =
        (Array.isArray(indInclude) && indInclude.some((x: any) => usableText(x))) ||
        (usableText(params.industry));
      const hasKeyword =
        (Array.isArray(kwInclude) && kwInclude.some((x: any) => usableText(x))) ||
        (usableText(params.keyword)) ||
        (usableText(params.keywords));

      if (!hasIndustry && !hasKeyword) {
        gaps.push("industry");
      }
    } else if (isPeople) {
      // people -> country and (title or keywords)
      const countryVal = params.country || params.location || query.location?.include?.[0];
      const hasCountry = usableText(countryVal);
      if (!hasCountry) {
        gaps.push("country");
      }

      const titleVal = params.title || params.jobTitle || query.title || query.jobTitle?.include?.[0];
      const kwVal = params.keywords || params.keyword || query.keywords || query.keyword?.include?.[0];
      const hasTitle =
        (usableText(titleVal)) ||
        (Array.isArray(titleVal) && titleVal.length > 0 && titleVal.some((t: any) => usableText(t)));
      const hasKeywords =
        (usableText(kwVal)) ||
        (Array.isArray(kwVal) && kwVal.length > 0 && kwVal.some((k: any) => usableText(k)));
      const isDecisionMakers = Array.isArray(params.requiredContactFields) && params.requiredContactFields.length > 0;

      if (!hasTitle && !hasKeywords && !isDecisionMakers) {
        gaps.push("title");
      }
    } else if (isSocial) {
      // social -> validateSocialParams
      const socialErr = validateSocialParams(item.capabilitySlug || slug, params);
      if (socialErr) {
        gaps.push("social_params");
      }
    }
  }

  return Array.from(new Set(gaps));
}

/**
 * Returns the scope chips to display on the plan card.
 * Country chip only for company/people plans or when params.region exists;
 * social without region shows no country chip.
 * For tweets (social-x-posts), returns exactly 2 chips (topic, volume) without "الدولة".
 */
export function planScopeRows(
  items: Array<{
    capabilitySlug?: string;
    endpointId?: string;
    slug?: string;
    params?: Record<string, any>;
    targetVolumeMax?: number;
    volume?: number;
    [key: string]: any;
  }> | undefined | null,
  conversationTitle?: string
): PlanScopeChip[] {
  if (!items || !Array.isArray(items) || items.length === 0) {
    return [];
  }

  const primary = items[0];
  const slug = String(primary.capabilitySlug || primary.endpointId || primary.slug || "").toLowerCase();
  const params = primary.params || {};
  const query = (params.query && typeof params.query === "object" ? params.query : (primary as any).query) || {};

  const isCompany = /compan|b2b/i.test(slug);
  const isPeople = slug.includes("people");
  const isSocial = isSocialCapabilitySlug(primary.capabilitySlug || slug) || /social|tiktok|youtube|facebook|instagram|x-posts|twitter|reddit/i.test(slug);

  const chips: PlanScopeChip[] = [];

  // Country chip: ONLY for company/people plans or when params.region exists; social without region shows no country chip.
  const hasRegion = Boolean(params.region);
  const shouldShowCountry = isCompany || isPeople || hasRegion;

  if (shouldShowCountry) {
    let countryDisplay = "";
    if (hasRegion) {
      countryDisplay = resolveCountryAr(params.region);
    } else {
      const rawCountry = query.location?.include?.[0] || params.location || params.country;
      countryDisplay = resolveCountryAr(rawCountry);
    }
    chips.push({
      label: "الدولة / النطاق:",
      value: countryDisplay,
    });
  }

  // Scope / Topic / Industry chip
  if (isPeople) {
    const titleVal = params.title || params.jobTitle || query.title || query.jobTitle?.include?.[0];
    const kwVal = params.keywords || params.keyword || query.keywords || query.keyword?.include?.[0];
    const scopeVal =
      (typeof titleVal === "string" && titleVal.trim() && roleTitleDisplayAr(titleVal)) ||
      (typeof kwVal === "string" && kwVal.trim()) ||
      "صناع القرار والمهنيون";
    chips.push({
      label: "نوع البحث:",
      value: scopeVal,
    });
  } else if (isSocial) {
    const rawVal =
      params.query ||
      params.channel ||
      params.url ||
      // a title cut at fifty characters («… عن «كرة…») is not a topic
      (conversationTitle && !/[…]$|\.\.\.$/u.test(conversationTitle.trim()) ? socialContentTopicFromTitle(conversationTitle) : "") ||
      "الموضوع المطلوب";
    // A page plan (its channel is the page's link or handle) shows the page, never the link as a topic.
    const pageOfPlan = pageChannelOfItem(primary);
    if (pageOfPlan) {
      chips.push({ label: "الصفحة:", value: pageHandleOf(pageOfPlan) });
    } else {
      chips.push({
        label: "موضوع المحتوى:",
        value: String(rawVal).trim(),
      });
    }
  } else {
    // Company or general: the activity name comes from the one shared reader, the very one the card's field and steps use.
    chips.push({
      label: "النشاط / التخصص:",
      value: planActivityLabelAr(params) || INDUSTRY_REQUIRED_AR,
    });
  }

  // Volume chip
  const vol = primary.targetVolumeMax || primary.volume || (primary.params && primary.params.count) || 1;
  // Several services (posts and their comments): every service's own count, the very string the card's title shows.
  chips.push({
    label: "العدد المطلوب:",
    value: planCountLineAr(items, Number(vol) || undefined),
  });

  // A chip never shows a value that was not found («undefined», «null», «NaN», blank): it asks for it instead.
  return chips.map((chip) => (isMissingText(chip.value) || containsMissingToken(chip.value) ? { ...chip, value: "يلزم تحديد القيمة" } : chip));
}
