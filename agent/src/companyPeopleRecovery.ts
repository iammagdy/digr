import { PEOPLE_OF_COMPANY_CAPABILITIES } from "../../src/lib/agentMission/childSources";
import { isContactSource, requestWantsContacts } from "../../src/lib/agentMission/contacts";
import { firstSentenceAr, validateAndPricePlan, type PricedPlan, type SavedEndpointCallDetail } from "../../src/lib/agentMission/plan";
import { askedTextOf } from "../../src/lib/agentMission/requestContract";
import { namesRoleAr, roleDefOf, roleOfNoun, titleRoleVerdict, titleTierOf, type RoleKey } from "../../src/lib/agentMission/roles";
import { checkCustomerText } from "../../src/lib/agentMission/text";
import { isPrivateCapabilityString, planStageIssues, type CapabilityDiscovery } from "../../src/lib/agentMission/capabilities";
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
export const nonEmptyStr = (v: unknown): string => (typeof v === "string" && v.trim() !== "" ? v.trim() : typeof v === "number" ? String(v) : "");

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

export type RecoveryResult =
  | { kind: "plan"; plan: PricedPlan; outSeq: number }
  | { kind: "question"; question_ar: string; options_ar: string[] }
  | { kind: "sources_unavailable" }
  | { kind: "own_limit" }
  | { kind: "none" };

export function extractPersonPreview(raw: Record<string, unknown>) {
  const person = isObject(raw.person) ? raw.person : raw;
  const exps = Array.isArray(person.experiences) ? person.experiences : Array.isArray(raw.experiences) ? raw.experiences : Array.isArray(raw.employment_history) ? raw.employment_history : [];
  const exp = exps.find(isObject) ?? {};
  const fullName = nonEmptyStr(person.full_name) || nonEmptyStr(person.fullName) || nonEmptyStr(person.name) || [nonEmptyStr(person.first_name) || nonEmptyStr(person.firstName), nonEmptyStr(person.last_name) || nonEmptyStr(person.lastName)].filter(Boolean).join(" ") || nonEmptyStr(raw.full_name) || nonEmptyStr(raw.name);
  const jobTitle = nonEmptyStr(person.job_title) || nonEmptyStr(person.jobTitle) || nonEmptyStr(person.title) || nonEmptyStr(person.headline) || nonEmptyStr(person.position) || nonEmptyStr(exp.job_title) || nonEmptyStr(exp.title) || nonEmptyStr(raw.job_title) || nonEmptyStr(raw.title);
  const compObj = isObject(person.company) ? person.company : isObject(raw.organization) ? raw.organization : null;
  const company = (typeof person.company === "string" ? person.company.trim() : "") || nonEmptyStr(person.company_name) || nonEmptyStr(person.companyName) || nonEmptyStr(exp.company_name) || nonEmptyStr(exp.companyName) || nonEmptyStr(compObj?.name) || nonEmptyStr(raw.companyName) || nonEmptyStr(raw.company_name);
  const urls = isObject(person.URLs) ? person.URLs : null;
  const linkedin = nonEmptyStr(person.linkedin_url) || nonEmptyStr(person.linkedinUrl) || nonEmptyStr(person.linkedin) || nonEmptyStr(person.profile_url) || nonEmptyStr(urls?.linkedin) || nonEmptyStr(raw.linkedin_url) || nonEmptyStr(raw.linkedin);
  const email = nonEmptyStr(person.email) || nonEmptyStr(raw.email);
  const id = nonEmptyStr(raw.id) || nonEmptyStr(raw.personID) || nonEmptyStr(raw.person_id) || nonEmptyStr(person.id) || linkedin || email;
  return { id, fullName, jobTitle, company, linkedin };
}

export function extractCompanyPreview(raw: Record<string, unknown>) {
  const linkedin = nonEmptyStr(raw.linkedin_url) || nonEmptyStr(raw.linkedinUrl) || nonEmptyStr(raw.linkedin) || nonEmptyStr(raw.company_linkedin_url);
  const website = nonEmptyStr(raw.website_url) || nonEmptyStr(raw.website) || nonEmptyStr(raw.domain) || nonEmptyStr(raw.url);
  const name = nonEmptyStr(raw.name) || nonEmptyStr(raw.company_name) || nonEmptyStr(raw.companyName) || nonEmptyStr(raw.title);
  const id = linkedin || nonEmptyStr(raw.id) || website || name;
  return { id, name, website, linkedin };
}

export function buildSavedPeopleMapCode(rowExpr: string): string {
  return [
    `const list = ${rowExpr};`,
    `if (!Array.isArray(list)) return [];`,
    `const s = (v) => typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : "";`,
    `return list.filter((r) => r && typeof r === "object").map((r) => {`,
    `  const p = r.person && typeof r.person === "object" ? r.person : r;`,
    `  const exps = Array.isArray(p.experiences) ? p.experiences : Array.isArray(r.experiences) ? r.experiences : Array.isArray(r.employment_history) ? r.employment_history : [];`,
    `  const exp = exps.find((x) => x && typeof x === "object") || {};`,
    `  const compObj = p.company && typeof p.company === "object" ? p.company : r.organization && typeof r.organization === "object" ? r.organization : {};`,
    `  const urls = p.URLs && typeof p.URLs === "object" ? p.URLs : {};`,
    `  const full_name = s(p.full_name) || s(p.fullName) || s(p.name) || [s(p.first_name) || s(p.firstName), s(p.last_name) || s(p.lastName)].filter(Boolean).join(" ").trim() || s(r.full_name) || s(r.name);`,
    `  const job_title = s(p.job_title) || s(p.jobTitle) || s(p.title) || s(p.headline) || s(p.position) || s(exp.job_title) || s(exp.title) || s(r.job_title) || s(r.title);`,
    `  const company = (typeof p.company === "string" ? p.company.trim() : "") || s(p.company_name) || s(p.companyName) || s(exp.company_name) || s(exp.companyName) || s(compObj.name) || s(r.companyName) || s(r.company_name);`,
    `  const linkedin = s(p.linkedin_url) || s(p.linkedinUrl) || s(p.linkedin) || s(p.profile_url) || s(urls.linkedin) || s(r.linkedin_url) || s(r.linkedin);`,
    `  const email = s(p.email) || s(r.email) || s(p.work_email) || s(r.work_email);`,
    `  const phone = s(p.phone) || s(r.phone) || s(p.mobile) || s(r.mobile);`,
    `  const id = s(r.id) || s(r.personID) || s(r.person_id) || s(p.id) || linkedin || email;`,
    `  return { id, full_name, job_title, company, linkedin, email, phone };`,
    `}).filter((row) => row.id && row.full_name && (row.job_title || row.company || row.linkedin));`,
  ].join("\n");
}

export function buildSavedCompanyMapCode(rowExpr: string): string {
  return [
    `const list = ${rowExpr};`,
    `if (!Array.isArray(list)) return [];`,
    `const s = (v) => typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : "";`,
    `return list.filter((r) => r && typeof r === "object").map((r, i) => {`,
    `  const linkedin = s(r.linkedin_url) || s(r.linkedinUrl) || s(r.linkedin) || s(r.company_linkedin_url);`,
    `  const website = s(r.website_url) || s(r.website) || s(r.domain) || s(r.url);`,
    `  const name = s(r.name) || s(r.company_name) || s(r.companyName) || s(r.title);`,
    `  const id = linkedin || s(r.id) || website || name || ("company_" + (i + 1));`,
    `  return {`,
    `    id,`,
    `    name,`,
    `    industry: s(r.industry) || s(r.sector) || s(r.category) || s(r.description),`,
    `    city: s(r.city) || s(r.locality) || s(r.location),`,
    `    country: s(r.country) || s(r.country_code),`,
    `    website,`,
    `    linkedin,`,
    `  };`,
    `}).filter((row) => row.id && row.name);`,
  ].join("\n");
}

export function parentCompanyMatchScore(params: Record<string, unknown>, rows: ReadonlyArray<Record<string, unknown>>, parentRows: Array<Record<string, unknown>>): number {
  if (parentRows.length === 0) return 0;
  if (parentBinding(params, parentRows)) return 2;
  const parentNames = parentRows.flatMap((p) => [p.name, p.company_name, p.website, p.domain].map((v) => nonEmptyStr(v).toLowerCase()).filter((v) => v.length >= 3));
  if (parentNames.length === 0) return 0;
  for (const r of rows) {
    const comp = extractPersonPreview(r).company.toLowerCase();
    if (comp && parentNames.some((pn) => comp.includes(pn) || pn.includes(comp.split(" ")[0] ?? ""))) return 1;
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
  const fallbackParentRows = companyCandidates.find((c) => c.usable)?.rawRows ?? [];
  const linkParentRows = parentRowsFromStage.length > 0 ? parentRowsFromStage : fallbackParentRows;

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
    peopleCandidates.push({ callId, endpointId: c.endpoint_id, rows, rowExpr: parsed.rowExpr, rawJson: parsed.rawJson, rawRows: parsed.rawRows, usable, linkScore, parentKey: rootKey });
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
  finalizePlan: (planIn: PricedPlan, evMap: Map<string, string | null>, opts: { skipAdvice?: boolean }) => Promise<{ ok: true; plan: PricedPlan } | { ok: false; issues?: string[] }>;
  inspection?: SavedEvidenceInspection;
  log?: (line: string) => void;
}): Promise<RecoveryResult> {
  const { mission, store, catalog, access, capabilities, calls, callParams, codeRuns, stagesIn = [], summaryHint, assumptionsHint, understoodCompanies, understoodPeople, runSandbox, loadEvidenceMap, makeLookup, finalizePlan, log } = params;
  const inspection = params.inspection ?? await inspectSavedCompanyAndPeople({ mission, store, catalog, calls, callParams, stagesIn });
  if (inspection.hasOwnLimit) return { kind: "own_limit" };

  const requestText = askedTextOf(mission);
  const peopleRequested = Boolean(understoodPeople) || inspection.peopleCandidates.length > 0;
  if (!peopleRequested) return { kind: "none" };

  // Any company source gave positive rows?
  const rootCandidateFromStages = stagesIn.find((st) => isObject(st) && (st.parent_key === null || st.parent_key === undefined || st.parent_key === ""));
  const usableCompany = inspection.companyCandidates.find((c) => c.usable && c.rawJson !== null);
  const hasCompanyEvidence = Boolean(usableCompany) || (Boolean(rootCandidateFromStages) && inspection.anyCompanyOk);
  if (!hasCompanyEvidence && !usableCompany) return { kind: "none" };

  // Counter-cases: missing raw people file or incompatible raw rows (e.g. non-person blobs) -> never invent card or question
  const usablePeople = inspection.peopleCandidates.filter((p) => p.usable);
  if (inspection.peopleCandidates.length > 0 && usablePeople.length === 0) {
    return { kind: "none" };
  }

  // No positive people call answered (all failed 402/422/timeout or never tried; note answeredEmpty preserves plan_invalid_after_N when all people calls returned 0 rows)
  if (inspection.peopleCandidates.length === 0) {
    if (inspection.anyPeopleOkOrEmpty) return { kind: "none" };
    return { kind: "sources_unavailable" };
  }

  // Positive usable people exist: verify parent linkage
  const linkedPeople = usablePeople.filter((p) => p.linkScore > 0 && p.rawJson !== null);
  const runState = await readRunState(store, mission.id);
  const alreadyAsked = runState.peopleRecoveryAsked === true || Boolean(mission.answer_text);

  if (linkedPeople.length === 0) {
    if (alreadyAsked) return { kind: "none" };
    const question_ar = "لم نتمكن من ربط نتائج مسؤولي الشركات تلقائيًا بالخطة؛ هل تفضّل الاستمرار بالشركات فقط أم تحديد مسمى وظيفي آخر؟";
    const options_ar = ["الاستمرار بالشركات فقط", "تحديد مسمى وظيفي آخر"];
    return checkCustomerText(question_ar).issues.length === 0 ? { kind: "question", question_ar, options_ar } : { kind: "none" };
  }

  // Check role compatibility (Driver/Intern vs requested Managers -> never fabricate manager card)
  if (roleMismatchDetected(linkedPeople, understoodPeople?.noun_ar, requestText)) {
    if (alreadyAsked) return { kind: "none" };
    const roleLabel = understoodPeople?.noun_ar?.trim() || "المديرين";
    const question_ar = `المتاح حاليًا في بيانات مسؤولي الشركات لا يطابق المسمى المطلوب (${roleLabel})؛ هل تفضّل الاستمرار بالشركات فقط أم توسيع المسمى الوظيفي المتاح؟`;
    const options_ar = ["الاستمرار بالشركات فقط", "توسيع المسمى الوظيفي المتاح"];
    return checkCustomerText(question_ar).issues.length === 0 ? { kind: "question", question_ar, options_ar } : { kind: "none" };
  }

  // Build mapped people stage from linked evidence
  const linked = linkedPeople[0]!;
  if (!isStageAllowed(linked.endpointId, catalog, access)) return { kind: "none" };
  const peopleCode = buildSavedPeopleMapCode(linked.rowExpr);
  const sbPeople = await runSandbox(peopleCode, { [linked.callId]: linked.rawJson });
  let mappedPeople: unknown[] = [];
  if (sbPeople.ok && sbPeople.resultJson) {
    try {
      const parsed = JSON.parse(sbPeople.resultJson);
      if (Array.isArray(parsed)) mappedPeople = parsed;
    } catch { /* empty */ }
  }
  if (mappedPeople.length === 0 || !mappedPeople.every(isObject)) return { kind: "none" };

  let seq = params.outSeq + 1;
  const peopleOutId = outIdOf(seq);
  await store.putFile(mission.id, `out/${peopleOutId}.json`, JSON.stringify(mappedPeople), "application/json");
  codeRuns.set(peopleOutId, { code: peopleCode, files: [linked.callId] });
  try { await store.putNew(mission.id, codeRunPath(peopleOutId), JSON.stringify({ code: peopleCode, files: [linked.callId] }), "application/json"); } catch { /* ignore */ }

  // Candidate root company stages: prefer valid root stage from stagesIn, fallback to synthesizing from saved company evidence
  const rootOptions: Array<Record<string, unknown>> = [];
  const wants = requestWantsContacts(requestText);
  const perCount = Math.max(1, understoodPeople?.per_parent ?? 1);
  const companiesTarget = Math.max(
    1,
    Number(understoodCompanies?.expected_rows) ||
    Number(isObject(rootCandidateFromStages) ? rootCandidateFromStages.expected_rows : 0) ||
    Math.max(2, usableCompany?.rows ?? 2),
  );

  if (rootCandidateFromStages && isObject(rootCandidateFromStages)) {
    rootOptions.push({ ...rootCandidateFromStages, expected_rows: Number(rootCandidateFromStages.expected_rows) || companiesTarget });
  }
  if (usableCompany && usableCompany.rawJson !== null && isStageAllowed(usableCompany.endpointId, catalog, access)) {
    const companyCode = buildSavedCompanyMapCode(usableCompany.rowExpr);
    const sbCo = await runSandbox(companyCode, { [usableCompany.callId]: usableCompany.rawJson });
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
      codeRuns.set(coOutId, { code: companyCode, files: [usableCompany.callId] });
      try { await store.putNew(mission.id, codeRunPath(coOutId), JSON.stringify({ code: companyCode, files: [usableCompany.callId] }), "application/json"); } catch { /* ignore */ }
      rootOptions.push({
        key: "companies",
        title_ar: understoodCompanies?.title_ar?.trim() || "الشركات المطلوبة",
        endpoint_id: usableCompany.endpointId,
        expected_rows: companiesTarget,
        parent_key: null,
        deliver: true,
        columns: [
          { key: "name", title_ar: "اسم الشركة" },
          { key: "industry", title_ar: "النشاط والتخصص" },
          { key: "city", title_ar: "المدينة" },
          { key: "country", title_ar: "الدولة" },
          { key: "website", title_ar: "الموقع الإلكتروني" },
          { key: "linkedin", title_ar: "صفحة الشركة على الشبكة المهنية" },
        ],
        measured_by: [usableCompany.callId],
        yield_from: coOutId,
      });
    }
  }

  const peopleTitle = understoodPeople?.noun_ar?.trim() ? `${understoodPeople.noun_ar.trim()} كل شركة` : "مسؤولو كل شركة";
  const peopleColumns: Array<{ key: string; title_ar: string; kind?: string }> = [
    { key: "full_name", title_ar: "الاسم الكامل" },
    { key: "job_title", title_ar: "المسمى الوظيفي" },
    { key: "company", title_ar: "الشركة" },
    { key: "linkedin", title_ar: "الملف المهني" },
    ...(wants.email ? [{ key: "email", title_ar: "الإيميل", kind: "work_email" }] : []),
    ...(wants.phone ? [{ key: "phone", title_ar: "رقم التليفون", kind: "phone" }] : []),
  ];

  let sawOverCap = false;
  for (const rootStage of rootOptions) {
    const pKey = typeof rootStage.key === "string" && rootStage.key ? rootStage.key : "companies";
    const rootExpected = Math.max(1, Number(rootStage.expected_rows) || companiesTarget);
    const parentTitle = String(rootStage.title_ar ?? "الشركات").trim();
    const baseSummary = summaryHint ? firstSentenceAr(summaryHint).replace(/[.،]+$/, "") : "";
    const assembledSummary = `${baseSummary || `ستحصل على ${parentTitle}`}، ومع كل شركة مسؤولها حسب المتاح.`;
    const assembledStages: Array<Record<string, unknown>> = [
      rootStage,
      {
        key: "people",
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
    const capOk = !capabilities || planStageIssues(assembledStages.map((st) => ({ key: String(st.key ?? ""), endpoint_id: String(st.endpoint_id ?? ""), parent_key: (st.parent_key as string | null) ?? null })), capabilities, catalog).length === 0;
    if (!capOk) continue;
    const evMap = await loadEvidenceMap(assembledStages);
    const checked = validateAndPricePlan({ summary_ar: assembledSummary, stages: assembledStages as any, ...(assumptionsHint !== undefined ? { assumptions_ar: assumptionsHint as any } : {}) }, makeLookup(evMap));
    if (!checked.ok) {
      if (checked.issues.some((i) => /more than the job limit|lower the expected rows/i.test(i))) sawOverCap = true;
      log?.(`company_people_recovery_validate_failed ${mission.id} ${checked.issues.slice(0, 3).join("; ")}`);
      continue;
    }
    const fin = await finalizePlan(checked.plan, evMap, { skipAdvice: false });
    if (fin.ok) return { kind: "plan", plan: fin.plan, outSeq: seq };
    log?.(`company_people_recovery_finalize_failed ${mission.id} ${(fin.issues ?? []).slice(0, 3).join("; ")}`);
  }

  if (sawOverCap && !alreadyAsked) {
    const question_ar = "العدد المطلوب من الشركات يتجاوز الحد الأقصى لحجز المهمة الواحدة حاليًا؛ هل تفضّل تقليل العدد ليناسب الحد المتاح أم الاستمرار بالشركات فقط؟";
    const options_ar = ["تقليل العدد ليناسب الحد المتاح", "الاستمرار بالشركات فقط"];
    if (checkCustomerText(question_ar).issues.length === 0) return { kind: "question", question_ar, options_ar };
  }

  return { kind: "none" };
}
