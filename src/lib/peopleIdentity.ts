/**
 * The identity sent to the work-email and office-phone lookups, and the check that an answer is about the person that was asked for.
 *
 * The lookups' contract: send everything known about the person; each provider receives only the variants it accepts
 * (`{linkedin_url}`, `{domain, full_name}`, `{domain, first_name, last_name}`). A WRONG domain is worse than none: a link-in-bio page or a social
 * network is not the person's company, so it is never sent as the company domain.
 */

/** Hosts that are never a company's own domain: link-in-bio pages, social networks, messengers and link shorteners (a host and its subdomains). */
export const NON_COMPANY_HOSTS: readonly string[] = [
  "linktr.ee", "linkedin.com", "lnkd.in", "facebook.com", "fb.com", "fb.me", "instagram.com", "x.com", "twitter.com", "t.co", "wa.me", "whatsapp.com",
  "t.me", "telegram.me", "youtube.com", "youtu.be", "tiktok.com", "snapchat.com", "pinterest.com", "bit.ly", "tinyurl.com", "linkin.bio", "beacons.ai",
  "carrd.co", "bio.link", "lnk.bio", "taplink.cc", "campsite.bio", "linkpop.com", "about.me", "behance.net", "dribbble.com", "github.com",
  "medium.com", "wixsite.com", "wordpress.com", "blogspot.com", "google.com", "goo.gl", "forms.gle", "calendly.com", "notion.site",
];

const stripAccents = (value: string): string => value.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** The host of a website, lower-case, without scheme, `www.`, path or port; empty when the value is not a host. */
export function websiteHost(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].split("@").pop()!.split(":")[0].toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : "";
}

/** True for a host in the list or a subdomain of one («in.linkedin.com», «shop.linktr.ee»). */
export function isNonCompanyHost(host: string): boolean {
  return NON_COMPANY_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

/** The company domain a website gives, or empty: nothing for a link-in-bio page, a social network or an empty value. */
export function companyDomainFromWebsite(value: unknown): string {
  const host = websiteHost(value);
  return host && !isNonCompanyHost(host) ? host : "";
}

/** «Mohamed Ali Shoukry» → first «Mohamed», last «Ali Shoukry» (the rest of the name); one word gives a first name only. */
export function splitFullName(fullName: unknown): { first: string; last: string } {
  const parts = (typeof fullName === "string" ? fullName : "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export interface PeopleRowFields {
  linkedin_url?: unknown; linkedinUrl?: unknown; profile_url?: unknown;
  domain?: unknown; company_domain?: unknown; website?: unknown;
  contact_name?: unknown; full_name?: unknown; fullName?: unknown; name?: unknown;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const firstText = (...values: unknown[]): string => values.map(text).find(Boolean) || "";

/**
 * Everything known about the person: the profile link, the company domain (only a real one), the full name and its first and last parts.
 * Null when there is neither a profile link nor a company domain with a name (nothing a provider could match on).
 */
export function buildPeopleIdentity(row: PeopleRowFields): Record<string, string> | null {
  const identity: Record<string, string> = {};
  const linkedin = firstText(row.linkedin_url, row.linkedinUrl, row.profile_url);
  const domain = companyDomainFromWebsite(firstText(row.domain, row.company_domain)) || companyDomainFromWebsite(row.website);
  const name = firstText(row.contact_name, row.full_name, row.fullName, row.name);
  if (!linkedin && !(domain && name)) return null;
  if (linkedin) identity.linkedin_url = linkedin;
  if (domain) identity.domain = domain;
  if (name) {
    identity.full_name = name;
    const { first, last } = splitFullName(name);
    if (first) identity.first_name = first;
    if (last) identity.last_name = last;
  }
  return identity;
}

/** How good an identity is for the lookups: a profile link and a real company domain together are best; null is worst. */
export function identityScore(identity: Record<string, string> | null): number {
  if (!identity) return -1;
  return (identity.linkedin_url ? 2 : 0) + (identity.domain ? 1 : 0);
}

/** A name for comparison: lower-case letters only (accents, hyphens, spaces and punctuation removed). */
const nameKey = (value: unknown): string => stripAccents(String(value ?? "")).toLowerCase().replace(/[^\p{L}]/gu, "");

/**
 * Whether an answer is about the requested person. The answer's own first and last name (or its full name) must match the requested ones,
 * accents, case, hyphens and spaces ignored. An answer that carries no name cannot be compared and is accepted.
 */
export function returnedPersonMatches(requestedFullName: unknown, returned: { first?: unknown; last?: unknown; full?: unknown }): boolean {
  const asked = splitFullName(requestedFullName);
  const askedFirst = nameKey(asked.first);
  const askedLast = nameKey(asked.last);
  const askedFull = nameKey(requestedFullName);
  const first = nameKey(returned.first);
  const last = nameKey(returned.last);
  const full = nameKey(returned.full);
  if (!first && !last && !full) return true;
  if (first || last) {
    if (first && askedFirst && first !== askedFirst) return false;
    if (last && askedLast && last !== askedLast) return false;
    if (first && last && !askedFirst && !askedLast) return `${first}${last}` === askedFull;
    return true;
  }
  return !askedFull || full === askedFull || full === `${askedLast}${askedFirst}`;
}

/** Mailbox providers whose addresses belong to a person, not to a company: such an address is never a work email. */
export const PERSONAL_EMAIL_DOMAINS: readonly string[] = [
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com",
  "me.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com", "yandex.com", "yandex.ru", "mail.ru",
];

/** Regional variants of the big providers: «yahoo.co.uk», «hotmail.fr», «outlook.sa», «live.com.au», «gmx.de», «yandex.by». */
const PERSONAL_EMAIL_FAMILY = /^(yahoo|hotmail|outlook|live|gmx|yandex)\.(?:[a-z]{2,3}|(?:co|com)\.[a-z]{2})$/;

/** The domain of an email address, lower-case; empty when the value is not an address. */
export function emailDomain(value: unknown): string {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  const at = text.lastIndexOf("@");
  const domain = at > 0 ? text.slice(at + 1) : "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : "";
}

/** True for an address on a personal mailbox domain (the listed ones and the regional variants of the big providers). */
export function isPersonalEmail(value: unknown): boolean {
  const domain = emailDomain(value);
  return Boolean(domain) && (PERSONAL_EMAIL_DOMAINS.includes(domain) || PERSONAL_EMAIL_FAMILY.test(domain));
}
