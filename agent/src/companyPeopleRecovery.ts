import { PEOPLE_OF_COMPANY_CAPABILITIES } from "../../src/lib/agentMission/childSources";
import { isContactSource, requestWantsContacts } from "../../src/lib/agentMission/contacts";
import { firstSentenceAr, validateAndPricePlan, type PricedPlan, type SavedEndpointCallDetail } from "../../src/lib/agentMission/plan";
import { askedTextOf } from "../../src/lib/agentMission/requestContract";
import { namesRoleAr, roleDefOf, roleOfNoun, titleRoleVerdict, titleTierOf, type RoleKey } from "../../src/lib/agentMission/roles";
import { checkCustomerText } from "../../src/lib/agentMission/text";
import { isPrivateCapabilityString, planStageIssues, type CapabilityDiscovery } from "../../src/lib/agentMission/capabilities";
import { FIELD_LABEL_AR, uncoveredFields, usefulFieldsOfPage, type FieldClass, type SourceField } from "../../src/lib/agentMission/fields";
import { requestNamesSector } from "../../src/lib/agentMission/entities";
import { CONTRACT_ONLY_CLASSES } from "../../src/lib/agentMission/taskContracts";
import { isSellable, type CatalogEndpoint, type TregCatalog } from "../../src/lib/treg/catalog";
import { blockedEndpointReason } from "../../src/lib/treg/blockList";
import { policyVerdict, type AccountAccess } from "../../src/lib/treg/dataPolicy";
import { buildShapeDigest } from "../../src/lib/modelPlanner/digest";
import { RAW_PATH, rowsExpressionOf } from "./gateway";
import { codeRunPath, parentBinding, type CodeRun } from "./engine/spec";
import type { SandboxResult } from "./sandbox";
import { readRunState, updateRunState } from "./runState";
import type { AgentStore, CallRow, MissionRecord } from "./types";

const FILE_ID = /^(call|out)_\d{4,6}$/;
const OWN_LIMIT_REFUSAL = /^(over_budget|daily_cap|recording_unavailable|missing_params)/;
const outIdOf = (n: number) => `out_${String(n).padStart(4, "0")}`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const nonEmptyStr = (v: unknown): string => (typeof v === "string" && v.trim() !== "" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

export interface SavedPeopleCandidate {
  callId: string;
  endpointId: string;
  rows: number;
  rowExpr: string;
  rawJson: unknown;
  rawRows: Array<Record<string, unknown>>;
  usable: boolean;
  linkScore: number;
  parentKey: string | null;
  matchedCompanyCallIds?: string[];
}

export interface SavedCompanyCandidate {
  callId: string;
  endpointId: string;
  rows: number;
  rowExpr: string;
  rawJson: unknown;
  rawRows: Array<Record<string, unknown>>;
  usable: boolean;
}

export interface SavedEvidenceInspection {
  hasOwnLimit: boolean;
  peopleCandidates: SavedPeopleCandidate[];
  savedPeopleMap: Map<string, Array<SavedEndpointCallDetail>>;
  companyCandidates: SavedCompanyCandidate[];
  hasMissingRawPeople: boolean;
  hasMissingRawCompanies: boolean;
  anyPeopleOkOrEmpty: boolean;
  anyCompanyOk: boolean;
}

export interface UnderstoodCompaniesSummary {
  title_ar: string;
  topic: string | null;
  search_terms: string[];
  country: string | null;
  expected_rows: number | null;
}

export interface UnderstoodPeopleSummary {
  noun_ar: string;
  parent_ar: string;
  per_parent: number | null;
  contact_kinds?: Array<"email" | "phone">;
  companies?: number;
}

export interface RecoveryDiagnostic {
  reason: string;
  issueCodes: string[];
  capIssues?: string[];
}

export type RecoveryResult =
  | { kind: "plan"; plan: PricedPlan; outSeq: number }
  | { kind: "question"; question_ar: string; options_ar: string[]; diagnostic?: RecoveryDiagnostic }
  | { kind: "sources_unavailable"; diagnostic?: RecoveryDiagnostic }
  | { kind: "own_limit"; diagnostic?: RecoveryDiagnostic }
  | { kind: "none"; diagnostic?: RecoveryDiagnostic };

export function sanitizeCapIssuesForAdmin(issues: ReadonlyArray<string>, maxCount = 2): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of issues) {
    const head = (String(raw ?? "").split(";")[0] ?? "").replace(/ for this request$/i, "").replace(/ of VALIDATED CAPABILITIES$/i, "");
    const clean = head.replace(/[^\x20-\x7E]/g, " ").replace(/["'`«»]/g, "").replace(/\s+/g, " ").trim().slice(0, 74);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= maxCount) break;
  }
  return out;
}

const lastRecoveryDiagnostic = new Map<string, RecoveryDiagnostic>();

export function getLastRecoveryDiagnostic(missionId: string): RecoveryDiagnostic | null {
  return lastRecoveryDiagnostic.get(missionId) ?? null;
}

const VALIDATOR_ISSUE_CODE_RULES: Array<[RegExp, string]> = [
  [/priced by an ESTIMATE and cannot be declared unserved|answered empty: a PEOPLE stage may be given/i, "people_estimate_unserved"],
  [/(?:CANNOT be declared in unserved_steps|CANNOT be omitted or re-sampled) because saved .* already returned rows/i, "people_saved_unserved"],
  [/CAN be served: the catalog has|catalog HAS sources for this step/i, "child_step_unserved"],
  [/measured_by must cite|no measured call/i, "missing_measured_call"],
  [/sample_rows|sampleRowsDiagnosis/i, "missing_sample_rows"],
  [/yield_from/i, "invalid_yield_from"],
  [/column «|mapping does not give|must give every row|missing field/i, "missing_column_or_mapping"],
  [/none of the \d+ rows of the sample matches your relevance rule/i, "relevance_zero_match"],
  [/parent «|expected_rows|place|another country/i, "stage_or_filter_invalid"],
  [/none of the \d+ items of your measured page passes the stage's filters|carries evidence of/i, "filter_zero_match"],
  [/contact stage|contacts_note_ar|work_email|e-mails and phones|no stage of the plan gives one/i, "contacts_or_note_invalid"],
  [/unserved_steps/i, "unserved_steps_invalid"],
  [/relevance/i, "relevance_spec_invalid"],
  [/assumptions_ar|summary_ar|title_ar|how_ar|target_reason_ar|promises|not a target of the plan|at least one stage must be delivered/i, "customer_text_or_promise_invalid"],
  [/more than the job limit|lower the expected rows/i, "over_job_limit"],
  [/duplicate key|earlier stage|per_parent_rows|must be an object|whole number|limit of \d+|not available for this account|stages is required|1 to \d+ stages/i, "stage_structure_invalid"],
];

export function classifyRecoveryIssueCode(issue: string): string {
  for (const [re, code] of VALIDATOR_ISSUE_CODE_RULES) if (re.test(issue)) return code;
  return "plan_validation_error";
}

const SAFE_FIELD_PATH = /^[A-Za-z0-9_.]+$/;

const extraFieldAssignments = (extraFields: ReadonlyArray<SourceField>, existingKeys: ReadonlySet<string>): string[] => {
  const seen = new Set<string>(existingKeys);
  const lines: string[] = [];
  for (const f of extraFields) {
    if (seen.has(f.cls) || !SAFE_FIELD_PATH.test(f.path)) continue;
    seen.add(f.cls);
    lines.push(`    ${f.cls}: atPath(r, ${JSON.stringify(f.path)}),`);
  }
  return lines;
};

export function extractPersonPreview(raw: Record<string, unknown>) {
  const person = isObject(raw.person) ? raw.person : raw;
  const exps = Array.isArray(person.experiences)
    ? person.experiences
    : Array.isArray(raw.experiences)
      ? raw.experiences
      : Array.isArray(raw.employment_history)
        ? raw.employment_history
        : Array.isArray(raw.positionList)
          ? raw.positionList
          : [];
  const exp = exps.find((x) => isObject(x) && !x.endDate) ?? exps.find(isObject) ?? {};
  const fullName =
    nonEmptyStr(person.full_name) ||
    nonEmptyStr(person.fullName) ||
    nonEmptyStr(person.name) ||
    [
      nonEmptyStr(person.first_name) || nonEmptyStr(person.firstName) || nonEmptyStr(person.firstname) || nonEmptyStr(raw.firstname),
      nonEmptyStr(person.last_name) || nonEmptyStr(person.lastName) || nonEmptyStr(person.lastname) || nonEmptyStr(raw.lastname),
    ].filter(Boolean).join(" ") ||
    nonEmptyStr(raw.full_name) ||
    nonEmptyStr(raw.name);
  const jobTitle =
    nonEmptyStr(person.job_title) ||
    nonEmptyStr(person.jobTitle) ||
    nonEmptyStr(person.lastJobTitle) ||
    nonEmptyStr(person.title) ||
    nonEmptyStr(person.headline) ||
    nonEmptyStr(person.position) ||
    nonEmptyStr(exp.job_title) ||
    nonEmptyStr(exp.jobTitle) ||
    nonEmptyStr(exp.title) ||
    nonEmptyStr(raw.lastJobTitle) ||
    nonEmptyStr(raw.job_title) ||
    nonEmptyStr(raw.title);
  const compObj = isObject(person.company) ? person.company : isObject(raw.organization) ? raw.organization : null;
  const company =
    (typeof person.company === "string" ? person.company.trim() : "") ||
    nonEmptyStr(person.company_name) ||
    nonEmptyStr(person.companyName) ||
    nonEmptyStr(person.lastCompanyName) ||
    nonEmptyStr(exp.company_name) ||
    nonEmptyStr(exp.companyName) ||
    nonEmptyStr(compObj?.name) ||
    nonEmptyStr(raw.lastCompanyName) ||
    nonEmptyStr(raw.companyName) ||
    nonEmptyStr(raw.company_name);
  const companyDomain =
    nonEmptyStr(exp.company_domain) ||
    nonEmptyStr(exp.companyDomain) ||
    nonEmptyStr(raw.lastCompanyWebsite) ||
    nonEmptyStr(person.lastCompanyWebsite) ||
    nonEmptyStr(raw.companyWebsite) ||
    nonEmptyStr(raw.company_website) ||
    nonEmptyStr(compObj?.website_url) ||
    nonEmptyStr(compObj?.domain);
  const companyLinkedin =
    nonEmptyStr(exp.company_linkedin_url) ||
    nonEmptyStr(exp.companyLinkedinUrl) ||
    nonEmptyStr(raw.lastCompanyUrl) ||
    nonEmptyStr(person.lastCompanyUrl) ||
    nonEmptyStr(raw.companyLinkedinUrl) ||
    nonEmptyStr(raw.company_linkedin_url) ||
    nonEmptyStr(compObj?.linkedin_url);
  const companyLinkedinId =
    nonEmptyStr(exp.company_linkedin_id) ||
    nonEmptyStr(exp.companyLinkedinId) ||
    nonEmptyStr(raw.lastCompanyUrn) ||
    nonEmptyStr(person.lastCompanyUrn) ||
    nonEmptyStr(raw.companyUrn) ||
    nonEmptyStr(raw.company_urn) ||
    nonEmptyStr(raw.linkedinNumID) ||
    nonEmptyStr(raw.linkedin_num_id) ||
    nonEmptyStr(raw.company_linkedin_id);
  const urls = isObject(person.URLs) ? person.URLs : null;
  const linkedin =
    nonEmptyStr(person.linkedin_url) ||
    nonEmptyStr(person.linkedinUrl) ||
    nonEmptyStr(person.linkedin) ||
    nonEmptyStr(person.profile_url) ||
    nonEmptyStr(person.profileUrl) ||
    nonEmptyStr(person.profileURL) ||
    nonEmptyStr(urls?.linkedin) ||
    nonEmptyStr(urls?.profile) ||
    nonEmptyStr(raw.linkedin_url) ||
    nonEmptyStr(raw.linkedin) ||
    nonEmptyStr(raw.profileUrl) ||
    nonEmptyStr(raw.profileURL);
  const email = nonEmptyStr(person.email) || nonEmptyStr(raw.email);
  const id = nonEmptyStr(raw.id) || nonEmptyStr(raw.personID) || nonEmptyStr(raw.person_id) || nonEmptyStr(person.id) || linkedin || email;
  return { id, fullName, jobTitle, company, companyDomain, companyLinkedin, companyLinkedinId, linkedin };
}

export function extractCompanyPreview(raw: Record<string, unknown>) {
  const linkedin = nonEmptyStr(raw.linkedin_url) || nonEmptyStr(raw.linkedinUrl) || nonEmptyStr(raw.linkedin) || nonEmptyStr(raw.company_linkedin_url);
  const website = nonEmptyStr(raw.website_url) || nonEmptyStr(raw.website) || nonEmptyStr(raw.domain) || nonEmptyStr(raw.url);
  const name = nonEmptyStr(raw.name) || nonEmptyStr(raw.company_name) || nonEmptyStr(raw.companyName) || nonEmptyStr(raw.title);
  const id = linkedin || nonEmptyStr(raw.id) || website || name;
  return { id, name, website, linkedin };
}

export function buildSavedPeopleMapCode(rowExpr: string, extraFields: ReadonlyArray<SourceField> = []): string {
  const extra = extraFieldAssignments(extraFields, new Set(["id", "full_name", "job_title", "company", "linkedin", "email", "phone"]));
  return [
    `const list = ${rowExpr};`,
    `if (!Array.isArray(list)) return [];`,
    `const s = (v) => typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";`,
    ...(extra.length > 0 ? [`const atPath = (obj, p) => { const v = p.split(".").reduce((c, k) => (c && typeof c === "object" ? c[k] : undefined), obj); return v === undefined || v === null || typeof v === "boolean" ? "" : s(v); };`] : []),
    `return list.filter((r) => r && typeof r === "object").map((r) => {`,
    `  const p = r.person && typeof r.person === "object" ? r.person : r;`,
    `  const exps = Array.isArray(p.experiences) ? p.experiences : Array.isArray(r.experiences) ? r.experiences : Array.isArray(r.employment_history) ? r.employment_history : Array.isArray(r.positionList) ? r.positionList : [];`,
    `  const exp = exps.find((x) => x && typeof x === "object" && !x.endDate) || exps.find((x) => x && typeof x === "object") || {};`,
    `  const compObj = p.company && typeof p.company === "object" ? p.company : r.organization && typeof r.organization === "object" ? r.organization : {};`,
    `  const urls = p.URLs && typeof p.URLs === "object" ? p.URLs : {};`,
    `  const full_name = s(p.full_name) || s(p.fullName) || s(p.name) || [s(p.first_name) || s(p.firstName) || s(p.firstname) || s(r.firstname), s(p.last_name) || s(p.lastName) || s(p.lastname) || s(r.lastname)].filter(Boolean).join(" ").trim() || s(r.full_name) || s(r.name);`,
    `  const job_title = s(p.job_title) || s(p.jobTitle) || s(p.lastJobTitle) || s(p.title) || s(p.headline) || s(p.position) || s(exp.job_title) || s(exp.jobTitle) || s(exp.title) || s(r.lastJobTitle) || s(r.job_title) || s(r.title);`,
    `  const company = (typeof p.company === "string" ? p.company.trim() : "") || s(p.company_name) || s(p.companyName) || s(p.lastCompanyName) || s(exp.company_name) || s(exp.companyName) || s(compObj.name) || s(r.lastCompanyName) || s(r.companyName) || s(r.company_name);`,
    `  const linkedin = s(p.linkedin_url) || s(p.linkedinUrl) || s(p.linkedin) || s(p.profile_url) || s(p.profileUrl) || s(p.profileURL) || s(urls.linkedin) || s(urls.profile) || s(r.linkedin_url) || s(r.linkedin) || s(r.profileUrl) || s(r.profileURL);`,
    `  const email = s(p.email) || s(r.email) || s(p.work_email) || s(r.work_email);`,
    `  const phone = s(p.phone) || s(r.phone) || s(p.mobile) || s(r.mobile);`,
    `  const id = s(r.id) || s(r.personID) || s(r.person_id) || s(p.id) || linkedin || email;`,
    `  return {`,
    `    id, full_name, job_title, company, linkedin, email, phone,`,
    ...extra,
    `  };`,
    `}).filter((row) => row.id && row.full_name && (row.job_title || row.company || row.linkedin));`,
  ].join("\n");
}

export function buildSavedCompanyMapCode(rowExpr: string, extraFields: ReadonlyArray<SourceField> = []): string {
  const extra = extraFieldAssignments(extraFields, new Set(["id", "name", "industry", "city", "country", "website", "linkedin", "phone", "address", "email"]));
  return [
    `const list = ${rowExpr};`,
    `if (!Array.isArray(list)) return [];`,
    `const s = (v) => typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";`,
    ...(extra.length > 0 ? [`const atPath = (obj, p) => { const v = p.split(".").reduce((c, k) => (c && typeof c === "object" ? c[k] : undefined), obj); return v === undefined || v === null || typeof v === "boolean" ? "" : s(v); };`] : []),
    `return list.filter((r) => r && typeof r === "object").map((r, i) => {`,
    `  const linkedin = s(r.linkedin_url) || s(r.linkedinUrl) || s(r.linkedin) || s(r.company_linkedin_url);`,
    `  const website = s(r.website_url) || s(r.website) || s(r.domain) || s(r.url);`,
    `  const name = s(r.name) || s(r.company_name) || s(r.companyName) || s(r.title);`,
    `  const phone = s(r.phone_number) || s(r.phone) || s(r.telephone) || s(r.mobile);`,
    `  const address = s(r.street_address) || s(r.address) || s(r.full_address) || s(r.formatted_address);`,
    `  const email = s(r.email) || s(r.contact_email) || s(r.public_email);`,
    `  const id = linkedin || s(r.id) || website || name || ("company_" + (i + 1));`,
    `  return {`,
    `    id,`,
    `    name,`,
    `    industry: s(r.industry) || s(r.sector) || s(r.category) || s(r.description),`,
    `    city: s(r.city) || s(r.locality) || s(r.location),`,
    `    country: s(r.country) || s(r.country_code),`,
    `    website,`,
    `    linkedin,`,
    `    phone,`,
    `    address,`,
    `    email,`,
    ...extra,
    `  };`,
    `}).filter((row) => row.id && row.name);`,
  ].join("\n");
}

const SOCIAL_OR_PLATFORM_HOSTS = new Set([
  "linkedin.com", "lnkd.in", "facebook.com", "fb.com", "twitter.com", "x.com",
  "instagram.com", "youtube.com", "youtu.be", "t.me", "tiktok.com", "github.com",
]);
const LINKEDIN_NUMERIC_ID = /^\d{4,15}$/;
const URN_COMPANY_ID = /^urn:li:[^:]+:(\d{4,15})$/i;
const PARAMS_IGNORE_FOR_LINK = /^(?:page|per_?page|limit|max_?results|count|size|offset|country|country_code|cursor)$/i;

export const normalizeHostToken = (raw: string): string => {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || /^urn:/i.test(trimmed)) return "";
  const noScheme = trimmed.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const host = (noScheme.split(/[/?#]/)[0] ?? "").split(":")[0] ?? "";
  if (!host.includes(".") || host.length < 4 || SOCIAL_OR_PLATFORM_HOSTS.has(host)) return "";
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : "";
};

export const linkedinCompanyTokens = (raw: string): { slug: string; numericId: string; hostFromSlug: string } => {
  const trimmed = raw.trim().toLowerCase().replace(/\/+$/, "");
  if (!trimmed) return { slug: "", numericId: "", hostFromSlug: "" };
  const urn = URN_COMPANY_ID.exec(trimmed);
  if (urn) return { slug: urn[1], numericId: urn[1], hostFromSlug: "" };
  if (LINKEDIN_NUMERIC_ID.test(trimmed)) return { slug: trimmed, numericId: trimmed, hostFromSlug: "" };
  const m = /(?:^|\/\/|\.)linkedin\.com\/company\/([^/?#]+)/i.exec(trimmed);
  if (!m) return { slug: "", numericId: "", hostFromSlug: "" };
  const seg = m[1].toLowerCase().replace(/\/+$/, "");
  if (!seg) return { slug: "", numericId: "", hostFromSlug: "" };
  const numericId = LINKEDIN_NUMERIC_ID.test(seg) ? seg : "";
  const hostFromSlug = normalizeHostToken(seg);
  return { slug: seg, numericId, hostFromSlug };
};

const normalizeCompanyNameToken = (raw: string): string => {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/\b(?:inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|sa|sae|s\.a\.e)\b\.?/g, " ")
    .replace(/(?:^|\s)شركة(?:\s|$)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length >= 3 ? s : "";
};

export function parentCompanyMatchScore(params: Record<string, unknown>, rows: ReadonlyArray<Record<string, unknown>>, parentRows: Array<Record<string, unknown>>): number {
  if (parentRows.length === 0) return 0;
  if (parentBinding(params, parentRows)) return 2;
  const parentHosts = new Set<string>();
  const parentSlugs = new Set<string>();
  const parentNumericIds = new Set<string>();
  const parentNames = new Set<string>();
  for (const p of parentRows) {
    for (const v of [p.name, p.company_name, p.companyName, p.website, p.website_url, p.domain, p.url]) {
      const s = nonEmptyStr(v);
      if (!s) continue;
      const host = normalizeHostToken(s);
      if (host) parentHosts.add(host);
    }
    for (const v of [p.name, p.company_name, p.companyName]) {
      const n = normalizeCompanyNameToken(nonEmptyStr(v));
      if (n) parentNames.add(n);
    }
    for (const v of [p.linkedin_url, p.linkedinUrl, p.linkedin, p.linkedin_id, p.linkedinId, p.linkedin_num_id, p.linkedinNumID, p.company_linkedin_id, p.urn]) {
      const tok = linkedinCompanyTokens(nonEmptyStr(v));
      if (tok.slug) parentSlugs.add(tok.slug);
      if (tok.numericId) parentNumericIds.add(tok.numericId);
      if (tok.hostFromSlug) parentHosts.add(tok.hostFromSlug);
    }
  }
  const matchesToken = (val: unknown): boolean => {
    const raw = nonEmptyStr(val);
    if (!raw) return false;
    const host = normalizeHostToken(raw);
    if (host && parentHosts.has(host)) return true;
    const li = linkedinCompanyTokens(raw);
    if (li.numericId && parentNumericIds.has(li.numericId)) return true;
    if (li.slug && parentSlugs.has(li.slug)) return true;
    if (li.hostFromSlug && parentHosts.has(li.hostFromSlug)) return true;
    if (li.slug && !li.numericId && !li.hostFromSlug && parentNames.has(normalizeCompanyNameToken(li.slug))) return true;
    return false;
  };
  for (const [pk, pv] of Object.entries(params)) {
    if (PARAMS_IGNORE_FOR_LINK.test(pk)) continue;
    if (matchesToken(pv)) return 2;
    const pname = typeof pv === "string" ? normalizeCompanyNameToken(pv) : "";
    if (pname && parentNames.has(pname)) return 2;
  }
  if (parentNames.size === 0 && parentHosts.size === 0 && parentSlugs.size === 0 && parentNumericIds.size === 0) return 0;
  for (const r of rows) {
    const pv = extractPersonPreview(r);
    if (matchesToken(pv.companyDomain) || matchesToken(pv.companyLinkedin) || matchesToken(pv.companyLinkedinId)) return 1;
    const compNorm = normalizeCompanyNameToken(pv.company);
    if (compNorm && parentNames.has(compNorm)) return 1;
    const compHost = normalizeHostToken(pv.company);
    if (compHost && parentHosts.has(compHost)) return 1;
  }
  return 0;
}

const isPeopleEndpoint = (ep: CatalogEndpoint | undefined): boolean => Boolean(ep?.capability && PEOPLE_OF_COMPANY_CAPABILITIES.has(ep.capability));

async function readRawRows(store: AgentStore, missionId: string, callId: string, ep: CatalogEndpoint | undefined): Promise<{ rawText: string | null; rawJson: unknown; rowExpr: string; rawRows: Array<Record<string, unknown>> }> {
  const rawText = await store.getFile(missionId, RAW_PATH(callId));
  let rawJson: unknown = null;
  let rowExpr = `inputs.${callId}.results`;
  let rawRows: Array<Record<string, unknown>> = [];
  if (rawText !== null) {
    try {
      rawJson = JSON.parse(rawText);
      if (ep) {
        const { reading } = buildShapeDigest(rawJson, ep);
        rowExpr = rowsExpressionOf(callId, reading.listPath, reading.listStrategy) ?? rowExpr;
        rawRows = reading.rows.filter(isObject);
      }
    } catch { /* ignore malformed raw file */ }
  }
  return { rawText, rawJson, rowExpr, rawRows };
}

export async function inspectSavedCompanyAndPeople(params: {
  mission: MissionRecord;
  store: AgentStore;
  catalog: TregCatalog;
  calls: CallRow[];
  callParams: Map<string, Record<string, unknown>>;
  stagesIn?: Array<Record<string, unknown>>;
}): Promise<SavedEvidenceInspection> {
  const { mission, store, catalog, calls, callParams, stagesIn = [] } = params;
  const planning = calls.filter((c) => (c.phase ?? "planning") === "planning");
  const hasOwnLimit = planning.some((c) => c.status === "refused" && OWN_LIMIT_REFUSAL.test(String(c.refused_reason ?? "")));
  const prefix = `${mission.id}:`;

  // Inspect root parent rows either from proposed root stage or from saved company calls
  const rootFromStages = stagesIn.find((st) => isObject(st) && (st.parent_key === null || st.parent_key === undefined || st.parent_key === ""));
  const rootKey = isObject(rootFromStages) && typeof rootFromStages.key === "string" && rootFromStages.key ? rootFromStages.key : "companies";
  let parentRowsFromStage: Array<Record<string, unknown>> = [];
  if (isObject(rootFromStages) && typeof rootFromStages.yield_from === "string" && FILE_ID.test(rootFromStages.yield_from)) {
    const fileId = rootFromStages.yield_from;
    const raw = await store.getFile(mission.id, fileId.startsWith("call_") ? `raw/${fileId}.json` : `out/${fileId}.json`);
    try {
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr) && arr.length > 0 && arr.every(isObject)) parentRowsFromStage = arr;
    } catch { /* fall through */ }
  } else if (isObject(rootFromStages) && Array.isArray(rootFromStages.sample_rows) && rootFromStages.sample_rows.some(isObject)) {
    parentRowsFromStage = rootFromStages.sample_rows.filter(isObject);
  }

  const companyCandidates: SavedCompanyCandidate[] = [];
  const rawPeopleEntries: Array<{ call: CallRow; callId: string; ep: CatalogEndpoint | undefined; parsed: Awaited<ReturnType<typeof readRawRows>> }> = [];
  let hasMissingRawPeople = false;
  let hasMissingRawCompanies = false;
  let anyPeopleOkOrEmpty = false;
  let anyCompanyOk = false;

  for (const c of planning) {
    const ep = catalog.byId.get(c.endpoint_id);
    const peopleEp = isPeopleEndpoint(ep);
    if (peopleEp && (c.status === "ok" || c.status === "empty")) anyPeopleOkOrEmpty = true;
    if (c.status !== "ok") continue;
    const rows = Number(c.rows_returned) || 0;
    if (rows <= 0) continue;
    const callId = c.id.startsWith(prefix) ? c.id.slice(prefix.length) : c.id;
    const parsed = await readRawRows(store, mission.id, callId, ep);
    if (peopleEp) {
      if (parsed.rawText === null) hasMissingRawPeople = true;
      rawPeopleEntries.push({ call: c, callId, ep, parsed });
    } else if (!isContactSource(c.endpoint_id)) {
      anyCompanyOk = true;
      if (parsed.rawText === null) hasMissingRawCompanies = true;
      const usable = parsed.rawRows.some((r) => {
        const p = extractCompanyPreview(r);
        return Boolean(p.id && p.name);
      });
      companyCandidates.push({ callId, endpointId: c.endpoint_id, rows, rowExpr: parsed.rowExpr, rawJson: parsed.rawJson, rawRows: parsed.rawRows, usable });
    }
  }

  companyCandidates.sort((a, b) => Number(b.usable) - Number(a.usable) || b.rows - a.rows || a.callId.localeCompare(b.callId));
  const usableCompanyCandidates = companyCandidates.filter((c) => c.usable);
  const allSavedCompanyRows = usableCompanyCandidates.flatMap((c) => c.rawRows);
  const linkParentRows = parentRowsFromStage.length > 0 ? [...parentRowsFromStage, ...allSavedCompanyRows] : allSavedCompanyRows;

  const peopleCandidates: SavedPeopleCandidate[] = [];
  for (const entry of rawPeopleEntries) {
    const { call: c, callId, parsed } = entry;
    const rows = Number(c.rows_returned) || 0;
    const usable = parsed.rawRows.some((r) => {
      const p = extractPersonPreview(r);
      return Boolean(p.id && p.fullName && (p.jobTitle || p.company || p.linkedin));
    });
    const pDigest = Object.fromEntries(Object.entries(c.params_digest ?? {}).filter(([k]) => !k.startsWith("__")));
    const cParams = callParams.get(callId) ?? pDigest;
    const linkScore = parentCompanyMatchScore(cParams, parsed.rawRows, linkParentRows);
    const matchedCompanyCallIds = linkScore > 0
      ? usableCompanyCandidates.filter((co) => parentCompanyMatchScore(cParams, parsed.rawRows, co.rawRows) > 0).map((co) => co.callId)
      : [];
    peopleCandidates.push({ callId, endpointId: c.endpoint_id, rows, rowExpr: parsed.rowExpr, rawJson: parsed.rawJson, rawRows: parsed.rawRows, usable, linkScore, parentKey: rootKey, matchedCompanyCallIds });
  }

  peopleCandidates.sort((a, b) => Number(b.usable) - Number(a.usable) || b.linkScore - a.linkScore || b.rows - a.rows || a.callId.localeCompare(b.callId));
  const savedPeopleMap = new Map<string, Array<SavedEndpointCallDetail>>();
  for (const cand of peopleCandidates) {
    const list = savedPeopleMap.get(cand.endpointId) ?? [];
    list.push({ callId: cand.callId, rows: cand.rows, rowPath: cand.rowExpr, ...(cand.parentKey ? { parentKey: cand.parentKey } : {}), linkedToParent: cand.linkScore > 0, linkScore: cand.linkScore });
    savedPeopleMap.set(cand.endpointId, list);
  }

  return { hasOwnLimit, peopleCandidates, savedPeopleMap, companyCandidates, hasMissingRawPeople, hasMissingRawCompanies, anyPeopleOkOrEmpty, anyCompanyOk };
}

function roleMismatchDetected(linkedCandidates: SavedPeopleCandidate[], nounAr: string | undefined, requestText: string): boolean {
  const roleKeys: ReadonlyArray<RoleKey> = ["manager", "engineer", "sales", "hr", "accountant"];
  const detectedKey = roleKeys.find((k) => namesRoleAr(requestText, k, false));
  const roleDef = roleOfNoun(nounAr) ?? (detectedKey ? roleDefOf(detectedKey) : null);
  if (!roleDef) return false;
  const previews = linkedCandidates.flatMap((c) => c.rawRows.map(extractPersonPreview)).filter((p) => p.fullName);
  if (previews.length === 0) return false;
  const titled = previews.filter((p) => p.jobTitle !== "");
  if (titled.length === 0) return false;
  const hasMatchOrUnclear = titled.some((p) => {
    const tier = titleTierOf(p.jobTitle, roleDef.key);
    const verdict = titleRoleVerdict(p.jobTitle, roleDef.key);
    return verdict === "match" || tier <= 1;
  });
  return !hasMatchOrUnclear;
}

export async function recordQuestionOnce(opts: {
  store: AgentStore;
  missionId: string;
  question_ar: string;
  options_ar: string[];
  log?: (line: string) => void;
}): Promise<boolean> {
  const runState = await readRunState(opts.store, opts.missionId);
  if (runState.peopleRecoveryAsked === true) return false;
  await updateRunState(opts.store, opts.missionId, (s) => ({ ...s, peopleRecoveryAsked: true, questionsAsked: (s.questionsAsked ?? 0) + 1 }), opts.log);
  await opts.store.updateMission(opts.missionId, { plan_public: { question_options: opts.options_ar } as any });
  await opts.store.addEvent(opts.missionId, { kind: "question", message_ar: opts.question_ar });
  return true;
}

function isStageAllowed(endpointId: string, catalog: TregCatalog, access: AccountAccess): boolean {
  return isSellable(endpointId, catalog) && !blockedEndpointReason(endpointId) && policyVerdict(endpointId, access).allowed && !isPrivateCapabilityString(catalog.byId.get(endpointId)?.capability);
}

export async function recoverCompanyPeopleFromSavedEvidence(params: {
  mission: MissionRecord;
  store: AgentStore;
  catalog: TregCatalog;
  access: AccountAccess;
  capabilities?: CapabilityDiscovery;
  calls: CallRow[];
  callParams: Map<string, Record<string, unknown>>;
  codeRuns: Map<string, CodeRun>;
  outSeq: number;
  stagesIn?: Array<Record<string, unknown>>;
  summaryHint?: string;
  assumptionsHint?: unknown;
  understoodCompanies?: UnderstoodCompaniesSummary;
  understoodPeople?: UnderstoodPeopleSummary;
  runSandbox: (code: string, inputs: Record<string, unknown>) => Promise<SandboxResult>;
  loadEvidenceMap: (stagesList: Array<Record<string, unknown>>) => Promise<Map<string, string | null>>;
  makeLookup: (evMap: Map<string, string | null>) => Parameters<typeof validateAndPricePlan>[1];
  finalizePlan: (planIn: PricedPlan, evMap: Map<string, string | null>, opts: { skipAdvice?: boolean }) => Promise<{ ok: true; plan: PricedPlan } | { ok: false; advice?: string[]; issues?: string[] }>;
  inspection?: SavedEvidenceInspection;
  log?: (line: string) => void;
}): Promise<RecoveryResult> {
  const { mission, store, catalog, access, capabilities, calls, callParams, codeRuns, stagesIn = [], summaryHint, assumptionsHint, understoodCompanies, understoodPeople, runSandbox, loadEvidenceMap, makeLookup, finalizePlan, log } = params;
  const inspection = params.inspection ?? await inspectSavedCompanyAndPeople({ mission, store, catalog, calls, callParams, stagesIn });

  const finishDiag = <T extends "none" | "own_limit" | "sources_unavailable">(kind: T, reason: string, issueCodes: ReadonlyArray<string> = [], capIssues: ReadonlyArray<string> = []): RecoveryResult => {
    const cleanCap = sanitizeCapIssuesForAdmin(capIssues, 2);
    const diagnostic: RecoveryDiagnostic = {
      reason,
      issueCodes: [...new Set(issueCodes)],
      ...(cleanCap.length > 0 ? { capIssues: cleanCap } : {}),
    };
    lastRecoveryDiagnostic.set(mission.id, diagnostic);
    return { kind, diagnostic } as RecoveryResult;
  };
  const clearDiag = () => {
    lastRecoveryDiagnostic.delete(mission.id);
  };

  const requestText = askedTextOf(mission);
  const peopleRequested = Boolean(understoodPeople) || inspection.peopleCandidates.length > 0;
  if (!peopleRequested) return finishDiag("none", "not_people_request");

  // Discover validated stages + eligible endpoints FROM capability discovery when enabled
  const discoveryPeopleStage = capabilities
    ? capabilities.stages.find((s) => s.stage.operation === "people.discover" && s.stage.parentKey !== null) ?? null
    : null;
  const discoveryRootStage = capabilities
    ? (discoveryPeopleStage?.stage.parentKey
        ? capabilities.stages.find((s) => s.stage.key === discoveryPeopleStage.stage.parentKey) ?? null
        : capabilities.stages.find((s) => s.stage.operation === "companies.discover" && s.stage.parentKey === null) ?? null)
    : null;
  const rootStageKey = discoveryRootStage?.stage.key || "companies";
  const peopleStageKey = discoveryPeopleStage?.stage.key || "people";
  const eligibleRootIds = discoveryRootStage ? new Set(discoveryRootStage.eligible.map((e) => e.id)) : null;
  const eligiblePeopleIds = discoveryPeopleStage ? new Set(discoveryPeopleStage.eligible.map((e) => e.id)) : null;
  const eligiblePeopleRank = new Map((discoveryPeopleStage?.eligible ?? []).map((e, i) => [e.id, i] as const));

  // Any company source gave positive rows?
  const rootCandidateFromStages = stagesIn.find((st) => isObject(st) && (st.parent_key === null || st.parent_key === undefined || st.parent_key === ""));
  const usableCompanies = inspection.companyCandidates.filter((c) => c.usable && c.rawJson !== null);
  const usableCompany = usableCompanies[0];
  const hasCompanyEvidence = Boolean(usableCompany) || (Boolean(rootCandidateFromStages) && inspection.anyCompanyOk);
  if (!hasCompanyEvidence && !usableCompany) {
    return inspection.hasOwnLimit
      ? finishDiag("own_limit", "no_company_evidence_own_limit")
      : finishDiag("none", "no_company_evidence");
  }

  // Counter-cases: missing raw people file or incompatible raw rows (e.g. non-person blobs) -> never invent card or question
  const usablePeople = inspection.peopleCandidates.filter((p) => p.usable);
  if (inspection.peopleCandidates.length > 0 && usablePeople.length === 0) {
    return finishDiag("none", "unusable_people_rows");
  }

  // No positive people call answered (all failed 402/422/timeout/refused or never tried; note answeredEmpty preserves plan_invalid_after_N when all people calls returned 0 rows)
  if (inspection.peopleCandidates.length === 0) {
    if (inspection.hasOwnLimit) return finishDiag("own_limit", "no_people_candidates_own_limit");
    if (inspection.anyPeopleOkOrEmpty) return finishDiag("none", "no_people_candidates_empty");
    return finishDiag("sources_unavailable", "no_people_candidates_unavailable");
  }

  // Positive usable people exist: verify parent linkage
  const linkedPeople = usablePeople.filter((p) => p.linkScore > 0 && p.rawJson !== null);
  const runState = await readRunState(store, mission.id);
  const alreadyAsked = runState.peopleRecoveryAsked === true || Boolean(mission.answer_text);
  const canAskOverCap = runState.peopleRecoveryAsked !== true;

  if (linkedPeople.length === 0) {
    if (alreadyAsked) return finishDiag("none", "no_linked_people");
    const question_ar = "لم نتمكن من ربط نتائج مسؤولي الشركات تلقائيًا بالخطة؛ هل تفضّل الاستمرار بالشركات فقط أم تحديد مسمى وظيفي آخر؟";
    const options_ar = ["الاستمرار بالشركات فقط", "تحديد مسمى وظيفي آخر"];
    if (checkCustomerText(question_ar).issues.length === 0) {
      clearDiag();
      return { kind: "question", question_ar, options_ar };
    }
    return finishDiag("none", "no_linked_people");
  }

  // Check role compatibility (Driver/Intern vs requested Managers -> never fabricate manager card)
  if (roleMismatchDetected(linkedPeople, understoodPeople?.noun_ar, requestText)) {
    if (alreadyAsked) return finishDiag("none", "role_mismatch");
    const roleLabel = understoodPeople?.noun_ar?.trim() || "المديرين";
    const question_ar = `المتاح حاليًا في بيانات مسؤولي الشركات لا يطابق المسمى المطلوب (${roleLabel})؛ هل تفضّل الاستمرار بالشركات فقط أم توسيع المسمى الوظيفي المتاح؟`;
    const options_ar = ["الاستمرار بالشركات فقط", "توسيع المسمى الوظيفي المتاح"];
    if (checkCustomerText(question_ar).issues.length === 0) {
      clearDiag();
      return { kind: "question", question_ar, options_ar };
    }
    return finishDiag("none", "role_mismatch");
  }

  // When capability discovery is active: never plan non-eligible people endpoints; prefer eligible + saved evidence,
  // else record exact capability reason + issues and ask ONE honest question (never «حد من جانبنا» when rows exist).
  const collectedCapIssues: string[] = [];
  let candidatesToPlan = linkedPeople;
  if (capabilities) {
    const sampleRootEp = usableCompanies.find((c) => !eligibleRootIds || eligibleRootIds.has(c.endpointId))?.endpointId
      ?? discoveryRootStage?.selected
      ?? usableCompany?.endpointId
      ?? "";
    const evalCapIssuesForPeople = (epIds: ReadonlyArray<string>): string[] => {
      const out: string[] = [];
      for (const epId of epIds) {
        const issues = planStageIssues(
          [
            { key: rootStageKey, endpoint_id: sampleRootEp, parent_key: null },
            { key: peopleStageKey, endpoint_id: epId, parent_key: rootStageKey },
          ],
          capabilities,
          catalog,
        );
        out.push(...issues);
      }
      return out;
    };

    if (!discoveryPeopleStage || !eligiblePeopleIds || eligiblePeopleIds.size === 0) {
      const rawCapIssues = evalCapIssuesForPeople(linkedPeople.map((p) => p.endpointId));
      const noStageIssues = rawCapIssues.length > 0 ? rawCapIssues : [`stage ${peopleStageKey}: no eligible capability in discovery`];
      const diag: RecoveryDiagnostic = {
        reason: "capability_no_people_stage",
        issueCodes: ["cap_stage_issues", "no_eligible_people_capability"],
        capIssues: sanitizeCapIssuesForAdmin(noStageIssues, 2),
      };
      lastRecoveryDiagnostic.set(mission.id, diag);
      if (canAskOverCap) {
        const question_ar = "مصادر بيانات مسؤولي الشركات التي جُرّبت لا تتوافق مع خطة الاستخراج المعتمدة حاليًا، وتتوفر قائمة الشركات نفسها؛ هل تفضّل الاستمرار بالشركات فقط أم إعادة المحاولة؟";
        const options_ar = ["الاستمرار بالشركات فقط", "إعادة المحاولة بمصدر آخر"];
        if (checkCustomerText(question_ar).issues.length === 0) {
          return { kind: "question", question_ar, options_ar, diagnostic: diag };
        }
      }
      return { kind: "none", diagnostic: diag };
    }

    const eligibleLinked = linkedPeople
      .filter((p) => eligiblePeopleIds.has(p.endpointId))
      .sort((a, b) =>
        b.linkScore - a.linkScore ||
        (eligiblePeopleRank.get(a.endpointId) ?? 999) - (eligiblePeopleRank.get(b.endpointId) ?? 999) ||
        b.rows - a.rows ||
        a.callId.localeCompare(b.callId),
      );
    const ineligibleLinked = linkedPeople.filter((p) => !eligiblePeopleIds.has(p.endpointId));
    if (ineligibleLinked.length > 0) {
      collectedCapIssues.push(...evalCapIssuesForPeople(ineligibleLinked.map((p) => p.endpointId)));
    }

    if (eligibleLinked.length === 0) {
      const rawIneligibleIssues = collectedCapIssues.length > 0
        ? collectedCapIssues
        : [`stage ${peopleStageKey}: sampled people endpoints are not eligible`];
      const diag: RecoveryDiagnostic = {
        reason: "sampled_people_not_eligible",
        issueCodes: ["sampled_people_not_eligible", "cap_stage_issues"],
        capIssues: sanitizeCapIssuesForAdmin(rawIneligibleIssues, 2),
      };
      lastRecoveryDiagnostic.set(mission.id, diag);
      if (canAskOverCap) {
        const question_ar = "مصادر بيانات مسؤولي الشركات التي جُرّبت لا تتوافق مع خطة الاستخراج المعتمدة حاليًا، وتتوفر قائمة الشركات نفسها؛ هل تفضّل الاستمرار بالشركات فقط أم إعادة المحاولة؟";
        const options_ar = ["الاستمرار بالشركات فقط", "إعادة المحاولة بمصدر آخر"];
        if (checkCustomerText(question_ar).issues.length === 0) {
          return { kind: "question", question_ar, options_ar, diagnostic: diag };
        }
      }
      return { kind: "none", diagnostic: diag };
    }

    candidatesToPlan = eligibleLinked;
  }

  const wants = requestWantsContacts(requestText);
  const peopleTitle = understoodPeople?.noun_ar?.trim() ? `${understoodPeople.noun_ar.trim()} كل شركة` : "مسؤولو كل شركة";
  const perCount = Math.max(1, understoodPeople?.per_parent ?? 1);
  let seq = params.outSeq;
  let sawOverCap = false;
  let sawCandidateRejected = false;
  let lastFailReason = "stage_not_allowed";
  const collectedIssueCodes: string[] = [];

  for (const linked of candidatesToPlan) {
    if (!isStageAllowed(linked.endpointId, catalog, access)) {
      collectedIssueCodes.push("stage_not_allowed");
      continue;
    }
    const peopleColumns: Array<{ key: string; title_ar: string; kind?: string }> = [
      { key: "full_name", title_ar: "الاسم الكامل" },
      { key: "job_title", title_ar: "المسمى الوظيفي" },
      { key: "company", title_ar: "الشركة" },
      { key: "linkedin", title_ar: "الملف المهني" },
      ...(wants.email ? [{ key: "email", title_ar: "الإيميل", kind: "work_email" }] : []),
      ...(wants.phone ? [{ key: "phone", title_ar: "رقم التليفون", kind: "phone" }] : []),
    ];
    const rawPeopleText = typeof linked.rawJson === "string" ? linked.rawJson : JSON.stringify(linked.rawJson);
    const peopleFields = usefulFieldsOfPage(rawPeopleText);
    const extraPeopleFields = uncoveredFields(peopleFields.filter((f) => !CONTRACT_ONLY_CLASSES.includes(f.cls) && SAFE_FIELD_PATH.test(f.path)), peopleColumns);
    for (const f of extraPeopleFields) {
      if (!peopleColumns.some((c) => c.key === f.cls)) peopleColumns.push({ key: f.cls, title_ar: FIELD_LABEL_AR[f.cls] });
    }
    const peopleCode = buildSavedPeopleMapCode(linked.rowExpr, extraPeopleFields);
    const sbPeople = await runSandbox(peopleCode, { [linked.callId]: linked.rawJson });
    let mappedPeople: unknown[] = [];
    if (sbPeople.ok && sbPeople.resultJson) {
      try {
        const parsed = JSON.parse(sbPeople.resultJson);
        if (Array.isArray(parsed)) mappedPeople = parsed;
      } catch { /* empty */ }
    }
    if (mappedPeople.length === 0 || !mappedPeople.every(isObject)) {
      lastFailReason = "people_map_empty";
      collectedIssueCodes.push("people_map_empty");
      continue;
    }

    seq += 1;
    const peopleOutId = outIdOf(seq);
    await store.putFile(mission.id, `out/${peopleOutId}.json`, JSON.stringify(mappedPeople), "application/json");
    codeRuns.set(peopleOutId, { code: peopleCode, files: [linked.callId] });
    try { await store.putNew(mission.id, codeRunPath(peopleOutId), JSON.stringify({ code: peopleCode, files: [linked.callId] }), "application/json"); } catch { /* ignore */ }

    const matchedIds = new Set(linked.matchedCompanyCallIds ?? []);
    const orderedCompanies = [
      ...usableCompanies.filter((c) => matchedIds.has(c.callId)),
      ...usableCompanies.filter((c) => !matchedIds.has(c.callId)),
    ];
    const preferredCompany = orderedCompanies[0];
    const companiesTarget = Math.max(
      1,
      Number(understoodCompanies?.expected_rows) ||
      Number(isObject(rootCandidateFromStages) ? rootCandidateFromStages.expected_rows : 0) ||
      Math.max(2, preferredCompany?.rows ?? 2),
    );

    const rootOptions: Array<Record<string, unknown>> = [];
    const rootCandidateAllowed = Boolean(rootCandidateFromStages && isObject(rootCandidateFromStages) && (!eligibleRootIds || eligibleRootIds.has(String(rootCandidateFromStages.endpoint_id ?? ""))));
    const rootMeasured = rootCandidateAllowed && isObject(rootCandidateFromStages) && Array.isArray(rootCandidateFromStages.measured_by)
      ? rootCandidateFromStages.measured_by.map(String)
      : [];
    const rootHasMatchedCompany = matchedIds.size === 0 || rootMeasured.some((id) => matchedIds.has(id));
    if (rootCandidateAllowed && isObject(rootCandidateFromStages) && rootHasMatchedCompany) {
      rootOptions.push({ ...rootCandidateFromStages, ...(capabilities ? { key: rootStageKey } : {}), expected_rows: Number(rootCandidateFromStages.expected_rows) || companiesTarget });
    }
    const allowedCompanies = orderedCompanies.filter((co) => co.rawJson !== null && isStageAllowed(co.endpointId, catalog, access) && (!eligibleRootIds || eligibleRootIds.has(co.endpointId)));
    for (const coCandidate of allowedCompanies.slice(0, 2)) {
      const rawCoText = typeof coCandidate.rawJson === "string" ? coCandidate.rawJson : JSON.stringify(coCandidate.rawJson);
      const coFields = usefulFieldsOfPage(rawCoText);
      const coFieldSet = new Set<FieldClass>(coFields.map((f) => f.cls));
      const coColumns: Array<{ key: string; title_ar: string }> = [
        { key: "name", title_ar: "اسم الشركة" },
        { key: "industry", title_ar: "النشاط والتخصص" },
        { key: "city", title_ar: "المدينة" },
        { key: "country", title_ar: "الدولة" },
        { key: "website", title_ar: "الموقع الإلكتروني" },
        { key: "linkedin", title_ar: "صفحة الشركة على الشبكة المهنية" },
        ...(coFieldSet.has("address") ? [{ key: "address", title_ar: FIELD_LABEL_AR.address }] : []),
        ...(coFieldSet.has("phone") ? [{ key: "phone", title_ar: "هاتف المقر الرئيسي" }] : []),
        ...(coFieldSet.has("email") ? [{ key: "email", title_ar: "الإيميل العام للشركة" }] : []),
      ];
      const extraCoFields = uncoveredFields(coFields.filter((f) => SAFE_FIELD_PATH.test(f.path)), coColumns);
      for (const f of extraCoFields) {
        if (!coColumns.some((c) => c.key === f.cls)) coColumns.push({ key: f.cls, title_ar: FIELD_LABEL_AR[f.cls] });
      }
      const companyCode = buildSavedCompanyMapCode(coCandidate.rowExpr, extraCoFields);
      const sbCo = await runSandbox(companyCode, { [coCandidate.callId]: coCandidate.rawJson });
      let mappedCo: unknown[] = [];
      if (sbCo.ok && sbCo.resultJson) {
        try {
          const parsed = JSON.parse(sbCo.resultJson);
          if (Array.isArray(parsed)) mappedCo = parsed;
        } catch { /* empty */ }
      }
      if (mappedCo.length > 0 && mappedCo.every(isObject)) {
        seq += 1;
        const coOutId = outIdOf(seq);
        await store.putFile(mission.id, `out/${coOutId}.json`, JSON.stringify(mappedCo), "application/json");
        codeRuns.set(coOutId, { code: companyCode, files: [coCandidate.callId] });
        try { await store.putNew(mission.id, codeRunPath(coOutId), JSON.stringify({ code: companyCode, files: [coCandidate.callId] }), "application/json"); } catch { /* ignore */ }
        const coCall = calls.find((c) => c.id === `${mission.id}:${coCandidate.callId}`);
        const coParams = callParams.get(coCandidate.callId) ?? coCall?.params_digest ?? {};
        const coQuery = ["query", "q", "keyword", "search", "search_query"].map((k) => coParams[k]).find((v) => typeof v === "string" && v.trim() !== "") as string | undefined;
        const needsRelFallback = Boolean(coQuery) && !requestNamesSector(`${requestText} ${mission.answer_text ?? ""}`);
        const relTerms = (understoodCompanies?.search_terms?.length ? understoodCompanies.search_terms : [understoodCompanies?.topic, coQuery].filter((v): v is string => typeof v === "string" && v.trim() !== "")).slice(0, 8);
        rootOptions.push({
          key: rootStageKey,
          title_ar: understoodCompanies?.title_ar?.trim() || "الشركات المطلوبة",
          endpoint_id: coCandidate.endpointId,
          expected_rows: companiesTarget,
          parent_key: null,
          deliver: true,
          columns: coColumns,
          measured_by: [coCandidate.callId],
          yield_from: coOutId,
          ...(needsRelFallback && relTerms.length > 0 ? { relevance: { subject_ar: understoodCompanies?.title_ar?.trim() || "الشركات المطلوبة", terms: relTerms, text_columns: ["name", "industry"], min_own_words: 0, review: true } } : {}),
        });
      }
    }
    if (rootCandidateAllowed && isObject(rootCandidateFromStages) && !rootHasMatchedCompany) {
      rootOptions.push({ ...rootCandidateFromStages, ...(capabilities ? { key: rootStageKey } : {}), expected_rows: Number(rootCandidateFromStages.expected_rows) || companiesTarget });
    }
    if (capabilities && rootOptions.length === 0 && usableCompanies.length > 0) {
      sawCandidateRejected = true;
      lastFailReason = "sampled_company_not_eligible";
      collectedIssueCodes.push("sampled_company_not_eligible", "cap_stage_issues");
      collectedCapIssues.push(...planStageIssues([{ key: rootStageKey, endpoint_id: usableCompanies[0].endpointId, parent_key: null }], capabilities, catalog));
    }

    for (const rootStage of rootOptions) {
      const pKey = typeof rootStage.key === "string" && rootStage.key ? rootStage.key : rootStageKey;
      const rootExpected = Math.max(1, Number(rootStage.expected_rows) || companiesTarget);
      const parentTitle = String(rootStage.title_ar ?? "الشركات").trim();
      const baseSummary = summaryHint ? firstSentenceAr(summaryHint).replace(/[.،]+$/, "") : "";
      const hintedSummary = `${baseSummary || `ستحصل على ${parentTitle}`}، ومع كل شركة مسؤولها حسب المتاح.`;
      const neutralSummary = `ستحصل على ${parentTitle}، ومع كل شركة مسؤولها حسب المتاح.`;
      const textVariants: Array<{ summary: string; assumptions: unknown }> = [
        { summary: hintedSummary, assumptions: assumptionsHint },
        ...(hintedSummary !== neutralSummary || assumptionsHint !== undefined ? [{ summary: neutralSummary, assumptions: undefined }] : []),
      ];
      const assembledStages: Array<Record<string, unknown>> = [
        rootStage,
        {
          key: peopleStageKey,
          title_ar: peopleTitle,
          endpoint_id: linked.endpointId,
          parent_key: pKey,
          per_parent_rows: perCount,
          expected_rows: rootExpected * perCount,
          deliver: true,
          columns: peopleColumns,
          measured_by: [linked.callId],
          yield_from: peopleOutId,
        },
      ];
      const capIssues = capabilities
        ? planStageIssues(assembledStages.map((st) => ({ key: String(st.key ?? ""), endpoint_id: String(st.endpoint_id ?? ""), parent_key: (st.parent_key as string | null) ?? null })), capabilities, catalog)
        : [];
      if (capIssues.length > 0) {
        sawCandidateRejected = true;
        lastFailReason = "capability_rejected";
        collectedIssueCodes.push("cap_stage_issues");
        collectedCapIssues.push(...capIssues);
        continue;
      }
      const evMap = await loadEvidenceMap(assembledStages);
      for (const tv of textVariants) {
        const checked = validateAndPricePlan({ summary_ar: tv.summary, stages: assembledStages as any, ...(tv.assumptions !== undefined ? { assumptions_ar: tv.assumptions as any } : {}) }, makeLookup(evMap));
        if (!checked.ok) {
          sawCandidateRejected = true;
          lastFailReason = "plan_rejected";
          if (checked.issues.some((i) => /more than the job limit|lower the expected rows/i.test(i))) sawOverCap = true;
          for (const issue of checked.issues) collectedIssueCodes.push(classifyRecoveryIssueCode(issue));
          log?.(`company_people_recovery_validate_failed ${mission.id} ${checked.issues.slice(0, 3).join("; ")}`);
          continue;
        }
        const fin = await finalizePlan(checked.plan, evMap, { skipAdvice: true });
        if (fin.ok) {
          clearDiag();
          return { kind: "plan", plan: fin.plan, outSeq: seq };
        }
        sawCandidateRejected = true;
        lastFailReason = "finalize_rejected";
        const finIssues = fin.issues ?? fin.advice ?? [];
        if (fin.issues?.length) collectedIssueCodes.push("finalize_derive", ...fin.issues.map(classifyRecoveryIssueCode));
        else if (fin.advice?.length) collectedIssueCodes.push("finalize_advice");
        else collectedIssueCodes.push("finalize_failed");
        log?.(`company_people_recovery_finalize_failed ${mission.id} ${finIssues.slice(0, 3).join("; ")}`);
      }
    }
  }

  if (sawOverCap && canAskOverCap) {
    const question_ar = "العدد المطلوب من الشركات يتجاوز الحد الأقصى لحجز المهمة الواحدة حاليًا؛ هل تفضّل تقليل العدد ليناسب الحد المتاح أم الاستمرار بالشركات فقط؟";
    const options_ar = ["تقليل العدد ليناسب الحد المتاح", "الاستمرار بالشركات فقط"];
    if (checkCustomerText(question_ar).issues.length === 0) {
      clearDiag();
      return { kind: "question", question_ar, options_ar };
    }
  }

  const finalReason = sawOverCap && !canAskOverCap
    ? "over_cap_question_blocked"
    : sawCandidateRejected
      ? lastFailReason
      : lastFailReason;
  return finishDiag("none", finalReason, collectedIssueCodes, collectedCapIssues);
}
