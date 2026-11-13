import { countriesOfNumber } from "./phoneValidation";

/**
 * ROUND 60: ONE PAID FETCH PER PAGE. The public contact fields of a page (its e-mails, its phone numbers, its links) are read by CODE from the page text bought ONCE, instead of buying the same
 * page again for every field (live msn_088c, 13 Nov 2026: 37 paid reads of 13 pages; the parsers `emails`, `phone-numbers`, `links` and a plain scrape each fetched the same page).
 * Nothing is invented: a value is returned only when it is written on the page (visible text, a mailto / tel link, or a Cloudflare-protected address the page itself carries). Pure.
 */

/** The parsers whose rows code can read from a page's text: the same page answers all three. */
export const PAGE_FIELD_PARSERS = ["emails", "phone-numbers", "links"] as const;
export type PageFieldParser = (typeof PAGE_FIELD_PARSERS)[number];
export const isPageFieldParser = (name: string): name is PageFieldParser => (PAGE_FIELD_PARSERS as ReadonlyArray<string>).includes(name);

/** Below this many characters of text a page was not really read (a script-only page): code does not answer for it, and the provider's own parser may still be asked once. */
export const PAGE_MIN_TEXT_CHARS = 200;

const TRACKING_PARAM = /^(?:utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|_ga|ref)$/i;

/**
 * THE PAGE A URL NAMES, for the mission's page cache: scheme ignored, host lower-case without «www.», no fragment, no tracking parameters, no trailing slash. «https://www.first-cosmetics.com/contact-details/»
 * and «http://first-cosmetics.com/contact-details» are one page. Null for an address that is not http(s).
 */
export function canonicalPageUrl(raw: unknown): string | null {
  let u: URL;
  try { u = new URL(String(raw ?? "").trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length > 0 ? `?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}` : "";
  const path = u.pathname.replace(/\/+$/, "") || "";
  const port = u.port && u.port !== "80" && u.port !== "443" ? `:${u.port}` : "";
  return `${host}${port}${path}${query}`;
}

/** The site of an address: its host lower-case without «www.» (null for anything that is not http(s)). */
export function siteOf(raw: unknown): string | null {
  const c = canonicalPageUrl(raw);
  return c ? c.split(/[/?:]/)[0] : null;
}

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
const westernDigits = (s: string): string => s.replace(ARABIC_DIGITS, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d) >= 0 ? "٠١٢٣٤٥٦٧٨٩".indexOf(d) : "۰۱۲۳۴۵۶۷۸۹".indexOf(d)));

interface MdLink { text: string; target: string; image: boolean }
/** Every markdown link of a page: «[text](target)» and «<https://…>», images marked. */
function markdownLinks(markdown: string): MdLink[] {
  const out: MdLink[] = [];
  for (const m of markdown.matchAll(/(!?)\[([^\]]{0,500})\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ image: m[1] === "!", text: m[2], target: m[3] });
  for (const m of markdown.matchAll(/<((?:https?:\/\/|mailto:|tel:)[^>\s]+)>/g)) out.push({ image: false, text: "", target: m[1] });
  return out;
}
/** The page's text with every link TARGET taken out (a product id or a tracking number in an address is not a phone; an address's path is not an e-mail). The link texts stay. */
const textWithoutTargets = (markdown: string): string => markdown.replace(/(!?\[[^\]]{0,500}\])\(\s*<?[^)\s>]+>?(?:\s+"[^"]*")?\s*\)/g, "$1").replace(/<(?:https?:\/\/|mailto:|tel:)[^>\s]+>/g, " ").replace(/https?:\/\/\S+/g, " ");

// ------------------------------------------------------------------------------------------------ e-mails
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;
const PLACEHOLDER_DOMAINS = new Set(["example.com", "example.org", "domain.com", "email.com", "yourdomain.com", "yoursite.com", "sentry.io", "wixpress.com", "sentry-next.wixpress.com", "test.com"]);
const NOT_A_TLD = /\.(?:png|jpe?g|gif|webp|svg|ico|css|js|json|bmp|tiff?|avif|mp4|webm)$/i;
const PLACEHOLDER_LOCAL = /^(?:name|email|your\.?name|yourname|user|username|someone|xxx+|test)$/i;

/** A Cloudflare-protected address («/cdn-cgi/l/email-protection#…»): the page carries it XOR-encoded; this is the page's own value, decoded. Null when it is not one. */
export function cloudflareEmailOf(target: string): string | null {
  const m = /email-protection#([0-9a-f]{4,})$/i.exec(target.trim());
  if (!m) return null;
  const hex = m[1];
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(out) ? out : null;
}

const cleanEmail = (raw: string): string | null => {
  const e = raw.trim().replace(/^mailto:/i, "").split("?")[0].replace(/[.,;:)\]]+$/, "").toLowerCase();
  let decoded = e;
  try { decoded = decodeURIComponent(e); } catch { /* keep */ }
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(decoded);
  if (!m) return null;
  const [, local, domain] = m;
  if (PLACEHOLDER_DOMAINS.has(domain) || NOT_A_TLD.test(domain) || PLACEHOLDER_LOCAL.test(local) || /@2x|@3x/i.test(decoded) || !/\.[a-z]{2,24}$/.test(domain)) return null;
  return decoded;
};

/** The e-mail addresses written on a page: mailto links, visible text, Cloudflare-protected links; lower-case, once each, in page order. A masked address («i***@x.com») is not an address. */
export function emailsFromPage(page: { markdown: string }): Array<{ email: string }> {
  const md = String(page.markdown ?? "");
  const found: string[] = [];
  for (const l of markdownLinks(md)) {
    if (/^mailto:/i.test(l.target)) { const e = cleanEmail(l.target); if (e) found.push(e); }
    const cf = cloudflareEmailOf(l.target);
    if (cf) { const e = cleanEmail(cf); if (e) found.push(e); }
  }
  for (const m of textWithoutTargets(md).matchAll(EMAIL)) { const e = cleanEmail(m[0]); if (e) found.push(e); }
  return [...new Set(found)].map((email) => ({ email }));
}

// ------------------------------------------------------------------------------------------------ phones
/** A valid Egyptian national number (without the leading 0): mobile 1x + 8 digits, Cairo/Giza 2 + 8, Alexandria 3 + 7, other areas two digits + 7. */
const EG_NATIONAL = /^(?:1[0125]\d{8}|2\d{8}|3\d{7}|(?:13|15|4[0-8]|5[05-7]|6[24-9]|8[2468]|9[2-7])\d{7})$/;

/**
 * One phone written on a page, in international form («+201003308322»), or null when it is not a number code can stand behind:
 *  - written with «+» or «00» (and «+2 0…», the Egyptian habit, is +20…): the calling code must be known; an Egyptian number must be a valid Egyptian number;
 *  - «(202)…» (the country code in brackets): an Egyptian number;
 *  - a national number (leading 0): only with the country of the request, and only for Egypt (the one numbering plan code checks); anything else is left out, never guessed.
 */
export function normalizePhone(raw: string, countryHint: string | null): string | null {
  const s = westernDigits(String(raw ?? "")).trim().replace(/[‎‏‪-‮]/g, "");
  const digits = s.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  const intl = /^\(?\s*(?:\+|00)/.test(s) || /^tel:\s*(?:\+|00)/i.test(s);
  if (intl) {
    const d = digits.startsWith("00") ? digits.slice(2) : digits;
    if (d.startsWith("20")) return EG_NATIONAL.test(d.slice(2)) ? `+${d}` : null;
    return d.length >= 8 && d.length <= 15 && countriesOfNumber(`+${d}`).length > 0 ? `+${d}` : null;
  }
  if (/^\(\s*20\d?\s*\)/.test(s) && digits.startsWith("20") && EG_NATIONAL.test(digits.slice(2))) return `+${digits}`;
  if ((countryHint ?? "").toUpperCase() === "EG" && digits.startsWith("0") && EG_NATIONAL.test(digits.slice(1))) return `+20${digits.slice(1)}`;
  return null;
}

const PHONE_CANDIDATE = /(?:\(\s*\+?\d{1,3}\s*\)|\+|00)?[\s‎‏]*\d[\d\s().\-‎‏]{6,22}\d/g;

/** The phone numbers written on a page: tel links and visible text, in international form, once each, in page order. */
export function phonesFromPage(page: { markdown: string }, countryHint: string | null): Array<{ phone: string }> {
  const md = westernDigits(String(page.markdown ?? ""));
  const found: string[] = [];
  for (const l of markdownLinks(md)) if (/^tel:/i.test(l.target)) { const p = normalizePhone(decodeURIComponentSafe(l.target.replace(/^tel:/i, "")), countryHint); if (p) found.push(p); }
  for (const line of textWithoutTargets(md).split(/\n+/)) {
    for (const m of line.matchAll(PHONE_CANDIDATE)) {
      // «(+20) 100 330 8322»: the bracket before the match belongs to it
      const before = line.slice(Math.max(0, (m.index ?? 0) - 2), m.index ?? 0);
      const candidate = /\(\s*$/.test(before) && !m[0].startsWith("(") ? `(${m[0]}` : m[0];
      const p = normalizePhone(candidate, countryHint);
      if (p) found.push(p);
    }
  }
  return [...new Set(found)].map((phone) => ({ phone }));
}
const decodeURIComponentSafe = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

// ------------------------------------------------------------------------------------------------ links
/** The links of a page as absolute addresses with their visible text, once each, in page order (no images, no mailto / tel / javascript, no in-page anchors). */
export function linksFromPage(page: { markdown: string; finalUrl: string }): Array<{ url: string; text: string | null }> {
  const out = new Map<string, string | null>();
  for (const l of markdownLinks(String(page.markdown ?? ""))) {
    if (l.image || /^(?:mailto:|tel:|javascript:|data:|#)/i.test(l.target)) continue;
    let abs: string;
    try { abs = new URL(l.target, page.finalUrl).toString(); } catch { continue; }
    if (!/^https?:/i.test(abs)) continue;
    const text = l.text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\s+/g, " ").trim() || null;
    if (!out.has(abs)) out.set(abs, text);
    else if (!out.get(abs) && text) out.set(abs, text);
  }
  return [...out].map(([url, text]) => ({ url, text }));
}

/** The rows a field parser would give for a page, read by code from its text. */
export function pageRowsFor(parser: PageFieldParser, page: { markdown: string; finalUrl: string }, countryHint: string | null): Array<Record<string, unknown>> {
  if (parser === "emails") return emailsFromPage(page);
  if (parser === "phone-numbers") return phonesFromPage(page, countryHint);
  return linksFromPage(page);
}

/** The characters of real text on a page (link targets and markdown marks left out): below PAGE_MIN_TEXT_CHARS the page was not really read. */
export const pageTextChars = (markdown: string): number => textWithoutTargets(String(markdown ?? "")).replace(/[#*_>`|\-\s[\]()!]/g, "").length;
