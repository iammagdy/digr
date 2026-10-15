/**
 * Extracts a human-readable display string from capability/plan parameters.
 * Guarantees that neither `[object Object]` nor raw technical exceptions are ever shown.
 */
export function extractParamDisplayString(
  params: Record<string, any> | undefined | null,
  summaryAr?: string
): string {
  if (!params || typeof params !== "object") return "";

  // 1. Direct string fields
  if (typeof params.search === "string" && params.search.trim()) return params.search.trim();
  if (typeof params.username === "string" && params.username.trim()) return params.username.trim();
  if (typeof params.keyword === "string" && params.keyword.trim()) return params.keyword.trim();
  if (typeof params.topic === "string" && params.topic.trim()) return params.topic.trim();
  if (typeof params.url === "string" && params.url.trim()) return params.url.trim();
  if (typeof params.postUrl === "string" && params.postUrl.trim()) return params.postUrl.trim();

  // 2. Query parameter: string or object (e.g. { keyword: { include: ["..."] } })
  if (typeof params.query === "string" && params.query.trim()) return params.query.trim();
  if (params.query && typeof params.query === "object") {
    if (
      Array.isArray(params.query.keyword?.include) &&
      typeof params.query.keyword.include[0] === "string" &&
      params.query.keyword.include[0].trim()
    ) {
      return params.query.keyword.include[0].trim();
    }
    if (typeof params.query.keyword === "string" && params.query.keyword.trim()) {
      return params.query.keyword.trim();
    }
    if (typeof params.query.search === "string" && params.query.search.trim()) {
      return params.query.search.trim();
    }
  }

  // 3. Nested topic object: e.g. { topic: { topic: "..." } }
  if (params.topic && typeof params.topic === "object") {
    if (typeof params.topic.topic === "string" && params.topic.topic.trim()) {
      return params.topic.topic.trim();
    }
    if (typeof params.topic.name === "string" && params.topic.name.trim()) {
      return params.topic.name.trim();
    }
  }

  // 4. Any other non-date string parameter
  for (const [key, val] of Object.entries(params)) {
    if (typeof val === "string" && val.trim() && key !== "dateFrom" && key !== "dateTo" && key !== "pagination") {
      return val.trim();
    }
  }

  // 5. Fallback: extract topic from summaryAr if available
  if (summaryAr && typeof summaryAr === "string") {
    const match = summaryAr.match(/(?:عن|لـ|في)\s+([^\n.]+)/);
    if (match?.[1] && match[1].trim()) return match[1].trim();
  }

  return "";
}
