import { GENERIC_ITEM_NOUN, itemNounOfPlan } from "./itemNoun";
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

/** A job from before missions existed, as the wallet reads it from the job row. */
export interface JobForWallet { id: string; status: string | null; delivered_units: number | null; charged_credits: number | string | null; reserved_credits: number | string | null }

const FINISHED_JOB = new Set(["completed", "done", "failed", "partial", "cancelled"]);

/** The one money line of a finished job that has no mission row (same wording as a mission's line; its items are called «عناصر» because no request noun was stored). Null while the job is open or has no stored charge. */
export function jobWalletLineAr(j: JobForWallet): string | null {
  if (!j.status || !FINISHED_JOB.has(j.status) || j.charged_credits === null || j.charged_credits === undefined) return null;
  return moneyLineAr({ reservedPoints: Number(j.reserved_credits ?? 0), chargedPoints: Number(j.charged_credits), delivered: Math.max(0, Math.floor(Number(j.delivered_units ?? 0))), noun: GENERIC_ITEM_NOUN });
}
