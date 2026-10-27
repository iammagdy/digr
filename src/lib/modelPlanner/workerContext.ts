import { categoryOf } from "../treg/dataPolicy";
import { resolveAccountAccess } from "../server/sensitiveAccess";
import { MODEL_PLAN_PARAM, MODEL_PLAN_PURPOSE_PARAM } from "./constants";
import type { StoredModelPlan } from "./types";

/** The `sensitive` part of the adapter input of a model-planned job: only when a step is of the sensitive category (the account's access is read fresh at every chunk). */
export async function modelPlanSensitiveContext(client: any, userId: string, params: Record<string, any> | undefined): Promise<{ sensitive?: { client: any; access: { isAdmin: boolean; verifiedBusiness: boolean }; purpose: string } }> {
  const plan = params?.[MODEL_PLAN_PARAM] as StoredModelPlan | undefined;
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.some((s) => categoryOf(s.endpointId) === "sensitive")) return {};
  const access = await resolveAccountAccess(client, userId);
  return { sensitive: { client, access, purpose: String(params?.[MODEL_PLAN_PURPOSE_PARAM] ?? "") } };
}
