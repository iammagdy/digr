import { FILE_WORKFLOW_ERRORS_AR, type AddonPhase, type FileWorkflowView, type WorkflowItemView, type WorkflowKind } from "./fileWorkflowLabels";

/**
 * STAGE C: THE BROWSER'S SIDE OF THE FILE'S WORKFLOW STATUS (client-safe: no server module). It only READS (GET, no body, no cache) and shows the answer ONLY if it is well-formed in a way that keeps the page honest: a recorded charge is accepted only in the two phases that may show one, the hold flag only in
 * `processing`, and the new version only where the kind has one. A malformed answer is an error, never a partial list, so a payment line can never be invented. Anything the server might add is dropped.
 */
export const fileWorkflowUrl = (missionId: string): string => `/api/missions/${encodeURIComponent(missionId)}/workflow`;

const PHASES: ReadonlyArray<AddonPhase> = ["waiting_approval", "approval_unverified", "processing", "delivered", "charged_delivery_pending", "failed_no_charge", "cancelled", "ended_unverified", "delivery_pending"];
const KINDS: ReadonlyArray<WorkflowKind> = ["review", "review_fix", "edit"];
const isVersion = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 9999;

function itemOf(raw: any): WorkflowItemView | null {
  if (!raw || typeof raw !== "object" || !KINDS.includes(raw.kind) || !PHASES.includes(raw.phase) || !isVersion(raw.version)) return null;
  // a review makes no new version; an edit and a fix make exactly the next one
  if (raw.kind === "review" ? raw.newVersion !== null : raw.newVersion !== raw.version + 1) return null;
  const mayShowCharge = raw.phase === "delivered" || raw.phase === "charged_delivery_pending";
  if (raw.chargedPoints !== undefined && (!mayShowCharge || !Number.isInteger(raw.chargedPoints) || raw.chargedPoints < 1)) return null;
  if (raw.held !== undefined && (raw.phase !== "processing" || typeof raw.held !== "boolean")) return null;
  return { kind: raw.kind, version: raw.version, newVersion: raw.newVersion, phase: raw.phase, ...(raw.held !== undefined ? { held: raw.held } : {}), ...(raw.chargedPoints !== undefined ? { chargedPoints: raw.chargedPoints } : {}) };
}

export type FileWorkflowResult =
  | { state: "ok"; view: FileWorkflowView }
  /** The feature is off, the customer is signed out, or the file is not theirs: the page draws nothing. */
  | { state: "off" }
  | { state: "error"; message: string };

export async function fetchFileWorkflow(input: { missionId: string; fetchFn: typeof fetch; headers: () => Promise<Record<string, string>> }): Promise<FileWorkflowResult> {
  try {
    const res = await input.fetchFn(fileWorkflowUrl(input.missionId), { cache: "no-store", headers: await input.headers() });
    if (res.status === 404 || res.status === 401) return { state: "off" };
    if (!res.ok) return { state: "error", message: FILE_WORKFLOW_ERRORS_AR.unavailable };
    const body = await res.json().catch(() => null);
    const raw = body && body.success === true ? body.workflow?.items : null;
    if (!Array.isArray(raw)) return { state: "error", message: FILE_WORKFLOW_ERRORS_AR.unavailable };
    const items: WorkflowItemView[] = [];
    for (const r of raw) { const i = itemOf(r); if (!i) return { state: "error", message: FILE_WORKFLOW_ERRORS_AR.unavailable }; items.push(i); }
    return { state: "ok", view: { items, ...(body.workflow?.hasVersions === false ? { hasVersions: false } : {}) } };
  } catch {
    return { state: "error", message: FILE_WORKFLOW_ERRORS_AR.network };
  }
}
