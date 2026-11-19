import type { PricedPlan } from "../../../src/lib/agentMission/plan";
import {
  FINDERS_PER_STEP,
  companyDomainAddressIn,
  companyMailboxIn,
  contactStatusAr,
  emailValueTypeOf,
  finderParamsFor,
  foundContactDetailIn,
  labelledStatus,
  missingInputsFor,
  personFactsOf,
  profileUrlIn,
  statusHead,
  verifierParamsFor,
  EMAIL_LABEL_PERSONAL_AR,
  EMAIL_LABEL_COMPANY_AR,
  EMAIL_LABEL_SHARED_AR,
  EMAIL_LABEL_DOMAIN_AR,
  PHONE_TYPE_FAX_AR,
  type OfficeLine,
  type ContactStep,
  type FinderInfo,
  type FoundContact,
  type PersonFacts,
} from "../../../src/lib/agentMission/contactFinders";
import { NOT_AVAILABLE_AR } from "../../../src/lib/agentMission/taskContracts";
import { isPeopleStage, mailboxesOf, nameKeysOf } from "../../../src/lib/agentMission/people";
import { EMAIL_STATUS_OTHER_COMPANY_AR, EMAIL_STATUS_VERIFIED_AR, emailOnOtherDomain, emailStatusAr, emailVerdictIn } from "../../../src/lib/agentMission/emailVerification";
import { companyIdentityOf, type CompanyIdentity } from "../../../src/lib/agentMission/companyIdentity";
import { isEnabled } from "../../../src/lib/agentMission/filters";
import { countryOfRequestText } from "../../../src/lib/agentMission/places";
import { PHONE_STATUS_OTHER_COUNTRY_AR, PHONE_STATUS_VERIFIED_AR, PHONE_TYPE_COMPANY_AR, PHONE_TYPE_PERSONAL_AR, companyCountryOf, companyPhoneOfRow, mapsParamsFor, phoneStatusAr, phoneStatusOf, phoneVerdictIn, placePhoneIn, validatorParamsFor, type PhoneVerdict } from "../../../src/lib/agentMission/phoneValidation";
import { verifyContactValue } from "../../../src/lib/agentMission/contacts";
import { rankPeopleByRole } from "../../../src/lib/agentMission/roles";
import { toArabicDigits } from "../../../src/lib/arabicDigits";
import type { Gateway } from "../gateway";
import { RAW_PATH } from "../gateway";
import type { ItemStore, Op, Row } from "../items/itemStore";
import type { AgentStore, MissionEventInput } from "../types";

/**
 * THE CONTACT FINDER STEPS, CARRIED OUT (contactFinders.ts, plan.contact_steps). After the stages, for every delivered person with a name and a professional page or a company domain: the cheapest ranked e-mail finder; then, when phones were asked and the budget has room, the
 * cheapest phone finder. Decision-maker titles first (roles.ts), so when the money runs out the managers have their cells. A miss goes to the next ranked finder (at most three per person and kind); the first value ends the person. The value goes in the cell, «موثّق» or «غير موثّق»
 * in the status cell; a person is never dropped and a cell stays empty only when nothing was found.
 *
 * MONEY: no ledger, price or cap code is touched. Each call goes through the gateway (the job's call budget, the provider's daily limit, the record), and this step adds two limits of its own: a step may not spend more than what its cap carries (max_person_usd x its people; per_person_usd for a plan stored before), and no
 * call is made when the job budget (40% of the approved reserve's value) has no room for its price. The first refusal for the budget or the daily limit ends the enrichment. The step fills CELLS: it adds no row, so the delivered count and the charge are what they were.
 */
export type ContactStop = "budget" | "daily_cap" | "time_limit" | "aborted";
export interface ContactEnrichmentOutcome {
  filled: { email: number; phone: number; unverified: number; verified: number };
  /** People a call was made for / people who had nothing to ask with. */
  looked: number;
  skipped: number;
  spentUsd: number;
  stopped: ContactStop | null;
  /** The company-level steps (audit 2026-11): companies a value was found for, and the ones written «غير متوفر». */
  companies: { email: number; phone: number; notAvailable: number };
  /** What the e-mail verifiers answered (counts only; audit F3): for the admin page, never an address. */
  verifier: VerifierTally;
  /** Personal mailboxes seen (kept and labelled per D-0118), counts only. */
  withheld: { personal_email: number };
}
export interface VerifierTally { calls: number; deliverable: number; catch_all: number; undeliverable: number; unknown: number; failed: number; second_opinion: number }
const emptyTally = (): VerifierTally => ({ calls: 0, deliverable: 0, catch_all: 0, undeliverable: 0, unknown: 0, failed: 0, second_opinion: 0 });
export interface ContactDeps {
  items: ItemStore;
  store: AgentStore;
  plan: Pick<PricedPlan, "stages" | "contact_steps">;
  missionId: string;
  gateway: Pick<Gateway, "tregCall">;
  addEvent: (event: MissionEventInput) => Promise<void>;
  /** The job's call budget (the gateway settles every call on it). */
  budget: { ceilingUsd: number | null; spentUsd(): number };
  deadlineMs: number;
  /** The customer's own words: the country they name («شركات مصرية») is the company's country when its row says none (audit F4). */
  requestText?: string;
  shouldStop?: () => string | null;
  log?: (line: string) => void;
  /**
   * STAGE 3, PART B (docs/STAGE-3.md S4): `record` is told of every lookup of a step's chain, per row and column (value, empty, failed, refused: the call was not made, not_tried: the step's own cap);
   * `cellFor` gives the cell of a company column that got no value by the fallthrough (stage3/b2bEngine.ts: «غير متوفر» only after every tool of the chain answered with nothing, else «لم يكتمل البحث»).
   * Passed by runMission.ts only when DIGER_STAGE3_COMPANIES is on for the account; absent, nothing is recorded and every step does exactly what it did.
   */
  /** PHASE 5: write the internal provenance marks of each contact cell (`_src_<column>`, `_call_<column>`). Passed only under the `multi_stage_engine` switch; absent, the stored rows are exactly what they were (flags-off digests). */
  provenance?: boolean;
  attempts?: {
    record: (a: { stage: string; row: string; column: string; endpointId: string; outcome: "value" | "empty" | "failed" | "refused" | "not_tried"; value?: string }) => void;
    cellFor: (stage: string, row: string, column: string, chain: ReadonlyArray<string>) => string;
  };
}

const EPS = 1e-9;
/** People per stored segment (a segment is one object in the append-only log). */
const COMMIT_EVERY = 10;
const STEP_LABEL_AR = { email: "الإيميل", phone: "رقم التليفون" } as const;

/**
 * PHASE 5, PROVENANCE OF A CONTACT CELL (internal marks, never a column of the file: the workbook writes the stage's columns only): which source gave the value and which recorded call
 * (mission_calls id, raw answer at raw/<call>.json). Written only with a value a call found; a value the source row already had keeps its stage provenance.
 */
export const contactSrcKey = (column: string): string => `_src_${column}`;
export const contactCallKey = (column: string): string => `_call_${column}`;
const provenanceOf = (column: string, endpointId: string, callId: string): Record<string, string> => ({ [contactSrcKey(column)]: endpointId, [contactCallKey(column)]: callId });

/** An internal file of the mission (the admin and the team read it): a write that fails is LOGGED, never swallowed (QA #575 FAIL 3), and never ends the step. */
async function putInternalFile(deps: Pick<ContactDeps, "store" | "missionId" | "log">, relPath: string, body: unknown): Promise<void> {
  try { await deps.store.putFile(deps.missionId, relPath, JSON.stringify(body), "application/json"); }
  catch (e) { (deps.log ?? console.warn)(`contact_file_write_failed ${deps.missionId} ${relPath} ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
}

/**
 * THE ATTEMPTS FILE OF A STEP, contacts/attempts_<stage>_<kind>.json (DT-20261118-05 item 3): what every finder answered, the people, why the run stopped and, when it stopped, how many people it never reached. A RESUMED run ADDS its outcomes to
 * the file a run before it wrote: its people already have their final cells, so it asks nobody and must not erase why they are empty (Gate 2 P2).
 */
async function writeAttempts(deps: ContactDeps, step: Pick<ContactStep, "stage_key" | "kind">, now: { outcomes: ReadonlyMap<string, number>; people: number; reached: number; stopped: string | null }): Promise<void> {
  const relPath = `contacts/attempts_${step.stage_key}_${step.kind}.json`;
  let before: unknown = null;
  try { before = JSON.parse((await deps.store.getFile(deps.missionId, relPath)) ?? "null"); } catch (e) { (deps.log ?? console.warn)(`contact_file_read_failed ${deps.missionId} ${relPath} ${String((e as Error)?.message ?? e).slice(0, 120)}`); }
  const outcomes: Record<string, number> = {};
  const prior = (before as { outcomes?: unknown } | null)?.outcomes;
  if (prior !== null && typeof prior === "object") for (const [k, n] of Object.entries(prior as Record<string, unknown>)) if (typeof n === "number" && Number.isFinite(n)) outcomes[k] = n;
  for (const [k, n] of now.outcomes) outcomes[k] = (outcomes[k] ?? 0) + n;
  await putInternalFile(deps, relPath, { outcomes, people: now.people, stopped: now.stopped, ...(now.stopped !== null ? { not_reached: Math.max(0, now.people - now.reached) } : {}) });
}

/**
 * ONE PASS PER PEOPLE STAGE, DECISION MAKERS FIRST: the people are taken in the order of their titles (roles.ts) and EACH person gets every step of the plan (the e-mail with its verifier, then the phone with its validator) before the next person is looked at. When the money or the
 * time ends, the chief executive and the general manager have all their cells and the ones left without are the people of the lowest titles. Each step keeps its own spend against its own priced cap; the job budget is shared and ends everything at once.
 */
export async function runContactEnrichment(deps: ContactDeps): Promise<ContactEnrichmentOutcome> {
  const out = await runContactSteps(deps);
  // WHAT THE VERIFIERS SAID, as counts only (audit F3: «غير موثّق» for 7 of 8 addresses could not be told from a skipped verifier): an internal report for the admin page, no address, no provider name
  if (out.verifier.calls + out.verifier.failed > 0) {
    try { await deps.addEvent({ kind: "call", message_ar: "تقرير داخلي لتوثيق الإيميلات.", counts: { ver_calls: out.verifier.calls, ver_deliverable: out.verifier.deliverable, ver_catch_all: out.verifier.catch_all, ver_undeliverable: out.verifier.undeliverable, ver_unknown: out.verifier.unknown, ver_failed: out.verifier.failed, ver_second_opinion: out.verifier.second_opinion } }); } catch { /* a lost note never stops a run */ }
  }
  return out;
}

async function runContactSteps(deps: ContactDeps): Promise<ContactEnrichmentOutcome> {
  const { items, plan } = deps;
  const out: ContactEnrichmentOutcome = { filled: { email: 0, phone: 0, unverified: 0, verified: 0 }, looked: 0, skipped: 0, spentUsd: 0, stopped: null, companies: { email: 0, phone: 0, notAvailable: 0 }, verifier: emptyTally(), withheld: { personal_email: 0 } };
  // e-mail before phone for one person (the phone helpers are asked only after the e-mail's)
  const steps = [...(plan.contact_steps ?? [])].filter((x) => x.level === undefined).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "email" ? -1 : 1));
  // THE COMPANY'S OWN E-MAIL AND HQ PHONE FIRST (the owner's top priority, reference A columns 5 and 6): before the people's steps spend any of the job's budget
  const companySteps = (plan.contact_steps ?? []).filter((x) => x.level === "company");
  const stageKeys = [...new Set(steps.map((x) => x.stage_key))];
  // A PEOPLE STEP THE RUN NEVER REACHED still writes its attempts file, with the reason (QA #575 FAIL 3: a stop in the company stage left no file)
  const notReached = async (keys: ReadonlyArray<string>, stop: ContactStop): Promise<void> => {
    for (const step of steps.filter((x) => keys.includes(x.stage_key))) await writeAttempts(deps, step, { outcomes: new Map(), people: items.acceptedRows(step.stage_key).length, reached: 0, stopped: stop });
  };
  for (const stageKey of [...new Set(companySteps.map((x) => x.stage_key))]) {
    const stopped = await runCompanyStage(deps, stageKey, companySteps.filter((x) => x.stage_key === stageKey), out);
    if (stopped) { out.stopped = stopped; await notReached(stageKeys, stopped); return out; }
  }
  for (const [i, stageKey] of stageKeys.entries()) {
    const stage = plan.stages.find((s) => s.key === stageKey);
    if (!stage) continue;
    const rows = items.acceptedRows(stageKey);
    const ranked = rankPeopleByRole(rows, (stage as { role_preference?: { role: Parameters<typeof rankPeopleByRole>[1] } }).role_preference?.role ?? "manager").rows;
    // WHAT ONE STEP LEARNED ABOUT A PERSON FOR THE NEXT (DT-20261118-05 item 4): the work e-mail the e-mail step found, the professional page the phone step looked up
    const learned = new Map<string, LearnedFacts>();
    const runners = steps.filter((x) => x.stage_key === stageKey).map((step) => createRunner(deps, step, stage, out, rows.length, learned));
    const groupStart = deps.budget.spentUsd();
    let stopped: ContactStop | null = null;
    try {
      outer: for (const row of ranked) for (const runner of runners) { stopped = await runner.process(row); if (stopped) break outer; }
    } finally {
      // the group's stop is every step's stop (Gate 2 P2: only the runner that saw it said why)
      for (const runner of runners) await runner.finish(stopped);
      out.spentUsd += deps.budget.spentUsd() - groupStart;
    }
    if (stopped) { out.stopped = stopped; await notReached(stageKeys.slice(i + 1), stopped); break; }
  }
  return out;
}

/** One call a step wants to make, and what came of it. */
type Attempt = { t: "stop"; stop: ContactStop } | { t: "skip" } | { t: "failed" } | { t: "page"; page: unknown; callId: string };
/** What the steps of one person learned for the next step of the same person (DT-20261118-05 item 4). */
type LearnedFacts = { email?: string; linkedin?: string };

/** The status of an e-mail value: «غير موثّق لهذه الشركة» when it is on another domain (no verifier is paid for it), «موثّق» when a verifier says deliverable, «غير موثّق» in every other case. A definitive answer (deliverable, catch-all, undeliverable) ends the chain; an unknown answer or a failed call goes to the next verifier. */
async function emailStatusFor(verifiers: ReadonlyArray<FinderInfo>, api: { attempt: (helper: FinderInfo, params: Record<string, string>) => Promise<Attempt>; down: Map<string, number> }, value: string, companyDomain: string | null, tally: VerifierTally = emptyTally()): Promise<{ status: "verified" | "unverified" | "other_company"; stop: ContactStop | null }> {
  if (emailOnOtherDomain(value, companyDomain)) return { status: "other_company", stop: null };
  // A CATCH-ALL OR UNKNOWN ANSWER IS NOT THE END (audit F3, golden G1: the free verifier answers «accept_all» for a domain it cannot judge, and the paid one after it was never asked): the next verifier gives a second opinion, inside the step's own priced cap. Only «undeliverable» ends the chain at once.
  let asked = 0;
  for (const verifier of verifiers) {
    if ((api.down.get(verifier.id) ?? 0) >= 2) continue;
    const params = verifierParamsFor(verifier, value);
    if (!params) continue;
    const a = await api.attempt(verifier, params);
    if (a.t === "stop") return { status: "unverified", stop: a.stop };
    if (a.t === "failed") { tally.failed += 1; continue; }
    if (a.t !== "page") continue;
    tally.calls += 1;
    if (asked > 0) tally.second_opinion += 1;
    asked += 1;
    const verdict = emailVerdictIn(a.page);
    tally[verdict] += 1;
    if (verdict === "deliverable") return { status: "verified", stop: null };
    if (verdict === "undeliverable") return { status: "unverified", stop: null };
  }
  return { status: "unverified", stop: null };
}

/**
 * THE COMPANY STEPS, CARRIED OUT (audit 2026-11, reference A columns 5 and 6, the owner's top priority). For every delivered company, before the people's steps spend anything:
 *   - the COMPANY E-MAIL: its role mailbox (info@, contact@, sales@ on its own domain), taken from where it is cheapest: the cell the source gave, then the role mailboxes the PEOPLE source returned for this company (kept aside as not-a-person rows), then the mailbox listers in order. It goes through the e-mail
 *     verifier chain: «موثّق» / «غير موثّق» (an address of another domain is never the company's). Nothing found: «غير متوفر».
 *   - the HQ PHONE: the source's own value is kept (zero cost, never dropped); only a company whose data has none is looked up, once, on a map search (the company must be the place found: its website or its name). Nothing found: «غير متوفر».
 * The steps fill CELLS of companies already delivered: no row is added, so the delivered count and the charge are untouched. Each step keeps its own spend against its priced cap (max_person_usd x the companies); the job budget is shared. A step stopped by the budget, the daily limit or the time leaves the companies it did not reach EMPTY, and so does a company every lookup of which FAILED (a source that is down): «غير متوفر» is written only when a source ANSWERED and had nothing (or there was nothing to look with).
 */
async function runCompanyStage(deps: ContactDeps, stageKey: string, steps: ContactStep[], out: ContactEnrichmentOutcome): Promise<ContactStop | null> {
  const { items, plan, budget } = deps;
  const stage = plan.stages.find((s) => s.key === stageKey);
  if (!stage) return null;
  const rows = items.acceptedRows(stageKey);
  if (rows.length === 0) return null;
  const emailStep = steps.find((x) => x.kind === "email");
  const phoneStep = steps.find((x) => x.kind === "phone");
  const emailApi = makeAttempt(deps, (emailStep?.max_person_usd ?? emailStep?.per_person_usd ?? 0) * rows.length);
  const phoneApi = makeAttempt(deps, (phoneStep?.max_person_usd ?? phoneStep?.per_person_usd ?? 0) * rows.length);
  // the role mailboxes the people source gave for each company (rows that were not people: kept with their address)
  const fromPeople = new Map<string, string[]>();
  for (const ps of plan.stages.filter((x) => x.parent_key === stageKey && isPeopleStage(x))) {
    for (const it of items.excludedItems(ps.key)) {
      if (it.reason !== "not_a_person" || !it.row) continue;
      const parentId = String(it.row.parent_id ?? "").trim();
      if (!parentId) continue;
      const have = fromPeople.get(parentId) ?? [];
      for (const e of mailboxesOf(it.row, ps.columns)) if (!have.includes(e)) have.push(e);
      fromPeople.set(parentId, have);
    }
  }
  const requestPlaces = (stage.filters ?? []).filter((f) => f.kind === "place" && isEnabled(f)).flatMap((f) => (f.places && f.places.length > 0 ? f.places : f.values ?? []));
  let pending: Op[] = [];
  const flush = async () => { if (pending.length > 0) { const ops = pending; pending = []; await items.commit(ops); } };
  const groupStart = budget.spentUsd();
  let stopped: ContactStop | null = null;
  let emailFound = 0;
  let phoneFound = 0;
  try {
    for (const row of rows) {
      const id = String(row.id);
      const cells: Record<string, string> = {};
      const facts = personFactsOf(row, stage.columns, null);
      const identity = companyIdentityOf(row, nameKeysOf(stage.columns));
      const domain = facts.domain ?? identity.domain;
      if (emailStep) {
        const own = String(row[emailStep.column_key] ?? "").trim();
        const ownStatus = String(row[emailStep.status_key] ?? "").trim();
        const final = own !== "" && own !== NOT_AVAILABLE_AR && (statusHead(ownStatus) === EMAIL_STATUS_VERIFIED_AR || statusHead(ownStatus) === EMAIL_STATUS_OTHER_COMPANY_AR);
        if (!final) {
          let domainOnly = false;
          let value = own !== "" && own !== NOT_AVAILABLE_AR && own.includes("@") ? own.toLowerCase() : "";
          if (value === "") value = companyMailboxIn({ emails: fromPeople.get(id) ?? [] }, domain) ?? "";
          if (value === "" && domain) {
            const domAddr = companyDomainAddressIn({ emails: fromPeople.get(id) ?? [] }, domain);
            if (domAddr) {
              value = domAddr;
              domainOnly = true;
            }
          }
          let asked = false;
          let origin: { endpointId: string; callId: string } | null = null;
          if (value === "" && domain) {
            const note = (endpointId: string, outcome: "value" | "empty" | "failed" | "refused" | "not_tried", v?: string) => deps.attempts?.record({ stage: stageKey, row: id, column: emailStep.column_key, endpointId, outcome, ...(v !== undefined ? { value: v } : {}) });
            for (const finder of emailStep.finders) {
              if ((emailApi.down.get(finder.id) ?? 0) >= 2) continue;
              const params = finderParamsFor(finder, facts, false);
              if (!params) continue;
              const a = await emailApi.attempt(finder, params);
              if (a.t === "stop") { note(finder.id, "refused"); stopped = a.stop; break; }
              if (a.t === "skip") { note(finder.id, "not_tried"); continue; }
              if (a.t === "failed") { note(finder.id, "failed"); continue; }
              asked = true;
              value = companyMailboxIn(a.page, domain) ?? "";
              if (value === "") {
                const domAddr = companyDomainAddressIn(a.page, domain);
                if (domAddr) {
                  value = domAddr;
                  domainOnly = true;
                }
              }
              if (value !== "") origin = { endpointId: finder.id, callId: a.callId };
              note(finder.id, value !== "" ? "value" : "empty", value !== "" ? value : undefined);
              if (value !== "") break;
            }
          }
          if (stopped) break;
          if (value !== "") {
            let verdict: Awaited<ReturnType<typeof emailStatusFor>>;
            // A FOUND ADDRESS IS ALWAYS WRITTEN: whatever happens to a verifier the status is «غير موثّق» and the cell is still written
            try { verdict = await emailStatusFor(emailStep.verifiers ?? [], emailApi, value, domain, out.verifier); } catch { verdict = { status: "unverified", stop: null }; }
            cells[emailStep.column_key] = value;
            cells[emailStep.status_key] = domainOnly
              ? labelledStatus(emailStatusAr(verdict.status), EMAIL_LABEL_DOMAIN_AR)
              : emailStatusAr(verdict.status);
            if (origin && deps.provenance) Object.assign(cells, provenanceOf(emailStep.column_key, origin.endpointId, origin.callId));
            emailFound += 1;
            if (verdict.stop) stopped = verdict.stop;
          } else if (deps.attempts) {
            // STAGE 3 PART B: «غير متوفر» only when every lister of the chain answered with nothing, else «لم يكتمل البحث»
            cells[emailStep.column_key] = deps.attempts.cellFor(stageKey, id, emailStep.column_key, emailStep.finders.map((f) => f.id));
            if (cells[emailStep.column_key] === NOT_AVAILABLE_AR) out.companies.notAvailable += 1;
          } else if (asked || !domain || emailStep.finders.length === 0) { cells[emailStep.column_key] = NOT_AVAILABLE_AR; out.companies.notAvailable += 1; }
        }
      }
      if (phoneStep && !stopped) {
        const own = String(row[phoneStep.column_key] ?? "").trim();
        // a value the source gave is kept as it is; «غير متوفر» from an earlier pass is looked up again only if room appears
        if (own === "" || own === NOT_AVAILABLE_AR) {
          const cityKey = Object.keys(row).find((k) => /(^|_)city$/i.test(k) && String(row[k] ?? "").trim() !== "");
          // the company's country: its row, the place filter, its website, and last the country the customer's own words name («شركات مصرية»): a helper that needs a location was skipped for a company with no city and no country in its row (audit F4)
          const country = companyCountryOf({ row, requestPlaces, domain: identity.domain }) ?? (deps.requestText ? countryOfRequestText(deps.requestText) : null);
          let value = "";
          let asked = false;
          let origin: { endpointId: string; callId: string } | null = null;
          const cityText = cityKey ? String(row[cityKey]).trim() : null;
          const lookup = async (helper: FinderInfo, name: string): Promise<boolean> => {
            const params = mapsParamsFor(helper, { name, city: cityText, country });
            if (!params) return false;
            const a = await phoneApi.attempt(helper, params);
            const note = (outcome: "value" | "empty" | "failed" | "refused" | "not_tried", v?: string) => deps.attempts?.record({ stage: stageKey, row: id, column: phoneStep.column_key, endpointId: helper.id, outcome, ...(v !== undefined ? { value: v } : {}) });
            if (a.t === "stop") { note("refused"); stopped = a.stop; return false; }
            if (a.t === "skip" || a.t === "failed") { note(a.t === "skip" ? "not_tried" : "failed"); return false; }
            asked = true;
            const found = placePhoneIn(a.page, identity);
            if (found) { value = verifyContactValue("phone", found) ?? found.trim(); origin = { endpointId: helper.id, callId: a.callId }; note("value", value); return true; }
            note("empty");
            return false;
          };
          const helpers = phoneStep.company_phone ?? [];
          for (const helper of helpers) {
            if ((phoneApi.down.get(helper.id) ?? 0) >= 2) continue;
            if (await lookup(helper, identity.names[0] ?? "")) break;
            if (stopped) break;
          }
          // THE SAME HELPER, ASKED WITH THE COMPANY'S WEBSITE (audit F4): a search by name finds other businesses; the place whose website is the company's domain is the company, the strictest proof there is
          if (value === "" && !stopped && asked && identity.domain) {
            const first = helpers.find((h) => (phoneApi.down.get(h.id) ?? 0) < 2 && /^(q|query|keyword)$/i.test(h.inputs.find((i) => /^(q|query|keyword)$/i.test(i.name))?.name ?? ""));
            if (first) await lookup(first, identity.domain);
          }
          if (value !== "") { cells[phoneStep.column_key] = value; const o = origin as { endpointId: string; callId: string } | null; /* set inside lookup() */ if (o && deps.provenance) Object.assign(cells, provenanceOf(phoneStep.column_key, o.endpointId, o.callId)); phoneFound += 1; }
          else if (deps.attempts) {
            // STAGE 3 PART B: the same rule over the map searches; a step stopped here leaves the cell to the pass after the steps
            if (!stopped) { cells[phoneStep.column_key] = deps.attempts.cellFor(stageKey, id, phoneStep.column_key, helpers.map((h) => h.id)); if (cells[phoneStep.column_key] === NOT_AVAILABLE_AR) out.companies.notAvailable += 1; }
          } else if (!stopped && (asked || (phoneStep.company_phone ?? []).length === 0)) { cells[phoneStep.column_key] = NOT_AVAILABLE_AR; out.companies.notAvailable += 1; }
        }
      }
      if (Object.keys(cells).length > 0) pending.push({ t: "cells", stage: stageKey, id, cells });
      if (pending.length >= COMMIT_EVERY) await flush();
      if (stopped) break;
    }
  } finally {
    await flush();
    await items.mirror(stageKey);
    out.spentUsd += budget.spentUsd() - groupStart;
    out.companies.email += emailFound;
    out.companies.phone += phoneFound;
    try {
      await deps.addEvent({ kind: "progress", message_ar: `بحث الإيميل العام وهاتف المقر الرئيسي: وُجد الإيميل لـ ${toArabicDigits(emailFound)} والهاتف لـ ${toArabicDigits(phoneFound)} من ${toArabicDigits(rows.length)} شركة.`, counts: { saved: emailFound + phoneFound, planned: rows.length } });
    } catch { /* a lost note never stops a run */ }
  }
  return stopped;
}

/**
 * THE LIMITS OF ONE STEP'S CALLS (shared by the people's steps and the company's): `capUsd` is what the step may spend (its calls are counted against it), `down` remembers a helper that failed twice in a row. Created once per step.
 */
function makeAttempt(deps: ContactDeps, capUsd: number): { attempt: (helper: FinderInfo, params: Record<string, string>) => Promise<Attempt>; down: Map<string, number> } {
  const { store, gateway, budget } = deps;
  let mySpent = 0;
  /** A helper that failed twice in a row (a rate limit, an outage) is not asked again by this step. */
  const down = new Map<string, number>();
  /**
   * ONE CALL, within every limit: the time, the outside stop, the step's priced amount (a call its own price would take past it is skipped, so a dearer fallback never runs past it) and the job budget (a call past it ends the step). The gateway settles the cost; a refusal for the
   * budget or the daily limit ends the step, any other failed or refused call (a source that is down or unhealthy) is not the end: the caller goes on to the next one.
   */
  const attempt = async (helper: FinderInfo, params: Record<string, string>): Promise<Attempt> => {
    if (Date.now() >= deps.deadlineMs) return { t: "stop", stop: "time_limit" };
    if (deps.shouldStop?.()) return { t: "stop", stop: "aborted" };
    if (mySpent + helper.usd > capUsd + EPS) return { t: "skip" };
    if (budget.ceilingUsd !== null && budget.spentUsd() + helper.usd > budget.ceilingUsd + EPS) return { t: "stop", stop: "budget" };
    const before = budget.spentUsd();
    // A CALL THAT THROWS (a dropped connection, an unreadable answer) is a failed call, never the end of the person: what was found before it stays
    let result: Awaited<ReturnType<typeof gateway.tregCall>>;
    try { result = await gateway.tregCall({ endpoint_id: helper.id, params }); } catch { mySpent += Math.max(0, budget.spentUsd() - before); down.set(helper.id, (down.get(helper.id) ?? 0) + 1); return { t: "failed" }; }
    mySpent += Math.max(0, budget.spentUsd() - before);
    if (!result.ok) {
      const refused = "refused" in result ? String(result.refused) : "";
      if (refused === "over_budget") return { t: "stop", stop: "budget" };
      if (refused === "daily_cap" || refused === "daily_limit") return { t: "stop", stop: "daily_cap" };
      down.set(helper.id, (down.get(helper.id) ?? 0) + 1);
      return { t: "failed" };
    }
    down.set(helper.id, 0);
    let page: unknown = null;
    try { const raw = await store.getFile(deps.missionId, RAW_PATH(result.call_id)); page = raw === null ? null : JSON.parse(raw); } catch { page = null; }
    return { t: "page", page, callId: result.call_id };
  };
  return { attempt, down };
}

function createRunner(deps: ContactDeps, step: ContactStep, stage: ContactDeps["plan"]["stages"][number], out: ContactEnrichmentOutcome, peopleCount: number, learned: Map<string, LearnedFacts> = new Map()): { process(row: Row): Promise<ContactStop | null>; finish(stop?: ContactStop | null): Promise<void> } {
  // the finders not tried for a person and the input each lacked (written to the mission's own file at the end of the step)
  const notTried = new Map<string, number>();
  // WHAT EVERY FINDER ANSWERED, per outcome (DT-20261118-05): written to the mission's own file at the end of the step whether or not the stage-3 attempt log is on, with the reason the run stopped, so a person left empty is always explained
  const outcomes = new Map<string, number>();
  // Old approved plans may contain a separate, already validated company lookup.
  const legacyCompanyLookup = step.kind === "phone" && !!step.type_key && (step.company_phone ?? []).length > 0;
  const rejected = new Map<string, { rejected: number; number_typed: number; scan_truncated: number }>();
  let stoppedBy: string | null = null;
  // the people this step was run for (the rest, when the run stopped, are counted as never reached)
  let reached = 0;
  // THE COMPANY MAILBOX, BY STRUCTURE (DT-20261118-03 PR-3, D-0086): an address that is on the person's company row, or that 2+ people of the same company share, is the company's, never one person's
  const addressOf = (v: unknown): string => String(v ?? "").trim().replace(/^mailto:/i, "").toLowerCase();
  const isAddress = (v: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  const companyAddresses = (parentId: string): Set<string> => new Set(Object.values(items.acceptedRows(stage.parent_key ?? "").find((r) => String(r.id) === parentId) ?? {}).map(addressOf).filter(isAddress));
  const isCompanyAddress = (parentId: string, v: unknown): boolean => step.kind === "email" && stage.parent_key !== null && companyAddresses(parentId).has(addressOf(v));
  const { items, store, gateway, budget } = deps;
  const parents = new Map<string, Row>(stage.parent_key ? items.acceptedRows(stage.parent_key).map((r) => [String(r.id), r] as const) : []);
  // what this step may spend: what its price carries (the calls of the step are counted against it by makeAttempt; the other step of the same person is not)
  // the CAP is the whole chain at full price for every person (max_person_usd), so each delivered decision maker can go through every finder and the verifier; a plan stored before has only the expected amount
  const capUsd = (step.max_person_usd ?? step.per_person_usd) * peopleCount;
  let pending: Op[] = [];
  let found = 0;
  const flush = async () => { if (pending.length > 0) { const ops = pending; pending = []; await items.commit(ops); } };
  const { attempt, down } = makeAttempt(deps, capUsd);
  /** The status of an e-mail value (see emailStatusFor). */
  const emailStatusOf = (value: string, companyDomain: string | null) => emailStatusFor(step.verifiers ?? [], { attempt, down }, value, companyDomain, out.verifier);
  // THE COMPANY of each person: who it is, which country it is in (its row, else the country the customer asked for, else its website's suffix), and its phone (its own data first, else ONE map search per company; a miss is remembered too)
  const parentStage = deps.plan.stages.find((s) => s.key === stage.parent_key);
  const requestPlaces = [...(parentStage?.filters ?? []), ...(stage.filters ?? [])].filter((f) => f.kind === "place" && isEnabled(f)).flatMap((f) => (f.places && f.places.length > 0 ? f.places : f.values ?? []));
  const companies = new Map<string, { identity: CompanyIdentity; country: string | null; phone: { value: string | null; origin?: { endpointId: string; callId: string } } | null; row: Row | null; city: string | null }>();
  const companyOf = (parentId: string) => {
    let c = companies.get(parentId);
    if (!c) {
      const row = parents.get(parentId) ?? null;
      const identity = companyIdentityOf(row, parentStage ? nameKeysOf(parentStage.columns) : []);
      const cityKey = row ? Object.keys(row).find((k) => /(^|_)city$/i.test(k) && String(row[k] ?? "").trim() !== "") : undefined;
      c = { identity, country: companyCountryOf({ row, requestPlaces, domain: identity.domain }), phone: null, row, city: cityKey && row ? String(row[cityKey]).trim() : null };
      companies.set(parentId, c);
    }
    return c;
  };
  /** The company's phone: its own data, else one map search (the helpers in order, each within the limits); remembered for every person of the company. */
  const companyPhoneFor = async (parentId: string): Promise<{ value: string | null; stop: ContactStop | null; origin?: { endpointId: string; callId: string } }> => {
    const c = companyOf(parentId);
    if (c.phone) return { value: c.phone.value, stop: null, ...(c.phone.origin ? { origin: c.phone.origin } : {}) };
    const own = companyPhoneOfRow(c.row);
    if (own) { c.phone = { value: own }; return { value: own, stop: null }; }
    // the COMPANY STEP already looked for this company's HQ phone and found none (it wrote «غير متوفر» in its phone cell): the same search is not paid for twice
    if (c.row && Object.entries(c.row).some(([k, v]) => /(^|_)(phone|tel|telephone|mobile|phone_?number)$/i.test(k) && String(v ?? "").trim() === NOT_AVAILABLE_AR)) { c.phone = { value: null }; return { value: null, stop: null }; }
    for (const helper of step.company_phone ?? []) {
      if ((down.get(helper.id) ?? 0) >= 2) continue;
      const params = mapsParamsFor(helper, { name: c.identity.names[0] ?? "", city: c.city, country: c.country });
      if (!params) continue;
      const a = await attempt(helper, params);
      if (a.t === "stop") return { value: null, stop: a.stop };
      if (a.t !== "page") continue;
      const found = placePhoneIn(a.page, c.identity);
      if (found) { const origin = { endpointId: helper.id, callId: a.callId }; c.phone = { value: found, origin }; return { value: found, stop: null, origin }; }
    }
    // looked for and not found (or nothing to look with): remembered, so the next person of the company does not pay for the same search; a search that was SKIPPED (the cap) is not a miss and is asked again only if room appears
    if ((step.company_phone ?? []).length > 0) c.phone = { value: null };
    return { value: null, stop: null };
  };
  /** The validator's answer for a number (the helpers in order; the first that says valid or not valid ends the chain). Null when none answered. */
  const phoneVerdictOf = async (number: string, country: string | null): Promise<{ verdict: PhoneVerdict | null; stop: ContactStop | null }> => {
    for (const validator of step.validators ?? []) {
      if ((down.get(validator.id) ?? 0) >= 2) continue;
      const params = validatorParamsFor(validator, number, country);
      if (!params) continue;
      const a = await attempt(validator, params);
      if (a.t === "stop") return { verdict: null, stop: a.stop };
      if (a.t !== "page") continue;
      const verdict = phoneVerdictIn(a.page);
      if (verdict.valid !== null) return { verdict, stop: null };
    }
    return { verdict: null, stop: null };
  };
  return {
    async process(row: Row): Promise<ContactStop | null> {
      reached += 1;
      let stopRun: ContactStop | null = null;
      let existing = String(row[step.column_key] ?? "").trim();
      let existingStatus = String(row[step.status_key] ?? "").trim();
      const priorType = step.type_key ? String(row[step.type_key] ?? "").trim() :
        existingStatus.split(" — ").find((part) => part === PHONE_TYPE_COMPANY_AR || part === PHONE_TYPE_FAX_AR) ?? "";
      const priorOffice: OfficeLine | null = step.kind === "phone" && existing !== "" &&
        (priorType === PHONE_TYPE_COMPANY_AR || priorType === PHONE_TYPE_FAX_AR) &&
        !(legacyCompanyLookup && priorType === PHONE_TYPE_COMPANY_AR && statusHead(existingStatus) === PHONE_STATUS_VERIFIED_AR)
        ? { value: existing, type: priorType === PHONE_TYPE_FAX_AR ? "fax" : "company" } : null;
      if (priorOffice) { existing = ""; existingStatus = ""; }
      let givenCompany: string | null = null;
      // an address the people source already gave that is the company's own is kept as company address before anything else (D-0118)
      if (existing !== "" && isCompanyAddress(String(row.parent_id ?? ""), existing)) {
        givenCompany = existing;
        existing = "";
        existingStatus = "";
      }
      // a value that already has its final status (an earlier run of this step) is not looked up or verified again
      if (existing !== "" && (step.kind === "email" ? statusHead(existingStatus) === EMAIL_STATUS_VERIFIED_AR || statusHead(existingStatus) === EMAIL_STATUS_OTHER_COMPANY_AR : statusHead(existingStatus) === PHONE_STATUS_VERIFIED_AR || statusHead(existingStatus) === PHONE_STATUS_OTHER_COUNTRY_AR)) return null;
      const parentId = String(row.parent_id ?? "");
      const isOwnWorkEmail = (address: string): boolean => emailValueTypeOf(address) === "professional" && !companyAddresses(parentId).has(addressOf(address));
      const given = personFactsOf(row, stage.columns, parents.get(parentId) ?? null, isOwnWorkEmail);
      const known = learned.get(String(row.id));
      const workEmail = given.email ?? (known?.email && isOwnWorkEmail(known.email) ? known.email : null);
      let facts: PersonFacts = { ...given, linkedin: given.linkedin ?? known?.linkedin ?? null, ...(workEmail ? { email: workEmail } : {}) };
      let typeAr: string | null = null;
      let asked = false;
      let value = existing;
      let statusAr: string | null = null;
      let labelAr: string | null = null;
      let hit: FoundContact | null = null;
      let keptPersonal: { value: string; finderId: string; callId: string } | null = null;
      let keptCompany: { value: string; finderId?: string; callId?: string } | null = givenCompany ? { value: givenCompany } : null;
      let origin: { endpointId: string; callId: string } | null = null;
      let keptOffice: (OfficeLine & { endpointId?: string; callId?: string }) | null = priorOffice;
      let useOffice = false;
      // the attempts file counts every outcome per finder; a finder not tried says why (the input the person lacked, or the person's share of the price)
      const note = (endpointId: string, outcome: "value" | "empty" | "failed" | "refused" | "not_tried", v?: string) => { const k = `${endpointId}|${outcome}${outcome === "not_tried" && v ? `:${v}` : ""}`; outcomes.set(k, (outcomes.get(k) ?? 0) + 1); deps.attempts?.record({ stage: step.stage_key, row: String(row.id), column: step.column_key, endpointId, outcome, ...(v !== undefined ? { value: v } : {}) }); };
      // ONE PERSON NEVER COSTS MORE THAN THE CHAIN'S OWN PRICE FOR ONE PERSON (DT-20261118-05 item 4, no money change): the profile lookup and the alternates share it; a call billed on a hit counts only when it found something
      const personCeilingUsd = step.finders.reduce((n, f) => n + f.usd, 0);
      let personUsd = 0;
      const affordable = (f: FinderInfo): boolean => personUsd + f.usd <= personCeilingUsd + 1e-9;
      const spent = (f: FinderInfo, found: boolean): void => { if (f.bill === "call" || found) personUsd += f.usd; };
      const officeTypeOf = (line: OfficeLine): string => line.type === "fax" ? PHONE_TYPE_FAX_AR : PHONE_TYPE_COMPANY_AR;
      if (value === "") {
        // (c) THE PERSON'S PROFESSIONAL PAGE FIRST (item 4c): a person without one is looked up by name and company, so the finders that need the page can be asked
        if (step.kind === "phone" && facts.linkedin === null) {
          for (const finder of step.profile_lookup ?? []) {
            const params = finderParamsFor(finder, facts);
            if (!params) { note(finder.id, "not_tried", `missing:${missingInputsFor(finder, facts).join("+")}`); continue; }
            if (!affordable(finder)) { note(finder.id, "not_tried", "person_budget"); continue; }
            const a = await attempt(finder, params);
            if (a.t === "stop") { note(finder.id, "refused"); stopRun = a.stop; break; }
            if (a.t === "skip") { note(finder.id, "not_tried"); continue; }
            asked = true;
            if (a.t === "failed") { note(finder.id, "failed"); continue; }
            const profile = profileUrlIn(a.page);
            spent(finder, profile !== null);
            note(finder.id, profile ? "value" : "empty", profile ?? undefined);
            if (profile) { facts = { ...facts, linkedin: profile }; learned.set(String(row.id), { ...learned.get(String(row.id)), linkedin: profile }); break; }
          }
        }
      }
      let tried = 0;
      const maxTries = Math.max(FINDERS_PER_STEP, step.finders.length);
      const chain = [...step.finders, ...(step.alternates ?? []).filter((x) => !step.finders.some((f) => f.id === x.id))];
      for (const finder of chain) {
        if (stopRun || value !== "" || tried >= maxTries) break;
        const params = finderParamsFor(finder, facts);
        // A FINDER NOT TRIED IS RECORDED with the input the person lacked (DT-20261118-03: the skip was silent), never skipped in silence
        if (!params) { const missing = missingInputsFor(finder, facts).join("+"); note(finder.id, "not_tried", `missing:${missing}`); const key = `${finder.id}|${missing}`; notTried.set(key, (notTried.get(key) ?? 0) + 1); continue; }
        if (!affordable(finder)) { note(finder.id, "not_tried", "person_budget"); continue; }
        tried += 1;
        const a = await attempt(finder, params);
        if (a.t === "stop") { note(finder.id, "refused"); stopRun = a.stop; break; }
        if (a.t === "skip") { note(finder.id, "not_tried"); continue; }
        asked = true;
        if (a.t === "failed") { note(finder.id, "failed"); continue; } // the next ranked finder is tried
        const detail = foundContactDetailIn(step.kind, a.page);
        hit = detail.found;
        spent(finder, hit !== null || detail.officeLine !== null);
        if (detail.rejected || detail.numberTyped || detail.scanTruncated) {
          rejected.set(`${finder.id}|${a.callId}`, { rejected: detail.rejected, number_typed: detail.numberTyped, scan_truncated: Number(detail.scanTruncated) });
        }
        let keptNow = false;
        // A PRIVATE MAILBOX IS NOT A WORK E-MAIL (Phase 5): an address on gmail.com, outlook.com … is kept as personal mailbox (D-0118)
        if (hit && step.kind === "email" && emailValueTypeOf(hit.value) === "personal_mailbox") {
          out.withheld.personal_email += 1;
          if (!keptPersonal) keptPersonal = { value: hit.value, finderId: finder.id, callId: a.callId };
          keptNow = true;
          hit = null;
        } else if (hit && step.kind === "email" && isCompanyAddress(parentId, hit.value)) {
          if (!keptCompany) keptCompany = { value: hit.value, finderId: finder.id, callId: a.callId };
          keptNow = true;
          hit = null;
        }
        if (step.kind === "email" && detail.personalAlso) {
          out.withheld.personal_email += 1;
          if (!keptPersonal) keptPersonal = { value: detail.personalAlso, finderId: finder.id, callId: a.callId };
        }
        const office = !hit ? detail.officeLine : null;
        if (office && !keptOffice) keptOffice = { ...office, endpointId: finder.id, callId: a.callId };
        const hasAnswer = !!(hit || keptNow || office);
        note(finder.id, hasAnswer ? "value" : "empty", hit?.value ?? office?.value);
        if (!hit) continue;
        origin = { endpointId: finder.id, callId: a.callId };
        value = hit.value;
        if (step.kind === "phone") typeAr = PHONE_TYPE_PERSONAL_AR;
        break;
      }
      if (value === "") {
        if (keptPersonal) {
          value = keptPersonal.value;
          hit = { value, status: "unverified" };
          origin = { endpointId: keptPersonal.finderId, callId: keptPersonal.callId };
          labelAr = EMAIL_LABEL_PERSONAL_AR;
        } else if (keptCompany) {
          value = keptCompany.value;
          hit = { value, status: "unverified" };
          if (keptCompany.finderId && keptCompany.callId) origin = { endpointId: keptCompany.finderId, callId: keptCompany.callId };
          labelAr = EMAIL_LABEL_COMPANY_AR;
        }
        if (value === "" && keptOffice) {
          useOffice = true;
          value = keptOffice.value;
          typeAr = officeTypeOf(keptOffice);
          if (keptOffice.endpointId && keptOffice.callId) {
            hit = { value, status: "unverified" };
            origin = { endpointId: keptOffice.endpointId, callId: keptOffice.callId };
          }
        }
        // NO PERSONAL PHONE: the COMPANY's phone goes in the person's row, labelled «رقم الشركة» (one lookup per company)
        // D-0084 (BUG HUNTER Gate 1 delta P0): only an older approved plan whose person step still carries the company search may do this; a new plan never copies the company row's phone into a person's cell
        if (value === "" && legacyCompanyLookup) {
          const cp = await companyPhoneFor(parentId);
          if (cp.stop) { stopRun = cp.stop; }
          if (cp.value) { value = verifyContactValue("phone", cp.value) ?? cp.value.trim(); typeAr = PHONE_TYPE_COMPANY_AR; asked = true; if (cp.origin) origin = cp.origin; }
        }
      } else if (step.kind === "phone" && !hit && step.type_key && priorType === "") typeAr = PHONE_TYPE_PERSONAL_AR; // a number the source gave with the person
      if (value !== "") {
        if (step.kind === "email") {
          // A FOUND ADDRESS IS ALWAYS WRITTEN: whatever happens to a verifier (rate limit, failure, a thrown error, the budget) the verdict is «غير موثّق» and the cells below are still written (a verifier only ever improves the status)
          let verdict: { status: "verified" | "unverified" | "other_company"; stop: ContactStop | null };
          try {
            const domain = labelAr === EMAIL_LABEL_PERSONAL_AR ? null : facts.domain;
            verdict = stopRun ? { status: emailOnOtherDomain(value, domain) ? "other_company" : "unverified", stop: null } : await emailStatusOf(value, domain);
          } catch { verdict = { status: "unverified", stop: null }; }
          if (verdict.stop) stopRun = verdict.stop;
          if ((step.verifiers ?? []).length > 0 || verdict.status === "other_company") asked = true;
          statusAr = emailStatusAr(verdict.status);
          if (labelAr) statusAr = labelledStatus(statusAr, labelAr);
          else if (keptPersonal && hit && emailValueTypeOf(hit.value) === "professional") {
            statusAr = labelledStatus(statusAr, `${EMAIL_LABEL_PERSONAL_AR}: ${keptPersonal.value}`);
          }
          if (verdict.status === "unverified") out.filled.unverified += hit ? 1 : 0;
          else if (verdict.status === "verified") out.filled.verified += 1;
        } else {
          const company = companyOf(parentId);
          const mayValidate = !useOffice && (!stopRun || legacyCompanyLookup);
          const checked = mayValidate ? await phoneVerdictOf(value, company.country) : { verdict: null, stop: null };
          if (checked.stop) stopRun = checked.stop;
          if (mayValidate && (step.validators ?? []).length > 0) asked = true;
          const status = phoneStatusOf({ number: value, verdict: checked.verdict, companyCountry: company.country });
          statusAr = phoneStatusAr(status);
          if (keptOffice && !useOffice) statusAr = labelledStatus(statusAr, `${officeTypeOf(keptOffice)}: ${keptOffice.value}`);
        else if (keptOffice && !step.type_key) statusAr = labelledStatus(statusAr, officeTypeOf(keptOffice));
          if (status === "verified") out.filled.verified += 1; else if (hit || (!useOffice && typeAr === PHONE_TYPE_COMPANY_AR)) out.filled.unverified += 1;
        }
        const id = String(row.id);
        if (givenCompany || (priorOffice && !useOffice)) {
          pending.push({ t: "clear", stage: step.stage_key, id, keys: [step.column_key, step.status_key,
            ...(priorOffice ? [...(step.type_key ? [step.type_key] : []), contactSrcKey(step.column_key), contactCallKey(step.column_key)] : [])] });
        }
        const cells: Record<string, string> = { ...(hit || existing === "" ? { [step.column_key]: value } : {}), ...(statusAr !== null ? { [step.status_key]: statusAr } : {}), ...(typeAr !== null && step.type_key ? { [step.type_key]: typeAr } : {}), ...(origin && deps.provenance && (hit || existing === "") ? provenanceOf(step.column_key, origin.endpointId, origin.callId) : {}) };
        if (Object.keys(cells).length > 0) pending.push({ t: "cells", stage: step.stage_key, id: String(row.id), cells });
        if (hit || (!useOffice && existing === "" && typeAr === PHONE_TYPE_COMPANY_AR)) { found += 1; out.filled[step.kind] += 1; }
        // the person's own work e-mail is an input of the phone step that follows (item 4: a phone finder looks the number up from it)
        if (step.kind === "email" && !labelAr && !isCompanyAddress(parentId, value)) learned.set(String(row.id), { ...learned.get(String(row.id)), email: addressOf(value) });
      }
      if (stopRun) stoppedBy = stopRun;
      if (asked) out.looked += 1; else out.skipped += 1;
      if (pending.length >= COMMIT_EVERY) await flush();
      return stopRun;
    },
    async finish(stop: ContactStop | null = null): Promise<void> {
      // one address held by 2+ people of the same company is kept and labelled «مشترك» (D-0118)
      // read from the stage's rows AS THEY END (QA consolidated FAIL 1): an address that already had its final status, one the people source gave, and the rows a stopped run never reached all count
      await flush();
      if (step.kind === "email" && stage.parent_key !== null) {
        const byAddress = new Map<string, string[]>();
        for (const r of items.acceptedRows(step.stage_key)) {
          const address = addressOf(r[step.column_key]);
          if (!isAddress(address)) continue;
          const key = `${String(r.parent_id ?? "")}|${address}`;
          byAddress.set(key, [...(byAddress.get(key) ?? []), String(r.id)]);
        }
        for (const ids of byAddress.values()) {
          if (ids.length < 2) continue;
          for (const id of ids) {
            const currentRow = items.acceptedRows(step.stage_key).find((r) => String(r.id) === id);
            const currentStatus = String(currentRow?.[step.status_key] ?? "");
            pending.push({
              t: "clear",
              stage: step.stage_key,
              id,
              keys: [step.status_key],
            });
            pending.push({
              t: "cells",
              stage: step.stage_key,
              id,
              cells: { [step.status_key]: labelledStatus(currentStatus, EMAIL_LABEL_SHARED_AR) },
            });
          }
        }
      }
      await flush();
      // the finders not tried and why, per finder and missing input (an internal file of the mission; the admin and the team read it)
      // EVERY RUN writes it (DT-20261118-05 item 3), also when nobody could be asked: the next live run proves why a cell is empty
      await writeAttempts(deps, step, { outcomes, people: peopleCount, reached, stopped: stoppedBy ?? stop });
      if (rejected.size > 0) await putInternalFile(deps, `contacts/rejected_${step.stage_key}_${step.kind}.json`, Object.fromEntries(rejected));
      if (notTried.size > 0) await putInternalFile(deps, `contacts/not_tried_${step.stage_key}_${step.kind}.json`, Object.fromEntries(notTried));
      await items.mirror(step.stage_key);
      try {
        await deps.addEvent({ kind: "progress", message_ar: `بحث ${STEP_LABEL_AR[step.kind]} لصناع القرار: وُجد لـ ${toArabicDigits(found)} من ${toArabicDigits(peopleCount)}.`, counts: { saved: found, planned: peopleCount } });
      } catch { /* a lost note never stops a run */ }
    },
  };
}
