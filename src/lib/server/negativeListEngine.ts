/**
 * Deterministic Negative-List & Entity Deduplication Engine
 * 
 * Provides robust, audited company and entity matching:
 * - Exact corporate domain matching
 * - Arabic character and suffix normalization
 * - Distinctive brand-token matching
 * - Strict false-positive guard against generic industry terms
 * - Four explicit match classifications:
 *   CONFIRMED_DUPLICATE | POSSIBLE_DUPLICATE | DISTINCT | INSUFFICIENT_EVIDENCE
 */

export type MatchCategory =
  | "CONFIRMED_DUPLICATE"
  | "POSSIBLE_DUPLICATE"
  | "DISTINCT"
  | "INSUFFICIENT_EVIDENCE";

export interface DeduplicationAuditItem {
  candidateId: string;
  candidateName: string;
  candidateDomain?: string;
  status: MatchCategory;
  matchedBaselineRecord?: string;
  matchRule: string;
  isDeterministic: boolean;
  reasonAr: string;
}

export const GENERIC_BUSINESS_WORDS: ReadonlySet<string> = new Set([
  // Arabic generic business terms
  "شركة",
  "شركه",
  "مؤسسة",
  "مؤسسه",
  "مجموعة",
  "مجموعه",
  "مقاولات",
  "مقاولون",
  "مقاولين",
  "هندسة",
  "هندسية",
  "هندسيه",
  "كهروميكانيكا",
  "كهروميكانيكية",
  "كهروميكانيكيه",
  "إلكتروميكانيكال",
  "الكتروميكانيكال",
  "خدمات",
  "أعمال",
  "اعمال",
  "تجارة",
  "تجاره",
  "توريدات",
  "استشارات",
  "تنمية",
  "دولية",
  "دوليه",
  "مصرية",
  "مصريه",
  "عالمية",
  "عالميه",
  "صناعية",
  "صناعات",
  "العامة",
  "العامه",
  "المتحدة",
  "المتحده",
  "الحديثة",
  "الحديثه",
  "مساهمة",
  "مساهمه",
  "ذمم",
  "شمم",
  "شمع",
  "شمس",

  // English generic business terms
  "company",
  "co",
  "corp",
  "corporation",
  "group",
  "holding",
  "holdings",
  "engineering",
  "contracting",
  "contractors",
  "contractor",
  "mep",
  "electromechanical",
  "services",
  "international",
  "solutions",
  "construction",
  "technologies",
  "technology",
  "consulting",
  "industries",
  "general",
  "united",
  "modern",
  "egypt",
  "cairo",
  "arab",
  "llc",
  "ltd",
  "inc",
  "sae",
  "gmbh",
  "plc",
]);

/**
 * Normalizes Arabic text: unifying alefs, yaas, taa marbutas, removing diacritics and tatweel
 */
export function normalizeArabicText(text: string): string {
  if (!text) return "";
  return text
    .replace(/[\u064B-\u065F\u0670]/g, "") // remove tashkeel
    .replace(/\u0640/g, "") // remove tatweel
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[ىي]/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\u0621-\u064A\w\s]/g, " ") // replace punctuation
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Normalizes English text: lowercase, strip punctuation, collapse whitespace
 */
export function normalizeEnglishText(text: string): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalizes corporate domains to a canonical hostname
 * e.g. "https://www.Orascom-Const.com/about?v=1:443" -> "orascom-const.com"
 */
export function normalizeDomain(domainOrUrl?: string): string | undefined {
  if (!domainOrUrl) return undefined;
  let clean = domainOrUrl.trim().toLowerCase();
  clean = clean.replace(/^https?:\/\//, "");
  clean = clean.replace(/^www\./, "");
  clean = clean.split("/")[0].split("?")[0].split("#")[0].split(":")[0].trim();
  return clean || undefined;
}

/**
 * Strips common corporate suffixes and prefixes from an organization name
 */
export function stripBusinessSuffixes(name: string): string {
  const norm = normalizeArabicText(name);
  const words = norm.split(/\s+/);
  const filtered = words.filter((w) => {
    const rawNoAl = w.replace(/^ال/, "");
    return !GENERIC_BUSINESS_WORDS.has(w) && !GENERIC_BUSINESS_WORDS.has(rawNoAl) && w.length > 1;
  });
  return filtered.join(" ");
}

/**
 * Extracts distinctive brand tokens, excluding generic industry vocabulary
 */
export function extractBrandTokens(name: string): string[] {
  if (!name) return [];
  const normalized = normalizeArabicText(name);
  const words = normalized.split(/\s+/);
  return words.filter((w) => {
    const rawNoAl = w.replace(/^ال/, "");
    return !GENERIC_BUSINESS_WORDS.has(w) && !GENERIC_BUSINESS_WORDS.has(rawNoAl) && w.length >= 2;
  });
}

/**
 * Generates a stable normalized entity fingerprint for hashing/indexing
 */
export function generateEntityFingerprint(name: string, domain?: string): string {
  const normDomain = normalizeDomain(domain || "");
  if (normDomain) return `dom:${normDomain}`;
  const brandTokens = extractBrandTokens(name);
  if (brandTokens.length > 0) return `tokens:${brandTokens.sort().join("_")}`;
  return `raw:${normalizeArabicText(name)}`;
}

export interface EntityRecord {
  id?: string;
  name: string;
  domain?: string;
  crNumber?: string;
}

/**
 * Compares a candidate organization against a baseline record and determines
 * the exact match category with a full audit rationale.
 */
export function compareOrganizations(
  candidate: EntityRecord,
  baseline: EntityRecord
): DeduplicationAuditItem {
  const candName = candidate.name.trim();
  const baseName = baseline.name.trim();
  const candDomain = normalizeDomain(candidate.domain || "");
  const baseDomain = normalizeDomain(baseline.domain || "");

  // Rule 1: Exact Domain Match
  if (candDomain && baseDomain && candDomain === baseDomain) {
    return {
      candidateId: candidate.id || candName,
      candidateName: candName,
      candidateDomain: candDomain,
      status: "CONFIRMED_DUPLICATE",
      matchedBaselineRecord: `${baseName} (${baseDomain})`,
      matchRule: "EXACT_CORPORATE_DOMAIN_MATCH",
      isDeterministic: true,
      reasonAr: `تطابق قطعي في النطاق الإلكتروني الرسمي للشركة (${candDomain}).`,
    };
  }

  // Rule 2: Commercial Registration / Tax ID match (if supplied)
  if (
    candidate.crNumber &&
    baseline.crNumber &&
    candidate.crNumber.trim() === baseline.crNumber.trim()
  ) {
    return {
      candidateId: candidate.id || candName,
      candidateName: candName,
      candidateDomain: candDomain || undefined,
      status: "CONFIRMED_DUPLICATE",
      matchedBaselineRecord: baseName,
      matchRule: "EXACT_COMMERCIAL_REGISTRATION_MATCH",
      isDeterministic: true,
      reasonAr: `تطابق في السجل التجاري / المعرف الضريبي الرسمي (${candidate.crNumber}).`,
    };
  }

  const candNorm = normalizeArabicText(candName);
  const baseNorm = normalizeArabicText(baseName);

  // Rule 3: Exact Normalized Full Name Match
  if (candNorm && baseNorm && candNorm === baseNorm && candNorm.length > 3) {
    return {
      candidateId: candidate.id || candName,
      candidateName: candName,
      candidateDomain: candDomain || undefined,
      status: "CONFIRMED_DUPLICATE",
      matchedBaselineRecord: baseName,
      matchRule: "EXACT_NORMALIZED_NAME_MATCH",
      isDeterministic: true,
      reasonAr: "تطابق حرفي كامل في الاسم التجاري الموحد بعد توحيد الحروف.",
    };
  }

  const candTokens = extractBrandTokens(candName);
  const baseTokens = extractBrandTokens(baseName);

  // Guard: If both have zero distinctive tokens (only generic words like "شركة مقاولات")
  if (candTokens.length === 0 && baseTokens.length === 0) {
    return {
      candidateId: candidate.id || candName,
      candidateName: candName,
      candidateDomain: candDomain || undefined,
      status: "INSUFFICIENT_EVIDENCE",
      matchedBaselineRecord: baseName,
      matchRule: "GENERIC_WORDS_ONLY_INSUFFICIENT_EVIDENCE",
      isDeterministic: false,
      reasonAr: "الاسم يحتوي على كلمات تجارية عامة فقط بدون علامة مميزة؛ لا يمكن الجزم بالتطابق.",
    };
  }

  // Rule 4: Distinctive Brand Token Complete Equivalence
  // e.g. "شركة أوراسكوم للإنشاءات" vs "مجموعة أوراسكوم للإنشاء" -> distinctive token is ["اوراسكوم"]
  if (candTokens.length > 0 && baseTokens.length > 0) {
    const candSet = new Set(candTokens);
    const baseSet = new Set(baseTokens);

    const intersection = candTokens.filter((t) => baseSet.has(t));
    const isExactTokenMatch =
      intersection.length === candTokens.length &&
      intersection.length === baseTokens.length;

    if (isExactTokenMatch && intersection.length >= 1) {
      return {
        candidateId: candidate.id || candName,
        candidateName: candName,
        candidateDomain: candDomain || undefined,
        status: "CONFIRMED_DUPLICATE",
        matchedBaselineRecord: baseName,
        matchRule: "DISTINCTIVE_BRAND_TOKEN_EQUIVALENCE",
        isDeterministic: true,
        reasonAr: `تطابق كامل في العلامة التجارية المميزة (${intersection.join(" ")}).`,
      };
    }

    // Rule 5: Partial Brand Token Overlap (Ambiguous Match -> Flag for review, DO NOT delete!)
    if (intersection.length >= 1 && (candTokens.length > 1 || baseTokens.length > 1)) {
      return {
        candidateId: candidate.id || candName,
        candidateName: candName,
        candidateDomain: candDomain || undefined,
        status: "POSSIBLE_DUPLICATE",
        matchedBaselineRecord: baseName,
        matchRule: "PARTIAL_BRAND_TOKEN_OVERLAP",
        isDeterministic: false,
        reasonAr: `تشابه في جزء من العلامة التجارية (${intersection.join(" ")}) مع اختلاف في باقي الأجزاء. مؤهل للمراجعة اليدوية وليس الحذف التلقائي.`,
      };
    }
  }

  // Rule 6: Distinct entity
  return {
    candidateId: candidate.id || candName,
    candidateName: candName,
    candidateDomain: candDomain || undefined,
    status: "DISTINCT",
    matchRule: "NO_OVERLAPPING_DISTINCTIVE_TOKENS",
    isDeterministic: true,
    reasonAr: "كيان مستقل تماماً بدون تطابق في النطاق أو العلامة التجارية.",
  };
}

/**
 * Filters candidate entities against a baseline exclusion set.
 * Confirmed duplicates are excluded and logged.
 * Ambiguous matches are preserved and flagged in the audit trail.
 * Distinct records are accepted.
 */
export function deduplicateAgainstBaseline(
  candidates: EntityRecord[],
  baselineRecords: EntityRecord[]
): {
  delivered: EntityRecord[];
  confirmedDuplicates: EntityRecord[];
  ambiguousMatches: EntityRecord[];
  auditTrail: DeduplicationAuditItem[];
} {
  const delivered: EntityRecord[] = [];
  const confirmedDuplicates: EntityRecord[] = [];
  const ambiguousMatches: EntityRecord[] = [];
  const auditTrail: DeduplicationAuditItem[] = [];

  for (const candidate of candidates) {
    let worstMatch: DeduplicationAuditItem | null = null;

    for (const base of baselineRecords) {
      const match = compareOrganizations(candidate, base);
      if (match.status === "CONFIRMED_DUPLICATE") {
        worstMatch = match;
        break; // immediate confirmed match
      }
      if (match.status === "POSSIBLE_DUPLICATE") {
        if (!worstMatch || worstMatch.status === "DISTINCT") {
          worstMatch = match;
        }
      }
    }

    if (!worstMatch) {
      worstMatch = {
        candidateId: candidate.id || candidate.name,
        candidateName: candidate.name,
        candidateDomain: candidate.domain,
        status: "DISTINCT",
        matchRule: "BASELINE_EMPTY_OR_UNMATCHED",
        isDeterministic: true,
        reasonAr: "لا يوجد أي تطابق مع قائمة الاستبعاد المرجعية.",
      };
    }

    auditTrail.push(worstMatch);

    if (worstMatch.status === "CONFIRMED_DUPLICATE") {
      confirmedDuplicates.push(candidate);
    } else if (worstMatch.status === "POSSIBLE_DUPLICATE") {
      ambiguousMatches.push(candidate);
      // As instructed by owner, questionable cases are preserved for user review, not silently deleted!
      delivered.push(candidate);
    } else {
      delivered.push(candidate);
    }
  }

  return {
    delivered,
    confirmedDuplicates,
    ambiguousMatches,
    auditTrail,
  };
}

export type NegativeListItem = Omit<EntityRecord, "name"> & {
  name?: string;
  nameAr?: string;
  nameEn?: string;
  normalizedNameAr?: string;
  normalizedNameEn?: string;
};

export type CandidateCompanyRecord = Omit<EntityRecord, "name"> & {
  name?: string;
  nameAr?: string;
  nameEn?: string;
};

const LEGAL_FORMS: ReadonlySet<string> = new Set(
  [
    "شركة", "شركه", "مؤسسة", "مؤسسه", "مجموعة", "مجموعه",
    "شمم", "ذمم", "شعم", "ش م م", "ذ م م", "ش ع م", "ش ذ م م",
    "مساهمة", "مساهمه", "توصية", "تضامن", "فردية",
    "sae", "llc", "ltd", "inc", "corp", "gmbh", "plc"
  ].map((w) => normalizeArabicText(w))
);

export function normalizeArabicCompanyName(name: string): string {
  const norm = normalizeArabicText(name);
  const words = norm.split(/\s+/);
  const filtered = words.filter((w) => {
    const rawNoAl = w.replace(/^ال/, "");
    return !LEGAL_FORMS.has(w) && !LEGAL_FORMS.has(rawNoAl) && !/^(ش|م|ذ|ع)$/.test(w);
  });
  return filtered.join(" ");
}

export function normalizeEnglishCompanyName(name: string): string {
  return normalizeEnglishText(name);
}

export function evaluateCompanyMatch(
  candidate: CandidateCompanyRecord,
  baseline: NegativeListItem
): {
  status: MatchCategory;
  matchCriteria?: string;
  confidence?: number;
  reasonAr: string;
} {
  const candRecord: EntityRecord = {
    id: candidate.id,
    name: candidate.name || candidate.nameAr || candidate.nameEn || "",
    domain: candidate.domain,
    crNumber: candidate.crNumber,
  };
  const baseRecord: EntityRecord = {
    id: baseline.id,
    name: baseline.name || baseline.nameAr || baseline.nameEn || "",
    domain: baseline.domain,
    crNumber: baseline.crNumber,
  };
  const res = compareOrganizations(candRecord, baseRecord);
  let matchCriteria = "distinct";
  let confidence = 0.0;
  if (res.matchRule.includes("DOMAIN")) {
    matchCriteria = "domain_exact";
    confidence = 1.0;
  } else if (res.matchRule.includes("COMMERCIAL_REGISTRATION")) {
    matchCriteria = "cr_exact";
    confidence = 1.0;
  } else if (res.matchRule.includes("NAME")) {
    matchCriteria = "name_exact";
    confidence = 0.95;
  } else if (res.matchRule.includes("BRAND")) {
    matchCriteria = "brand_token";
    confidence = res.status === "CONFIRMED_DUPLICATE" ? 0.9 : 0.6;
  }
  return {
    status: res.status,
    matchCriteria,
    confidence,
    reasonAr: res.reasonAr,
  };
}

export function auditDeduplication(
  candidates: CandidateCompanyRecord[],
  baseline: NegativeListItem[]
): {
  uniqueRecords: CandidateCompanyRecord[];
  duplicatesRemovedCount: number;
  auditLog: Array<{
    candidateName: string;
    matchedBaselineName?: string;
    status: MatchCategory;
    actionAr: string;
    confidence: number;
  }>;
} {
  const candRecords: EntityRecord[] = candidates.map((c) => ({
    id: c.id,
    name: c.name || c.nameAr || c.nameEn || "",
    domain: c.domain,
    crNumber: c.crNumber,
  }));
  const baseRecords: EntityRecord[] = baseline.map((b) => ({
    id: b.id,
    name: b.name || b.nameAr || b.nameEn || "",
    domain: b.domain,
    crNumber: b.crNumber,
  }));

  const res = deduplicateAgainstBaseline(candRecords, baseRecords);

  const deliveredNames = new Set(res.delivered.map((d) => d.name));
  const uniqueRecords = candidates.filter((c) => deliveredNames.has(c.name || c.nameAr || c.nameEn || ""));

  const auditLog = res.auditTrail.map((item) => ({
    candidateName: item.candidateName,
    matchedBaselineName: item.matchedBaselineRecord,
    status: item.status,
    actionAr: item.status === "CONFIRMED_DUPLICATE" ? "مستبعد (تطابق قطعي مع قائمة الاستبعاد)" : "مقبول",
    confidence: item.status === "CONFIRMED_DUPLICATE" ? 1.0 : 0.0,
  }));

  return {
    uniqueRecords,
    duplicatesRemovedCount: res.confirmedDuplicates.length,
    auditLog,
  };
}

