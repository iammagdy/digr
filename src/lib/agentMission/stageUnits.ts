import { UNIT_SCALE } from "../recordPricing";
import { AGENT_JOB_POINTS_CAP } from "./constants";
import { stagePriceInputs, type PricedPlan, type PricedStage } from "./plan";
import { chargeForDelivered, priceMissionByCode } from "./price";
import type { MissionPricingSettings } from "../missionPricing";

/**
 * SETTLEMENT PER STAGE (DT-20261119-01, owner decisions D-0103 and D-0107). A mission whose people stage was priced by an ESTIMATE (stage.estimated) is sold with TWO unit prices, both derived by code from the same
 * pricing rule the card uses (price.ts, never changed here):
 *
 *   companies (base)    uc = the unit of the plan WITHOUT the estimated stage («the companies' own unit», the minimum spread over their rows as today), G = that plan's charge at full
 *   people (estimated)  up = (F - G) / Np rounded DOWN to six decimals, F = today's charge at full for the WHOLE plan, Np = the people rows sold
 *
 * so Nc x uc + Np x up is in (F - 1, F] and a full delivery is charged EXACTLY F, the card's «السعر حتى». The charge of a delivery of Dc companies and Dp people is
 *
 *   min( ceil(Dc x uc + Dp x up),  ceil((Dc + Dp) x the job's blended unit),  the hold,  the cap )
 *
 * The second term is what the website's one-unit settlement charges for the same delivery today: the customer never pays more than today's rule (CTO rule, Gate 1 P1-4). The hold and the job's unit stay the blended ones.
 * The database function (settle_job_by_stage_atomic, 20261119020000) does the same arithmetic on the prices carried by the accepted quote; the tests run both on the same scenarios.
 * A plan without an estimated stage has no stage units and settles exactly as before.
 */
export interface StageUnits {
  /** points per company row (the companies' own unit), six decimals */
  base: number;
  /** points per person row, six decimals */
  estimated: number;
  /** the rows sold per group */
  rows: { base: number; estimated: number };
}
export interface StageCounts { base: number; estimated: number }

const micro = (points: number): bigint => BigInt(Math.round(points * UNIT_SCALE));

/** The keys of the stages that belong to the estimated group: the estimated stages and everything below them. */
export function estimatedGroupKeys(stages: ReadonlyArray<Pick<PricedStage, "key" | "parent_key" | "estimated">>): Set<string> {
  const group = new Set(stages.filter((s) => s.estimated === true).map((s) => s.key));
  let grew = group.size > 0;
  while (grew) {
    grew = false;
    for (const s of stages) if (s.parent_key !== null && s.parent_key !== undefined && group.has(s.parent_key) && !group.has(s.key)) { group.add(s.key); grew = true; }
  }
  return group;
}

/** The two units of a plan with an estimated people stage, or null when it has none (then the one-unit settlement applies, exactly as before). Pure: derived from the stored plan, so an edit can never leave them stale. */
export function stageUnitsOf(plan: Pick<PricedPlan, "stages" | "contact_steps"> & { price: Pick<PricedPlan["price"], "settings"> }, settings?: MissionPricingSettings): StageUnits | null {
  const group = estimatedGroupKeys(plan.stages);
  if (group.size === 0) return null;
  const cfg = settings ?? plan.price.settings;
  const sold = (keys: (k: string) => boolean) => plan.stages.filter((s) => s.deliver && keys(s.key)).reduce((n, s) => n + Math.max(0, Math.floor(s.planned_rows)), 0);
  const nc = sold((k) => !group.has(k));
  const np = sold((k) => group.has(k));
  const baseStages = plan.stages.filter((s) => !group.has(s.key));
  // a plan with no people to sell, or no companies to sell, has nothing to split: it is settled by the one unit (never an error here: the approval refuses what cannot be split)
  if (np <= 0 || nc <= 0 || baseStages.length === 0) return null;
  const full = priceMissionByCode(stagePriceInputs(plan.stages, plan.contact_steps), { settings: cfg });
  const baseOnly = priceMissionByCode(stagePriceInputs(baseStages, plan.contact_steps), { settings: cfg });
  const base = baseOnly.unitPricePoints;
  const diff = Math.max(0, full.maxChargePoints - baseOnly.maxChargePoints);
  const estimated = Number((BigInt(diff) * BigInt(UNIT_SCALE)) / BigInt(np)) / UNIT_SCALE;
  return { base, estimated, rows: { base: nc, estimated: np } };
}

/** What the database function charges (the same integer arithmetic): the lower of the per-stage charge and the one-unit charge, never above the hold or the cap; nothing when nothing is delivered. */
export function settlementChargeByStage(counts: StageCounts, units: Pick<StageUnits, "base" | "estimated">, blendedUnitPoints: number, reservedPoints: number, capPoints: number = AGENT_JOB_POINTS_CAP): number {
  const dc = Math.max(0, Math.floor(counts.base));
  const dp = Math.max(0, Math.floor(counts.estimated));
  if (dc + dp <= 0) return 0;
  const scale = BigInt(UNIT_SCALE);
  const byStage = (BigInt(dc) * micro(units.base) + BigInt(dp) * micro(units.estimated) + scale - BigInt(1)) / scale;
  const blended = BigInt(chargeForDelivered(dc + dp, blendedUnitPoints));
  const lowest = [byStage, blended, BigInt(Math.max(0, Math.floor(reservedPoints))), BigInt(Math.max(0, Math.floor(capPoints)))].reduce((a, b) => (b < a ? b : a));
  return Number(lowest);
}

/**
 * The delivered rows of each group, read from the items of each stage IN THE FILE (fileByStage) or, when the file could not be counted by stage, from the rows saved. Each group is capped by the rows sold for it, so the two
 * counts always add up to the rows the job records as delivered (the database refuses a split that does not): `deliveredUnits` is the sum, never more than `delivered`.
 */
export function stageCountsOf(stages: ReadonlyArray<Pick<PricedStage, "key" | "parent_key" | "estimated" | "deliver">>, byStage: Readonly<Record<string, number>>, units: Pick<StageUnits, "rows">, delivered: number): StageCounts & { deliveredUnits: number } {
  const group = estimatedGroupKeys(stages);
  const inGroup = stages.filter((s) => s.deliver && group.has(s.key)).reduce((n, s) => n + Math.max(0, Math.floor(byStage[s.key] ?? 0)), 0);
  const total = Math.max(0, Math.floor(delivered));
  const estimated = Math.min(inGroup, units.rows.estimated, total);
  const base = Math.min(total - estimated, units.rows.base);
  return { base, estimated, deliveredUnits: base + estimated };
}
