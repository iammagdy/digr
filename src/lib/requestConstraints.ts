/**
 * Constraints a customer may add to a request that the data source cannot filter by (company size, revenue, founding
 * year, sentiment, language). They are recognised so that (a) their numbers are never read as the record count and their
 * words never turn a company list into a people search, and (b) the plan can say honestly that the source cannot filter by
 * them while the relevance gate still reviews every row.
 */
export const SIZE_RE = /(?:أكثر|اكتر|أكتر|أقل|اقل)\s*من\s*[\d٠-٩]+\s*(?:موظف|موظفين|عامل|عاملين)|(?:ب|بـ)?\s*[\d٠-٩]+\s*(?:موظف|موظفين|عامل|عاملين)\s*(?:فأكثر|فاكثر|أو أكثر|او اكتر|أو أقل)?|عدد (?:ال)?(?:موظفين|عاملين)|حجم(?:ها| ال)?\s*(?:شركة)?|شركات (?:كبيرة|صغيرة|متوسطة)/;
export const REVENUE_RE = /إيرادات|ايرادات|رأس المال|راس المال|مبيعات سنوية|أرباح|ارباح/;
export const FOUNDED_RE = /تأسست|تاسست|سنة التأسيس|منذ عام\s*[\d٠-٩]{4}/;

/** The request with the constraint phrases (and their numbers) removed, for counting and kind detection. */
export function stripConstraintPhrases(text: string): string {
  return String(text || "")
    .replace(new RegExp(SIZE_RE.source, "g"), " ")
    .replace(/(?:تأسست|تاسست)\s*(?:بعد|قبل|في)?\s*(?:عام|سنة)?\s*[\d٠-٩]{4}/g, " ")
    .replace(/منذ عام\s*[\d٠-٩]{4}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
