/** Avoid charging for overlapping company or people searches proposed by the model. */
export function dedupeRecordSearchItems<T extends { capabilitySlug: string; params?: Record<string, any> }>(items: T[]): T[] {
  const result: T[] = [];
  const normalized = (value: unknown) => String(value || "").trim().toLowerCase();
  const scope = (item: T) => {
    const params = item.params || {};
    const country = normalized(params.query?.location?.include?.[0] || params.location || params.country);
    const industry = normalized(params.industry || params.query?.industry?.include?.[0]);
    return { country, industry };
  };
  for (const item of items) {
    if (!/compan|b2b|people/i.test(item.capabilitySlug)) {
      result.push(item);
      continue;
    }
    const current = scope(item);
    const duplicate = result.some((prior) => {
      if (prior.capabilitySlug !== item.capabilitySlug) return false;
      const old = scope(prior);
      return old.country === current.country && (!old.industry || !current.industry || old.industry === current.industry);
    });
    if (!duplicate) result.push(item);
  }
  return result;
}
