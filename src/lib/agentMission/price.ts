import { unitPricePointsFromCost, UNIT_SCALE, type PricingBasis } from "../recordPricing";
import { holdValueUsd } from "../server/callBudget";
import { AGENT_EXECUTION_BUDGET_FLOOR_USD, AGENT_EXECUTION_BUDGET_SHARE, AGENT_JOB_POINTS_CAP, AGENT_PRICING_BASIS, AGENT_RESERVE_MARGIN } from "./constants";

/**
 * THE PRICE OF A MISSION, BY CODE. The model proposes a plan and cites the calls it measured with; it never states a number. Everything below is arithmetic on
 * what the gateway recorded (the actual charge of each call) and on the shared constants of the website:
 *
 *   unit price (points) = cost per final row (USD) x 5,500            (recordPricing.ts, fractional, six decimals, rounded UP)
 *   reserve             = ceil(volume x unit price x 1.15)            (the 15% buffer is on the reserve only)
 *   charge              = ceil(delivered unique final rows x unit price), never above the reserve and never above the cap (the database does the same: settle_job_atomic)
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
  /** Rows this stage will collect (already limited by its parent: see limitStageRows). */
  rows: number;
  /** Measured cost per row of this stage, USD. */
  costPerRowUsd: number;
  deliver: boolean;
}

export interface MissionPriceResult {
  /** Provider cost of the whole mission at the planned rows, USD. */
  totalCostUsd: number;
  /** Rows the customer receives (the delivered stages together). */
  deliveredRows: number;
  /** Provider cost per FINAL row, USD: total cost over the delivered rows. */
  costPerFinalRowUsd: number;
  /** Points per final row (fractional, six decimals). */
  unitPricePoints: number;
  /** Points held: ceil(delivered x unit x 1.15). */
  reservePoints: number;
  /** What the customer is charged if every planned row is delivered: ceil(delivered x unit). */
  maxChargePoints: number;
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

/** What settle_job_atomic charges: ceil(delivered x unit), never above the reserve, never above the cap. */
export function settlementCharge(input: { deliveredUnits: number; unitPricePoints: number; reservedPoints: number; capPoints?: number }): { chargedPoints: number; releasedPoints: number } {
  const raw = chargeForDelivered(input.deliveredUnits, input.unitPricePoints);
  const charged = Math.min(raw, Math.max(0, input.reservedPoints), input.capPoints ?? AGENT_JOB_POINTS_CAP);
  return { chargedPoints: charged, releasedPoints: Math.max(0, input.reservedPoints - charged) };
}

export function priceMissionByCode(stages: ReadonlyArray<StagePriceInput>, basis: PricingBasis = AGENT_PRICING_BASIS): MissionPriceResult {
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
  return {
    totalCostUsd: total,
    deliveredRows: delivered,
    costPerFinalRowUsd: costPerFinal,
    unitPricePoints: unit,
    reservePoints: reserve,
    maxChargePoints: chargeForDelivered(delivered, unit),
    overCap: reserve > AGENT_JOB_POINTS_CAP,
  };
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
