import type { PricedPlan } from "../../../src/lib/agentMission/plan";
import { contactStatusAr, finderParamsFor, foundContactIn, personFactsOf, verifierParamsFor, type ContactStep, type FinderInfo, type FoundContact } from "../../../src/lib/agentMission/contactFinders";
import { EMAIL_STATUS_OTHER_COMPANY_AR, EMAIL_STATUS_VERIFIED_AR, emailOnOtherDomain, emailStatusAr, emailVerdictIn } from "../../../src/lib/agentMission/emailVerification";
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
 * MONEY: no ledger, price or cap code is touched. Each call goes through the gateway (the job's call budget, the provider's daily limit, the record), and this step adds two limits of its own: a step may not spend more than what its price carries (per_person_usd x its people), and no
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

export async function runContactEnrichment(deps: ContactDeps): Promise<ContactEnrichmentOutcome> {
  const { items, plan } = deps;
  const out: ContactEnrichmentOutcome = { filled: { email: 0, phone: 0, unverified: 0, verified: 0 }, looked: 0, skipped: 0, spentUsd: 0, stopped: null };
  // e-mails first, phones after them (a phone is asked only when the e-mails are done and the budget has room)
  const steps = [...(plan.contact_steps ?? [])].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "email" ? -1 : 1));
  for (const step of steps) {
    const stage = plan.stages.find((s) => s.key === step.stage_key);
    if (!stage) continue;
    const stopped = await runStep(deps, step, stage, out);
    if (stopped) { out.stopped = stopped; break; }
  }
  return out;
}

/** One call a step wants to make, and what came of it. */
type Attempt = { t: "stop"; stop: ContactStop } | { t: "skip" } | { t: "failed" } | { t: "page"; page: unknown };

async function runStep(deps: ContactDeps, step: ContactStep, stage: ContactDeps["plan"]["stages"][number], out: ContactEnrichmentOutcome): Promise<ContactStop | null> {
  const { items, store, gateway, budget } = deps;
  const parents = new Map<string, Row>(stage.parent_key ? items.acceptedRows(stage.parent_key).map((r) => [String(r.id), r] as const) : []);
  const rows = items.acceptedRows(step.stage_key);
  const ranked = rankPeopleByRole(rows, (stage as { role_preference?: { role: Parameters<typeof rankPeopleByRole>[1] } }).role_preference?.role ?? "manager").rows;
  // what this step may spend: what its price carries
  const capUsd = step.per_person_usd * rows.length;
  const startedAt = budget.spentUsd();
  let pending: Op[] = [];
  let stopped: ContactStop | null = null;
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
    if (budget.spentUsd() - startedAt + helper.usd > capUsd + EPS) return { t: "skip" };
    if (budget.ceilingUsd !== null && budget.spentUsd() + helper.usd > budget.ceilingUsd + EPS) return { t: "stop", stop: "budget" };
    const result = await gateway.tregCall({ endpoint_id: helper.id, params });
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
  try {
    outer: for (const row of ranked) {
      const existing = String(row[step.column_key] ?? "").trim();
      const existingStatus = String(row[step.status_key] ?? "").trim();
      // a value that already has its final status (an earlier run of this step) is not looked up or verified again
      if (existing !== "" && (step.kind !== "email" || existingStatus === EMAIL_STATUS_VERIFIED_AR || existingStatus === EMAIL_STATUS_OTHER_COMPANY_AR)) continue;
      const facts = personFactsOf(row, stage.columns, parents.get(String(row.parent_id)) ?? null);
      let asked = false;
      let value = existing;
      let statusAr: string | null = null;
      let hit: FoundContact | null = null;
      if (value === "") {
        for (const finder of step.finders) {
          const params = finderParamsFor(finder, facts);
          if (!params) continue;
          const a = await attempt(finder, params);
          if (a.t === "stop") { stopped = a.stop; break outer; }
          if (a.t === "skip") continue;
          asked = true;
          if (a.t === "failed") continue; // the next ranked finder is tried
          hit = foundContactIn(step.kind, a.page);
          if (!hit) continue;
          value = hit.value;
          break;
        }
      }
      if (value !== "") {
        if (step.kind === "email") {
          // finder, fallback finder, then the VERIFIER: «موثّق» only when a verifier says so
          const verdict = await emailStatusOf(value, facts.domain);
          if (verdict.stop) stopped = verdict.stop;
          if ((step.verifiers ?? []).length > 0 || verdict.status === "other_company") asked = true;
          statusAr = emailStatusAr(verdict.status);
          if (verdict.status === "unverified") out.filled.unverified += hit ? 1 : 0;
          else if (verdict.status === "verified") out.filled.verified += 1;
        } else if (hit) {
          statusAr = contactStatusAr(hit.status);
          if (hit.status === "unverified") out.filled.unverified += 1;
        }
        const cells: Record<string, string> = { ...(hit || existing === "" ? { [step.column_key]: value } : {}), ...(statusAr !== null ? { [step.status_key]: statusAr } : {}) };
        if (Object.keys(cells).length > 0) pending.push({ t: "cells", stage: step.stage_key, id: String(row.id), cells });
        if (hit) { found += 1; out.filled[step.kind] += 1; }
      }
      if (asked) out.looked += 1; else out.skipped += 1;
      if (pending.length >= COMMIT_EVERY) await flush();
      if (stopped) break outer;
    }
  } finally {
    await flush();
    await items.mirror(step.stage_key);
  }
  out.spentUsd += budget.spentUsd() - startedAt;
  try {
    await deps.addEvent({ kind: "progress", message_ar: `بحث ${STEP_LABEL_AR[step.kind]} لصناع القرار: وُجد لـ ${toArabicDigits(found)} من ${toArabicDigits(rows.length)}.`, counts: { saved: found, planned: rows.length } });
  } catch { /* a lost note never stops a run */ }
  return stopped;
}
