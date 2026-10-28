/**
 * THE ORDER OF REVERSE LOOKUPS, from live evidence (one place, used by the admin «بحث عكسي» and by the planner's candidate list for a verified business, so the two can never disagree).
 *
 * E-mail → person: the order below, each tried only after the one before it gave nothing useful.
 *   - fiber-ai.people.identity.resolve answered with a name and a country at 0 USD (a miss is free), so it goes first.
 *   - treg.people.identity.resolve is a routed waterfall that bills every provider it tries: it is always called with `X-Treg-Route-Waterfall: 0` (one provider, one price).
 *   - branddev.brand.retrieve-by-email refuses outlook/gmail-type mailboxes (it answers about a COMPANY), so it is tried ONLY for a company domain.
 * Phone → person (sixtyfour.people.phone.reverse is left out: it needs a structured «lead» object, not a number): only the endpoints that cost nothing run by default. Any paid phone endpoint runs only after the admin confirmed its price, with a warning when its coverage of the number's
 * country is unproven. enrichlayer.contacts.reverse-phone is for US numbers: it is never offered automatically outside the US.
 */
export const EMAIL_REVERSE_ORDER: readonly string[] = [
  "fiber-ai.people.identity.resolve",
  "blitzapi.people.email.reverse",
  "quickenrich.people.enrich",
  "aiark.people.enrich",
  "findymail.search.reverse-email",
  "treg.people.identity.resolve",
  "branddev.brand.retrieve-by-email",
  "companyenrich.people.lookup",
];

/** Phone endpoints in the order they are offered: the free one first, then the paid ones (each needs a confirmed price). */
export const PHONE_REVERSE_ORDER: readonly string[] = [
  "getleadsio.people.phone.lookup",
  "blitzapi.people.phone.reverse",
  "enrichlayer.contacts.reverse-phone",
];

/** The endpoints that carry the header `X-Treg-Route-Waterfall: 0` (a routed waterfall: without it every provider tried is billed). */
export const NO_WATERFALL_ENDPOINTS: readonly string[] = ["treg.people.identity.resolve"];
export const NO_WATERFALL_HEADER = "X-Treg-Route-Waterfall";

/** Endpoints that answer about the COMPANY of an e-mail's domain: a mailbox at a public provider has no company to find. */
export const COMPANY_DOMAIN_ONLY_ENDPOINTS: readonly string[] = ["branddev.brand.retrieve-by-email"];

/** Phone endpoints for numbers of one country only, whatever the catalog's own text says (never automatic elsewhere). */
export const US_ONLY_PHONE_ENDPOINTS: readonly string[] = ["enrichlayer.contacts.reverse-phone"];

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
