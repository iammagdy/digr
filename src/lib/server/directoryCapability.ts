/**
 * One place that says whether a job is a COMPANY directory search. The worker, the relevance gate and the execution spec all ask here,
 * so a company search can never be judged by the social rules (topic words in the record text) or run without the directory page limits.
 *
 * A job is a company search when its service or endpoint names companies, or when its plan carries the company plan's own shape: the
 * planner builds a company search with an `industry` and a `query` object (`query.keyword`, `query.location`). The shape matters
 * because the live catalog can offer a company source whose name says nothing about companies (22 Oct 2026: a company request ran on
 * a source whose slug did not contain "compan", was treated as a feed, and rejected every row for «no topic words»).
 */
const COMPANY_NAME_RE = /compan|icypeas/i;

export function isCompanyDirectoryJob(capabilitySlug: string, endpointId: string, params?: Record<string, any> | null): boolean {
  if (COMPANY_NAME_RE.test(`${capabilitySlug || ""} ${endpointId || ""}`)) return true;
  if (!params || typeof params !== "object") return false;
  const query = params.query;
  const hasCompanyPlanShape =
    typeof params.industry === "string" && params.industry.trim().length > 0 &&
    query !== null && typeof query === "object" && !Array.isArray(query) && typeof query.keyword === "object" && query.keyword !== null;
  return hasCompanyPlanShape;
}
