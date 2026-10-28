import { loadTregCatalog, type TregCatalog } from "../treg/catalog";
import type { AccountAccess } from "../treg/dataPolicy";
import { PLAN_UNAVAILABLE_AR, runPlanner } from "./planner";
import { plannerCostUsd, type PlannerTransport } from "./transport";
import type { ExplorationDeps } from "./exploration";

/**
 * «أعد التجربة» on the failures board: re-runs ONE request through the REAL planner and stops before any approval (no quote, no job, no hold, no charge, nothing of the customer's is written).
 * Its whole cost (the planning model and the sample calls together) is capped: the sample calls get what is left of RETRY_CAP_USD after the model's share, and the turn is cut at a few turns.
 * It plans as an ordinary customer would (not an admin, not a verified business), so a refusal that depended on the account is not hidden.
 */
export const RETRY_CAP_USD = 0.05;
/** What the model is assumed to need at most, kept out of the sample budget. */
export const RETRY_MODEL_RESERVE_USD = 0.01;
export const RETRY_MAX_TURNS = 5;

export interface RetryResult {
  outcome: "plan" | "question" | "refusal" | "restricted" | "purpose";
  /** What the planner would show the customer (the plan's goal line, or its one sentence). */
  customerText: string;
  endpoints: string[];
  attempts: Array<{ endpoint: string; outcome: string; httpStatus: number; costUsd: number }>;
  unitPricePoints: number | null;
  turns: number;
  modelUsd: number;
  providerUsd: number;
  capUsd: number;
  overCap: boolean;
  endReason: string;
}

export async function retryRequest(input: { requestText: string; transport: PlannerTransport; client: any; adminId: string; runId: string; catalog?: TregCatalog; call?: ExplorationDeps["call"]; deadlineAtMs?: number }): Promise<RetryResult> {
  const access: AccountAccess = { isAdmin: false, verifiedBusiness: false };
  const out = await runPlanner({
    transport: input.transport, customerMessages: [String(input.requestText).slice(0, 600)], access, catalog: input.catalog ?? loadTregCatalog(), maxTurns: RETRY_MAX_TURNS,
    exploration: { client: input.client && typeof input.client.from === "function" ? { from: (t: string) => input.client.from(t) } : null, requestId: `retry_${input.runId}`.slice(0, 120), userId: input.adminId, requestCapUsd: Math.max(0, RETRY_CAP_USD - RETRY_MODEL_RESERVE_USD), ...(input.call ? { call: input.call } : {}) },
    ...(input.deadlineAtMs !== undefined ? { deadlineAtMs: input.deadlineAtMs } : {}),
  });
  const outcome: RetryResult["outcome"] = out.kind === "plan" ? "plan" : out.kind === "purpose_needed" ? "purpose" : out.reason === "restricted" ? "restricted" : out.reason === "clarification" || out.reason === "incomplete" ? "question" : "refusal";
  const providerUsd = out.attempts.reduce((s, a) => s + a.costUsd, 0);
  const modelUsd = plannerCostUsd(out.usage);
  return {
    outcome,
    customerText: out.kind === "plan" ? out.plan.summaryAr : out.kind === "message" ? out.messageAr : PLAN_UNAVAILABLE_AR,
    endpoints: out.kind === "plan" ? out.plan.steps.map((s) => s.step.endpointId) : [],
    attempts: out.attempts.map((a) => ({ endpoint: a.endpointId, outcome: a.outcome, httpStatus: a.httpStatus, costUsd: a.costUsd })),
    unitPricePoints: out.kind === "plan" ? out.plan.price.unitPricePoints : null,
    turns: out.turns, modelUsd, providerUsd, capUsd: RETRY_CAP_USD, overCap: modelUsd + providerUsd > RETRY_CAP_USD + 1e-9, endReason: out.endReason ?? "",
  };
}
