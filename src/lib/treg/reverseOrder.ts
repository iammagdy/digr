import providerMetadata from "../../../data/capabilities/provider-metadata.json";
import { PROVIDER_TREG } from "../multiProvider/types";

export interface ReverseLookupMetadata {
  emailOrder: readonly string[];
  phoneOrder: readonly string[];
  noWaterfall: readonly string[];
  companyDomainOnly: readonly string[];
  usOnlyPhone: readonly string[];
}

function readNonEmptyStringArray(obj: Record<string, unknown>, key: string): readonly string[] {
  const val = obj[key];
  if (!Array.isArray(val) || val.length === 0 || val.some((x) => typeof x !== "string" || x.length === 0)) {
    throw new Error(`provider-metadata.json: missing or empty treg.reverseLookup.${key}`);
  }
  return val;
}

/** Validates and extracts reverse-lookup order lists from provider metadata; throws a clear error naming the missing key. */
export function readReverseLookupConfig(meta: unknown): ReverseLookupMetadata {
  const treg = (meta as { treg?: { reverseLookup?: unknown } } | null | undefined)?.treg;
  const raw = treg?.reverseLookup;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`provider-metadata.json: missing ${PROVIDER_TREG}.reverseLookup`);
  }
  const obj = raw as Record<string, unknown>;
  return {
    emailOrder: readNonEmptyStringArray(obj, "emailOrder"),
    phoneOrder: readNonEmptyStringArray(obj, "phoneOrder"),
    noWaterfall: readNonEmptyStringArray(obj, "noWaterfall"),
    companyDomainOnly: readNonEmptyStringArray(obj, "companyDomainOnly"),
    usOnlyPhone: readNonEmptyStringArray(obj, "usOnlyPhone"),
  };
}

const REVERSE_CONFIG = readReverseLookupConfig(providerMetadata);

/**
 * THE ORDER OF REVERSE LOOKUPS, from live evidence (one place, used by the admin «بحث عكسي» and by the planner's candidate list for a verified business, so the two can never disagree).
 * Lists come from `data/capabilities/provider-metadata.json` (`treg.reverseLookup`) so code holds no hardcoded endpoint lists.
 */
export const EMAIL_REVERSE_ORDER: readonly string[] = REVERSE_CONFIG.emailOrder;

/** Phone endpoints in the order they are offered: the free one first, then the paid ones (each needs a confirmed price). */
export const PHONE_REVERSE_ORDER: readonly string[] = REVERSE_CONFIG.phoneOrder;

/** The endpoints that carry the header `X-Treg-Route-Waterfall: 0` (a routed waterfall: without it every provider tried is billed). */
export const NO_WATERFALL_ENDPOINTS: readonly string[] = REVERSE_CONFIG.noWaterfall;
export const NO_WATERFALL_HEADER = "X-Treg-Route-Waterfall";

/** Endpoints that answer about the COMPANY of an e-mail's domain: a mailbox at a public provider has no company to find. */
export const COMPANY_DOMAIN_ONLY_ENDPOINTS: readonly string[] = REVERSE_CONFIG.companyDomainOnly;

/** Phone endpoints for numbers of one country only, whatever the catalog's own text says (never automatic elsewhere). */
export const US_ONLY_PHONE_ENDPOINTS: readonly string[] = REVERSE_CONFIG.usOnlyPhone;

const PUBLIC_MAILBOX_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.net", "mail.com", "yandex.com", "yandex.ru", "zoho.com", "qq.com", "163.com", "126.com", "rediffmail.com", "inbox.com", "fastmail.com", "tutanota.com", "hotmail.co.uk", "outlook.sa", "live.co.uk",
]);

export const emailDomain = (email: string): string => String(email ?? "").trim().toLowerCase().split("@")[1] ?? "";

/** True when the address is at a company's own domain (not a public mailbox such as outlook.com or gmail.com, whatever its country suffix). */
export function isCompanyDomainEmail(email: string): boolean {
  const domain = emailDomain(email);
  if (!domain || !domain.includes(".")) return false;
  if (PUBLIC_MAILBOX_DOMAINS.has(domain)) return false;
  return !/^(?:gmail|outlook|hotmail|live|yahoo|icloud|msn|aol|proton(?:mail)?)\.[a-z.]+$/.test(domain);
}

export const reverseOrderIndex = (id: string): number => {
  const e = EMAIL_REVERSE_ORDER.indexOf(id);
  if (e >= 0) return e;
  const p = PHONE_REVERSE_ORDER.indexOf(id);
  return p >= 0 ? 100 + p : -1;
};

/**
 * Puts the members of the reverse-lookup lists in their evidence order, in the places the same members already hold: every other id keeps its place. (Cost order first, then this: the
 * evidence order replaces cost order only among the endpoints it names.)
 */
export function applyReverseOrder<T>(items: ReadonlyArray<T>, idOf: (item: T) => string): T[] {
  const slots: number[] = [];
  const members: T[] = [];
  items.forEach((item, i) => { if (reverseOrderIndex(idOf(item)) >= 0) { slots.push(i); members.push(item); } });
  if (members.length < 2) return [...items];
  members.sort((a, b) => reverseOrderIndex(idOf(a)) - reverseOrderIndex(idOf(b)));
  const out = [...items];
  slots.forEach((slot, k) => { out[slot] = members[k]; });
  return out;
}
