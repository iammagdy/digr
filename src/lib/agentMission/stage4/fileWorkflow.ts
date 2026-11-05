import { AGENT_BUCKET, MISSION_TABLE } from "../constants";
import { readAddonPlan } from "../addonSettlement";
import type { FileWorkflowView, WorkflowItemView } from "./fileWorkflowLabels";
import { stage4FlagMode } from "./flags";

/**
 * STAGE C (docs/STAGE-4-CUSTOMER-WORKFLOW.md): THE FILE'S WORKFLOW STATUS, behind DIGER_STAGE4_REVIEW or DIGER_STAGE4_EDITS (either «on»). READ-ONLY: for the customer's own mission it reads the customer's add-on rows and the two listings of published objects, and decides for each request which PHASE it is in,
 * so the page can tell the truth. The rules, each pinned by tests/stage4-file-workflow.test.ts:
 *   - «delivered» only when the request's output is VERIFIED published (a review's report `reviews/rNNNN.json`, an edit's or a fix's new version `versions/vNNNN.json`); a `completed` row with no such object is never shown as delivered;
 *   - a recorded charge (`charged_points`) is passed on only for `delivered` and `charged_delivery_pending`;
 *   - a request that was EVER put through an approval attempt (an approval time or a job) is never shown as «nothing was held»: it is `approval_unverified` (waiting) or `ended_unverified` (cancelled), or `processing` with the hold flagged known only when it has a job;
 *   - a failed request with no recorded charge says only that: no charge is recorded.
 * The view carries no request id, job id, path, digest, summary or error text. Nothing is written; no money function is called.
 */
export function workflowAvailable(env?: Readonly<Record<string, string | undefined>>): boolean {
  return stage4FlagMode("DIGER_STAGE4_REVIEW", env) === "on" || stage4FlagMode("DIGER_STAGE4_EDITS", env) === "on";
}

/** The row as this module reads it (the same table as the other add-on readers). */
export interface WorkflowRow { id: string; status: string; plan: unknown; job_id?: string | null; approved_at?: string | null; charged_points?: number | null; error?: string | null; created_at?: string | null }
/** What is VERIFIED published, by number: the versions and the reviewed versions. */
export interface PublishedNumbers { versions: ReadonlySet<number>; reviews: ReadonlySet<number> }

const OPEN = new Set(["queued", "planning", "needs_input", "plan_ready", "approved", "executing"]);

/** The phase of one add-on row, or null when the row is not an add-on or its status is not one this view knows. Pure. */
export function addonPhaseOf(row: WorkflowRow, published: PublishedNumbers): WorkflowItemView | null {
  const addon = readAddonPlan(row.plan);
  if (!addon || (addon.kind !== "review" && addon.kind !== "review_fix" && addon.kind !== "edit")) return null;
  const base = { kind: addon.kind, version: addon.baseVersion, newVersion: addon.kind === "review" ? null : addon.newVersion ?? addon.baseVersion + 1 } as const;
  const attempted = Boolean(row.job_id) || Boolean(row.approved_at);
  const charged = Number.isInteger(row.charged_points) && (row.charged_points as number) > 0 ? (row.charged_points as number) : 0;
  const out = published.versions;
  const isPublished = addon.kind === "review" ? published.reviews.has(addon.baseVersion) : out.has(base.newVersion as number);
  switch (row.status) {
    case "plan_ready": return { ...base, phase: attempted ? "approval_unverified" : "waiting_approval" };
    case "queued": case "planning": case "needs_input": case "approved": case "executing": return { ...base, phase: "processing", held: Boolean(row.job_id) };
    case "completed":
      if (isPublished) return { ...base, phase: "delivered", ...(charged > 0 ? { chargedPoints: charged } : {}) };
      return charged > 0 ? { ...base, phase: "charged_delivery_pending", chargedPoints: charged } : { ...base, phase: "delivery_pending" };
    case "failed": case "unserved":
      return charged > 0 || row.error === "charged_not_published" ? { ...base, phase: "charged_delivery_pending", ...(charged > 0 ? { chargedPoints: charged } : {}) } : { ...base, phase: "failed_no_charge" };
    case "cancelled": return { ...base, phase: attempted ? "ended_unverified" : "cancelled" };
    default: return null;
  }
}

type Failure = { ok: false; status: 404 | 503; error: "not_found" | "unavailable" };
const no = (status: Failure["status"], error: Failure["error"]): Failure => ({ ok: false, status, error });
export const WORKFLOW_ITEMS_MAX = 5;

async function numbersIn(client: any, missionId: string, folder: "versions" | "reviews"): Promise<Set<number>> {
  const { data, error } = await client.storage.from(AGENT_BUCKET).list(`${missionId}/${folder}`, { limit: 1000, sortBy: { column: "name", order: "asc" } });
  if (error) throw new Error("list failed");
  const pattern = folder === "versions" ? /^v(\d{4,})\.json$/ : /^r(\d{4,})\.json$/;
  return new Set(((data ?? []) as Array<{ name: string; id?: string | null }>).filter((o) => Boolean(o.id)).map((o) => Number(pattern.exec(o.name)?.[1] ?? 0)).filter((n) => n >= 1));
}

export type FileWorkflowResult = { ok: true; workflow: FileWorkflowView } | Failure;

/** The workflow status of the customer's own mission. 404: not theirs or missing (the same answer). 503: the database or the storage could not answer (never an empty list, never «delivered»). */
export async function fileWorkflowFor(client: any, input: { missionId: string; userId: string }): Promise<FileWorkflowResult> {
  try {
    const { data: mission, error } = await client.from(MISSION_TABLE).select("id,user_id").eq("id", input.missionId).maybeSingle();
    if (error) return no(503, "unavailable");
    if (!mission || mission.user_id !== input.userId) return no(404, "not_found");
    const { data, error: rowsError } = await client.from(MISSION_TABLE).select("id,status,plan,job_id,approved_at,charged_points,error,created_at").eq("user_id", input.userId).eq("plan->addon->>of", input.missionId);
    if (rowsError || !Array.isArray(data)) return no(503, "unavailable");
    const published: PublishedNumbers = { versions: await numbersIn(client, input.missionId, "versions"), reviews: await numbersIn(client, input.missionId, "reviews") };
    const rows = (data as WorkflowRow[]).filter((r) => addonPhaseOf(r, published) !== null);
    // an open request first, then the newest
    const rank = (r: WorkflowRow): number => (OPEN.has(String(r.status)) ? 0 : 1);
    rows.sort((a, b) => rank(a) - rank(b) || String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || (a.id < b.id ? -1 : 1));
    const items = rows.slice(0, WORKFLOW_ITEMS_MAX).map((r) => addonPhaseOf(r, published) as WorkflowItemView);
    return { ok: true, workflow: { items } };
  } catch {
    return no(503, "unavailable");
  }
}
