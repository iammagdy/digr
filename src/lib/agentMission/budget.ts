import { COMPANIES_PLATFORM, isPeopleOfCompanyStep } from "./childSources";
import { AGENT_PLANNING_BUDGET_MULTI_STAGE_USD, AGENT_PLANNING_BUDGET_USD } from "./constants";

export interface BudgetStep {
  key: string;
  platform: string;
  capability: string;
  parent: string | null;
}

export interface BudgetUnderstandingInput {
  steps: ReadonlyArray<BudgetStep>;
  people_of_companies?: { asked: boolean } | null;
}

export function implicitCompanyStages(u: BudgetUnderstandingInput) {
  const asked = u.people_of_companies?.asked === true;
  return {
    companies: asked && !u.steps.some((step) => step.parent === null && step.platform === COMPANIES_PLATFORM && !isPeopleOfCompanyStep(step)),
    people: asked && !u.steps.some((step) => step.parent !== null && isPeopleOfCompanyStep(step)),
  };
}

export function expectedStageCount(u: BudgetUnderstandingInput | null | undefined): number {
  if (!u) return 1;
  const implicit = implicitCompanyStages(u);
  return Math.max(1, u.steps.length + Number(implicit.companies) + Number(implicit.people));
}

export function isMultiStageUnderstanding(u: BudgetUnderstandingInput | null | undefined): boolean {
  return !!u && (u.people_of_companies?.asked === true || expectedStageCount(u) > 1 || u.steps.some((step) => step.parent !== null));
}

/** Provider sampling spend is an owner cost. Code chooses the base from the validated request structure. */
export const planningBudgetUsd = (u: BudgetUnderstandingInput | null | undefined): number =>
  isMultiStageUnderstanding(u) ? AGENT_PLANNING_BUDGET_MULTI_STAGE_USD : AGENT_PLANNING_BUDGET_USD;
