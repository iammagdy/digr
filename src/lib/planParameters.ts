const GREETING_WORDS = new Set([
  "ازيك",
  "ازيكوا",
  "ازيكم",
  "مرحبا",
  "مرحباً",
  "أهلاً",
  "أهلا",
  "اهلا",
  "صباح الخير",
  "مساء الخير",
  "سلام عليكم",
  "السلام عليكم",
  "هلا",
  "hello",
  "hi",
  "hey",
]);

function isGreeting(val?: string): boolean {
  if (!val) return true;
  const trimmed = val.trim().toLowerCase();
  return GREETING_WORDS.has(trimmed) || /^(ازيك|مرحبا|اهلا|أهلا|هاي|سلام|hello|hi)[\s!.؟?]*$/i.test(trimmed);
}

/**
 * Extracts a human-readable display string from capability/plan parameters.
 * Guarantees that neither `[object Object]` nor raw technical exceptions are ever shown,
 * and ensures earlier greetings ("ازيك", "مرحبا") never override the research topic.
 */
export function extractParamDisplayString(
  params: Record<string, any> | undefined | null,
  summaryAr?: string
): string {
  if (!params || typeof params !== "object") return "";

  const candidates: string[] = [];

  // 1. Direct string fields
  if (typeof params.search === "string" && params.search.trim()) candidates.push(params.search.trim());
  if (typeof params.username === "string" && params.username.trim()) candidates.push(params.username.trim());
  if (typeof params.keyword === "string" && params.keyword.trim()) candidates.push(params.keyword.trim());
  if (typeof params.topic === "string" && params.topic.trim()) candidates.push(params.topic.trim());
  if (typeof params.url === "string" && params.url.trim()) candidates.push(params.url.trim());
  if (typeof params.postUrl === "string" && params.postUrl.trim()) candidates.push(params.postUrl.trim());

  // 2. Query parameter: string or object (e.g. { keyword: { include: ["..."] } })
  if (typeof params.query === "string" && params.query.trim()) candidates.push(params.query.trim());
  if (params.query && typeof params.query === "object") {
    if (
      Array.isArray(params.query.keyword?.include) &&
      typeof params.query.keyword.include[0] === "string" &&
      params.query.keyword.include[0].trim()
    ) {
      candidates.push(params.query.keyword.include[0].trim());
    }
    if (typeof params.query.keyword === "string" && params.query.keyword.trim()) {
      candidates.push(params.query.keyword.trim());
    }
    if (typeof params.query.search === "string" && params.query.search.trim()) {
      candidates.push(params.query.search.trim());
    }
  }

  // 3. Nested topic object: e.g. { topic: { topic: "..." } }
  if (params.topic && typeof params.topic === "object") {
    if (typeof params.topic.topic === "string" && params.topic.topic.trim()) {
      candidates.push(params.topic.topic.trim());
    }
    if (typeof params.topic.name === "string" && params.topic.name.trim()) {
      candidates.push(params.topic.name.trim());
    }
  }

  // 4. Any other non-date string parameter
  for (const [key, val] of Object.entries(params)) {
    if (typeof val === "string" && val.trim() && key !== "dateFrom" && key !== "dateTo" && key !== "pagination") {
      candidates.push(val.trim());
    }
  }

  // Pick first non-greeting candidate
  for (const cand of candidates) {
    if (!isGreeting(cand)) {
      return cand;
    }
  }

  // 5. Fallback: extract topic from summaryAr if available
  if (summaryAr && typeof summaryAr === "string") {
    const match = summaryAr.match(/(?:عن|لـ|في|حول|بشأن)\s+([^\n.]+)/);
    if (match?.[1] && match[1].trim() && !isGreeting(match[1])) {
      return match[1].trim();
    }
  }

  return candidates.find((c) => Boolean(c.trim())) || "";
}
