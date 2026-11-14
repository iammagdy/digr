import { createHash } from "node:crypto";
import { extractBrandTokens, normalizeArabicText } from "../server/negativeListEngine";
import { registrableDomain } from "./companyIdentity";
import { isPersonalMailDomain } from "../multiProvider/policy";

/**
 * PHASE 5.3 (docs/intelligence/PHASE-5-3-AND-6.md): THE CUSTOMER'S EXCLUSION FILE REACHES THE MISSION.
 *
 * The chat route parses the uploaded spreadsheet on the server (exclusionFileParser.ts: company name, corporate domain, registration number; never a person's contact) and keeps it in the conversation brief. Until now the agent
 * worker never saw it. With the server switch below ON for the account:
 *   1. the chat stores a SNAPSHOT of the parsed list on the assistant message that carries the new mission's card (`messages.plan.customerExclusion`, written by the server only: customers cannot insert an assistant message
 *      with a plan, and have no update policy);
 *   2. the worker reads it at planning (same user, same mission id), copies it to the mission's private folder, and records its digest on the plan the customer approves;
 *   3. at execution the item check (agent/src/items/ingest.ts) refuses every row of a company or people stage that the matcher below CONFIRMS is in the list. The check runs on every row that enters the item store (every page,
 *      retried page, fallback source and model save), so nothing can bring an excluded company back.
 *
 * OFF (the default; nothing in the repository sets it): nothing is stored or applied, and the chat says plainly that the file was received but is NOT applied.
 *
 * Matching is deterministic (no model): the same rules as negativeListEngine.compareOrganizations (exact corporate domain, exact registration number, exact normalized name, equal set of distinctive brand words), indexed so a
 * list of 5,000 companies is checked in constant time per row. A partial brand-word overlap is only a POSSIBLE match: it is never excluded (owner rule of the negative-list engine: an uncertain case is kept), it is marked on the
 * row and counted in the delivered file's methodology. The uploaded list never goes to a provider or a model.
 */

/** `agent_settings` key (scopedFlag.ts: `true` / `"on"` for everyone, `{ "user_ids": [...] }` for named accounts). OFF by default. */
export const CUSTOMER_EXCLUSION_FLAG_KEY = "customer_exclusion_files_v1";
/** The chat route's own maximum (src/app/api/chat/route.ts MAX_EXCLUSION_ROWS). */
export const EXCLUSION_MAX_ENTITIES = 5000;
/** Internal row mark (never a column of the file): the row resembles a listed company without a certain match, so it was kept. */
export const EXCLUSION_POSSIBLE_MARK = "_excl_possible";
/** The item reason of a row the list excluded (agent/src/items/itemStore.ts). */
export const CUSTOMER_EXCLUSION_REASON = "customer_exclusion" as const;
/** Where the worker keeps the approved copy, inside the mission's private folder. */
export const EXCLUSION_SNAPSHOT_PATH = "inputs/customer-exclusion.json";

export interface ExclusionEntity { name: string; domain?: string; crNumber?: string }
export interface ExclusionSnapshot { v: 1; file_name: string; entities: ExclusionEntity[]; digest: string }
/** What the APPROVED plan records: the digest of the exact list and whether any stage of the plan can be checked against it. Never the list itself (the plan text reaches models; the list does not). */
export interface PlanExclusionMark { digest: string; entities: number; applies: boolean }

// ------------------------------------------------------------------------------------------------ the snapshot
const ARABIC_INDIC = /[٠-٩۰-۹]/g;
const asciiDigits = (s: string): string => s.replace(ARABIC_INDIC, (d) => String((d.charCodeAt(0) & 0xf) % 10));
const cleanText = (v: unknown, max: number): string => (typeof v === "string" || typeof v === "number" ? String(v) : "").replace(/[\u0000-\u001f​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Hosts that never identify ONE company: social networks, free mailboxes and site builders («facebook.com/acme», «acme.wixsite.com»). A domain on one of them is dropped from both the list and the row, so it can never exclude
 * every company that only has a social page.
 */
const SHARED_LABELS: ReadonlySet<string> = new Set([
  "facebook", "fb", "instagram", "linkedin", "twitter", "x", "tiktok", "youtube", "youtu", "snapchat", "pinterest", "reddit", "telegram", "t", "whatsapp", "wa", "threads",
  "google", "goo", "bit", "linktr", "wixsite", "wix", "blogspot", "wordpress", "weebly", "godaddysites", "medium", "github", "gitlab", "notion", "carrd", "webflow", "myshopify",
  "tripadvisor", "yelp", "wikipedia", "zoominfo", "crunchbase", "kompass", "yellowpages", "dubizzle", "olx", "jumia", "noon", "amazon",
]);
const SHARED_DOMAINS: ReadonlySet<string> = new Set(["business.site", "square.site", "ueniweb.com", "site123.me"]);
const isSharedHost = (registrable: string): boolean => SHARED_DOMAINS.has(registrable) || SHARED_LABELS.has(registrable.split(".")[0] ?? "");

/** The corporate domain of a value, or null (no domain, a shared host, a free mailbox). Registrable form: «eg.orascom.com» and «www.orascom.com» are «orascom.com»; «x.com.eg» keeps three labels. */
export function corporateDomainOf(value: unknown): string | null {
  const d = registrableDomain(typeof value === "string" ? value.trim() : value);
  if (!d || isSharedHost(d) || isPersonalMailDomain(d)) return null;
  return d;
}

const registrationOf = (value: unknown): string | null => {
  const t = asciiDigits(cleanText(value, 64)).replace(/[\s\-_/.]/g, "").toUpperCase();
  return /^[A-Z0-9]{3,40}$/.test(t) ? t : null;
};

const digestOf = (entities: ReadonlyArray<ExclusionEntity>): string => createHash("sha256").update(JSON.stringify(entities)).digest("hex");

/**
 * THE SNAPSHOT of the brief's parsed exclusion file (the chat route already parsed and validated it on the server). Only organisation identifiers are kept: a name of at least two letters, a corporate domain, a registration
 * number. Repeats are removed, the list is capped at the route's maximum, and the digest pins the exact list. Null when nothing usable remains (an empty or unreadable file is never «applied»).
 */
export function exclusionSnapshotOf(file: { name?: unknown; normalizedEntities?: unknown } | null | undefined): ExclusionSnapshot | null {
  if (!file || !Array.isArray(file.normalizedEntities)) return null;
  const entities: ExclusionEntity[] = [];
  const seen = new Set<string>();
  for (const raw of file.normalizedEntities) {
    if (entities.length >= EXCLUSION_MAX_ENTITIES) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = cleanText(r.name, 200);
    if (name.length < 2) continue;
    const domain = corporateDomainOf(r.domain);
    const crNumber = registrationOf(r.crNumber);
    const key = `${normalizeArabicText(name)}|${domain ?? ""}|${crNumber ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push({ name, ...(domain ? { domain } : {}), ...(crNumber ? { crNumber } : {}) });
  }
  if (entities.length === 0) return null;
  const fileName = cleanText(file.name, 100) || "exclusion";
  return { v: 1, file_name: fileName, entities, digest: digestOf(entities) };
}

/** A stored snapshot read back (a message's plan or the mission's private copy): its shape is checked and its digest recomputed. Anything else is null, never a partial list. */
export function parseExclusionSnapshot(raw: unknown): ExclusionSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (s.v !== 1 || typeof s.file_name !== "string" || typeof s.digest !== "string" || !Array.isArray(s.entities)) return null;
  if (s.entities.length === 0 || s.entities.length > EXCLUSION_MAX_ENTITIES) return null;
  const entities: ExclusionEntity[] = [];
  for (const e of s.entities) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return null;
    const x = e as Record<string, unknown>;
    if (typeof x.name !== "string" || x.name.length < 2) return null;
    if (x.domain !== undefined && typeof x.domain !== "string") return null;
    if (x.crNumber !== undefined && typeof x.crNumber !== "string") return null;
    entities.push({ name: x.name, ...(typeof x.domain === "string" ? { domain: x.domain } : {}), ...(typeof x.crNumber === "string" ? { crNumber: x.crNumber } : {}) });
  }
  if (digestOf(entities) !== s.digest) return null;
  return { v: 1, file_name: s.file_name, entities, digest: s.digest };
}

// ------------------------------------------------------------------------------------------------ the matcher
export type ExclusionRule = "domain" | "registration" | "name" | "brand";
export type ExclusionVerdict = { kind: "excluded"; rule: ExclusionRule } | { kind: "possible" } | { kind: "none" };
export interface OrganisationIdentity { names: ReadonlyArray<string>; domain?: string | null; crNumber?: string | null }
export interface ExclusionMatcher { readonly size: number; readonly digest: string; check(candidate: OrganisationIdentity): ExclusionVerdict }

const brandKey = (tokens: ReadonlyArray<string>): string => [...new Set(tokens)].sort().join(" ");

/**
 * The deterministic matcher of a snapshot. A row is EXCLUDED when, against any listed company: the corporate domains are equal; or the registration numbers are equal; or the normalized full names are equal (longer than three
 * letters); or the sets of distinctive brand words are equal (generic words such as «شركة», «مقاولات», «group» never count). It is POSSIBLE when a distinctive brand word is shared and one of the two names has more than one
 * such word. Otherwise NONE. A name made only of generic words is never matched by its words (only an exact full name, a domain or a registration number can match it).
 */
export function exclusionMatcherOf(snapshot: ExclusionSnapshot): ExclusionMatcher {
  const domains = new Set<string>();
  const registrations = new Set<string>();
  const fullNames = new Set<string>();
  const brandSets = new Set<string>();
  /** distinctive word → the largest number of distinctive words of a listed name that holds it */
  const wordWidth = new Map<string, number>();
  for (const e of snapshot.entities) {
    const d = corporateDomainOf(e.domain);
    if (d) domains.add(d);
    const cr = registrationOf(e.crNumber);
    if (cr) registrations.add(cr);
    const norm = normalizeArabicText(e.name);
    if (norm.length > 3) fullNames.add(norm);
    const tokens = [...new Set(extractBrandTokens(e.name))];
    if (tokens.length > 0) {
      brandSets.add(brandKey(tokens));
      for (const t of tokens) wordWidth.set(t, Math.max(wordWidth.get(t) ?? 0, tokens.length));
    }
  }
  return {
    size: snapshot.entities.length,
    digest: snapshot.digest,
    check(candidate) {
      const d = corporateDomainOf(candidate.domain);
      if (d && domains.has(d)) return { kind: "excluded", rule: "domain" };
      const cr = registrationOf(candidate.crNumber);
      if (cr && registrations.has(cr)) return { kind: "excluded", rule: "registration" };
      let possible = false;
      for (const name of candidate.names) {
        const clean = cleanText(name, 300);
        if (clean.length < 2) continue;
        const norm = normalizeArabicText(clean);
        if (norm.length > 3 && fullNames.has(norm)) return { kind: "excluded", rule: "name" };
        const tokens = [...new Set(extractBrandTokens(clean))];
        if (tokens.length === 0) continue;
        if (brandSets.has(brandKey(tokens))) return { kind: "excluded", rule: "brand" };
        if (!possible) for (const t of tokens) { const w = wordWidth.get(t); if (w !== undefined && (tokens.length > 1 || w > 1)) { possible = true; break; } }
      }
      return possible ? { kind: "possible" } : { kind: "none" };
    },
  };
}

// ------------------------------------------------------------------------------------------------ the organisation of a row
const PEOPLE_COMPANY_NAME_KEY = /^(?:company|company_name|company_name_en|company_name_ar|current_company|current_company_name|employer|employer_name|organization|organisation|organization_name|organisation_name|org_name|account_name)$/i;
const COMPANY_NAME_KEY = /^(?:name|title|company|company_name|company_name_en|company_name_ar|name_en|name_ar|brand|brand_name|organization|organisation|organization_name|organisation_name|legal_name|trade_name)$/i;
const DOMAIN_KEY = /^(?:domain|website|website_url|site|homepage|url|company_domain|company_website|company_url|company_website_url|web|web_site)$/i;
const REGISTRATION_KEY = /^(?:cr|cr_number|commercial_registration|commercial_registration_number|registration|registration_number|registration_no|tax_id|tax_number|vat_number)$/i;

/**
 * The organisation a stored row names, read only from fields that hold the company: on a COMPANY row its name fields (the planner's name columns, then the usual keys), website and registration number; on a PERSON row only the
 * employer fields (never the person's own name, never their job title). A LinkedIn or other shared address is never a domain.
 */
export function organisationOfRow(row: Record<string, unknown>, opts: { people: boolean; nameKeys?: ReadonlyArray<string> }): OrganisationIdentity {
  const names: string[] = [];
  let domain: string | null = null;
  let crNumber: string | null = null;
  const nameKey = (k: string): boolean => (opts.people ? PEOPLE_COMPANY_NAME_KEY.test(k) : (opts.nameKeys ?? []).includes(k) || COMPANY_NAME_KEY.test(k));
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith("_")) continue;
    // a nested employer or company record («company: { name, website }»): its own name and website fields
    if (v && typeof v === "object" && !Array.isArray(v) && /company|organi[sz]ation|employer/i.test(k)) {
      const o = v as Record<string, unknown>;
      for (const nk of ["name", "company_name", "title", "legal_name"]) { const n = cleanText(o[nk], 300); if (n.length >= 2 && !/^https?:\/\//i.test(n) && !names.includes(n)) names.push(n); }
      if (domain === null) for (const dk of ["domain", "website", "website_url", "url", "homepage"]) { const d = corporateDomainOf(o[dk]); if (d) { domain = d; break; } }
      continue;
    }
    const t = cleanText(v, 300);
    if (!t) continue;
    if (nameKey(k)) {
      if (!/^https?:\/\//i.test(t) && !names.includes(t)) {
        names.push(t);
        const parts = t.split(/\s*[\\|]\s*|\s+\/\s+/).map((x) => x.trim()).filter((x) => x.length >= 2);
        if (parts.length > 1) for (const p of parts) if (!names.includes(p)) names.push(p);
      }
      continue;
    }
    if (domain === null && (DOMAIN_KEY.test(k) || (opts.people && /^(?:company_)?(?:domain|website)$/i.test(k)))) { domain = corporateDomainOf(t); continue; }
    if (crNumber === null && REGISTRATION_KEY.test(k)) crNumber = registrationOf(t);
  }
  return { names, domain, crNumber };
}

// ------------------------------------------------------------------------------------------------ what the customer meant by the file
/**
 * PHASE 5.3 / 5.3-B: WHAT THE CUSTOMER WANTS DONE WITH THE UPLOADED LIST, read by code from their words (no model). The upload control is labelled «ملف استبعاد», so an unspecified request keeps that meaning. A request
 * that names the companies IN the file as the ones to research («هات مواقع الشركات اللي في الملف», «كمّل بيانات القائمة المرفقة», «enrich») is an ENRICHMENT request: that is not supported yet (docs/intelligence/
 * PHASE-5-3-AND-6.md §B), so the file is NEVER applied as an exclusion list then (it would remove the very companies the customer asked about) and the customer is told plainly. Explicit exclusion words win.
 */
const EXCLUSION_WORDS = /(?:استبعد|استبعاد|إستبعاد|استثن|ماعدا|ما عدا|بخلاف|(?:غير|مش|مو|ليست|ليس)\s+(?:ال)?(?:موجود|وارد|مذكور|اللي)|exclude|excluding|except|not in)/i;
const IN_FILE_WORDS = /(?:(?:ال)?شركات|(?:ال)?شركة|(?:ال)?شركه|الأسماء|الاسماء|القائمة|القائمه|اللستة|الليستة|الكيانات|companies|names)\s+(?:(?:اللي|الى|التي|الموجودة|الموجوده|الواردة|الوارده|المذكورة|المذكوره)\s+)?(?:في|فى|ف|ب)\s*(?:ال)?(?:ملف|مرفق|شيت|إكسل|اكسل|اكسيل|جدول|قائمة|file|sheet)|(?:(?:ال)?شركات|القائمة|القائمه|الأسماء|الاسماء|اللستة)\s+(?:المرفقة|المرفقه|المرفوعة|المرفوعه)|(?:بيانات|مواقع|إيميلات|ايميلات|أرقام|ارقام|حسابات|روابط|تفاصيل)\s+(?:الملف|المرفق|الشيت|القائمة المرفقة|القائمه المرفقه)|\benrich(?:ment)?\b|(?:إثراء|اثراء)\s+(?:ال)?(?:ملف|قائمة|قائمه|بيانات|شركات)/i;
export type UploadIntent = "exclusion" | "enrichment" | "unspecified";
export function uploadIntentOf(text: unknown): UploadIntent {
  const t = cleanText(text, 4000);
  if (!t) return "unspecified";
  if (EXCLUSION_WORDS.test(t)) return "exclusion";
  return IN_FILE_WORDS.test(t) ? "enrichment" : "unspecified";
}
/** The chat's sentence for an enrichment request with an uploaded list (any switch state): not supported yet, the file is not used, the plan says what will really be collected, nothing is charged before approval. */
export const ENRICHMENT_NOT_SUPPORTED_AR = "ملاحظة: استخدام ملف مرفوع كقائمة شركات تُكمَل بياناتها غير متاح حاليًا، فلن تُستخدم شركات الملف كبداية للبحث ولن يُطبَّق الملف كقائمة استبعاد. ستوضح خطة المهمة ما سيُجمع فعلًا، ولن يُخصم شيء قبل اعتمادك.";

// ------------------------------------------------------------------------------------------------ what the customer reads
/** The chat's honest sentence when the switch is OFF: the file was received, it is NOT applied. */
export const exclusionNotAppliedAr = (count: number): string =>
  `ملاحظة: استلمنا ملف الاستبعاد (${formatCount(count)})، لكن تطبيقه على نتائج البحث غير مفعّل حاليًا، فقد تتضمن النتيجة شركات واردة فيه.`;
/** The chat's sentence when the uploaded file holds no usable company (an empty or unreadable list is never applied). */
export const EXCLUSION_UNUSABLE_AR = "ملاحظة: لم نجد في ملف الاستبعاد المرفوع أسماء شركات صالحة، فلن يُستخدم في هذا الطلب.";
/** The chat's sentence when the switch is ON: the plan card says whether it applies (the worker decides from the plan's stages). */
export const exclusionWillApplyAr = (count: number): string =>
  `استلمنا ملف الاستبعاد (${formatCount(count)}): ستوضح خطة المهمة هل يُطبَّق على نتائجها، ولن تُسلَّم أي شركة يثبت تطابقها مع الملف.`;
/** The plan card's line when the plan has a company or people stage. */
export const exclusionPlanLineAr = (count: number): string =>
  `ملف الاستبعاد: تُستبعد من النتيجة كل شركة واردة في ملفك (${formatCount(count)}) عند تطابق مؤكد في النطاق الإلكتروني أو رقم القيد التجاري أو الاسم أو العلامة التجارية المميزة؛ التشابه الجزئي غير المؤكد لا يُستبعد ويُذكر عدده في المنهجية. السعر لا يتغير، ولا يُحتسب إلا ما يُسلَّم.`;
/** The plan card's line when no stage of the plan lists companies or people (the file lists organisations only). */
export const exclusionNotApplicableAr = (count: number): string =>
  `ملف الاستبعاد (${formatCount(count)}) يخص الشركات، ولا ينطبق على نوع البيانات في هذه الخطة، فلن يُستخدم فيها.`;
/** The methodology's line of the approved rule. */
export const exclusionMethodologyAr = (count: number): string =>
  `طُبّق ملف الاستبعاد الذي أرسلته (${formatCount(count)}): استُبعدت كل شركة ثبت تطابقها معه في النطاق الإلكتروني أو رقم القيد التجاري أو الاسم أو العلامة التجارية المميزة، ولم تُحتسب أي نتيجة مستبعدة.`;
export const exclusionPossibleLineAr = (possible: number, delivered: number): string =>
  `${formatCount(possible, false)} من ${formatCount(delivered, false)} نتيجة مسلّمة تشبه أسماؤها اسمًا في ملف الاستبعاد دون تطابق مؤكد، فسُلّمت ولم تُستبعد.`;
/** The item reason's text (agent/src/finalize.ts REASON_TEXT_AR). */
export const EXCLUSION_REASON_TEXT_AR = "وارد في ملف الاستبعاد الذي أرسلته";

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
function formatCount(n: number, withNoun = true): string {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  const digits = v.toLocaleString("en-US").replace(/\d/g, (d) => AR_DIGITS[Number(d)]).replace(/,/g, "٬");
  if (!withNoun) return digits;
  return v === 1 ? "شركة واحدة" : v === 2 ? "شركتان" : v >= 3 && v <= 10 ? `${digits} شركات` : `${digits} شركة`;
}
