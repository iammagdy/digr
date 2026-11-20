import { MODEL_SONNET } from "../../../src/lib/agentMission/constants";
import { isPeopleOfCompanyStep } from "../../../src/lib/agentMission/childSources";
import { cairoDayOf } from "../../../src/lib/agentMission/cairoTime";
import { RAW_PATH, type Gateway, type GatewayCallResult } from "../gateway";
import type { WebGateway } from "../webGateway";
import { webRequestOf } from "../engine/sourceGateway";
import { directWebEndpoints, peopleOfCompanyCapabilitiesOf } from "./catalogView";
import type { AgentStore, MissionRecord } from "../types";
import type { StoredCustomerWords } from "../../../src/lib/agentMission/customerWords";
import type { TregCatalog } from "../../../src/lib/treg/catalog";
import type { AccountAccess } from "../../../src/lib/treg/dataPolicy";
import { planWithLlm, type LlmPlanResult, type PlannerModel, type Understanding } from "./planner";

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
/** Company and people research goes on to its own path: a step on a B2B platform key OR a step whose tool is a people-of-company capability (the catalog files those under «linkedin» too). */
export const handsOverToB2B = (u: { steps: ReadonlyArray<{ platform: string; capability?: string | null }>; people_of_companies?: { asked: boolean } | null }, catalogHasPeople = false): boolean =>
  u.steps.some((s) => B2B_PLATFORMS.has(s.platform) || isPeopleOfCompanyStep(s)) || (catalogHasPeople && u.people_of_companies?.asked === true);
/** Whether the planner plans what the model understood: not a company-and-people request, and not a request whose required answer says the people of the companies were asked while this catalog can give them (DT-20261118-08: code acts on the answer even when the model wrote no people step). */
export function acceptOf(catalog: TregCatalog, access: AccountAccess | null): (u: Understanding) => boolean {
  const catalogHasPeople = peopleOfCompanyCapabilitiesOf(catalog, access).length > 0;
  return (u) => !handsOverToB2B(u, catalogHasPeople);
}

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
/** Samples of one source the planner's gateway allows (the default is 2): measuring what a source holds reads a few pages, and the planning runs again after the customer answers. The planning budget cap still bounds the spend. */
export const LLM_PLANNER_MAX_SAMPLES_PER_SOURCE = 12;

export interface RunLlmPlanningInput {
  mission: MissionRecord;
  store: AgentStore;
  gateway: Gateway;
  /** The direct web tools (Firecrawl, Context.dev) of this planning, and which of them the worker holds a key for. Absent: only the catalog's tools are offered. */
  web?: Pick<WebGateway, "parsePage" | "webSearch" | "webScrape" | "peopleSearch">;
  webAvailable?: { firecrawl?: boolean; contextdev?: boolean };
  catalog: TregCatalog;
  access: AccountAccess | null;
  model: PlannerModel;
  words: StoredCustomerWords | null;
  pricingSettings?: unknown;
  availablePoints?: () => Promise<number | null>;
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
      probe: (endpointId, params) => probeAny(input, endpointId, params),
      ...(input.web && input.webAvailable ? { webTools: directWebEndpoints(input.webAvailable) } : {}),
      readPage: async (callId) => { const raw = await store.getFile(mission.id, RAW_PATH(callId)); if (raw === null) return null; try { return JSON.parse(raw) as unknown; } catch { return null; } },
      pricingSettings: input.pricingSettings,
      availablePoints: input.availablePoints,
      today: cairoDayOf(input.now),
      onProgress: async (lineAr) => { await store.addEvent(mission.id, { kind: "progress", message_ar: lineAr }); },
      accept: acceptOf(input.catalog, input.access),
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

/** One planning call: a direct web id goes to the web gateway (its own key, the same budget and record), every other id to the TREG gateway; the answer has the TREG gateway's shape. */
async function probeAny(input: RunLlmPlanningInput, endpointId: string, params: Record<string, unknown>): Promise<GatewayCallResult> {
  const req = webRequestOf(endpointId, params);
  if (req && input.web) {
    const w = await input.web[req.method]({ ...req.args, why: "llm planner probe" } as never);
    if (w.ok) return { ok: true, call_id: w.call_id, http_status: 200, rows_in_page: w.rows_in_page, has_more: false, next_cursor: null, shape: w.shape, first_rows: w.first_rows, warnings: [], saved: w.saved } as unknown as GatewayCallResult;
    if ("refused" in w) return { ok: false, call_id: w.call_id, refused: w.refused as never, message: w.message };
    return { ok: false, call_id: w.call_id, failed: true, http_status: 0, message: w.message };
  }
  return input.gateway.tregCall({ endpoint_id: endpointId, params, purpose: "planning sample", why: "llm planner probe" });
}
