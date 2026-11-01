import type { PricedPlan } from "../../../src/lib/agentMission/plan";
import { contactStatusAr, finderParamsFor, foundContactIn, personFactsOf, verifierParamsFor, type ContactStep, type FinderInfo, type FoundContact } from "../../../src/lib/agentMission/contactFinders";
import { EMAIL_STATUS_OTHER_COMPANY_AR, EMAIL_STATUS_VERIFIED_AR, emailOnOtherDomain, emailStatusAr, emailVerdictIn } from "../../../src/lib/agentMission/emailVerification";
import { companyIdentityOf, type CompanyIdentity } from "../../../src/lib/agentMission/companyIdentity";
import { isEnabled } from "../../../src/lib/agentMission/filters";
import { nameKeysOf } from "../../../src/lib/agentMission/people";
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
}
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
  shouldStop?: () => string | null;
  log?: (line: string) => void;
}

const EPS = 1e-9;
/** People per stored segment (a segment is one object in the append-only log). */
const COMMIT_EVERY = 10;
const STEP_LABEL_AR = { email: "الإيميل", phone: "رقم التليفون" } as const;

/**
 * ONE PASS PER PEOPLE STAGE, DECISION MAKERS FIRST: the people are taken in the order of their titles (roles.ts) and EACH person gets every step of the plan (the e-mail with its verifier, then the phone with its validator) before the next person is looked at. When the money or the
 * time ends, the chief executive and the general manager have all their cells and the ones left without are the people of the lowest titles. Each step keeps its own spend against its own priced cap; the job budget is shared and ends everything at once.
 */
export async function runContactEnrichment(deps: ContactDeps): Promise<ContactEnrichmentOutcome> {
  const { items, plan } = deps;
  const out: ContactEnrichmentOutcome = { filled: { email: 0, phone: 0, unverified: 0, verified: 0 }, looked: 0, skipped: 0, spentUsd: 0, stopped: null };
  // e-mail before phone for one person (the phone helpers are asked only after the e-mail's)
  const steps = [...(plan.contact_steps ?? [])].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "email" ? -1 : 1));
  const stageKeys = [...new Set(steps.map((x) => x.stage_key))];
  for (const stageKey of stageKeys) {
    const stage = plan.stages.find((s) => s.key === stageKey);
    if (!stage) continue;
    const rows = items.acceptedRows(stageKey);
    const ranked = rankPeopleByRole(rows, (stage as { role_preference?: { role: Parameters<typeof rankPeopleByRole>[1] } }).role_preference?.role ?? "manager").rows;
    const runners = steps.filter((x) => x.stage_key === stageKey).map((step) => createRunner(deps, step, stage, out, rows.length));
    const groupStart = deps.budget.spentUsd();
    let stopped: ContactStop | null = null;
    try {
      outer: for (const row of ranked) for (const runner of runners) { stopped = await runner.process(row); if (stopped) break outer; }
    } finally {
      for (const runner of runners) await runner.finish();
      out.spentUsd += deps.budget.spentUsd() - groupStart;
    }
    if (stopped) { out.stopped = stopped; break; }
  }
  return out;
}

/** One call a step wants to make, and what came of it. */
type Attempt = { t: "stop"; stop: ContactStop } | { t: "skip" } | { t: "failed" } | { t: "page"; page: unknown };

function createRunner(deps: ContactDeps, step: ContactStep, stage: ContactDeps["plan"]["stages"][number], out: ContactEnrichmentOutcome, peopleCount: number): { process(row: Row): Promise<ContactStop | null>; finish(): Promise<void> } {
  const { items, store, gateway, budget } = deps;
  const parents = new Map<string, Row>(stage.parent_key ? items.acceptedRows(stage.parent_key).map((r) => [String(r.id), r] as const) : []);
  // what this step may spend: what its price carries; `mySpent` is what ITS calls have cost so far (the other step of the same person is not counted against it)
  // the CAP is the whole chain at full price for every person (max_person_usd), so each delivered decision maker can go through every finder and the verifier; a plan stored before has only the expected amount
  const capUsd = (step.max_person_usd ?? step.per_person_usd) * peopleCount;
  let mySpent = 0;
  let pending: Op[] = [];
  let found = 0;
  const flush = async () => { if (pending.length > 0) { const ops = pending; pending = []; await items.commit(ops); } };
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
    return { t: "page", page };
  };
  /** The status of an e-mail value: «غير موثّق لهذه الشركة» when it is on another domain (no verifier is paid for it), «موثّق» when a verifier says deliverable, «غير موثّق» in every other case. A definitive answer (deliverable, catch-all, undeliverable) ends the chain; an unknown answer or a failed call goes to the next verifier. */
  const emailStatusOf = async (value: string, companyDomain: string | null): Promise<{ status: "verified" | "unverified" | "other_company"; stop: ContactStop | null }> => {
    if (emailOnOtherDomain(value, companyDomain)) return { status: "other_company", stop: null };
    for (const verifier of step.verifiers ?? []) {
      if ((down.get(verifier.id) ?? 0) >= 2) continue;
      const params = verifierParamsFor(verifier, value);
      if (!params) continue;
      const a = await attempt(verifier, params);
      if (a.t === "stop") return { status: "unverified", stop: a.stop };
      if (a.t !== "page") continue;
      const verdict = emailVerdictIn(a.page);
      if (verdict === "deliverable") return { status: "verified", stop: null };
      if (verdict === "catch_all" || verdict === "undeliverable") return { status: "unverified", stop: null };
    }
    return { status: "unverified", stop: null };
  };
  // THE COMPANY of each person: who it is, which country it is in (its row, else the country the customer asked for, else its website's suffix), and its phone (its own data first, else ONE map search per company; a miss is remembered too)
  const parentStage = deps.plan.stages.find((s) => s.key === stage.parent_key);
  const requestPlaces = [...(parentStage?.filters ?? []), ...(stage.filters ?? [])].filter((f) => f.kind === "place" && isEnabled(f)).flatMap((f) => (f.places && f.places.length > 0 ? f.places : f.values ?? []));
  const companies = new Map<string, { identity: CompanyIdentity; country: string | null; phone: { value: string | null } | null; row: Row | null; city: string | null }>();
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
  const companyPhoneFor = async (parentId: string): Promise<{ value: string | null; stop: ContactStop | null }> => {
    const c = companyOf(parentId);
    if (c.phone) return { value: c.phone.value, stop: null };
    const own = companyPhoneOfRow(c.row);
    if (own) { c.phone = { value: own }; return { value: own, stop: null }; }
    for (const helper of step.company_phone ?? []) {
      if ((down.get(helper.id) ?? 0) >= 2) continue;
      const params = mapsParamsFor(helper, { name: c.identity.names[0] ?? "", city: c.city, country: c.country });
      if (!params) continue;
      const a = await attempt(helper, params);
      if (a.t === "stop") return { value: null, stop: a.stop };
      if (a.t !== "page") continue;
      const found = placePhoneIn(a.page, c.identity);
      if (found) { c.phone = { value: found }; return { value: found, stop: null }; }
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
      let stopRun: ContactStop | null = null;
      const existing = String(row[step.column_key] ?? "").trim();
      const existingStatus = String(row[step.status_key] ?? "").trim();
      // a value that already has its final status (an earlier run of this step) is not looked up or verified again
      if (existing !== "" && (step.kind === "email" ? existingStatus === EMAIL_STATUS_VERIFIED_AR || existingStatus === EMAIL_STATUS_OTHER_COMPANY_AR : existingStatus === PHONE_STATUS_VERIFIED_AR || existingStatus === PHONE_STATUS_OTHER_COUNTRY_AR)) return null;
      const parentId = String(row.parent_id ?? "");
      const facts = personFactsOf(row, stage.columns, parents.get(parentId) ?? null);
      let typeAr: string | null = null;
      let asked = false;
      let value = existing;
      let statusAr: string | null = null;
      let hit: FoundContact | null = null;
      if (value === "") {
        for (const finder of step.finders) {
          const params = finderParamsFor(finder, facts);
          if (!params) continue;
          const a = await attempt(finder, params);
          if (a.t === "stop") { stopRun = a.stop; break; }
          if (a.t === "skip") continue;
          asked = true;
          if (a.t === "failed") continue; // the next ranked finder is tried
          hit = foundContactIn(step.kind, a.page);
          if (!hit) continue;
          value = hit.value;
          if (step.kind === "phone") typeAr = PHONE_TYPE_PERSONAL_AR;
          break;
        }
        // NO PERSONAL PHONE: the COMPANY's phone goes in the person's row, labelled «رقم الشركة» (one lookup per company)
        if (value === "" && step.kind === "phone" && step.type_key) {
          const cp = await companyPhoneFor(parentId);
          if (cp.stop) { stopRun = cp.stop; }
          if (cp.value) { value = verifyContactValue("phone", cp.value) ?? cp.value.trim(); typeAr = PHONE_TYPE_COMPANY_AR; asked = true; }
        }
      } else if (step.kind === "phone" && step.type_key && String(row[step.type_key] ?? "").trim() === "") typeAr = PHONE_TYPE_PERSONAL_AR; // a number the source gave with the person
      if (value !== "") {
        if (step.kind === "email") {
          // A FOUND ADDRESS IS ALWAYS WRITTEN: whatever happens to a verifier (rate limit, failure, a thrown error, the budget) the verdict is «غير موثّق» and the cells below are still written (a verifier only ever improves the status)
          let verdict: { status: "verified" | "unverified" | "other_company"; stop: ContactStop | null };
          try { verdict = await emailStatusOf(value, facts.domain); } catch { verdict = { status: "unverified", stop: null }; }
          if (verdict.stop) stopRun = verdict.stop;
          if ((step.verifiers ?? []).length > 0 || verdict.status === "other_company") asked = true;
          statusAr = emailStatusAr(verdict.status);
          if (verdict.status === "unverified") out.filled.unverified += hit ? 1 : 0;
          else if (verdict.status === "verified") out.filled.verified += 1;
        } else {
          // EVERY PHONE IS VALIDATED: «رقم من دولة أخرى» when its country is not the company's, «موثّق» only when a validator says the number is valid, «غير موثّق» otherwise
          const company = companyOf(parentId);
          const checked = await phoneVerdictOf(value, company.country);
          if (checked.stop) stopRun = checked.stop;
          if ((step.validators ?? []).length > 0) asked = true;
          const status = phoneStatusOf({ number: value, verdict: checked.verdict, companyCountry: company.country });
          statusAr = phoneStatusAr(status);
          if (status === "verified") out.filled.verified += 1; else if (hit || typeAr === PHONE_TYPE_COMPANY_AR) out.filled.unverified += 1;
        }
        const cells: Record<string, string> = { ...(hit || existing === "" ? { [step.column_key]: value } : {}), ...(statusAr !== null ? { [step.status_key]: statusAr } : {}), ...(typeAr !== null && step.type_key ? { [step.type_key]: typeAr } : {}) };
        if (Object.keys(cells).length > 0) pending.push({ t: "cells", stage: step.stage_key, id: String(row.id), cells });
        if (hit || (existing === "" && typeAr === PHONE_TYPE_COMPANY_AR)) { found += 1; out.filled[step.kind] += 1; }
      }
      if (asked) out.looked += 1; else out.skipped += 1;
      if (pending.length >= COMMIT_EVERY) await flush();
      return stopRun;
    },
    async finish(): Promise<void> {
      await flush();
      await items.mirror(step.stage_key);
      try {
        await deps.addEvent({ kind: "progress", message_ar: `بحث ${STEP_LABEL_AR[step.kind]} لصناع القرار: وُجد لـ ${toArabicDigits(found)} من ${toArabicDigits(peopleCount)}.`, counts: { saved: found, planned: peopleCount } });
      } catch { /* a lost note never stops a run */ }
    },
  };
}
