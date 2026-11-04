import { toArabicDigits } from "../../arabicDigits";
import type { MissionPricingSettings } from "../../missionPricing";
import type { TregCatalog } from "../../treg/catalog";
import { AGENT_PEOPLE_PAGES_DEFAULT } from "../constants";
import { buildCompanySteps, buildContactSteps, rankedHelpers, withContactColumns, type ContactAids, type ContactStep, type FinderInfo, type FinderKind } from "../contactFinders";
import { countAr, knownItemNoun } from "../itemNoun";
import { stagePriceInputs, type PlanColumn, type PricedPlan, type PricedStage } from "../plan";
import { priceMissionByCode } from "../price";
import { DEFAULT_PEOPLE_PER_PARENT } from "../quantity";
import type { StatsMap } from "../sourceRanking";
import { bindCompanySteps, withContractColumns, COMPANY_EMAIL_TITLE_AR, PERSON_NAME_TITLE_AR, PERSON_TITLE_TITLE_AR } from "../taskContracts";
import { buildB2BAsk, type B2BAsk } from "./b2bAsk";
import { B2B_CARDS, type B2BCard, type B2BField } from "./b2bCards";
import { compileB2BPlan, COMPANY_HQ_TITLE_AR, type B2BCompileResult } from "./b2bCompile";
import { b2bMapCode } from "./b2bMapCode";
import { b2bCompaniesRequest } from "./b2bRequest";

/**
 * STAGE 3, PART A (docs/STAGE-3.md, S3): THE COMPANIES AND DECISION-MAKERS PLAN, BUILT BY CODE. buildB2BAsk -> compileB2BPlan (verified cards only) -> a PricedPlan of the SAME shape the engine runs
 * today for a companies plan: a companies stage and a people stage, each with a recipe built by code (`engine`: the endpoint, the inputs the stored real pages echo, the paging input, the mapping code
 * of b2bMapCode.ts, the people bound to the company's profile link), the company and person contact steps of contactFinders.ts (`buildCompanySteps`, `buildContactSteps`) whose finders are the compiled
 * CHAINS in their order, the reference columns of taskContracts.ts. The price is made ONLY by the existing function, `priceMissionByCode(stagePriceInputs(stages, steps))`, the call the social compiler
 * makes; a plan whose hold passes the job cap (`overCap`) is not made. No page is read and no model is asked: the plan is a pure function of the words, the cards and the catalog.
 *
 * Anything this path does not plan returns `ok: false` and the caller keeps TODAY's planning unchanged: a request that is not B2B, a people request with no company named, no number of companies,
 * a condition (a size, a founding year: its mark column is filled at delivery, not wired yet), no verified card, a card the account may not buy, a tool with no request code knows, the job cap.
 * Unverified cards are never used here, for any account (docs/STAGE-3.md section 10). Pure.
 */
export interface B2BPlanInput {
  /** The customer's words (the request and the answer to a question, `askedTextOf`). */
  requestText: string;
  catalog: Pick<TregCatalog, "byId" | "endpoints"> & TregCatalog;
  /** May this account buy this endpoint (sellable, not blocked, data policy): the same check as the model's planning. */
  isAllowed: (endpointId: string) => boolean;
  /** The helpers of today's steps besides the lookups (the e-mail verifiers, the phone validators): contactFinders.ts, as the model's planning gets them. */
  aids: (kind: FinderKind) => ContactAids;
  stats?: StatsMap;
  now?: number;
  pricingSettings?: MissionPricingSettings;
}
export type B2BPlanFallback = "not_b2b" | "not_companies_people" | "no_count" | "has_conditions" | "no_verified_card" | "not_allowed" | "no_request" | "over_cap";
export type B2BPlanResult =
  | { ok: true; plan: PricedPlan; ask: B2BAsk; compiled: Extract<B2BCompileResult, { ok: true }> }
  | { ok: false; reason: B2BPlanFallback };

const COMPANY_TITLE_OF: Partial<Record<B2BField, string>> = { name: "اسم الشركة", activity: "النشاط والتخصص", website: "الموقع الإلكتروني", hq: COMPANY_HQ_TITLE_AR, linkedin: "صفحة الشركة على الشبكة المهنية" };
const PERSON_TITLE_OF: Partial<Record<B2BField, string>> = { person_name: PERSON_NAME_TITLE_AR, title: PERSON_TITLE_TITLE_AR, linkedin: "الملف المهني" };
/** The person's contact columns (the owner's «Decision makers: e-mail and mobile»): marked by kind, so today's `buildContactSteps` makes their steps whatever words the request used. */
const PERSON_CONTACT_COLUMNS: PlanColumn[] = [{ key: "email", title_ar: "الإيميل", kind: "work_email" }, { key: "phone", title_ar: "رقم التليفون", kind: "phone" }];
const COMPANY = knownItemNoun("شركة")!;

const cardOf = (id: string | null): B2BCard | null => (id ? B2B_CARDS.find((c) => c.endpointId === id) ?? null : null);
/** The columns of a list card's mapped fields, in the order of the titles above (the id is never a column). */
const columnsOf = (card: B2BCard, titles: Partial<Record<B2BField, string>>): PlanColumn[] => {
  const fields = card.reader.kind === "list" ? card.reader.fields : {};
  return (Object.keys(titles) as B2BField[]).filter((k) => k in fields).map((k) => ({ key: k, title_ar: titles[k]! }));
};
/** The paging input of a list tool (the catalog's): only a page NUMBER is used (the engine's page mode); anything else means one page. */
const pageInputOf = (catalog: B2BPlanInput["catalog"], endpointId: string): string | null => ((catalog.byId.get(endpointId)?.pagination ?? []) as string[]).includes("page") ? "page" : null;

export function planB2BByCode(input: B2BPlanInput): B2BPlanResult {
  const ask = buildB2BAsk(input.requestText);
  if (!ask) return { ok: false, reason: "not_b2b" };
  if (ask.kind !== "companies_people") return { ok: false, reason: "not_companies_people" };
  if (ask.companies === null) return { ok: false, reason: "no_count" };
  if (ask.conditions.length > 0) return { ok: false, reason: "has_conditions" };
  // VERIFIED CARDS ONLY, for every account (no switch is passed)
  const compiled = compileB2BPlan(ask);
  if (!compiled.ok) return { ok: false, reason: "no_verified_card" };
  const companiesCard = cardOf(compiled.companiesCard);
  const peopleCard = cardOf(compiled.peopleCard);
  if (!companiesCard || !peopleCard) return { ok: false, reason: "no_verified_card" };
  if (!input.isAllowed(companiesCard.endpointId) || !input.isAllowed(peopleCard.endpointId)) return { ok: false, reason: "not_allowed" };
  const companiesParams = b2bCompaniesRequest(ask, input.requestText, companiesCard);
  const parent = peopleCard.request?.parent;
  const companiesCode = b2bMapCode(companiesCard);
  const peopleCode = b2bMapCode(peopleCard);
  if (!companiesParams || !parent || !companiesCode || !peopleCode) return { ok: false, reason: "no_request" };

  const capabilityOf = (id: string): string | null => input.catalog.byId.get(id)?.capability ?? null;
  const n = ask.companies;
  const perParent = ask.peoplePerCompany ?? DEFAULT_PEOPLE_PER_PARENT;
  const companiesCursor = pageInputOf(input.catalog, companiesCard.endpointId);
  const peopleCursor = pageInputOf(input.catalog, peopleCard.endpointId);
  const peopleParams: Record<string, unknown> = { ...structuredClone(peopleCard.request?.fixed ?? {}), ...(peopleCursor ? { page: 1 } : {}) };
  const perPage = Number(peopleParams.max_results) > 0 ? Number(peopleParams.max_results) : 1;
  const companies: PricedStage = {
    key: "companies", title_ar: ask.sector.length > 0 ? `الشركات في قطاع ${ask.sector.join(" و")}` : "الشركات", endpoint_id: companiesCard.endpointId,
    ...(capabilityOf(companiesCard.endpointId) ? { capability: capabilityOf(companiesCard.endpointId)! } : {}),
    expected_rows: n, planned_rows: n, parent_key: null, deliver: true, columns: columnsOf(companiesCard, COMPANY_TITLE_OF), sample_rows: [], measured_by: [], measured_from_calls: [],
    measured_cost_per_row_usd: companiesCard.costUsd, yield_share: 1, review_share: 0,
    engine: { endpoint_id: companiesCard.endpointId, params: companiesParams, cursor_param: companiesCursor, map_code: companiesCode, map_file_id: "page", parent_binding: null, built_by: "code" },
  };
  const people: PricedStage = {
    key: "people", title_ar: "صناع القرار في كل شركة", endpoint_id: peopleCard.endpointId, ...(capabilityOf(peopleCard.endpointId) ? { capability: capabilityOf(peopleCard.endpointId)! } : {}),
    expected_rows: n * perParent, planned_rows: n * perParent, parent_key: "companies", per_parent_rows: perParent, role_preference: { role: "manager" }, deliver: true,
    columns: [...columnsOf(peopleCard, PERSON_TITLE_OF), ...PERSON_CONTACT_COLUMNS.map((c) => ({ ...c }))], sample_rows: [], measured_by: [], measured_from_calls: [],
    // THE PEOPLE DEPTH, as the model's planning sets it (plan.ts): pages read per company to find its decision makers, and what one page costs (the tool bills per person given, `max_results` a page)
    measured_cost_per_row_usd: peopleCard.costUsd, pages_per_parent: AGENT_PEOPLE_PAGES_DEFAULT, page_cost_usd: peopleCard.costUsd * perPage, yield_share: 1, review_share: 0,
    engine: { endpoint_id: peopleCard.endpointId, params: peopleParams, cursor_param: peopleCursor, map_code: peopleCode, map_file_id: "page", parent_binding: { param: parent.param, from: parent.from }, built_by: "code" },
  };
  const stages0 = [companies, people];

  // THE CHAINS ARE THE FINDER ORDER: each contact column's lookups, in the compiled order, priced from the catalog by today's helper (`rankedHelpers`, ranked by the chain position)
  const helpersOf = (chain: ReadonlyArray<string>): FinderInfo[] => {
    const ids = chain.filter((id) => id !== companiesCard.endpointId && id !== peopleCard.endpointId && input.isAllowed(id));
    const group = ids.map((id) => input.catalog.byId.get(id)).filter((e): e is NonNullable<typeof e> => e !== undefined);
    return rankedHelpers(group, input.catalog, input.stats ?? new Map(), input.now ?? 0, { rank: (id) => ids.indexOf(id) });
  };
  const aidsOf = (kind: FinderKind): ContactAids => (kind === "phone" ? { ...input.aids("phone"), company_phone: helpersOf(compiled.chains.hq_phone) } : input.aids("email"));
  const finders = (kind: FinderKind): FinderInfo[] => helpersOf(kind === "email" ? compiled.chains.email : compiled.chains.mobile);
  let steps: ContactStep[] = [...buildContactSteps(stages0, input.requestText, finders, aidsOf), ...buildCompanySteps(stages0, helpersOf(compiled.chains.general_email), aidsOf)];
  // the columns as the model's planning leaves them after the check (tools.ts propose_plan): the steps' columns, then the reference's order and titles, then the company steps bound to those columns
  const withContacts = stages0.map((st) => ({ ...st, columns: withContactColumns(st.key, st.columns, steps) }));
  const stages = withContractColumns(withContacts);
  steps = bindCompanySteps(stages, steps);

  const price = priceMissionByCode(stagePriceInputs(stages, steps), { ...(input.pricingSettings ? { settings: input.pricingSettings } : {}) });
  if (price.overCap) return { ok: false, reason: "over_cap" };
  const notes: string[] = [];
  if (!steps.some((s) => s.level === "company" && s.kind === "email")) notes.push(`${COMPANY_EMAIL_TITLE_AR}: لا يوجد بعد مصدر موثّق نبحث فيه عنه، فسيُكتب في الملف أن البحث عنه لم يكتمل.`);
  const plan: PricedPlan = {
    summary_ar: `ستحصل على ${countAr(n, COMPANY)}${ask.sector.length > 0 ? ` في قطاع ${ask.sector.join(" و")}` : ""}، ومن كل شركة حتى ${toArabicDigits(perParent)} من صناع القرار بالإيميل والموبايل.`,
    stages, price, contact_steps: steps, ...(notes.length > 0 ? { notes_ar: notes } : {}),
    quantity: { requested: n, stage_key: "companies", target: n, source: "request" },
  };
  return { ok: true, plan, ask, compiled };
}
