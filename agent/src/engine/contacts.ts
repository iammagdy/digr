import type { PricedPlan } from "../../../src/lib/agentMission/plan";
import { contactStatusAr, finderParamsFor, foundContactIn, personFactsOf, type ContactStep } from "../../../src/lib/agentMission/contactFinders";
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
  filled: { email: number; phone: number; unverified: number };
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
  const out: ContactEnrichmentOutcome = { filled: { email: 0, phone: 0, unverified: 0 }, looked: 0, skipped: 0, spentUsd: 0, stopped: null };
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
  try {
    outer: for (const row of ranked) {
      if (String(row[step.column_key] ?? "").trim() !== "") continue; // already has a value (the source gave one, or an earlier run found it)
      const facts = personFactsOf(row, stage.columns, parents.get(String(row.parent_id)) ?? null);
      let asked = false;
      for (const finder of step.finders) {
        const params = finderParamsFor(finder, facts);
        if (!params) continue;
        if (Date.now() >= deps.deadlineMs) { stopped = "time_limit"; break outer; }
        if (deps.shouldStop?.()) { stopped = "aborted"; break outer; }
        // no call that its own price would take past the step's priced amount (a dearer fallback finder never runs past it) or past the job's budget
        if (budget.spentUsd() - startedAt + finder.usd > capUsd + EPS) continue;
        if (budget.ceilingUsd !== null && budget.spentUsd() + finder.usd > budget.ceilingUsd + EPS) { stopped = "budget"; break outer; }
        asked = true;
        const result = await gateway.tregCall({ endpoint_id: finder.id, params });
        if (!result.ok) {
          const refused = "refused" in result ? String(result.refused) : "";
          if (refused === "over_budget") { stopped = "budget"; break outer; }
          if (refused === "daily_cap" || refused === "daily_limit") { stopped = "daily_cap"; break outer; }
          continue; // a failed or refused call (a source that is down or unhealthy) is not the end: the next ranked finder is tried
        }
        let page: unknown = null;
        try { const raw = await store.getFile(deps.missionId, RAW_PATH(result.call_id)); page = raw === null ? null : JSON.parse(raw); } catch { page = null; }
        const hit = page === null ? null : foundContactIn(step.kind, page);
        if (!hit) continue;
        pending.push({ t: "cells", stage: step.stage_key, id: String(row.id), cells: { [step.column_key]: hit.value, [step.status_key]: contactStatusAr(hit.status) } });
        found += 1;
        out.filled[step.kind] += 1;
        if (hit.status === "unverified") out.filled.unverified += 1;
        break;
      }
      if (asked) out.looked += 1; else out.skipped += 1;
      if (pending.length >= COMMIT_EVERY) await flush();
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
