/**
 * The data policy of the multi-provider feature, in code.
 *
 * ALLOWED: business contact data from PUBLIC pages of a company's own website (contact, about, team): business name, work email,
 * office phone, a professional profile link, and the name and title of a decision maker when the page lists them publicly.
 * NOT ALLOWED: home addresses, family information, private accounts, anything behind a login, and any way around a protection,
 * a block or a robots rule. Every contact field carries a verification status; a row whose required fields are not verified is
 * neither delivered nor charged (see `rowPassesGate`). Pure module: no network, no server imports (robots.txt is fetched by the
 * caller and handed in as text).
 */

/** The only keys a collected row may carry. Anything else is dropped before a row leaves the chain. */
export const ALLOWED_ROW_KEYS = [
  "company_name", "website", "industry", "location", "description",
  "work_email", "work_email_verification_status",
  "phone", "phone_verification_status",
  "linkedin_url", "contact_name", "job_title",
  "source_page",
] as const;
const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_ROW_KEYS);

/** A key that names private data is refused even if a provider returned it. */
const FORBIDDEN_KEY = /home|residen|family|spouse|wife|husband|child|kids|birth|dob|ssn|national[_ ]?id|passport|personal[_ ]?(?:email|phone|mobile)|private/i;

export function sanitizeRowKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (FORBIDDEN_KEY.test(key)) continue;
    if (!ALLOWED_SET.has(key)) continue;
    out[key] = value;
  }
  return out;
}

// ---- Hosts and pages -------------------------------------------------------------------------------------------------------

/** Networks whose pages are personal or login-walled: never read as a company website. */
const SOCIAL_HOSTS = /(?:^|\.)(?:facebook|fb|instagram|linkedin|twitter|x|tiktok|youtube|snapchat|pinterest|reddit|telegram|whatsapp|threads)\.(?:com|me|net|com\.eg|app)$/i;
/** Path parts that sit behind a login or belong to an account. */
const LOGIN_PATH = /(?:^|\/)(?:log-?in|sign-?in|sign-?up|register|account|my-?account|members?|portal|dashboard|admin|wp-admin|wp-login|user|users|profile|checkout|cart|auth|sso|oauth|private|intranet|client-?area)(?:\/|$|\.|\?)/i;

function hostOf(url: string): string | null {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
}

function isIpOrLocal(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":") || host === "localhost" || !host.includes(".") || /\.(?:local|internal|localhost|test|invalid)$/.test(host);
}

/** The registrable-looking domain used to compare a company's website with its emails (no public-suffix list: the last two labels, three for a two-part country suffix). */
export function companyDomain(url: string): string | null {
  const host = hostOf(url);
  if (!host || isIpOrLocal(host)) return null;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const secondLevel = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "sch"]);
  const take = secondLevel.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? 3 : 2;
  return labels.slice(-take).join(".");
}

export interface UrlVerdict { ok: boolean; reason?: "invalid" | "not_https_or_http" | "private_host" | "social_network" | "login_page" }

/** A page may be read only if it is a public page of a company website: no login, no account, no social network, no private host. */
export function checkPublicBusinessUrl(url: string): UrlVerdict {
  let parsed: URL;
  try { parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`); } catch { return { ok: false, reason: "invalid" }; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: "not_https_or_http" };
  if (parsed.username || parsed.password) return { ok: false, reason: "login_page" };
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (isIpOrLocal(host)) return { ok: false, reason: "private_host" };
  if (SOCIAL_HOSTS.test(host)) return { ok: false, reason: "social_network" };
  if (LOGIN_PATH.test(parsed.pathname)) return { ok: false, reason: "login_page" };
  return { ok: true };
}

/** The pages worth reading for contacts: a link whose path names contact, about or team (English or Arabic), on the company's own domain. */
const CONTACT_PATH = /(?:contact|reach-?us|get-?in-?touch|about|team|leadership|management|our-?people|اتصل|تواصل|من-?نحن|عن-?نا|الفريق|الإدارة|فريق)/i;

export function pickContactPages(links: string[], baseUrl: string, max = 2): string[] {
  const base = companyDomain(baseUrl);
  if (!base) return [];
  const scored: Array<{ url: string; score: number }> = [];
  const seen = new Set<string>();
  for (const raw of links) {
    let url: URL;
    try { url = new URL(raw, baseUrl); } catch { continue; }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    url.hash = ""; url.search = "";
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    if (companyDomain(url.toString()) !== base) continue;
    if (!checkPublicBusinessUrl(key).ok) continue;
    const path = decodeURIComponent(url.pathname);
    if (!CONTACT_PATH.test(path)) continue;
    const score = /contact|اتصل|تواصل/i.test(path) ? 3 : /team|leadership|management|الفريق|الإدارة/i.test(path) ? 2 : 1;
    scored.push({ url: key, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.url.length - b.url.length).slice(0, Math.max(0, max)).map((s) => s.url);
}

/** The link targets of a Markdown text (absolute, relative, mailto and tel), for providers that return only the text. */
export function linksFromMarkdown(markdown: string): string[] {
  const out: string[] = [];
  for (const m of String(markdown || "").matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]);
  for (const m of String(markdown || "").matchAll(/<(https?:\/\/[^>\s]+|mailto:[^>\s]+|tel:[^>\s]+)>/g)) out.push(m[1]);
  return [...new Set(out)];
}

// ---- robots.txt ------------------------------------------------------------------------------------------------------------

export interface RobotsRules { groups: Array<{ agents: string[]; allow: string[]; disallow: string[] }> }

export function parseRobots(text: string): RobotsRules {
  const groups: RobotsRules["groups"] = [];
  let current: RobotsRules["groups"][number] | null = null;
  let lastWasAgent = false;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], allow: [], disallow: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (current) (field === "allow" ? current.allow : current.disallow).push(value);
    } else {
      lastWasAgent = false;
    }
  }
  return { groups };
}

function ruleMatches(rule: string, path: string): boolean {
  if (rule === "") return false;
  const pattern = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const anchored = pattern.endsWith("\\$") ? `^${pattern.slice(0, -2)}$` : `^${pattern}`;
  try { return new RegExp(anchored).test(path); } catch { return false; }
}

/** Standard longest-match rule: the most specific rule wins and an Allow beats a Disallow of the same length. The groups of `agents` apply, else the `*` group. */
export function robotsAllows(rules: RobotsRules, path: string, agents: string[] = []): boolean {
  const names = agents.map((a) => a.toLowerCase());
  const specific = rules.groups.filter((g) => g.agents.some((a) => a !== "*" && names.some((n) => n.includes(a) || a.includes(n))));
  const groups = specific.length > 0 ? specific : rules.groups.filter((g) => g.agents.includes("*"));
  let best: { len: number; allow: boolean } | null = null;
  for (const group of groups) {
    for (const rule of group.disallow) if (ruleMatches(rule, path) && (!best || rule.length > best.len)) best = { len: rule.length, allow: false };
    for (const rule of group.allow) if (ruleMatches(rule, path) && (!best || rule.length >= best.len)) best = { len: rule.length, allow: true };
  }
  return best ? best.allow : true;
}

export type RobotsFetch = (origin: string) => Promise<{ status: number; text: string } | null>;

export interface RobotsDecision { allowed: boolean; reason: "allowed" | "disallowed" | "unreadable" }

/**
 * A page is read only when its site's robots.txt allows it. A site with no robots.txt (404 or 410) allows everything; one that
 * cannot be read (a server error, a timeout) is treated as NOT allowed: the platform never guesses its way past a rule.
 */
export async function checkRobots(pageUrl: string, fetchRobots: RobotsFetch, cache: Map<string, RobotsRules | "none" | "unreadable">, agents: string[] = ["firecrawl", "contextdev", "diger"]): Promise<RobotsDecision> {
  let url: URL;
  try { url = new URL(pageUrl); } catch { return { allowed: false, reason: "unreadable" }; }
  const origin = url.origin;
  let entry = cache.get(origin);
  if (entry === undefined) {
    const res = await fetchRobots(origin).catch(() => null);
    if (!res) entry = "unreadable";
    else if (res.status === 404 || res.status === 410) entry = "none";
    else if (res.status >= 200 && res.status < 300) entry = parseRobots(res.text);
    else if (res.status >= 400 && res.status < 500) entry = "none"; // 401/403 on robots.txt: the convention treats a client error as no rules; a 5xx is unreadable
    else entry = "unreadable";
    cache.set(origin, entry);
  }
  if (entry === "unreadable") return { allowed: false, reason: "unreadable" };
  if (entry === "none") return { allowed: true, reason: "allowed" };
  return robotsAllows(entry, url.pathname + url.search, agents) ? { allowed: true, reason: "allowed" } : { allowed: false, reason: "disallowed" };
}

// ---- Contact extraction and verification -----------------------------------------------------------------------------------

export type FieldStatus = "verified" | "unverified";

export interface FoundEmail { value: string; status: FieldStatus; evidence: "mailto" | "page_text"; reason?: string }
export interface FoundPhone { value: string; status: FieldStatus; evidence: "tel_link" | "labelled_text" | "page_text"; reason?: string }

const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}/g;
/** Addresses that are placeholders, tracking or image names, never a company's contact. */
const PLACEHOLDER_DOMAINS = /(?:^|\.)(?:example\.(?:com|org|net)|domain\.com|yourdomain\.com|yoursite\.com|email\.com|test\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|godaddy\.com|schema\.org|w3\.org)$/i;
const PERSONAL_MAIL_DOMAINS = /^(?:gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|aol|proton|protonmail|gmx|mail|yandex|zoho)\.(?:com|net|me|org|ru|fr|de|co\.uk|com\.eg)$/i;
const IMAGE_LIKE = /\.(?:png|jpe?g|gif|svg|webp|ico|css|js)$/i;

export function isPlausibleEmail(email: string): boolean {
  if (email.length > 254 || IMAGE_LIKE.test(email)) return false;
  const [local, domain] = email.split("@");
  if (!local || !domain || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return !PLACEHOLDER_DOMAINS.test(domain);
}

/** The emails of a page: `mailto:` links first (strong evidence), then addresses written in the text. Deduplicated, lower-cased. */
export function extractEmails(markdown: string, links: string[], websiteDomain: string | null): FoundEmail[] {
  const found = new Map<string, FoundEmail>();
  const consider = (raw: string, evidence: FoundEmail["evidence"]) => {
    const email = raw.trim().replace(/^mailto:/i, "").split("?")[0].replace(/[),.;:]+$/, "").toLowerCase();
    if (!email.includes("@") || !isPlausibleEmail(email)) return;
    const domain = email.split("@")[1];
    let status: FieldStatus = "verified";
    let reason: string | undefined;
    if (PERSONAL_MAIL_DOMAINS.test(domain)) { status = "unverified"; reason = "personal_domain"; }
    else if (!websiteDomain || !(domain === websiteDomain || domain.endsWith(`.${websiteDomain}`))) { status = "unverified"; reason = "domain_differs_from_website"; }
    const existing = found.get(email);
    if (!existing || (existing.evidence === "page_text" && evidence === "mailto")) found.set(email, { value: email, status, evidence, ...(reason ? { reason } : {}) });
  };
  for (const link of links || []) if (/^mailto:/i.test(link)) consider(link, "mailto");
  for (const m of String(markdown || "").matchAll(/mailto:([^)\s"'>]+)/gi)) consider(m[1], "mailto");
  for (const m of String(markdown || "").matchAll(EMAIL_RE)) consider(m[0], "page_text");
  return [...found.values()];
}

const PHONE_LABEL = /(?:tel|phone|call|mobile|هاتف|تليفون|تلفون|جوال|موبايل|اتصل|للتواصل|رقم)[^\d+]{0,12}$/i;
const PHONE_RE = /(?:\+|00)?\d[\d\s().-]{6,18}\d/g;

/** Digits only, with a leading + kept; null when the length is not that of a phone number (7 to 15 digits). */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const plus = /^(?:\+|00)/.test(trimmed);
  const digits = trimmed.replace(/^(?:\+|00)/, "").replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (/^(\d)\1+$/.test(digits)) return null;
  return plus ? `+${digits}` : digits;
}

/** The phones of a page: `tel:` links and numbers written after a label (verified), other number-like text (unverified). Years and ids are not phones. */
export function extractPhones(markdown: string, links: string[]): FoundPhone[] {
  const found = new Map<string, FoundPhone>();
  const add = (raw: string, evidence: FoundPhone["evidence"], status: FieldStatus, reason?: string) => {
    const value = normalizePhone(raw);
    if (!value) return;
    const prior = found.get(value);
    const rank = (e: FoundPhone["evidence"]) => (e === "tel_link" ? 3 : e === "labelled_text" ? 2 : 1);
    if (!prior || rank(evidence) > rank(prior.evidence)) found.set(value, { value, status, evidence, ...(reason ? { reason } : {}) });
  };
  for (const link of links || []) if (/^tel:/i.test(link)) add(decodeURIComponent(link.replace(/^tel:/i, "")), "tel_link", "verified");
  for (const m of String(markdown || "").matchAll(/\(tel:([^)\s]+)\)/gi)) add(decodeURIComponent(m[1]), "tel_link", "verified");
  const text = String(markdown || "");
  for (const m of text.matchAll(PHONE_RE)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0);
    const raw = m[0];
    if (/^\d{4}$/.test(raw.replace(/\D/g, ""))) continue;
    if (PHONE_LABEL.test(before) || /^(?:\+|00)/.test(raw.trim())) add(raw, "labelled_text", "verified");
    else add(raw, "page_text", "unverified", "no_label");
  }
  return [...found.values()];
}

/** A professional profile link listed on the company's own page: a company or person page on LinkedIn. Never a private account. */
export function extractProfileLink(markdown: string, links: string[]): string | null {
  const all = [...(links || []), ...[...String(markdown || "").matchAll(/https?:\/\/[^\s)"'<>]+/g)].map((m) => m[0])];
  for (const raw of all) {
    const m = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(company|in)\/([A-Za-z0-9%_.-]{2,100})\/?/i.exec(raw.replace(/[),.;]+$/, ""));
    if (m) return `https://www.linkedin.com/${m[1].toLowerCase()}/${m[2]}`;
  }
  return null;
}

/** Titles that count as a decision maker (English and Arabic). */
const DECISION_TITLE = /\b(?:ceo|chief executive|founder|co-?founder|owner|managing director|general manager|\bmd\b|president|chairman|cfo|coo|cto|director|partner)\b|(?:المدير (?:العام|التنفيذي)|مدير عام|رئيس مجلس|مؤسس|مالك|الرئيس التنفيذي|الشريك|مدير)/i;

export interface DecisionMaker { name: string; title: string }

/** Names and titles a team page lists publicly, as returned by a structured read. Only the name and the title are kept. */
export function parseDecisionMakers(json: unknown, max = 3): DecisionMaker[] {
  const out: DecisionMaker[] = [];
  const list = Array.isArray((json as any)?.people) ? (json as any).people : Array.isArray((json as any)?.team) ? (json as any).team : Array.isArray(json) ? (json as any) : [];
  for (const entry of list) {
    const name = typeof entry?.name === "string" ? entry.name.trim().replace(/\s+/g, " ") : "";
    const title = typeof entry?.title === "string" ? entry.title.trim().replace(/\s+/g, " ") : "";
    if (name.length < 3 || name.length > 80 || /[@\d]/.test(name) || !title || title.length > 80 || !DECISION_TITLE.test(title)) continue;
    out.push({ name, title });
    if (out.length >= max) break;
  }
  return out;
}

// ---- Rows ------------------------------------------------------------------------------------------------------------------

/** Arabic statuses of the existing contact columns. */
export const STATUS_VERIFIED_AR = "متحقق";
export const STATUS_UNVERIFIED_AR = "لم يتم التحقق";
export const STATUS_UNAVAILABLE_AR = "غير متاح";

export interface EnrichmentFacts {
  companyName: string;
  website: string;
  industry?: string;
  location?: string;
  description?: string;
  emails: FoundEmail[];
  phones: FoundPhone[];
  profileLink?: string | null;
  decisionMakers?: DecisionMaker[];
  sourcePage?: string;
}

/** A customer row: the best verified value of each contact field, its status in Arabic, and nothing outside the allowed keys. */
export function buildContactRow(facts: EnrichmentFacts): Record<string, unknown> {
  const email = facts.emails.find((e) => e.status === "verified") ?? facts.emails[0] ?? null;
  const phone = facts.phones.find((p) => p.status === "verified") ?? facts.phones[0] ?? null;
  const dm = facts.decisionMakers?.[0] ?? null;
  return sanitizeRowKeys({
    company_name: facts.companyName,
    website: facts.website,
    industry: facts.industry,
    location: facts.location,
    description: facts.description,
    work_email: email?.value,
    work_email_verification_status: email ? (email.status === "verified" ? STATUS_VERIFIED_AR : STATUS_UNVERIFIED_AR) : STATUS_UNAVAILABLE_AR,
    phone: phone?.value,
    phone_verification_status: phone ? (phone.status === "verified" ? STATUS_VERIFIED_AR : STATUS_UNVERIFIED_AR) : STATUS_UNAVAILABLE_AR,
    linkedin_url: facts.profileLink || undefined,
    contact_name: dm?.name,
    job_title: dm?.title,
    source_page: facts.sourcePage,
  });
}

/**
 * The delivery gate: a row counts (and is charged) only when EVERY required contact field is present and verified. An unverified
 * row is not delivered and not charged. With nothing required, a row needs a verified email or phone, so a row with no contact
 * at all is never a delivered unit of a contact job.
 */
export function rowPassesGate(row: Record<string, any>, requiredFields: string[]): boolean {
  const emailOk = Boolean(row?.work_email) && row?.work_email_verification_status === STATUS_VERIFIED_AR;
  const phoneOk = Boolean(row?.phone) && row?.phone_verification_status === STATUS_VERIFIED_AR;
  const required = requiredFields.filter((f) => f === "work_email" || f === "office_phone");
  if (required.length === 0) return emailOk || phoneOk;
  return required.every((f) => (f === "work_email" ? emailOk : phoneOk));
}
