/**
 * What the people search needs before it is sent. `treg.people.search` is an IDENTITY lookup: it matches each provider on the variants
 * it accepts ({q} | {company_domain} | {company_domain, title} | {title} | {full_name}). Country, location, keywords and limit are FILTERS
 * only: a body made of filters alone has no identity key, no provider can take it, and the source answers 422 (live failure of
 * 2026-10-25: params {country, keywords, limit}, answered in 360 ms, nothing delivered). Pure module: no server imports.
 */

/** The title searched when the customer asked for «صناع القرار» without naming a role. Shown on the plan card (as «الرئيس التنفيذي») and editable before approval. */
export const DEFAULT_DECISION_MAKER_TITLE = "CEO";

const IDENTITY_KEYS = ["q", "company_domain", "domain", "title", "full_name"] as const;

const hasText = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasText);
  return typeof value === "string" && value.trim().length > 0;
};

/** True when the params carry at least one key the source can identify a person search by. */
export function hasPeopleIdentityKey(params: Record<string, any> | null | undefined): boolean {
  const p = params || {};
  return IDENTITY_KEYS.some((key) => hasText(p[key]));
}

/** The same params, with the default title added when no identity key is present. Never changes a key that is already there. */
export function withPeopleIdentity<T extends Record<string, any>>(params: T): T & { title?: string } {
  if (hasPeopleIdentityKey(params)) return params;
  return { ...params, title: DEFAULT_DECISION_MAKER_TITLE };
}
