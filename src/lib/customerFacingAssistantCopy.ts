const UNSAFE_ALTERNATIVE_PATTERNS = [
  /أقرب خدمة متاحة/i,
  /closest\s+(?:available\s+)?(?:service|capability)/i,
];

/** Replaces stale assistant fallbacks that name a capability unrelated to the request. */
export function customerFacingAssistantCopy(content: string): string {
  if (UNSAFE_ALTERNATIVE_PATTERNS.some((pattern) => pattern.test(content))) {
    return "لم نتمكن من تحديد نوع الطلب المناسب. راجع تفاصيل طلبك وحاول مجددًا.";
  }
  return content;
}
