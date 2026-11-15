/**
 * THE LLM-FIRST PLANNER'S SWITCH (owner decision, 15 Nov 2026: «the model understands the request and calls the catalog's tools; no word rules, no filters», for every customer).
 * Key `llm_planner_v1` of agent_settings: ON unless the owner stores false («off», or `{ enabled: false }`). Off: the chat's brief checks and the worker's earlier paths, unchanged.
 * Read by the chat (which then hands the customer's own words to the worker without the word-rule checks) and by the worker (which plans with the model).
 */
export const LLM_PLANNER_SETTING_KEY = "llm_planner_v1";

export function llmPlannerOnValue(v: unknown): boolean {
  if (v === false || v === "false" || v === "off") return false;
  if (v && typeof v === "object" && ((v as { enabled?: unknown }).enabled === false || (v as { mode?: unknown }).mode === "off")) return false;
  return true;
}

export const llmPlannerOn = (settings: Record<string, unknown>): boolean => llmPlannerOnValue(settings[LLM_PLANNER_SETTING_KEY]);
