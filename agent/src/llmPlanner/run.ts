import { MODEL_SONNET } from "../../../src/lib/agentMission/constants";
import { cairoDayOf } from "../../../src/lib/agentMission/cairoTime";
import { RAW_PATH, type Gateway } from "../gateway";
import type { AgentStore, MissionRecord } from "../types";
import type { StoredCustomerWords } from "../../../src/lib/agentMission/customerWords";
import type { TregCatalog } from "../../../src/lib/treg/catalog";
import type { AccountAccess } from "../../../src/lib/treg/dataPolicy";
import { planWithLlm, type LlmPlanResult, type PlannerModel } from "./planner";

/**
 * THE LLM PLANNER INSIDE THE WORKER: the model, the customer's words and the question it asked, and which requests it plans. The switch is `llm_planner_v1` (src/lib/agentMission/llmPlannerFlag.ts).
 */
export { LLM_PLANNER_SETTING_KEY, llmPlannerOn } from "../../../src/lib/agentMission/llmPlannerFlag";
/** The model that understands the request and chooses the tools (owner decision 15 Nov 2026). */
export const LLM_PLANNER_MODEL = MODEL_SONNET;
/** What this planner remembers between runs of one mission (the question it asked), in the mission's private folder. */
export const LLM_PLANNER_STATE_FILE = "state/llm_planner.json";
/**
 * The families the earlier, live-proven company and people path plans (finders of e-mails and phones, verification, decision makers): a request the model reads as one of them goes there.
 * Everything else the catalog collects (every social platform, forums, video sites, maps, reviews, news, the web catalog …) is planned here.
 */
export const B2B_PLATFORMS: ReadonlySet<string> = new Set(["companies", "people"]);

interface PlannerState { asked: Array<{ question_ar: string; answer: string | null; scout?: boolean }> }

export async function readPlannerState(store: AgentStore, missionId: string): Promise<PlannerState> {
  try {
    const text = await store.getFile(missionId, LLM_PLANNER_STATE_FILE);
    const v = text ? (JSON.parse(text) as { asked?: unknown }) : null;
    const asked = Array.isArray(v?.asked) ? (v!.asked as Array<{ question_ar?: unknown; answer?: unknown; scout?: unknown }>).filter((a) => typeof a?.question_ar === "string").map((a) => ({ question_ar: String(a.question_ar), answer: typeof a.answer === "string" ? a.answer : null, ...(a.scout === true ? { scout: true as const } : {}) })) : [];
    return { asked };
  } catch { return { asked: [] }; }
}
export async function writePlannerState(store: AgentStore, missionId: string, state: PlannerState): Promise<void> {
  try { await store.putFile(missionId, LLM_PLANNER_STATE_FILE, JSON.stringify(state), "application/json"); } catch { /* the next run asks again at worst */ }
}

/** The most questions the planner may ask for one mission before it plans with what it has. */
export const MAX_PLANNER_QUESTIONS = 2;
/** The most times one mission may stop to tell the customer what the real search found and ask what to do (take it, or widen). */
export const MAX_SCOUT_QUESTIONS = 2;

export interface RunLlmPlanningInput {
  mission: MissionRecord;
  store: AgentStore;
  gateway: Gateway;
  catalog: TregCatalog;
  access: AccountAccess | null;
  model: PlannerModel;
  words: StoredCustomerWords | null;
  pricingSettings?: unknown;
  now: number;
  log?: (line: string) => void;
}

/** Plans one mission with the model. The caller stores the result (plan card, question, or the honest end). */
export async function runLlmPlanning(input: RunLlmPlanningInput): Promise<LlmPlanResult & { asked: number }> {
  const { mission, store } = input;
  const state = await readPlannerState(store, mission.id);
  // the customer's answer to the planner's last question is kept with it (a later run reads every question and answer)
  const last = state.asked[state.asked.length - 1];
  const answer = typeof mission.answer_text === "string" && mission.answer_text.trim() !== "" ? mission.answer_text.trim() : null;
  if (last && last.answer === null && answer) { last.answer = answer; await writePlannerState(store, mission.id, state); }
  const words = input.words && input.words.current.length > 0 ? input.words.current : [mission.request_text];
  const qa = state.asked.filter((a) => a.answer !== null);
  const result = await planWithLlm(
    {
      words,
      earlier: input.words?.earlier ?? [],
      request: mission.request_text,
      question: qa.length > 0 ? qa.map((a) => a.question_ar).join(" | ") : null,
      answer: qa.length > 0 ? qa.map((a) => a.answer).join(" | ") : answer,
      exchanges: qa.map((a) => ({ question: a.question_ar, answer: String(a.answer) })),
      scoutAllowed: state.asked.filter((a) => a.scout).length < MAX_SCOUT_QUESTIONS,
    },
    {
      model: input.model,
      catalog: input.catalog,
      access: input.access,
      probe: (endpointId, params) => input.gateway.tregCall({ endpoint_id: endpointId, params, purpose: "planning sample", why: "llm planner probe" }),
      readPage: async (callId) => { const raw = await store.getFile(mission.id, RAW_PATH(callId)); if (raw === null) return null; try { return JSON.parse(raw) as unknown; } catch { return null; } },
      pricingSettings: input.pricingSettings,
      today: cairoDayOf(input.now),
      onProgress: async (lineAr) => { await store.addEvent(mission.id, { kind: "progress", message_ar: lineAr }); },
      accept: (u) => !u.steps.some((s) => B2B_PLATFORMS.has(s.platform)),
      ...(input.log ? { log: input.log } : {}),
    },
  );
  if (result.kind === "question") {
    // a question beyond the limit is not asked: the planner is told to plan with sensible assumptions (one more understanding call)
    if (!result.scout && state.asked.filter((a) => !a.scout).length >= MAX_PLANNER_QUESTIONS) return { kind: "cannot", reason_ar: "", understanding: result.understanding, costUsd: result.costUsd, detail: "too_many_questions", asked: state.asked.length };
    state.asked.push({ question_ar: result.question_ar, answer: null, ...(result.scout ? { scout: true as const } : {}) });
    await writePlannerState(store, mission.id, state);
  }
  return { ...result, asked: state.asked.length };
}

/** True when the model read the request as company or people research, which the earlier live-proven path plans (no paid call was made for it here). */
export const handedOver = (r: LlmPlanResult): boolean => r.kind === "cannot" && r.detail === "handed_over";
