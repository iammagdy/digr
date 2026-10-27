import { blockedEndpointReason } from "../treg/blockList";
import { categoryOf, mayUseSensitive } from "../treg/dataPolicy";
import { MIN_PURPOSE_CHARS, PURPOSE_REQUIRED_AR, resolveAccountAccess } from "../server/sensitiveAccess";
import { SENSITIVE_NOT_VERIFIED_AR } from "../treg/dataPolicy";
import { MODEL_PLAN_PARAM, MODEL_PLAN_PURPOSE_PARAM, MODEL_PLAN_SLUG } from "./constants";
import type { StoredModelPlan } from "./types";

/**
 * At APPROVAL, once more (the account may have lost its verification since the plan was shown): a model plan with a blocked endpoint is never accepted; a plan with a sensitive step is
 * accepted only for the admin or a verified business account that gave a purpose. Nothing is reserved when this refuses. Other plans (every plan of the old path) are not looked at.
 */
export async function modelPlanAcceptRefusal(client: any, userId: string, items: unknown): Promise<{ status: number; error: string } | null> {
  const list = Array.isArray(items) ? (items as Array<{ capabilitySlug?: string; params?: Record<string, any> }>) : [];
  const modelItems = list.filter((it) => it?.capabilitySlug === MODEL_PLAN_SLUG);
  if (modelItems.length === 0) return null;
  let sensitive = false;
  let purpose = "";
  for (const item of modelItems) {
    const plan = item.params?.[MODEL_PLAN_PARAM] as StoredModelPlan | undefined;
    if (!plan || !Array.isArray(plan.steps)) return { status: 409, error: "الخطة غير مكتملة" };
    for (const step of plan.steps) {
      const category = categoryOf(step.endpointId);
      if (blockedEndpointReason(step.endpointId, step.facts?.scope) || category === "blocked") return { status: 403, error: "هذه الخدمة غير متاحة حاليًا، ولم يُحجز أي رصيد." };
      if (category === "sensitive") sensitive = true;
    }
    purpose = String(item.params?.[MODEL_PLAN_PURPOSE_PARAM] ?? "");
  }
  if (!sensitive) return null;
  const access = await resolveAccountAccess(client, userId);
  if (!mayUseSensitive(access)) return { status: 403, error: SENSITIVE_NOT_VERIFIED_AR };
  if (!access.isAdmin && purpose.trim().length < MIN_PURPOSE_CHARS) return { status: 409, error: PURPOSE_REQUIRED_AR };
  return null;
}
