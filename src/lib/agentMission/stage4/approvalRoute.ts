import { MISSION_TABLE } from "../constants";
import { ADDON_APPROVE_MESSAGES_AR, ADDON_MAX_HOLD_POINTS, approveAddonOnce, readAddonPlan, type AddonKind } from "../addonSettlement";
import { SIGNUP_TO_APPROVE_AR } from "../customerActions";
import { guardApproval } from "./approvalGuard";
import { stage4FlagMode } from "./flags";

/**
 * LAUNCH ROUND, WORKSTREAM 2: THE CUSTOMER'S APPROVAL OF A REVIEW OR AN EDIT QUOTE. The one function behind `POST /api/missions/[id]/addon-approval`. It moves no money itself: it composes the two functions the safety rounds built and tested, in the order the contract
 * (docs/STAGE-4-APPROVAL-BOUNDARY.md section 4) requires, and adds only what a route must decide:
 *   0 the flags, read FIRST by the route: `DIGER_STAGE4_APPROVAL` must be exactly «on» (off is a 404 before the viewer, the body or the database is looked at); the kind's own flag is read here once the request is known (a review needs `DIGER_STAGE4_REVIEW`, an edit `DIGER_STAGE4_EDITS`)
 *   1 the customer: a guest signs up first (401), an unverified account verifies its e-mail (403): the same two gates as approving a mission
 *   2 the body is `{ requestId, expectedPoints }` and nothing else, both whole numbers/ids (the route rejects any other key): `expectedPoints` is the hold the page showed; it is COMPARED with the price the server computes and never used as one
 *   3 the request must be this customer's, an add-on of THIS file (the URL's mission), of a kind that can be run (`review`, `edit`: a `review_fix` is not offered and is refused as «not found»), and its kind's flag must be on
 *   4 `guardApproval`: published version, price recalculated and equal to `expectedPoints`, one open add-on per file, no second paid review (nothing here has called a money function yet)
 *   5 `approveAddonOnce`: price again, compare-and-set `plan_ready -> approved`, then the three existing money functions with deterministic ids. A double click, a retry or a lost answer converges on the same quote, job and ledger rows
 * The answer carries the customer's words and a `state`: `approved`, `already_approved` (a second click: the request is already running or done: the page shows its status), `refused` (nothing held) or `uncertain` (the points MAY be held: the page re-reads the request's status, never says «nothing was held»).
 * No job id, quote id, ledger id, provider or USD is ever returned. NO provider is called here (a review spends nothing on providers; an edit's provider calls are the worker's, after the hold). Display and wiring only: the money files are read and reused, never edited.
 */
export type ApprovalState = "approved" | "already_approved" | "refused" | "uncertain";
export interface ApprovalAnswer {
  status: number;
  body: { success: boolean; state: ApprovalState; error?: string; code?: string; kind?: AddonKind; holdPoints?: number };
}

/** The flag read FIRST by the route: approval is served only when this one is exactly «on». */
export function approvalAvailable(env?: Readonly<Record<string, string | undefined>>): boolean {
  return stage4FlagMode("DIGER_STAGE4_APPROVAL", env) === "on";
}
/** The flag of the request's own kind. A kind that cannot be run (`review_fix`) has none. */
export function kindFlagOn(kind: AddonKind, env?: Readonly<Record<string, string | undefined>>): boolean {
  if (kind === "review") return stage4FlagMode("DIGER_STAGE4_REVIEW", env) === "on";
  if (kind === "edit") return stage4FlagMode("DIGER_STAGE4_EDITS", env) === "on";
  return false;
}

const NOT_FOUND_AR = ADDON_APPROVE_MESSAGES_AR.not_found;
const VERIFY_EMAIL_AR = "فعّل بريدك الإلكتروني أولًا ثم اعتمد الطلب.";
const BAD_REQUEST_AR = "تعذّر قراءة طلب الاعتماد. حدّث الصفحة وحاول مرة أخرى؛ لم يُحجز أو يُخصم شيء.";
const answer = (status: number, state: ApprovalState, error: string, code?: string): ApprovalAnswer => ({ status, body: { success: false, state, error, ...(code ? { code } : {}) } });
/** Codes after which the points MAY be held (the lost-answer family): never «nothing was held». */
const UNCERTAIN = new Set(["approval_unverified", "record_unverified", "claim_retry"]);
const ALREADY_STARTED = new Set(["approved", "executing", "completed"]);

const isRequestId = (v: unknown): v is string => typeof v === "string" && /^msn_[a-z0-9]{8,40}$/.test(v);

export async function approveAddonForCustomer(client: any, input: {
  missionId: string;
  userId: string;
  isGuest: boolean;
  emailVerified: boolean;
  /** The parsed JSON body of the request, untouched. */
  body: unknown;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<ApprovalAnswer> {
  if (!approvalAvailable(input.env)) return answer(404, "refused", NOT_FOUND_AR, "not_found");
  if (input.isGuest) return answer(401, "refused", SIGNUP_TO_APPROVE_AR, "guest");
  if (!input.emailVerified) return answer(403, "refused", VERIFY_EMAIL_AR, "unverified");

  const body = input.body;
  const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body as object) : [];
  const { requestId, expectedPoints } = (keys.length > 0 ? body : {}) as { requestId?: unknown; expectedPoints?: unknown };
  if (keys.length !== 2 || keys.some((k) => k !== "requestId" && k !== "expectedPoints")) return answer(400, "refused", BAD_REQUEST_AR, "bad_request");
  if (!isRequestId(requestId) || typeof expectedPoints !== "number" || !Number.isInteger(expectedPoints) || expectedPoints < 1 || expectedPoints > ADDON_MAX_HOLD_POINTS) return answer(400, "refused", BAD_REQUEST_AR, "bad_request");

  try {
    const { data: row, error } = await client.from(MISSION_TABLE).select("id,user_id,status,plan").eq("id", requestId).maybeSingle();
    if (error) return answer(503, "refused", "تعذّر التحقق من الطلب الآن. لم يُحجز أو يُخصم شيء، فحاول بعد قليل.", "unavailable");
    const addon = row && row.user_id === input.userId ? readAddonPlan(row.plan) : null;
    // not theirs, not an add-on, not of THIS file, or a kind that cannot be run: one answer, nothing said about which
    if (!row || !addon || addon.of !== input.missionId || (addon.kind !== "review" && addon.kind !== "edit")) return answer(404, "refused", NOT_FOUND_AR, "not_found");
    if (!kindFlagOn(addon.kind, input.env)) return answer(404, "refused", NOT_FOUND_AR, "not_found");
    // a second click (or a refresh after the first): the request is already approved, running or done: no second reservation is even attempted
    if (ALREADY_STARTED.has(String(row.status))) return { status: 409, body: { success: false, state: "already_approved", error: ADDON_APPROVE_MESSAGES_AR.already_approved, code: "already_approved", kind: addon.kind } };

    const guard = await guardApproval(client, { id: requestId, userId: input.userId, expectedPoints });
    if (!guard.ok) return answer(guard.status, "refused", guard.messageAr, guard.reason);

    const approved = await approveAddonOnce(client, { id: requestId, actorId: input.userId, expectUserId: input.userId });
    if (approved.ok) return { status: 200, body: { success: true, state: "approved", kind: approved.kind, holdPoints: approved.holdPoints } };
    if (approved.code === "already_approved" || approved.error === ADDON_APPROVE_MESSAGES_AR.already_approved) return { status: 409, body: { success: false, state: "already_approved", error: approved.error, code: "already_approved", kind: addon.kind } };
    const uncertain = approved.code !== undefined && UNCERTAIN.has(approved.code);
    return answer(approved.status, uncertain ? "uncertain" : "refused", approved.error, approved.code);
  } catch {
    // the answer of a call may be lost (the money may or may not have moved): never «nothing was held», and the page re-reads the request's status
    return answer(503, "uncertain", ADDON_APPROVE_MESSAGES_AR.approval_unverified, "approval_unverified");
  }
}
