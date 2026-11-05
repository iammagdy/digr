import { blockedEndpointReason } from "../../treg/blockList";
import { isSellable, type TregCatalog } from "../../treg/catalog";
import { policyVerdict, type AccountAccess } from "../../treg/dataPolicy";
import type { MissionPricingSettings } from "../../missionPricing";
import { companyPhoneSourcesOf, validatorSourcesOf, verifierSourcesOf } from "../contactFinders";
import type { StatsMap } from "../sourceRanking";
import { stage3Enabled } from "./flags";
import { planB2BByCode, type B2BPlanResult } from "./b2bPlan";

/**
 * STAGE 3, PART A, THE WIRING (docs/STAGE-3.md S3): the worker's planning asks this first. It reads DIGER_STAGE3_COMPANIES BEFORE anything else: off (unset, empty, any other word) or «test» for a
 * customer gives null and the planning is today's, untouched. On (or «test» for a test account): the code-built plan (b2bPlan.ts), with the account's own rule for which tools it may buy and today's
 * helpers of the contact steps (the same calls as the model's planning makes in agent/src/tools.ts). A result with `ok: false` means the caller keeps today's path.
 */
export interface CompaniesPlanningInput {
  requestText: string;
  isTestAccount: boolean;
  catalog: TregCatalog;
  access: AccountAccess;
  stats: StatsMap;
  now: number;
  pricingSettings?: MissionPricingSettings;
  env?: Readonly<Record<string, string | undefined>>;
}

export function planCompaniesByCodeIfOn(input: CompaniesPlanningInput): B2BPlanResult | null {
  if (!stage3Enabled("DIGER_STAGE3_COMPANIES", input.isTestAccount, input.env)) return null;
  const { catalog, access, stats, now } = input;
  const allowed = (id: string): boolean => isSellable(id, catalog) && !blockedEndpointReason(id) && policyVerdict(id, access).allowed;
  return planB2BByCode({
    requestText: input.requestText, catalog, isAllowed: allowed, stats, now, ...(input.pricingSettings ? { pricingSettings: input.pricingSettings } : {}),
    aids: (kind) => (kind === "email" ? { verifiers: verifierSourcesOf(catalog, allowed, stats, now) } : { validators: validatorSourcesOf(catalog, allowed, stats, now), company_phone: companyPhoneSourcesOf(catalog, allowed, stats, now) }),
  });
}
