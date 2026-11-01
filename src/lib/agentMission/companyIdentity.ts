import { normalizeText } from "./relevance";

/**
 * WHO A PERSON WORKS FOR, CONFIRMED BY CODE (live test A1, 2026-11-01). The company «falcon misr» (falconmisr.com) carried the company page link https://linkedin.com/company/mycompany, a placeholder some data source filled in. The people source answered for a company that
 * is literally named «mycompany» (a person in the US with a phone marked «موثّق», one in Italy) and both were delivered and charged under «falcon misr». Owner direction (benchmark step 2, 10 of 10 people confirmed at the right company):
 *   1. a placeholder or generic company page link (or website) is NEVER the key people are asked for: the company is asked through its other fields (website, name) where the source takes them, or has no people from that source;
 *   2. a person is delivered under a company only when one of the experiences the source gives for them is CURRENT (job_is_current true, or no end date) AND names the company (its domain, or its name). A person who does not match is not delivered, not counted and not charged;
 *      the company gets the next people who match. A person the source gives NO experience for cannot be judged and is not rejected (the rule needs evidence to contradict).
 * Pure: values in, a verdict out. No provider, no model.
 */

// ------------------------------------------------------------------------------------------------ placeholders
/** Page names that mean «a company» and not a company: what a form, a template or a lazy data source puts where a real page should be (compared after removing every character that is not a letter or a digit). */
const PLACEHOLDER_SLUGS: ReadonlySet<string> = new Set([
  "mycompany", "yourcompany", "ourcompany", "thecompany", "company", "companyname", "yourcompanyname", "mycompanyname", "companyinc", "companypage", "companyprofile", "yourbusiness", "mybusiness", "business", "organization", "organisation", "yourorganization",
  "example", "examplecompany", "examplecom", "sample", "samplecompany", "demo", "democompany", "test", "testcompany", "testing", "unknown", "unavailable", "notavailable", "na", "none", "null", "undefined", "nil", "tbd", "tba", "xxx", "xxxx", "abc", "abcd", "abcdef", "abccompany", "acme", "acmeinc",
  "linkedin", "linkedincompany", "private", "privatecompany", "stealth", "stealthstartup", "stealthmode", "selfemployed", "freelance", "freelancer", "confidential", "hidden", "redacted", "signup", "login", "company123", "yourcompany123",
]);
/** Hosts that stand in for «a website» (documentation and template hosts, a placeholder written as a domain). */
const PLACEHOLDER_HOSTS: ReadonlySet<string> = new Set(["example.com", "example.org", "example.net", "example.eg", "test.com", "domain.com", "yourdomain.com", "yourcompany.com", "mycompany.com", "company.com", "companyname.com", "website.com", "yourwebsite.com", "site.com", "localhost", "n/a", "na.com", "none.com", "null.com", "undefined.com"]);

const compact = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const hostOf = (value: string): string => value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] ?? "";
const LINKEDIN_COMPANY = /^(?:[a-z0-9-]+\.)?linkedin\.[a-z.]+\/(?:company|school|showcase)(?:\/([^/?#]*))?/i;

/**
 * True when a company page link or website is a placeholder or too generic to stand for ONE company: a LinkedIn company page with no name or a placeholder name (`/company/mycompany`, `/company/company-name`, `/company/example`), the bare LinkedIn host, a website that is
 * a template host (example.com, yourcompany.com). A real page name that merely looks short is NOT a placeholder.
 */
export function isPlaceholderCompanyUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  const lowered = text.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "");
  const isLinkedIn = /^(?:[a-z0-9-]+\.)?linkedin\.[a-z.]+(?:[/?#]|$)/i.test(lowered);
  if (isLinkedIn) {
    const m = LINKEDIN_COMPANY.exec(lowered);
    if (!m) return /^(?:[a-z0-9-]+\.)?linkedin\.[a-z.]+\/?$/i.test(lowered.split(/[?#]/)[0]); // the bare host is no company
    const slug = decodeURIComponent((m[1] ?? "").trim());
    if (!slug) return true;
    const c = compact(slug);
    if (PLACEHOLDER_SLUGS.has(c)) return true;
    // «my-company-2», «your_company», «company-name-here»: a placeholder word with a counter or a filler word
    return /^(?:my|your|our|the)?(?:company|business|organi[sz]ation|firm|startup)(?:name|page|profile|here|inc|llc|ltd|co)?\d*$/.test(c) || /^(?:example|sample|test|demo)(?:company|inc|llc|ltd|co|corp)?\d*$/.test(c);
  }
  if (!/[./]/.test(text)) return false;
  const host = hostOf(text);
  return PLACEHOLDER_HOSTS.has(host);
}

// ------------------------------------------------------------------------------------------------ domains and names
const SECOND_LEVEL: ReadonlySet<string> = new Set(["com", "co", "org", "net", "gov", "edu", "ac", "mil", "sch", "ltd", "plc", "gouv"]);
/** The registrable domain of an address or a bare domain («mail.falconmisr.com» and «www.falconmisr.com» are «falconmisr.com»; «x.com.eg» keeps three labels). Null when the text holds no domain. */
export function registrableDomain(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim().toLowerCase().replace(/^mailto:/, "");
  if (!raw) return null;
  const afterAt = raw.includes("@") ? raw.slice(raw.lastIndexOf("@") + 1) : raw;
  const host = hostOf(afterAt).replace(/\.$/, "").replace(/:\d+$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  return tld.length === 2 && SECOND_LEVEL.has(second) ? labels.slice(-3).join(".") : labels.slice(-2).join(".");
}

/** Words that only say «a company» («Co», «Ltd», «Group», «شركة»): they never tell two companies apart. «Egypt» and «Misr» are kept: they are part of what a name is. */
const LEGAL_WORDS: ReadonlySet<string> = new Set(["co", "company", "companies", "ltd", "llc", "inc", "corp", "corporation", "limited", "plc", "group", "holding", "holdings", "the", "and", "for", "of", "sae", "gmbh", "llp", "sa", "ag", "bv", "est", "شركه", "مجموعه", "الشركه", "للتجاره", "والتوريدات"]);
const tokensOf = (name: string): string[] => normalizeText(String(name ?? "")).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 0 && !LEGAL_WORDS.has(t));

/** Do two company names name the same company? Their meaningful words are the same set or one contains the other, or the compact form of one contains the other's (a domain label «falconmisr» against «Falcon Misr Co»). */
export function sameCompanyName(a: string, b: string): boolean {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const sa = new Set(ta);
  const sb = new Set(tb);
  if (ta.every((t) => sb.has(t)) || tb.every((t) => sa.has(t))) return true;
  const ca = ta.join("");
  const cb = tb.join("");
  const shorter = ca.length <= cb.length ? ca : cb;
  const longer = ca.length <= cb.length ? cb : ca;
  return shorter.length >= 5 && longer.includes(shorter);
}

// ------------------------------------------------------------------------------------------------ the company of a row
export interface CompanyIdentity {
  /** The company's names (the row's name cells). */
  names: string[];
  /** Its website's registrable domain (never a LinkedIn address, never a placeholder). */
  domain: string | null;
}

const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").replace(/[​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();

/** What a company row tells about who the company is: its name and its website, from the values (the planner's key names are only a hint). */
export function companyIdentityOf(row: Record<string, unknown> | null | undefined, nameKeys: ReadonlyArray<string> = []): CompanyIdentity {
  const names: string[] = [];
  let domain: string | null = null;
  if (!row) return { names, domain };
  for (const [k, v] of Object.entries(row)) {
    const t = text(v);
    if (!t) continue;
    if (nameKeys.includes(k) || /^(company|company_name|name|title|organization|organisation)$/i.test(k)) { if (!/^https?:\/\//i.test(t) && !isPlaceholderCompanyUrl(t) && !names.includes(t)) names.push(t); continue; }
    if (domain === null && /(website|domain|site|homepage|url)/i.test(k) && !/linkedin/i.test(t) && !isPlaceholderCompanyUrl(t)) domain = registrableDomain(t);
  }
  return { names, domain };
}

// ------------------------------------------------------------------------------------------------ experiences
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const EXPERIENCE_KEYS = ["experiences", "experience", "positions", "work_experience", "jobs"] as const;

export type PersonCompanyVerdict = "match" | "mismatch" | "unknown";
const NAME_KEYS = ["company_name", "companyName", "company", "organization", "organisation", "employer", "name"] as const;
const DOMAIN_KEYS = ["company_domain", "companyDomain", "domain", "company_website", "website", "company_url"] as const;
const pick = (o: Obj, keys: ReadonlyArray<string>): string => { for (const k of keys) { const v = text(o[k]); if (v) return v; } return ""; };

/** Is this experience a current one? `job_is_current` says so when it is a boolean; else an end date that is empty or «present» does; an experience with neither is not contradicted (counted as current). */
function isCurrentExperience(e: Obj): boolean {
  for (const k of ["job_is_current", "is_current", "current", "isCurrent"]) { const v = e[k]; if (typeof v === "boolean") return v; if (typeof v === "string" && /^(true|false)$/i.test(v)) return v.toLowerCase() === "true"; }
  for (const k of ["job_end_date", "end_date", "endDate", "ended_at", "to"]) {
    if (!(k in e)) continue;
    const v = e[k];
    if (v === null || v === undefined) return true;
    const t = text(v).toLowerCase();
    return t === "" || t === "present" || t === "current" || t === "now";
  }
  return true;
}

/**
 * Is the person at this company now? `match`: a current experience names the company (its domain, or its name). `mismatch`: the person has experiences, none of the current ones names the company (or none is current). `unknown`: the source gave no usable
 * experience (or the company has no name and no domain to compare), so nothing contradicts the source's own answer.
 */
export function personAtCompany(experiences: ReadonlyArray<unknown>, company: CompanyIdentity): PersonCompanyVerdict {
  const exps = experiences.filter(isObj);
  if (exps.length === 0) return "unknown";
  if (company.names.length === 0 && !company.domain) return "unknown";
  const current = exps.filter(isCurrentExperience);
  if (current.length === 0) return "mismatch";
  let judged = false;
  for (const e of current) {
    const name = pick(e, NAME_KEYS);
    const domain = registrableDomain(pick(e, DOMAIN_KEYS));
    if (name || domain) judged = true;
    if (domain && company.domain && domain === company.domain) return "match";
    if (name && company.names.some((n) => sameCompanyName(n, name))) return "match";
    // a company domain label inside the experience's company name («falconmisr» in «Falcon Misr Co»)
    if (name && company.domain) { const label = company.domain.split(".")[0]; if (label.length >= 5 && compact(name).includes(label.replace(/[^a-z0-9]/g, ""))) return "match"; }
  }
  return judged ? "mismatch" : "unknown";
}

// ------------------------------------------------------------------------------------------------ the raw page
const LINKEDIN_PERSON = /linkedin\.[a-z.]+\/in\/([^\s/?#]+)/i;
const personUrlKey = (v: unknown): string | null => { const m = LINKEDIN_PERSON.exec(text(v)); return m ? decodeURIComponent(m[1]).toLowerCase() : null; };
const nameKey = (v: string): string => normalizeText(v).replace(/[^\p{L}\p{N}]/gu, "");

export interface PeopleEvidence {
  /** The experiences the source gave for a person, found by their professional page or by their name. */
  of(row: Record<string, unknown>, nameKeys: ReadonlyArray<string>): ReadonlyArray<unknown> | null;
  /** True when the page carried at least one person with experiences. */
  any: boolean;
}

/** Reads a people source's raw answer: every object that carries an experiences list (a result's `person`, or the result itself) is indexed by the person's professional page and by their name. */
export function peopleEvidenceOf(page: unknown): PeopleEvidence {
  const byUrl = new Map<string, ReadonlyArray<unknown>>();
  const byName = new Map<string, ReadonlyArray<unknown>>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > 7 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const x of node.slice(0, 500)) walk(x, depth + 1); return; }
    const o = node as Obj;
    const key = EXPERIENCE_KEYS.find((k) => Array.isArray(o[k]));
    if (key) {
      const list = o[key] as unknown[];
      let url: string | null = null;
      for (const v of Object.values(o)) { url = personUrlKey(v); if (url) break; }
      if (url) byUrl.set(url, list);
      const full = text(o.full_name) || text(o.name) || [text(o.first_name), text(o.last_name)].filter(Boolean).join(" ");
      if (full) byName.set(nameKey(full), list);
    }
    for (const v of Object.values(o)) if (typeof v === "object") walk(v, depth + 1);
  };
  walk(page, 0);
  return {
    any: byUrl.size > 0 || byName.size > 0,
    of: (row, nameKeys) => {
      for (const v of Object.values(row)) { const u = personUrlKey(v); if (u && byUrl.has(u)) return byUrl.get(u)!; }
      const full = nameKeys.map((k) => text(row[k])).filter(Boolean).join(" ").trim();
      return full && byName.has(nameKey(full)) ? byName.get(nameKey(full))! : null;
    },
  };
}
