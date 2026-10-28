import { AGENT_ALLOWED_MODELS, AGENT_MODEL_DEFAULT, PLANNING_MODEL_SETTING_KEY } from "../../src/lib/agentMission/constants";

const allowed = (v: unknown): string | null => (typeof v === "string" && AGENT_ALLOWED_MODELS.includes(v.trim()) ? v.trim() : null);

/**
 * Which model does which phase. EXECUTION uses AGENT_MODEL (default claude-haiku-5-5). PLANNING uses the `planning_model` setting the owner flips on the admin page «الوكيل»
 * when it is set to an allowed model, else AGENT_MODEL, else the default. Anything that is not an allowed model is ignored. The cost of each phase is stored on the mission.
 */
export function resolveModels(env: Record<string, string | undefined>, settings: Record<string, unknown>): { planning: string; execution: string } {
  const execution = allowed(env.AGENT_MODEL) ?? AGENT_MODEL_DEFAULT;
  const planning = allowed(settings[PLANNING_MODEL_SETTING_KEY] && typeof settings[PLANNING_MODEL_SETTING_KEY] === "object" ? (settings[PLANNING_MODEL_SETTING_KEY] as { model?: unknown }).model : settings[PLANNING_MODEL_SETTING_KEY]) ?? execution;
  return { planning, execution };
}
