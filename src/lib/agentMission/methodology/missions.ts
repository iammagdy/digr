import { MISSION_TABLE } from "../constants";
import { missionTitleAr } from "../fileNames";

/**
 * THE MISSIONS A DATA-COLLECTION METHODOLOGY CAN BE WRITTEN FOR (round 21): a request of the customer that was DELIVERED (completed, at least one row delivered), carried out on the COMPILED path (the plan the compiler built: `plan_public.compiled`), with its job and its Excel file.
 * Read only (SELECT on the customer's own missions). One definition, used by the chat's answer, the list the chooser card draws and the purchase route.
 */
export interface MethodologyMission {
  missionId: string;
  jobId: string;
  /** What the request was, in a few words (the delivered file's own name without its extension, else the request shortened). */
  titleAr: string;
  deliveredUnits: number;
  /** The delivered workbook's path inside the mission's folder of the agent bucket. */
  xlsx: { name: string; path: string };
  requestText: string;
  createdAt: string | null;
}

export const METHODOLOGY_MISSION_COLUMNS = "id,user_id,status,job_id,delivered_units,request_text,plan_public,files,created_at";

type Row = Record<string, unknown>;

/** The mission as a methodology candidate, or null when it is not one (not delivered, not compiled, no job, no Excel file). */
export function methodologyMissionOf(row: Row | null | undefined): MethodologyMission | null {
  if (!row || typeof row !== "object") return null;
  if (row.status !== "completed") return null;
  const delivered = Number(row.delivered_units);
  if (!(delivered > 0)) return null;
  const jobId = typeof row.job_id === "string" ? row.job_id : "";
  const id = typeof row.id === "string" ? row.id : "";
  if (!jobId || !id) return null;
  const plan = row.plan_public as { compiled?: unknown } | null | undefined;
  if (!plan || typeof plan !== "object" || plan.compiled !== true) return null;
  const files = Array.isArray(row.files) ? (row.files as Row[]) : [];
  const xlsx = files.find((f) => f && typeof f.path === "string" && typeof f.name === "string" && String(f.kind ?? "").toLowerCase() !== "csv" && (String(f.kind ?? "").toLowerCase() === "xlsx" || /\.xlsx$/i.test(String(f.name))));
  if (!xlsx) return null;
  const stored = typeof xlsx.download_name === "string" ? xlsx.download_name.trim().replace(/\.xlsx$/i, "") : "";
  const requestText = String(row.request_text ?? "");
  return {
    missionId: id,
    jobId,
    titleAr: stored || missionTitleAr({ plan: null, requestText }),
    deliveredUnits: delivered,
    xlsx: { name: String(xlsx.name), path: String(xlsx.path) },
    requestText,
    createdAt: typeof row.created_at === "string" ? row.created_at : null,
  };
}

/** The customer's own delivered compiled missions, newest first. Never throws: a failed read is an empty list (the chat then says there is none, charges nothing). */
export async function listMethodologyMissions(client: any, userId: string, limit = 20): Promise<MethodologyMission[]> {
  try {
    const { data, error } = await client.from(MISSION_TABLE).select(METHODOLOGY_MISSION_COLUMNS).eq("user_id", userId).eq("status", "completed").gt("delivered_units", 0).order("created_at", { ascending: false }).limit(Math.max(1, Math.min(60, limit)));
    if (error || !Array.isArray(data)) return [];
    return data.map((r: Row) => methodologyMissionOf(r)).filter((m: MethodologyMission | null): m is MethodologyMission => m !== null && (data as Row[]).find((r) => r.id === m.missionId)?.user_id === userId);
  } catch {
    return [];
  }
}

/** The mission of a job, when it is a methodology candidate and belongs to this customer (the purchase route's own check). */
export async function methodologyMissionOfJob(client: any, input: { jobId: string; userId: string }): Promise<MethodologyMission | null> {
  try {
    const { data } = await client.from(MISSION_TABLE).select(METHODOLOGY_MISSION_COLUMNS).eq("job_id", input.jobId).eq("user_id", input.userId).maybeSingle();
    return methodologyMissionOf(data as Row | null);
  } catch {
    return null;
  }
}

/** One of the customer's own missions, when it is a methodology candidate (the mission card's offer). */
export async function methodologyMissionById(client: any, input: { missionId: string; userId: string }): Promise<MethodologyMission | null> {
  try {
    const { data } = await client.from(MISSION_TABLE).select(METHODOLOGY_MISSION_COLUMNS).eq("id", input.missionId).eq("user_id", input.userId).maybeSingle();
    return methodologyMissionOf(data as Row | null);
  } catch {
    return null;
  }
}
