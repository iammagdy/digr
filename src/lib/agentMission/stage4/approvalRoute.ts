import { MISSION_TABLE } from "../constants";
import { ADDON_APPROVE_MESSAGES_AR, ADDON_MAX_HOLD_POINTS, addonJobId, addonQuoteId, approveAddonOnce, readAddonPlan, type AddonKind } from "../addonSettlement";
import { readJobMoneyState } from "../addonMoneyState";
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
/** «approved», «executing» or «completed» may also be an approval still being made by another tab: the sentence does not claim more than that. */
const ALREADY_APPROVED_AR = "هذا الطلب اعتُمد بالفعل أو قيد الاعتماد الآن؛ تابع حالته في «حالة طلباتك على هذا الملف».";
const BAD_REQUEST_AR = "تعذّر قراءة طلب الاعتماد. حدّث الصفحة وحاول مرة أخرى؛ لم يُحجز أو يُخصم شيء.";
const answer = (status: number, state: ApprovalState, error: string, code?: string): ApprovalAnswer => ({ status, body: { success: false, state, error, ...(code ? { code } : {}) } });
/**
 * After which answers the points MAY be held (the lost-answer family): never «nothing was held». The money core answers a held-but-not-started job with the code `claim_failed` (the same code as a hold that was proved RELEASED), so the SENTENCE decides, not the code:
 * `claim_retry` says «نقاطك محجوزة». (Found by the independent review of this route.)
 */
const UNCERTAIN_CODES = new Set(["approval_unverified", "record_unverified", "claim_retry"]);
const UNCERTAIN_SENTENCES = new Set<string>([ADDON_APPROVE_MESSAGES_AR.approval_unverified, ADDON_APPROVE_MESSAGES_AR.record_unverified, ADDON_APPROVE_MESSAGES_AR.claim_retry]);
const ALREADY_STARTED = new Set(["approved", "executing", "completed"]);

/** The refusals of the money core that are CLEAN: the database said no and nothing was reserved (insufficient balance, the two-active-jobs limit, a quote or an accept that was refused). */
const CLEAN_REFUSALS = new Set(["insufficient_balance", "concurrency_limit", "quote_failed", "accept_failed"]);

/**
 * After a CLEAN refusal the approval function puts the request back to `plan_ready` but leaves the approval time it wrote when it claimed the row, and every reader treats a request «that was ever put through an approval» as possibly paid: it would no longer be offered as waiting (no button,
 * no cancel), could not be replaced (another open request is refused) and the status panel would say «the points may be held». That is wrong for a refusal that moved nothing, and it leaves the customer stuck after the most common refusal (not enough points). So, ONLY when the job's own
 * ledger state is proved `none` (no job and no ledger row of its deterministic id), the approval mark is cleared by ONE compare-and-set pinned to `plan_ready` with no job. Anything else (a held, released, charged or unreadable state) keeps the mark: the request stays «possibly paid».
 * (Found by the end-to-end journey; the money core is not edited.)
 */
export async function clearApprovalMarkIfNothingHeld(client: any, requestId: string, userId: string): Promise<void> {
  try {
    const state = await readJobMoneyState(client, addonJobId(addonQuoteId(requestId)));
    if (state.kind !== "none") return;
    await client.from(MISSION_TABLE).update({ approved_at: null, approved_by: null }).eq("id", requestId).eq("user_id", userId).eq("status", "plan_ready").is("job_id", null).select("id");
  } catch { /* the mark stays: the request is shown as possibly paid, never as free by a guess */ }
}

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
    if (ALREADY_STARTED.has(String(row.status))) return { status: 409, body: { success: false, state: "already_approved", error: ALREADY_APPROVED_AR, code: "already_approved", kind: addon.kind } };

    const guard = await guardApproval(client, { id: requestId, userId: input.userId, expectedPoints });
    if (!guard.ok) {
      // the status moved between the first read and the guard's (another tab started this very request): it is already approved or running, not «no request ready»
      if (guard.reason === "not_ready") {
        const { data: again } = await client.from(MISSION_TABLE).select("status").eq("id", requestId).eq("user_id", input.userId).maybeSingle();
        if (again && ALREADY_STARTED.has(String(again.status))) return { status: 409, body: { success: false, state: "already_approved", error: ALREADY_APPROVED_AR, code: "already_approved", kind: addon.kind } };
      }
      return answer(guard.status, "refused", guard.messageAr, guard.reason);
    }

    const approved = await approveAddonOnce(client, { id: requestId, actorId: input.userId, expectUserId: input.userId });
    if (approved.ok) return { status: 200, body: { success: true, state: "approved", kind: approved.kind, holdPoints: approved.holdPoints } };
    if (approved.code === "already_approved" || approved.error === ADDON_APPROVE_MESSAGES_AR.already_approved) return { status: 409, body: { success: false, state: "already_approved", error: ALREADY_APPROVED_AR, code: "already_approved", kind: addon.kind } };
    if (approved.code !== undefined && CLEAN_REFUSALS.has(approved.code)) await clearApprovalMarkIfNothingHeld(client, requestId, input.userId);
    const uncertain = (approved.code !== undefined && UNCERTAIN_CODES.has(approved.code)) || UNCERTAIN_SENTENCES.has(approved.error);
    return answer(approved.status, uncertain ? "uncertain" : "refused", approved.error, approved.code);
  } catch {
    // the answer of a call may be lost (the money may or may not have moved): never «nothing was held», and the page re-reads the request's status
    return answer(503, "uncertain", ADDON_APPROVE_MESSAGES_AR.approval_unverified, "approval_unverified");
  }
}
