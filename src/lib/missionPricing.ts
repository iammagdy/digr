import { DEFAULT_PRICING_BASIS, UNIT_SCALE, unitPriceMicro, type PricingBasis } from "./recordPricing";
import { effectiveJobPointsCap, JOB_MAX_POINTS_CAP } from "./jobPointsCap";
import { formatAr } from "./arabicDigits";

/**
 * THE ONE PRICING RULE of every mission (owner decision of 2026-10-28). One general rule, no per-service price. The quote of the agent (agentMission/plan.ts), the calculator (missionEstimate.ts)
 * and the public pages all take their numbers from THIS module; the model never decides or states a price.
 *
 *   unit price per delivered MATCHING row (points) = (provider cost + model cost, review included, per delivered matching row, USD) x markup x 55 / 0.10      (markup 10: 5,500 points per USD)
 *   charge  = max(minimum, ceil(delivered matching rows x unit)) when at least one row is delivered; nothing delivered: no charge; never above the reserve and never above the cap
 *   reserve = max(minimum, ceil(volume x unit x 1.15)); the 15% buffer is on the reserve only
 *
 * `markup` and `minChargePoints` are settings the owner edits on the admin page «الوكيل» (table agent_settings, key `mission_pricing`, every change has an audit row); code reads them with
 * `readMissionPricingSettings` and falls back to the defaults below when the row is missing or invalid.
 *
 * THE MINIMUM AND THE DATABASE. settle_job_atomic charges ceil(delivered_units x the job's unit_price), and a job stores ONE unit price. So the job's unit is `max(rule unit, floor(minimum / volume))`
 * (`jobUnitPoints`): a mission that delivers everything it was sold is charged EXACTLY max(minimum, ceil(volume x rule unit)). A PARTIAL delivery is charged in proportion to that unit (never more
 * than the full charge); applying the minimum to a partial delivery needs a settlement function that knows the minimum: docs/proposals/agent-pricing-minimum/ (NOT APPLIED; no code depends on it).
 */
export interface MissionPricingSettings {
  /** The multiple of the provider-and-model cost that the customer pays (10 today). */
  markup: number;
  /** The smallest charge of a mission that delivers at least one row, in points (200 today). */
  minChargePoints: number;
}

export const DEFAULT_MISSION_PRICING_SETTINGS: MissionPricingSettings = { markup: 10, minChargePoints: 200 };
/** What the admin page accepts (a mistake of a digit must not reach a quote). */
export const MISSION_MARKUP_LIMITS = { min: 1, max: 50 } as const;
export const MISSION_MIN_CHARGE_LIMITS = { min: 0, max: 2_000 } as const;
/** The agent_settings key that holds both settings: {markup, min_charge_points}. */
export const MISSION_PRICING_SETTING_KEY = "mission_pricing";

const finite = (v: unknown): number | null => { const n = typeof v === "string" ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) ? n : null; };

/** The settings from a stored value; anything missing or out of range falls back to the default, field by field. */
export function normalizeMissionPricingSettings(raw: unknown): MissionPricingSettings {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const markup = finite(o.markup);
  const min = finite(o.min_charge_points ?? o.minChargePoints);
  return {
    markup: markup !== null && markup >= MISSION_MARKUP_LIMITS.min && markup <= MISSION_MARKUP_LIMITS.max ? markup : DEFAULT_MISSION_PRICING_SETTINGS.markup,
    minChargePoints: min !== null && Number.isInteger(min) && min >= MISSION_MIN_CHARGE_LIMITS.min && min <= MISSION_MIN_CHARGE_LIMITS.max ? min : DEFAULT_MISSION_PRICING_SETTINGS.minChargePoints,
  };
}

/** Why a value the admin typed is refused, or null when it is valid. */
export function missionPricingSettingsProblemAr(input: { markup: unknown; minChargePoints: unknown }): string | null {
  const m = finite(input.markup);
  const c = finite(input.minChargePoints);
  if (m === null || m < MISSION_MARKUP_LIMITS.min || m > MISSION_MARKUP_LIMITS.max) return `المضاعف يجب أن يكون بين ${formatAr(MISSION_MARKUP_LIMITS.min)} و${formatAr(MISSION_MARKUP_LIMITS.max)}.`;
  if (c === null || !Number.isInteger(c) || c < MISSION_MIN_CHARGE_LIMITS.min || c > MISSION_MIN_CHARGE_LIMITS.max) return `الحد الأدنى يجب أن يكون عددًا صحيحًا بين ${formatAr(MISSION_MIN_CHARGE_LIMITS.min)} و${formatAr(MISSION_MIN_CHARGE_LIMITS.max)} نقطة.`;
  return null;
}

/** Reads the settings from the agent_settings table (service-role client). Never throws: an unreadable row is the defaults. */
export async function readMissionPricingSettings(client: { from: (t: string) => any }): Promise<MissionPricingSettings> {
  try {
    const { data } = await client.from("agent_settings").select("value").eq("key", MISSION_PRICING_SETTING_KEY).maybeSingle();
    return normalizeMissionPricingSettings(data?.value);
  } catch {
    return { ...DEFAULT_MISSION_PRICING_SETTINGS };
  }
}

/** The basis of the arithmetic: the website's exchange rate and point value with THIS markup. */
export const basisOf = (settings: MissionPricingSettings): PricingBasis => ({ ...DEFAULT_PRICING_BASIS, markup: settings.markup });
/** Points the customer pays per USD of cost (5,500 with the defaults). */
export const pointsPerCostUsd = (settings: MissionPricingSettings = DEFAULT_MISSION_PRICING_SETTINGS): number => (DEFAULT_PRICING_BASIS.usdToEgp * settings.markup) / DEFAULT_PRICING_BASIS.creditValueEgp;
/** What one point of REVENUE is worth in USD (1/550 with the defaults): the base of the review budget. */
export const revenueUsdPerPoint = (): number => DEFAULT_PRICING_BASIS.creditValueEgp / DEFAULT_PRICING_BASIS.usdToEgp;

const big = (n: number) => BigInt(Math.trunc(n));
const ceilDiv = (num: bigint, den: bigint): bigint => (num + den - BigInt(1)) / den;

export interface MissionRuleInput {
  /** Rows the customer is sold (the volume of the delivered stages). */
  volume: number;
  /** Provider cost + model cost (review included) per delivered MATCHING row, USD. */
  costPerRowUsd: number;
  settings?: MissionPricingSettings;
  /** The most a job may hold (the site's cap). */
  capPoints?: number;
}

export interface MissionRulePrice {
  settings: MissionPricingSettings;
  volume: number;
  /** The rule's unit price: cost per matching row x markup x 55 / 0.10, six decimals, rounded up. */
  unitPoints: number;
  /** The unit the JOB stores (what the database multiplies): the rule unit, or floor(minimum / volume) when the minimum is the larger. */
  jobUnitPoints: number;
  /** What a mission that delivers all its rows is charged. */
  chargeAtFullPoints: number;
  reservePoints: number;
  /** True when the minimum (not the rule) sets the charge of a full delivery. */
  minApplied: boolean;
  overCap: boolean;
}

/** ceil(volume x unit): exact, on millionths of a point. */
export function chargeAtUnit(rows: number, unitPoints: number): number {
  const d = Math.max(0, Math.floor(rows));
  const micro = Math.round(unitPoints * UNIT_SCALE);
  if (d <= 0 || micro <= 0) return 0;
  return Number(ceilDiv(big(d) * big(micro), big(UNIT_SCALE)));
}

/** ceil(volume x unit x (1 + buffer)), exact. */
export function reserveAtUnit(volume: number, unitPoints: number, buffer: number = DEFAULT_PRICING_BASIS.safetyBuffer): number {
  const v = Math.max(0, Math.floor(volume));
  const micro = Math.round(unitPoints * UNIT_SCALE);
  if (v <= 0 || micro <= 0) return 0;
  const bps = Math.round(Math.max(0, buffer) * 10_000);
  return Number(ceilDiv(big(v) * big(micro) * big(10_000 + bps), big(UNIT_SCALE) * big(10_000)));
}

export function priceByRule(input: MissionRuleInput): MissionRulePrice {
  const settings = input.settings ?? DEFAULT_MISSION_PRICING_SETTINGS;
  const volume = Math.max(0, Math.floor(input.volume));
  if (volume < 1) throw new Error("a mission sells at least one row");
  if (!(input.costPerRowUsd > 0)) throw new Error("the cost per matching row must be positive");
  const unitMicroRule = unitPriceMicro(input.costPerRowUsd, basisOf(settings));
  const unitPoints = unitMicroRule / UNIT_SCALE;
  const min = settings.minChargePoints;
  // floor(minimum / volume) in millionths: volume x that is at most the minimum and more than the minimum minus a thousandth of a point per 1,000 rows, so its ceil is exactly the minimum
  const minUnitMicro = min > 0 ? Math.max(1, Math.floor((min * UNIT_SCALE) / volume)) : 0;
  const jobMicro = Math.max(unitMicroRule, minUnitMicro);
  const jobUnitPoints = jobMicro / UNIT_SCALE;
  const ruleCharge = chargeAtUnit(volume, unitPoints);
  const chargeAtFull = chargeAtUnit(volume, jobUnitPoints);
  const reserve = Math.max(min, reserveAtUnit(volume, unitPoints));
  const cap = input.capPoints ?? effectiveJobPointsCap();
  return { settings, volume, unitPoints, jobUnitPoints, chargeAtFullPoints: Math.min(chargeAtFull, reserve), reservePoints: reserve, minApplied: min > ruleCharge, overCap: reserve > cap };
}

/**
 * What the settlement charges for `delivered` rows of a job sold at this price: nothing for zero rows, else ceil(delivered x the job's unit), never above the reserve (the database does the same).
 * With the minimum applied by the unit, a full delivery is charged exactly the minimum or the rule's charge. The settlement call always passes the constant cap (a job sold under a higher cap is never under-charged when the cap is lowered later).
 */
export function settlementChargeFor(delivered: number, price: Pick<MissionRulePrice, "jobUnitPoints" | "reservePoints">, capPoints: number = JOB_MAX_POINTS_CAP): number {
  if (!(delivered > 0)) return 0;
  return Math.min(chargeAtUnit(delivered, price.jobUnitPoints), price.reservePoints, capPoints);
}

/** The sentence of the plan card (and the public pages) about the minimum. Empty when the minimum is switched off (0). */
export function minimumLineAr(settings: MissionPricingSettings = DEFAULT_MISSION_PRICING_SETTINGS): string {
  return settings.minChargePoints > 0 ? `الحد الأدنى للمهمة ${formatAr(settings.minChargePoints)} نقطة، ولا خصم إن لم يُسلَّم شيء.` : "لا خصم إن لم يُسلَّم شيء.";
}
