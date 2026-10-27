import { loadTregCatalog } from "../treg/catalog";
import { PLANNER_TURN_ROW_ENDPOINT, EXPLORATION_TABLE } from "./exploration";
import { PLANNER_MODEL_DEFAULT } from "./constants";

/** The planner's health line for the admin: the catalog the DEPLOYED bundle really loaded, the last planner turn that ended without a plan (and why), the last exploration call and its result. Never throws. */
export interface PlannerHealth {
  catalog: { endpoints: number; source: string } | { error: string };
  model: string;
  lastPlannerError: { at: string; reason: string } | null;
  lastExploration: { at: string; endpoint: string; result: string; httpStatus: number | null; rows: number | null; costUsd: number } | null;
}

export async function readPlannerHealth(client: any, model: string = process.env.ANTHROPIC_MODEL || PLANNER_MODEL_DEFAULT): Promise<PlannerHealth> {
  let catalog: PlannerHealth["catalog"];
  try { const c = loadTregCatalog(); catalog = { endpoints: c.endpoints.length, source: c.source }; } catch (err) { catalog = { error: String((err as Error)?.message ?? err).slice(0, 160) }; }
  let lastPlannerError: PlannerHealth["lastPlannerError"] = null;
  let lastExploration: PlannerHealth["lastExploration"] = null;
  if (typeof client?.from === "function") {
    try {
      const { data } = await client.from(EXPLORATION_TABLE).select("endpoint_id,refused_reason,http_status,rows_returned,cost_usd,created_at").eq("endpoint_id", PLANNER_TURN_ROW_ENDPOINT).order("created_at", { ascending: false }).limit(1);
      const r = Array.isArray(data) ? data[0] : null;
      if (r) lastPlannerError = { at: String(r.created_at), reason: String(r.refused_reason ?? "") };
    } catch { /* the table is not there */ }
    try {
      const { data } = await client.from(EXPLORATION_TABLE).select("endpoint_id,refused_reason,http_status,rows_returned,cost_usd,created_at").neq("endpoint_id", PLANNER_TURN_ROW_ENDPOINT).order("created_at", { ascending: false }).limit(1);
      const r = Array.isArray(data) ? data[0] : null;
      if (r) lastExploration = { at: String(r.created_at), endpoint: String(r.endpoint_id), result: r.refused_reason ? String(r.refused_reason) : "ok", httpStatus: r.http_status ?? null, rows: r.rows_returned ?? null, costUsd: Number(r.cost_usd) || 0 };
    } catch { /* the table is not there */ }
  }
  return { catalog, model, lastPlannerError, lastExploration };
}
