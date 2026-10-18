/**
 * A company's website and its LinkedIn page are different columns. Sources sometimes return the LinkedIn page in the
 * website field (or only a bare domain); a delivered workbook must never show a LinkedIn URL as the website.
 */
const LINKEDIN_HOST_RE = /(?:^|\.)linkedin\.com$/i;

function hostOf(value: string): string {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

export function isLinkedInUrl(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  return LINKEDIN_HOST_RE.test(hostOf(text)) || /linkedin\.com\//i.test(text);
}

function toHttpUrl(value: string): string {
  const text = value.trim();
  if (/^https?:\/\//i.test(text)) return text;
  return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+(\/\S*)?$/i.test(text) ? `https://${text}` : "";
}

/** The website URL and LinkedIn URL for a row, each empty when the source has no clean value for that column. */
export function resolveCompanyLinks(row: Record<string, any>): { website: string; linkedin: string } {
  const candidates = [row.website, row.website_url, row.domain, row.company_website]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  const linkedinCandidates = [row.linkedin_url, row.linkedin, row.company_linkedin]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  const websiteCandidate = candidates.find((value) => !isLinkedInUrl(value)) ?? "";
  const linkedin =
    linkedinCandidates.find((value) => isLinkedInUrl(value) && /^https?:\/\//i.test(value)) ??
    // A LinkedIn page that came in through the website field belongs in the LinkedIn column.
    candidates.find((value) => isLinkedInUrl(value) && toHttpUrl(value)) ??
    "";
  return { website: toHttpUrl(websiteCandidate), linkedin: linkedin ? toHttpUrl(linkedin) : "" };
}
