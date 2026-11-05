import { MISSION_TABLE } from "../constants";
import { isCurrentTitleForm, missionFileTitleAr, missionTitleAr } from "../fileNames";
import { ADDON_MARKER_COLUMN, hasAddonMarker } from "../addonMarker";

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

export const METHODOLOGY_MISSION_COLUMNS = `id,user_id,status,job_id,delivered_units,request_text,plan_public,files,created_at,updated_at,${ADDON_MARKER_COLUMN}`;

type Row = Record<string, unknown>;

/** The mission as a methodology candidate, or null when it is not one (not delivered, not compiled, no job, no Excel file). */
export function methodologyMissionOf(row: Row | null | undefined): MethodologyMission | null {
  if (!row || typeof row !== "object") return null;
  // a review, review-fix or edit of a delivered file (an add-on row) is not a research request a methodology can be written for, whatever else its row carries (MONEY PR 7e, docs/MONEY-PR-7A.md section 17)
  if (hasAddonMarker(row)) return null;
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
  const stages = (plan as { stages?: unknown }).stages;
  // the date a rebuilt name carries is the mission's last update (the day it finished), as the download's name does
  const when = typeof row.updated_at === "string" ? row.updated_at : typeof row.created_at === "string" ? row.created_at : null;
  const date = when ? new Date(when) : null;
  // a stored name already in the current form is the very name of the Excel file (same words and same date, even when the request was made the day before it finished)
  const title = isCurrentTitleForm(stored) ? stored : Array.isArray(stages) && stages.some((s) => s && typeof s === "object" && typeof s.title_ar === "string")
    ? (date && Number.isFinite(date.getTime())
      ? missionFileTitleAr({ plan: { stages }, requestText, delivered, date })
      : missionTitleAr({ plan: { stages }, requestText, delivered }))
    : stored || missionTitleAr({ plan: null, requestText });
  return {
    missionId: id,
    jobId,
    titleAr: title,
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
