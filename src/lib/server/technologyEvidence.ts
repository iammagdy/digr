/**
 * Technology activity of a PERSON's employer, read from everything the source gave about the person and the company: the person's job title and
 * headline, the company's name, description and industry label. Used only for a request for technology companies (see `isTechnologyRequest`).
 *
 * The rule, in short:
 *  - the company's name or description carries ONE clear technology signal (a short constant list, English and Arabic) -> evidence;
 *  - the person's job title, headline or profile text carries a signal AND says it is a firm's activity («IT Consultancy & Management Firm», «Founder, web
 *    development agency»), not a role («IT Manager», «Head of IT» works inside a bank or a hospital too) -> evidence;
 *  - the source's industry label is NEVER evidence on its own (the source filtered by that label, so every returned row carries it);
 *  - a generic word is no signal: «development» alone (a community development union), «systems» in a description (compressed-air systems), «mobile»,
 *    «network», «electronic», «automation» (industrial).
 * Deterministic and offline.
 */
import { normalizeArabic } from "./relevanceEvidence";

/** English signals in a company's name or description. Uppercase abbreviations (IT, AI, VR) are matched case-sensitively so «it» the pronoun is not one. */
const ENGLISH_SIGNALS: readonly RegExp[] = [
  /\b(?:software|saas|paas|fintech|edtech|healthtech|insurtech|proptech|cyber ?security|blockchain|artificial intelligence|machine learning|virtual reality|augmented reality|e-?commerce|internet|telecom\w*|telecommunications?|digital|technolog(?:y|ies)|tech|programming|programmers?|websites?|web|apps?|cloud|erp)\b/i,
  /\b(?:IT|ICT|AI|VR|AR|XR)\b/,
  /\bit (?:services?|solutions?|consult\w*|outsourcing|infrastructure|company|firm)\b/i,
  /\b(?:software|web|app|mobile app|game|application|systems?) (?:development|developers?|integration)\b/i,
  /\b(?:information|computer|software|embedded|payment|banking) systems?\b/i,
  /\bdata (?:cent(?:er|re)s?|analytics|science|platforms?|engineering)\b/i,
  /\b(?:web|online|payment|customer) portals?\b/i,
];

/** Arabic signals, after the usual letter folding (hamza forms, ya, ta marbuta). */
const ARABIC_SIGNALS: readonly RegExp[] = [
  /تقني|تكنولوجي|برمج|رقمي|اتصالات|تطبيقات|ويب|سحابي|الحوسبه|ذكاء اصطناعي|بوابه|انترنت|معلوماتيه|نظم المعلومات|تجاره الكترونيه/,
];

const hasSignal = (text: string): boolean => {
  if (!text) return false;
  if (ENGLISH_SIGNALS.some((pattern) => pattern.test(text))) return true;
  const arabic = normalizeArabic(text);
  return ARABIC_SIGNALS.some((pattern) => pattern.test(arabic));
};

/** One clear technology signal in a text (a company name or description, or a request's keyword). */
export function technologySignalIn(text: unknown): boolean {
  return typeof text === "string" && hasSignal(text);
}

/** A word that makes a phrase a FIRM's activity (not a person's role). */
const FIRM_WORDS = /\b(?:consultanc\w*|consulting|compan\w*|firm|solutions?|services?|agency|studio|provider|house|start-?up|platform|developers?|development|labs?|technologies|systems)\b|شرك|مؤسس|حلول|خدمات|وكال|استشارات/i;

/**
 * A person's job title or headline: it counts only when a segment of it («CEO - IT Consultancy & Management Firm» has the segments «CEO» and
 * «IT Consultancy & Management Firm») names a technology signal AND a firm word. A role alone («IT Manager», «Head of IT») does not.
 */
export function technologyFirmInTitle(title: unknown): boolean {
  if (typeof title !== "string" || !title.trim()) return false;
  return title.split(/\s[-–—|•@]\s|\s+at\s+|[|,;/]|\.\s|\sof\s/i).some((segment) => hasSignal(segment) && FIRM_WORDS.test(normalizeArabic(segment) + " " + segment));
}

/** The request is for technology companies: one of its activity keywords or its Arabic sector label carries a technology signal. */
export function isTechnologyRequest(keywords: readonly unknown[], industryLabel?: unknown): boolean {
  return keywords.some((keyword) => technologySignalIn(keyword)) || technologySignalIn(industryLabel);
}

/**
 * Whether the row establishes technology activity of the person's employer, and from which part: `company` (name or description), `title`
 * (the person's job title or headline names a firm's technology activity), or none. The industry label is never consulted here.
 */
export function technologyEvidenceOf(row: Record<string, any>): "company" | "title" | null {
  const companyTexts = [row.company_name, row.industry_description, row.company_description, row.specialties, row.tagline]
    .map((value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string").join(" ") : value))
    .filter((value): value is string => typeof value === "string");
  if (companyTexts.some(hasSignal)) return "company";
  // «Smartec Systems»: «systems» is a signal in a company's NAME only (in a description it is as likely «compressed-air systems»)
  if (typeof row.company_name === "string" && /\bsystems?\b/i.test(row.company_name)) return "company";
  if ([row.job_title, row.headline, row.lastJobTitle, row.currentJobTitle, row.description].some(technologyFirmInTitle)) return "title";
  return null;
}
