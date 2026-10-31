import { GENERIC_ITEM_NOUN, itemNounOfPlan, type ItemNoun } from "./itemNoun";
import { pointsAr } from "../pointsFormat";
import type { JobLedgerTotals } from "../walletView";
import { moneyLineAr } from "./moneyText";

/**
 * THE MONEY LINE OF A FINISHED MISSION for the wallet: the same line the completion panel, the notification and the e-mail show («خُصم ١٢٨ نقطة مقابل ١٩٢ تغريدة»), built from the mission's own numbers (the delivered count is the count of the
 * file the customer received). Null for a mission that is not finished yet or has no stored charge: its ledger rows are then listed one by one.
 */
export interface MissionForWallet { job_id: string | null; status: string | null; delivered_units: number | null; charged_points: number | string | null; reserved_points: number | string | null; plan_public: unknown }

const FINISHED = new Set(["completed", "unserved", "failed"]);

export function missionWalletLineAr(m: MissionForWallet): string | null {
  if (!m.job_id || !m.status || !FINISHED.has(m.status) || m.charged_points === null || m.charged_points === undefined) return null;
  const plan = m.plan_public && typeof m.plan_public === "object" ? (m.plan_public as { stages?: ReadonlyArray<{ title_ar?: unknown; deliver?: boolean }> }) : null;
  return moneyLineAr({ reservedPoints: Number(m.reserved_points ?? 0), chargedPoints: Number(m.charged_points), delivered: Math.max(0, Math.floor(Number(m.delivered_units ?? 0))), noun: itemNounOfPlan(plan) });
}

/**
 * THE ONE LINE OF A JOB IN THE WALLET, MADE FROM THE LEDGER. The points are the job's own `credit_ledger` rows summed (see `jobLedgerTotals`: the balance's sign and the wallet month figures' grouping); the mission and job rows
 * supply only the delivered count and the noun of the items, never a point figure. A stored figure on a mission or a job is a display helper and can be stale (3 older jobs disagreed with the ledger when this was written).
 *   - held and not yet lifted or charged (a running job): «حجز مؤقت ٢٣٠ نقطة لطلب قيد التنفيذ»;
 *   - finished: «خُصم ٢٠٠ نقطة مقابل ٥٠ تغريدة» (what the charge rows add up to), or, with nothing charged, «لم يُخصم شيء؛ حجز مؤقت مُحرَّر ٢٣٠ نقطة»; the hold is then lifted, so nothing is shown as held.
 * Null when the job has no rows, or has a row of a type this line does not explain (its rows are then listed one by one).
 */
export interface JobFactsForWallet { delivered: number | null; noun: ItemNoun }

export function jobLedgerLineAr(totals: JobLedgerTotals | undefined, facts: JobFactsForWallet): string | null {
  if (!totals || totals.rows === 0 || totals.otherTypes) return null;
  const { reserved, released, charged } = totals;
  if (released === 0 && charged === 0) return reserved > 0 ? `حجز مؤقت ${pointsAr(reserved)} لطلب قيد التنفيذ` : null;
  if (charged > 0 && facts.delivered === null) return `خُصم ${pointsAr(charged)}`;
  return moneyLineAr({ reservedPoints: Math.max(reserved, released), chargedPoints: charged, delivered: Math.max(0, Math.floor(facts.delivered ?? 0)), noun: facts.noun });
}

/** The delivered count and the noun of a job's items, from its mission (the plan's stages) or, for an older job, from the job row; the noun of an older job is the generic «عنصر». Never a point figure. */
export function jobFactsForWallet(mission: { delivered_units: number | null; plan_public: unknown } | undefined, job: { delivered_units: number | null } | undefined): JobFactsForWallet {
  const plan = mission && mission.plan_public && typeof mission.plan_public === "object" ? (mission.plan_public as { stages?: ReadonlyArray<{ title_ar?: unknown; deliver?: boolean }> }) : null;
  const units = mission?.delivered_units ?? job?.delivered_units;
  return { delivered: typeof units === "number" && Number.isFinite(units) ? units : null, noun: mission ? itemNounOfPlan(plan) : GENERIC_ITEM_NOUN };
}
