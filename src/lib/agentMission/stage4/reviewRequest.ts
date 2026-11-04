import { formatAr } from "../../arabicDigits";
import { MISSION_TABLE } from "../constants";
import { addonId, readAddonPlan } from "../addonSettlement";
import { reviewCard } from "./addonQuote";
import { addonThatStays, createAddonRow, isUnpaidAddonRow, OPEN_STATUSES, reconcileOpenAddons, type AddonRowLike } from "./addonRow";
import { cancelUnpaidAddonRow, createSupabaseAddonRowStore } from "./addonRowStore";
import { reviewCellsOf } from "./review";
import type { ReviewRequestView } from "./reviewRequestLabels";
import { readPublishedVersion } from "./versionFile";

/**
 * MONEY PR 7d, PHASE 2B-2 TASK 3 (docs/MONEY-PR-7A.md section 16): THE REVIEW REQUEST BEFORE PAYMENT, behind DIGER_STAGE4_REVIEW. It makes the add-on row of a review of ONE published version, finds it again after a refresh, and cancels it while it is unpaid.
 * Nothing is reserved, charged, released or refunded here: the row is `plan_ready` (it WAITS for the approval of a later task), no job exists, no provider or model is called. Nothing the browser sends is trusted: the version is read from storage by the owner's
 * own check, the cells are counted by `reviewCellsOf`, the price is the existing `reviewCard`, the rules are `createAddonRow`/`canCreateAddon` (one open add-on per file, a completed review is reused), and the id is the deterministic one.
 */
type Failure = { ok: false; status: 404 | 409 | 500 | 503; error: "not_found" | "damaged" | "unavailable" | "open_addon" | "review_exists" | "too_large" | "nothing_to_review" | "changed" | "plan_changed" | "bad_request" };
const no = (status: Failure["status"], error: Failure["error"]): Failure => ({ ok: false, status, error });

/** The words stored in the row's `request_text` (3 to 4,000 characters; a fixed sentence: nothing the browser sent). */
const requestTextOf = (version: number): string => `طلب مراجعة النسخة ${formatAr(version)} من الملف`;

/**
 * The view of a waiting review request, priced again from its stored cells by the card (never from a stored points field); null for a row that is not a waiting review of its own identity (the id is the deterministic one). A row whose STORED price no longer equals
 * the code's (the price rule changed after it was made) is still shown, at the code's price, so the customer can cancel it; the approval of a later task checks the stored price again (`checkAddon`) and refuses such a row.
 * Only an UNPAID row is shown (waiting, no job, never put through an approval): the page tells the customer that nothing was held, which it cannot say of a row whose approval was attempted and failed.
 */
function viewOf(row: AddonRowLike): ReviewRequestView | null {
  const addon = readAddonPlan(row.plan);
  if (!addon || addon.kind !== "review" || !isUnpaidAddonRow(row) || row.id !== addonId(addon.of, addon.baseVersion, addon.attempt)) return null;
  const cells = addon.pricing.cells as number;
  const card = reviewCard(cells);
  return card.ok ? { id: row.id, version: addon.baseVersion, cells, points: card.holdPoints, status: "plan_ready" } : null;
}

export type CreateReviewRequestResult = { ok: true; created: boolean; request: ReviewRequestView } | Failure;

/** Make the review request of published version `version` of the customer's own mission; a second ask returns the request that already waits (`created: false`). */
export async function createReviewRequest(client: any, input: { missionId: string; userId: string; version: number }): Promise<CreateReviewRequestResult> {
  const read = await readPublishedVersion(client, input);
  if (!read.ok) return read;
  const cells = reviewCellsOf(read.version);
  if (cells === 0) return no(409, "nothing_to_review");
  const card = reviewCard(cells);
  if (!card.ok) return no(409, card.reason === "too_large" ? "too_large" : "nothing_to_review");
  const store = createSupabaseAddonRowStore(client, input.userId);
  try {
    const made = await createAddonRow(store, { userId: input.userId, of: input.missionId, kind: "review", baseVersion: input.version, latestVersion: read.latest, request: { kind: "review" }, pricing: card.pricing, requestText: requestTextOf(input.version) });
    if (made.ok) {
      const view = viewOf(made.row);
      return view ? { ok: true, created: true, request: view } : no(409, "plan_changed");
    }
    if (made.reason === "open_addon" && made.existingId) {
      // the same click twice, or a request already waiting for THIS version: that request is the answer, never a second one
      const open = (await store.listFor(input.missionId)).find((r) => r.id === made.existingId);
      const view = open ? viewOf(open) : null;
      if (view && view.version === input.version) return { ok: true, created: false, request: view };
    }
    return no(409, made.reason === "open_addon" || made.reason === "review_exists" || made.reason === "too_large" ? made.reason : made.reason === "plan_changed" ? "plan_changed" : "bad_request");
  } catch {
    return no(503, "unavailable");
  }
}

export type CurrentReviewRequestResult = { ok: true; request: ReviewRequestView | null } | Failure;

/**
 * The waiting review request of the customer's own mission, if one waits (the page finds it again after a refresh). It creates nothing. If it finds MORE THAN ONE open add-on on the file (the end state of a creation whose settlement could not run, section 17.2) it runs the same
 * repair every creator runs (`reconcileOpenAddons`: the unpaid duplicates are cancelled, the one that stays is shown); if the repair itself cannot run, it still shows the one that would stay.
 */
export async function currentReviewRequest(client: any, input: { missionId: string; userId: string }): Promise<CurrentReviewRequestResult> {
  try {
    const { data, error } = await client.from(MISSION_TABLE).select("id,user_id").eq("id", input.missionId).maybeSingle();
    if (error) return no(503, "unavailable");
    if (!data || data.user_id !== input.userId) return no(404, "not_found");
    const store = createSupabaseAddonRowStore(client, input.userId);
    let rows = await store.listFor(input.missionId);
    const open = rows.filter((r) => (OPEN_STATUSES as ReadonlyArray<string>).includes(r.status) && readAddonPlan(r.plan) !== null);
    if (open.length > 1) {
      let stays: AddonRowLike | null;
      try { stays = (await reconcileOpenAddons(store, input.missionId)).keeper; } catch { stays = addonThatStays(open); }
      rows = stays ? [stays] : [];
    }
    const waiting = rows.filter((r) => (OPEN_STATUSES as ReadonlyArray<string>).includes(r.status)).map(viewOf).find((v) => v !== null) ?? null;
    return { ok: true, request: waiting };
  } catch {
    return no(503, "unavailable");
  }
}

export type CancelReviewRequestResult = { ok: true } | Failure;

/**
 * Cancel an UNPAID review request of the customer's own mission. 404 for a request that is not theirs, does not exist, is not a review, or belongs to another mission (the same answer). 409 `changed` for a request that is not waiting any more (started, finished,
 * already cancelled), that already holds a job, or that was ever put through an approval; the cancel itself is ONE compare-and-set on `plan_ready` with no job and no approval, so a status that changed between the read and the update changes nothing. No refund or settlement function is called.
 */
export async function cancelReviewRequest(client: any, input: { missionId: string; userId: string; requestId: string }): Promise<CancelReviewRequestResult> {
  try {
    const { data, error } = await client.from(MISSION_TABLE).select("id,user_id,status,job_id,approved_at,plan").eq("id", input.requestId).maybeSingle();
    if (error) return no(503, "unavailable");
    const addon = data && data.user_id === input.userId ? readAddonPlan(data.plan) : null;
    if (!data || !addon || addon.kind !== "review" || addon.of !== input.missionId) return no(404, "not_found");
    if (data.status !== "plan_ready" || (data.job_id !== null && data.job_id !== undefined) || (data.approved_at !== null && data.approved_at !== undefined)) return no(409, "changed");
    return (await cancelUnpaidAddonRow(client, { id: input.requestId, userId: input.userId })) ? { ok: true } : no(409, "changed");
  } catch {
    return no(503, "unavailable");
  }
}
