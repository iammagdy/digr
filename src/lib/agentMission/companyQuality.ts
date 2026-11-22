import { organisationOfRow } from "./customerExclusion";
import { isCompanyStage } from "./entities";
import { countAr, knownItemNoun } from "./itemNoun";
import { exactPlaceLabelAr, isPlaceFragment, placeCellKind, withoutRepeatedWords } from "./places";
import { normalizeText } from "./relevance";
import { formatAr } from "../arabicDigits";

/**
 * ROUND 59: THE COMPANY ROWS OF A FILE ARE CHECKED, NOT TRUSTED (live msn_088c, 13 Nov 2026). A company database gave:
 *   - «BOBANA» (bobana-eg.com) whose description and LinkedIn page name «Vision Cosmetics»; «yolo-cosmetics.com» (the name is only the domain) whose description names «Cosmotrade»;
 *   - an address «31.25» (a number, no place);
 *   - no public page the record came from (the «website» is the company's own site as the database states it, not the page the record was read from).
 * Nothing here removes, replaces or invents a row or a value: a row whose identity conflicts is FLAGGED, an unusable value is left out of its cell and said, and the file states what was checked
 * and what was not (no company was visited to verify it). The rows the settlement counts are never touched: this works on the copy the file is written from. Pure.
 */
type Row = Record<string, unknown>;
interface QualityStage { key: string; title_ar: string; capability?: string | null; parent_key: string | null; deliver?: boolean; columns: ReadonlyArray<{ key: string; title_ar: string }> }
interface QualityPlan { stages: ReadonlyArray<QualityStage> }

export const VERIFICATION_NOTE_KEY = "verification_note";
export const VERIFICATION_NOTE_HEADER_AR = "ملاحظات التحقق";

const COMPANY = knownItemNoun("شركة")!;
const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v)).trim();

/** Words that say WHAT a company is, never WHICH one («cosmetics», «natural», «trade», «egypt»): they cannot tell two companies apart. */
const GENERIC = new Set([
  "cosmetics", "cosmetic", "cosmeceuticals", "cosmeceutical", "beauty", "natural", "naturals", "organic", "pure", "care", "skin", "skincare", "hair", "haircare", "body", "makeup", "perfume", "perfumes",
  "company", "companies", "corp", "corporation", "inc", "ltd", "llc", "group", "holding", "international", "trading", "trade", "industries", "industry", "industrial", "manufacturing", "factory",
  "products", "product", "brand", "brands", "store", "shop", "official", "online", "lab", "labs", "laboratory", "laboratories", "pharma", "pharmaceutical", "pharmaceuticals", "medical",
  "egypt", "egyptian", "cairo", "giza", "alexandria", "the", "and", "for", "www", "com", "net", "org", "shop", "store", "co",
]);
const tokensOf = (value: string): string[] => value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9؀-ۿ]+/).filter((w) => w.length >= 3 && !GENERIC.has(w));
const hostOf = (url: string): string => {
  const m = /^(?:https?:\/\/)?([^/?#\s]+)/i.exec(url.trim());
  return m ? m[1].toLowerCase().replace(/^www\./, "") : "";
};
/** The distinctive words of a site's address: «bobana-eg.com» → [«bobana»]. */
const domainTokens = (url: string): string[] => tokensOf(hostOf(url).split(".").slice(0, -1).join(" "));
/** Two words name the same company when one is the other, or one starts the other (four letters at least: «nanostetic», «nanostetics»). */
const sameWord = (a: string, b: string): boolean => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
const overlaps = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => a.some((x) => b.some((y) => sameWord(x, y)));

/** The company a description opens with («vision cosmetics is one of egypt's leading…» → «vision cosmetics»); null when it does not open with «X is / are / was». */
export function describedCompanyOf(description: unknown): string | null {
  const m = /^\s*([^.,;:!?"“”«»()]{2,50}?)\s+(?:is|are|was|has been)\s/i.exec(text(description));
  return m ? m[1].trim() : null;
}
/** The company a LinkedIn company page names by its address («linkedin.com/company/vision-cosmetics» → «vision cosmetics»); null for any other address. */
export function linkedinCompanyOf(url: unknown): string | null {
  const m = /linkedin\.com\/company\/([^/?#\s]+)/i.exec(text(url));
  if (!m) return null;
  try { return decodeURIComponent(m[1]).replace(/[-_]+/g, " ").trim(); } catch { return null; }
}
/** A name that is only a site's address («yolo-cosmetics.com»). */
export const nameIsDomain = (name: unknown): boolean => /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z]{2,})+\/?$/i.test(text(name));

export interface IdentityConflict { /** Where the other name was read: the description, the LinkedIn page or both. */ where: Array<"description" | "linkedin">; otherName: string }
/**
 * Whether the name and the site of a row are contradicted by its own description or LinkedIn page: both sides must hold a distinctive word and share none. A side with no distinctive word
 * («hk trade», «go natural») proves nothing and is not a conflict.
 */
export function identityConflictOf(row: { name?: unknown; website?: unknown; description?: unknown; linkedin?: unknown }): IdentityConflict | null {
  const own = [...tokensOf(nameIsDomain(row.name) ? hostOf(text(row.name)).split(".").slice(0, -1).join(" ") : text(row.name)), ...domainTokens(text(row.website))];
  if (own.length === 0) return null;
  const where: IdentityConflict["where"] = [];
  let otherName = "";
  const described = describedCompanyOf(row.description);
  if (described && tokensOf(described).length > 0 && !overlaps(tokensOf(described), own)) { where.push("description"); otherName = described; }
  const linked = linkedinCompanyOf(row.linkedin);
  if (linked && tokensOf(linked).length > 0 && !overlaps(tokensOf(linked), own)) { where.push("linkedin"); if (!otherName) otherName = linked; }
  return where.length > 0 ? { where, otherName } : null;
}

/** An address cell that holds no place a reader could use: only digits and marks («31.25»), or a stop word. */
export const isUnusableAddress = (value: unknown): boolean => text(value) !== "" && isPlaceFragment(value);

const columnKey = (stage: QualityStage, keyRe: RegExp, titleRe?: RegExp): string | null => stage.columns.find((c) => keyRe.test(c.key) || (titleRe ? titleRe.test(c.title_ar.trim()) : false))?.key ?? null;
const NAME_KEY = /^(?:name|company_name|company|organization_name)$/i;
const WEBSITE_KEY = /(?:^|_)(?:website|domain|homepage|site)$/i;
const DESCRIPTION_KEY = /(?:^|_)(?:description|about|summary|overview)$/i;
const LINKEDIN_KEY = /linkedin/i;
const ADDRESS_KEY = /(?:^|_)(?:street_address|address|street|address_line)$/i;
/** A column that says where a record was read from: a page link or a source address (never the company's own site or its LinkedIn page). */
const SOURCE_KEY = /(?:^|_)(?:link|source|source_url|source_link|page_url|url|evidence_url)$/i;

// Stored with accepted rows so the same identity decision is available after a restart.
export const COMPANY_EVIDENCE_KEY = "_company_evidence";
export const COMPANY_SOURCE_ID_KEY = "_company_source_id";
export const COMPANY_UNCERTAIN_KEY = "_company_uncertain";
export const COMPANY_BRANCH_FIELDS = ["branch_id", "outlet_id", "location_id", "store_id"] as const;
type BranchField = typeof COMPANY_BRANCH_FIELDS[number];

interface CompanyEvidence {
  keys: string[];
  name: string;
  registration: string | null;
  jurisdiction: string;
  branches: Partial<Record<BranchField, string>>;
  address: string;
  conflict: boolean;
}

const nameKey = (value: unknown): string => normalizeText(text(value)).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const identityValue = (value: unknown): string => typeof value === "string" || typeof value === "number" ? text(value) : "";

export function companyEvidenceOf(row: Row, stage: QualityStage): CompanyEvidence {
  const read = (key: RegExp, label?: RegExp): unknown => {
    const column = columnKey(stage, key, label);
    return (column ? row[column] : undefined) ?? Object.entries(row).find(([field]) => key.test(field))?.[1];
  };
  const displayName = read(NAME_KEY, /^(?:الاسم|اسم الشركة)$/);
  const website = read(WEBSITE_KEY, /^الموقع الإلكتروني$/);
  const description = read(DESCRIPTION_KEY, /^الوصف$/);
  const linkedin = read(LINKEDIN_KEY);
  const organisation = organisationOfRow(row, { people: false, nameKeys: [columnKey(stage, NAME_KEY, /^(?:الاسم|اسم الشركة)$/) ?? "name"] });
  const jurisdiction = nameKey(read(/^(?:registration_country|registration_jurisdiction|jurisdiction|country_code|country)$/i, /^الدولة$/));
  const city = nameKey(read(/^(?:city|city_name|locality|town)$/i, /^المدينة$/));
  const street = nameKey(read(ADDRESS_KEY, /^العنوان$/));
  const address = (city || jurisdiction) && /\p{N}/u.test(street) && /\p{L}/u.test(street)
    ? JSON.stringify([jurisdiction, city, street]) : "";
  const branches: CompanyEvidence["branches"] = {};
  for (const field of COMPANY_BRANCH_FIELDS) {
    if (identityValue(row[field])) branches[field] = identityValue(row[field]);
  }
  const keys = new Set<string>();
  if (organisation.crNumber && jurisdiction) keys.add(JSON.stringify(["registration", jurisdiction, organisation.crNumber]));
  const profile = nameKey(linkedinCompanyOf(linkedin));
  if (profile) keys.add(JSON.stringify(["profile", profile]));
  for (const name of [displayName, ...organisation.names]) {
    if (organisation.domain && !nameIsDomain(name) && tokensOf(text(name)).length > 0) {
      keys.add(JSON.stringify(["website", organisation.domain, nameKey(name)]));
    }
  }
  const described = describedCompanyOf(description);
  const linked = linkedinCompanyOf(linkedin);
  const conflict = identityConflictOf({ name: displayName ?? organisation.names[0], website: website ?? organisation.domain, description, linkedin });
  return {
    keys: [...keys].sort(),
    name: nameKey(displayName ?? organisation.names[0]),
    registration: organisation.crNumber,
    jurisdiction,
    branches,
    address,
    conflict: conflict?.where.length === 2 && overlaps(tokensOf(text(described)), tokensOf(text(linked)),
  };
}

export function storedCompanyEvidence(row: Row, stage: QualityStage): CompanyEvidence {
  return (row[COMPANY_EVIDENCE_KEY] as CompanyEvidence | undefined) ?? companyEvidenceOf(row, stage);
}

export function branchesDiffer(a: CompanyEvidence, b: CompanyEvidence): boolean {
  return COMPANY_BRANCH_FIELDS.some((key) => Boolean(a.branches[key] && b.branches[key] && a.branches[key] !== b.branches[key]))
    || Boolean(a.address && b.address && a.address !== b.address);
}

export function companyRelationship(a: CompanyEvidence, b: CompanyEvidence): "same" | "different" | "uncertain" {
  if (branchesDiffer(a, b) || (a.registration && b.registration
      && (a.registration !== b.registration || (a.jurisdiction && b.jurisdiction && a.jurisdiction !== b.jurisdiction)))) return "different";
  if (!a.keys.some((key) => b.keys.includes(key))) return "uncertain";
  const sameBranch = COMPANY_BRANCH_FIELDS.some((key) => Boolean(a.branches[key] && a.branches[key] === b.branches[key]))
    || Boolean(a.address && a.address === b.address);
  return sameBranch ? "same" : "uncertain";
}

/** Index by positive organisation evidence. Only accepted rows enter the index. */
export class AcceptedCompanies {
  private readonly byIdentity = new Map<string, CompanyEvidence[]>();

  inspect(evidence: CompanyEvidence): "duplicate_company" | "company_identity_conflict" | "possible" | null {
    if (evidence.conflict) return "company_identity_conflict";
    let possible = false;
    const seen = new Set<CompanyEvidence>();
    for (const key of evidence.keys) {
      for (const previous of this.byIdentity.get(key) ?? []) {
        if (seen.has(previous)) continue;
        seen.add(previous);
        const relationship = companyRelationship(previous, evidence);
        if (relationship === "same") return "duplicate_company";
        if (relationship === "uncertain") possible = true;
      }
    }
    return possible ? "possible" : null;
  }

  add(evidence: CompanyEvidence): void {
    for (const key of evidence.keys) {
      const existing = this.byIdentity.get(key);
      if (existing) existing.push(evidence);
      else this.byIdentity.set(key, [evidence]);
    }
  }
}

const whereAr = (where: IdentityConflict["where"]): string => (where.length === 2 ? "الوصف وصفحة لينكدإن يذكران" : where[0] === "description" ? "الوصف يذكر" : "صفحة لينكدإن تذكر");
const quoteAr = (s: string): string => `«${s.length > 40 ? `${s.slice(0, 40)}…` : s}»`;

export interface CompanyQualityReport {
  stageKey: string;
  total: number;
  /** The ids of the rows whose identity is contradicted by their own description or LinkedIn page. */
  uncertain: string[];
  nameIsDomain: string[];
  unusableAddress: string[];
  /** Rows that may be a branch or a copy of another row of the sheet (same site, or the same distinctive name). */
  possibleDuplicates: string[];
  /** Rows with no row of a delivered step hanging on them (their contacts were not found), when such a step exists. */
  withoutDetails: string[];
  hasSourceColumn: boolean;
}

/**
 * The quality notes of every company sheet, on a COPY of the rows: one «ملاحظات التحقق» cell per company (empty when nothing was found), an unusable address left out of its cell, and the lines
 * the file's «حدود هذا التسليم» states. A plan with no company stage, or company rows with nothing to say, come back unchanged (no column is added).
 */
export function withCompanyQuality<P extends QualityPlan>(plan: P, rowsIn: Record<string, Row[]>): { rowsByStage: Record<string, Row[]>; layoutPlan: P; limitLines: string[]; reports: CompanyQualityReport[] } {
  const rowsByStage: Record<string, Row[]> = { ...rowsIn };
  let layoutPlan = plan;
  const limitLines: string[] = [];
  const reports: CompanyQualityReport[] = [];
  for (const stage of plan.stages) {
    if (stage.deliver === false || !isCompanyStage(stage)) continue;
    const rows = rowsByStage[stage.key];
    if (!rows || rows.length === 0) continue;
    const k = {
      name: columnKey(stage, NAME_KEY, /^(?:الاسم|اسم الشركة)$/),
      website: columnKey(stage, WEBSITE_KEY, /^الموقع الإلكتروني$/),
      description: columnKey(stage, DESCRIPTION_KEY, /^الوصف$/),
      linkedin: columnKey(stage, LINKEDIN_KEY),
      address: columnKey(stage, ADDRESS_KEY, /^العنوان$/),
    };
    const children = plan.stages.filter((s) => s.parent_key === stage.key && s.deliver !== false);
    const parentsWithDetails = new Set(children.flatMap((c) => (rowsByStage[c.key] ?? []).map((r) => text(r.parent_id))));
    const report: CompanyQualityReport = { stageKey: stage.key, total: rows.length, uncertain: [], nameIsDomain: [], unusableAddress: [], possibleDuplicates: [], withoutDetails: [], hasSourceColumn: stage.columns.some((c) => SOURCE_KEY.test(c.key) && !WEBSITE_KEY.test(c.key) && !LINKEDIN_KEY.test(c.key)) };
    const badAddresses: string[] = [];
    // the same site or the same distinctive name twice: a branch or a copy (never removed: the customer decides)
    const firstBySite = new Map<string, Row>();
    const firstByName = new Map<string, Row>();
    const notes = rows.map((r) => {
      const id = text(r.id);
      const name = k.name ? text(r[k.name]) : "";
      const out: string[] = [];
      const conflict = identityConflictOf({ name, website: k.website ? r[k.website] : "", description: k.description ? r[k.description] : "", linkedin: k.linkedin ? r[k.linkedin] : "" });
      if (conflict) { report.uncertain.push(id); out.push(`الهوية غير مؤكدة: ${whereAr(conflict.where)} ${quoteAr(conflict.otherName)} لا ${quoteAr(name || hostOf(text(k.website ? r[k.website] : "")))}`); }
      if (name && nameIsDomain(name)) { report.nameIsDomain.push(id); out.push("الاسم في المصدر هو عنوان الموقع فقط"); }
      const site = k.website ? hostOf(text(r[k.website])) : "";
      const nameKey = tokensOf(name).sort().join(" ");
      const twin = (site ? firstBySite.get(site) : undefined) ?? (nameKey ? firstByName.get(nameKey) : undefined);
      if (twin) { report.possibleDuplicates.push(id); out.push(`قد تكون فرعًا أو تكرارًا لـ ${quoteAr(k.name ? text(twin[k.name]) : text(twin.id))} (${site && firstBySite.get(site) === twin ? "نفس الموقع الإلكتروني" : "نفس الاسم"})`); }
      if (r[COMPANY_UNCERTAIN_KEY] === true && !twin) {
        report.possibleDuplicates.push(id);
        out.push("لم تكفِ بيانات المصدر لتمييز هذا الفرع عن الصفوف المشابهة");
      }
      if (site && !firstBySite.has(site)) firstBySite.set(site, r);
      if (nameKey && !firstByName.has(nameKey)) firstByName.set(nameKey, r);
      if (k.address && isUnusableAddress(r[k.address])) { report.unusableAddress.push(id); badAddresses.push(text(r[k.address])); out.push(`العنوان في المصدر (${quoteAr(text(r[k.address]))}) ليس عنوانًا فتُرك فارغًا`); }
      if (children.length > 0 && !parentsWithDetails.has(id)) { report.withoutDetails.push(id); out.push(`لا توجد لها بيانات في «${children[0].title_ar}»`); }
      return out.join("؛ ");
    });
    reports.push(report);
    const nameOf = (id: string): string => { const r = rows.find((x) => text(x.id) === id); return r ? text(k.name ? r[k.name] : "") || id : id; };
    if (report.uncertain.length > 0) limitLines.push(`هوية ${countAr(report.uncertain.length, COMPANY)} من ${formatAr(report.total)} غير مؤكدة (اسمها أو موقعها لا يطابق ما يذكره وصفها أو صفحة لينكدإن): ${report.uncertain.map(nameOf).map(quoteAr).join("، ")}. لم نحذفها ولم نستبدلها بغيرها؛ التفاصيل في عمود «${VERIFICATION_NOTE_HEADER_AR}».`);
    if (report.possibleDuplicates.length > 0) limitLines.push(`${countAr(report.possibleDuplicates.length, COMPANY, { subject: true })} في «${stage.title_ar}» قد تكون فرعًا أو تكرارًا لشركة أخرى في الملف (نفس الموقع أو الاسم)؛ تركناها كما هي.`);
    if (badAddresses.length > 0) limitLines.push(`تركنا العنوان فارغًا في ${countAr(badAddresses.length, COMPANY)} لأن قيمته في المصدر ليست عنوانًا (${[...new Set(badAddresses)].map(quoteAr).join("، ")}).`);
    if (!report.hasSourceColumn) limitLines.push(`ليس في ورقة «${stage.title_ar}» رابط مصدر لكل سجل: بياناتها من مصدر الشركات المذكور في المنهجية، و«الموقع الإلكتروني» هو موقع الشركة كما ذكره المصدر، وليس صفحة قُرئ منها السجل.`);
    if (k.description || k.linkedin) limitLines.push(`فحصنا اتساق اسم كل شركة وموقعها مع وصفها وصفحة لينكدإن، ولم نزر مواقع الشركات للتحقق من هويتها؛ ${report.uncertain.length > 0 ? `لم نجد تعارضًا في الباقي (${countAr(report.total - report.uncertain.length, COMPANY)})` : "لم نجد تعارضًا في أي منها"}.`);
    const placeColumns = stage.columns.map((c) => ({ key: c.key, kind: placeCellKind(c) })).filter((c): c is { key: string; kind: "country" | "city" | "region" } => c.kind !== null);
    const placeFixes = rows.map((r) => Object.fromEntries(placeColumns.map((c) => [c.key, repeatedPlaceFixOf(r[c.key], c.kind)] as const).filter(([, v]) => v !== null)));
    const anyNote = notes.some((n) => n !== "");
    if (!anyNote && !placeFixes.some((f) => Object.keys(f).length > 0)) continue;
    rowsByStage[stage.key] = rows.map((r, i) => {
      const copy: Row = { ...r, ...placeFixes[i], ...(anyNote ? { [VERIFICATION_NOTE_KEY]: notes[i] } : {}) };
      if (k.address && isUnusableAddress(r[k.address])) copy[k.address] = null;
      return copy;
    });
    if (!anyNote) continue;
    layoutPlan = { ...layoutPlan, stages: layoutPlan.stages.map((s) => (s.key === stage.key && !s.columns.some((c) => c.key === VERIFICATION_NOTE_KEY) ? { ...s, columns: [...s.columns, { key: VERIFICATION_NOTE_KEY, title_ar: VERIFICATION_NOTE_HEADER_AR }] } : s)) };
  }
  return { rowsByStage, layoutPlan, limitLines, reports };
}

/**
 * A place cell the source wrote twice («Giza Giza») in rows saved before round 59: said once, in Arabic when the table knows it («الجيزة»). Any other place cell is left as it is (the place
 * cells are written by `placeCellsAr` when the row is saved). Null when there is nothing to change.
 */
export function repeatedPlaceFixOf(value: unknown, kind: "country" | "city" | "region"): string | null {
  const raw = text(value);
  if (!raw) return null;
  const once = withoutRepeatedWords(normalizeText(raw));
  if (once === normalizeText(raw).replace(/[,،]/g, " ").split(/\s+/).filter(Boolean).join(" ")) return null;
  return exactPlaceLabelAr(raw, kind) ?? null;
}

/**
 * THE LINE THE CUSTOMER READS WITH THE DELIVERY when the company check found something that changes how a row may be used: an identity its own description or LinkedIn page contradicts,
 * or a possible branch / copy. Null when there is nothing of the kind (an unusable address or a missing source link is said in the file only). Never a number of the settlement.
 */
export function qualityResultLineAr(reports: ReadonlyArray<CompanyQualityReport>): string | null {
  const uncertain = reports.reduce((n, r) => n + r.uncertain.length, 0);
  const duplicates = reports.reduce((n, r) => n + r.possibleDuplicates.length, 0);
  if (uncertain === 0 && duplicates === 0) return null;
  const total = reports.reduce((n, r) => n + r.total, 0);
  const parts: string[] = [];
  if (uncertain > 0) parts.push(`هوية ${countAr(uncertain, COMPANY)} من ${formatAr(total)} غير مؤكدة (اسمها أو موقعها لا يطابق وصفها أو صفحة لينكدإن)`);
  if (duplicates > 0) parts.push(`و${countAr(duplicates, COMPANY, { subject: true })} قد تكون فرعًا أو تكرارًا لشركة أخرى في الملف`);
  return `تنبيه عن جودة البيانات: ${parts.join("، ")}. لم نحذف شيئًا ولم نستبدله، والتفاصيل في عمود «${VERIFICATION_NOTE_HEADER_AR}» في ملف Excel.`;
}
