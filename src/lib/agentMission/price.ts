import { unitPricePointsFromCost, UNIT_SCALE, type PricingBasis } from "../recordPricing";
import { DEFAULT_MISSION_PRICING_SETTINGS, priceByRule, settlementChargeFor, type MissionPricingSettings } from "../missionPricing";
import { holdValueUsd } from "../server/callBudget";
import {
  AGENT_EXECUTION_BUDGET_FLOOR_USD, AGENT_EXECUTION_BUDGET_SHARE, AGENT_JOB_POINTS_CAP, AGENT_MODEL_EXECUTION_PER_STAGE_ESTIMATE_USD, AGENT_MODEL_PLANNING_ESTIMATE_USD, AGENT_PRICING_BASIS, AGENT_RESERVE_MARGIN,
  AGENT_REVIEW_ROW_ESTIMATE_USD, AGENT_REVIEW_BUDGET_SHARE, AGENT_REVIEW_CEILING_SHARE,
} from "./constants";

/**
 * THE PRICE OF A MISSION, BY CODE. The model proposes a plan and cites the calls it measured with; it never states a number. Everything below is arithmetic on what the gateway recorded (the actual charge
 * of each call), on the share of the sampled rows that MATCH the request (relevance.ts, computed by code on the sample), and on the one pricing rule of the site (missionPricing.ts):
 *
 *   cost per delivered row (USD) = ( provider cost of the rows to collect + estimated model cost, review included ) / delivered matching rows
 *   unit price (points)          = cost per delivered row x markup x 55 / 0.10                   (markup 10 by default; an admin setting)
 *   charge                       = max(minimum, ceil(delivered x unit)) when anything is delivered, else nothing; reserve = max(minimum, ceil(volume x unit x 1.15)); cap 25,000
 *
 * Integer arithmetic on millionths of a point, so no floating-point drift can make a charge pass a reserve.
 */

export interface MeasuredCall {
  /** What the call really cost (USD): the charge recorded in provider_costs. */
  costUsd: number;
  /** Rows the call returned, counted by code from the saved page. */
  rows: number;
}

/** Cost per row of one stage from the calls that measured it: total actual cost over total rows returned. Null when nothing measurable (no rows). */
export function measuredCostPerRowUsd(calls: ReadonlyArray<MeasuredCall>): number | null {
  const rows = calls.reduce((n, c) => n + Math.max(0, Math.floor(c.rows)), 0);
  if (rows <= 0) return null;
  const cost = calls.reduce((n, c) => n + Math.max(0, Number(c.costUsd) || 0), 0);
  return cost / rows;
}

export interface StagePriceInput {
  /** Rows this stage will DELIVER (matching rows; already limited by its parent: see limitStageRows). */
  rows: number;
  /** Measured cost per RAW row of this stage, USD. */
  costPerRowUsd: number;
  deliver: boolean;
  /** Share of the sampled rows that match the request (0 to 1, from the code's own check of the sample); 1 when the stage has no relevance check. The rows to collect are rows / yield. */
  yield?: number;
  /** Share of the sampled rows the model will have to review (uncertain rows), 0 when none. */
  reviewShare?: number;
}

export interface MissionPriceOptions {
  settings?: MissionPricingSettings;
  /** The most a job may hold. */
  capPoints?: number;
}

export interface MissionPriceResult {
  /** 2: the one rule of missionPricing.ts. Plans stored before it have no `rule` and are priced by the old formula (legacyPriceMissionByCode). */
  rule?: 2;
  /** Provider cost of the whole mission at the planned rows, USD (the rows to collect included). */
  totalCostUsd: number;
  /** Estimated model cost (planning, execution, review), USD. */
  modelCostUsd?: number;
  /** Estimated provider cost alone, USD. */
  providerCostUsd?: number;
  /** What the model may spend on reviewing uncertain rows: 20% of the mission's revenue, USD. */
  reviewBudgetUsd?: number;
  /** Rows the customer receives (the delivered stages together). */
  deliveredRows: number;
  /** Provider + model cost per FINAL row, USD. */
  costPerFinalRowUsd: number;
  /** The rule's unit price per matching row (points, six decimals). */
  ruleUnitPoints?: number;
  /** Points per final row THE JOB STORES (what the database multiplies): the rule's unit, or the minimum spread over the volume when the minimum is larger. */
  unitPricePoints: number;
  /** Points held. */
  reservePoints: number;
  /** What the customer is charged if every planned row is delivered. */
  maxChargePoints: number;
  minChargePoints?: number;
  /** True when the minimum, not the unit price, sets the charge. */
  minApplied?: boolean;
  /** The markup and the minimum this price was computed with (kept so the approval prices the SAME plan the customer saw). */
  settings?: MissionPricingSettings;
  overCap: boolean;
}

/** unit price in millionths of a point (the integer the arithmetic runs on). */
export const unitMicro = (unitPricePoints: number): number => Math.round(unitPricePoints * UNIT_SCALE);

/** ceil(volume x unit x margin) in exact integer arithmetic. */
export function reservePointsFor(volume: number, unitPricePoints: number, margin: number = AGENT_RESERVE_MARGIN): number {
  const v = Math.max(0, Math.floor(volume));
  // margin as integer hundredths (1.15 -> 115): exact for the 15% buffer
  const marginPct = Math.round(margin * 100);
  const micro = BigInt(unitMicro(unitPricePoints)) * BigInt(v) * BigInt(marginPct);
  const denominator = BigInt(UNIT_SCALE) * BigInt(100);
  return Number((micro + denominator - BigInt(1)) / denominator);
}

/** charge = ceil(delivered x unit), exact. */
export function chargeForDelivered(deliveredUnits: number, unitPricePoints: number): number {
  const d = BigInt(Math.max(0, Math.floor(deliveredUnits)));
  const micro = BigInt(unitMicro(unitPricePoints)) * d;
  const scale = BigInt(UNIT_SCALE);
  return Number((micro + scale - BigInt(1)) / scale);
}

/** What settle_job_atomic charges: ceil(delivered x the job's unit price), never above the reserve, never above the cap; nothing for zero rows. */
export function settlementCharge(input: { deliveredUnits: number; unitPricePoints: number; reservedPoints: number; capPoints?: number }): { chargedPoints: number; releasedPoints: number } {
  const charged = settlementChargeFor(input.deliveredUnits, { jobUnitPoints: input.unitPricePoints, reservePoints: Math.max(0, input.reservedPoints) }, input.capPoints ?? AGENT_JOB_POINTS_CAP);
  return { chargedPoints: charged, releasedPoints: Math.max(0, input.reservedPoints - charged) };
}

/** The model's estimated cost of a mission, USD: one planning, one execution per stage, and the review of the rows the code is unsure about (all estimates: see the constants). */
export function estimateModelCostUsd(stages: ReadonlyArray<StagePriceInput>): number {
  let review = 0;
  for (const s of stages) {
    const y = s.yield !== undefined && s.yield > 0 ? Math.min(1, s.yield) : 1;
    review += Math.max(0, s.rows) / y * Math.max(0, s.reviewShare ?? 0);
  }
  return AGENT_MODEL_PLANNING_ESTIMATE_USD + AGENT_MODEL_EXECUTION_PER_STAGE_ESTIMATE_USD * stages.length + review * AGENT_REVIEW_ROW_ESTIMATE_USD;
}

export function priceMissionByCode(stages: ReadonlyArray<StagePriceInput>, options: MissionPriceOptions = {}): MissionPriceResult {
  if (stages.length === 0) throw new Error("a mission has at least one stage");
  const settings = options.settings ?? DEFAULT_MISSION_PRICING_SETTINGS;
  let provider = 0;
  let delivered = 0;
  for (const s of stages) {
    const y = s.yield !== undefined && s.yield > 0 ? Math.min(1, s.yield) : 1;
    // the rows to COLLECT are the matching rows over the yield: the price rests on the cost per MATCHING row, never on one raw sample
    provider += Math.max(0, s.rows) / y * Math.max(0, s.costPerRowUsd);
    if (s.deliver) delivered += Math.max(0, Math.floor(s.rows));
  }
  if (delivered <= 0) throw new Error("a mission delivers at least one row");
  const model = estimateModelCostUsd(stages);
  const total = provider + model;
  const costPerFinal = total / delivered;
  if (!(costPerFinal > 0)) throw new Error("the measured cost per final row is not positive");
  const rule = priceByRule({ volume: delivered, costPerRowUsd: costPerFinal, settings, capPoints: options.capPoints ?? AGENT_JOB_POINTS_CAP });
  return {
    rule: 2, totalCostUsd: provider, providerCostUsd: provider, modelCostUsd: model, deliveredRows: delivered, costPerFinalRowUsd: costPerFinal,
    ruleUnitPoints: rule.unitPoints, unitPricePoints: rule.jobUnitPoints, reservePoints: rule.reservePoints, maxChargePoints: rule.chargeAtFullPoints,
    minChargePoints: settings.minChargePoints, minApplied: rule.minApplied, settings, overCap: rule.overCap,
    reviewBudgetUsd: reviewBudgetUsdFor(rule.chargeAtFullPoints),
  };
}

/** What the review of uncertain rows may cost one mission: 20% of its revenue (the full charge) in USD. Rows beyond it are not delivered and not charged. */
export function reviewBudgetUsdFor(revenuePoints: number): number {
  return Math.max(0, revenuePoints) * AGENT_PRICING_BASIS.creditValueEgp / AGENT_PRICING_BASIS.usdToEgp * AGENT_REVIEW_BUDGET_SHARE;
}

/** The most the review may reach when rows the request needs are still waiting: 40% of the reserve's value (the hold covers it), USD. */
export function reviewCeilingUsdFor(reservePoints: number, basis: PricingBasis = AGENT_PRICING_BASIS): number {
  return holdValueUsd(reservePoints, basis) * AGENT_REVIEW_CEILING_SHARE;
}

/** THE OLD FORMULA (provider cost only, no minimum, no yield): kept for plans stored before the one rule, so a plan the customer was shown is approved at the price it showed. */
export function legacyPriceMissionByCode(stages: ReadonlyArray<StagePriceInput>, basis: PricingBasis = AGENT_PRICING_BASIS): MissionPriceResult {
  if (stages.length === 0) throw new Error("a mission has at least one stage");
  let total = 0;
  let delivered = 0;
  for (const s of stages) {
    total += Math.max(0, s.rows) * Math.max(0, s.costPerRowUsd);
    if (s.deliver) delivered += Math.max(0, Math.floor(s.rows));
  }
  if (delivered <= 0) throw new Error("a mission delivers at least one row");
  const costPerFinal = total / delivered;
  if (!(costPerFinal > 0)) throw new Error("the measured cost per final row is not positive");
  const unit = unitPricePointsFromCost(costPerFinal, basis);
  const reserve = reservePointsFor(delivered, unit, 1 + basis.safetyBuffer);
  return { totalCostUsd: total, deliveredRows: delivered, costPerFinalRowUsd: costPerFinal, unitPricePoints: unit, reservePoints: reserve, maxChargePoints: chargeForDelivered(delivered, unit), overCap: reserve > AGENT_JOB_POINTS_CAP };
}

/** The TREG USD budget of the EXECUTION phase: 40% of the approved reserve's value, never below 0.005 USD (the website's job budget rule). */
export function executionBudgetUsd(reservePoints: number, basis: PricingBasis = AGENT_PRICING_BASIS): number {
  return Math.max(AGENT_EXECUTION_BUDGET_FLOOR_USD, holdValueUsd(reservePoints, basis) * AGENT_EXECUTION_BUDGET_SHARE);
}

// ------------------------------------------------------------------------------------------- the expected time
/**
 * THE EXPECTED TIME OF A MISSION, BY CODE (the model never states it). It is built from what the planning calls MEASURED: how long they took per row they returned.
 *   seconds = AGENT_TIME_BASE_S + sum over stages of ( AGENT_TIME_STAGE_S + rows x ms-per-row / 1000 x AGENT_TIME_SAFETY + ceil(rows / 200) x AGENT_TIME_TURN_S )
 * rounded UP to whole minutes, never below two. A stage whose calls have no recorded time uses AGENT_TIME_DEFAULT_MS_PER_ROW. It is shown to the customer as «نحو N دقائق».
 */
export const AGENT_TIME_BASE_S = 45;
export const AGENT_TIME_STAGE_S = 40;
export const AGENT_TIME_SAFETY = 1.5;
export const AGENT_TIME_TURN_S = 12;
export const AGENT_TIME_DEFAULT_MS_PER_ROW = 300;
export const AGENT_TIME_MIN_MINUTES = 2;

export function estimateMissionMinutes(stages: ReadonlyArray<{ rows: number; msPerRow?: number | null }>): number {
  let seconds = AGENT_TIME_BASE_S;
  for (const s of stages) {
    const rows = Math.max(0, Math.floor(s.rows));
    const ms = typeof s.msPerRow === "number" && s.msPerRow > 0 ? s.msPerRow : AGENT_TIME_DEFAULT_MS_PER_ROW;
    seconds += AGENT_TIME_STAGE_S + (rows * ms / 1000) * AGENT_TIME_SAFETY + Math.ceil(rows / 200) * AGENT_TIME_TURN_S;
  }
  return Math.max(AGENT_TIME_MIN_MINUTES, Math.ceil(seconds / 60));
}
