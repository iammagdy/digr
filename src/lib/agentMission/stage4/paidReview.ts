import { AGENT_BUCKET } from "../constants";
import { addonJobId, addonQuoteId, readAddonPlan } from "../addonSettlement";
import { readJobMoneyState } from "../addonMoneyState";
import type { AddonRowLike } from "./addonRow";

/**
 * SAFETY FIX B (docs/STAGE-4-FINANCIAL-SAFETY.md): THE VERDICT ON EARLIER REVIEWS OF ONE VERSION. A review that was CHARGED and could not publish its report ends `failed` (`charged_not_published`). `failed` does not block, and the creation rules looked at a completed review only, so a SECOND PAID review of
 * the same version could be offered and approved. This module judges the earlier reviews of a version from what is AUTHORITATIVE, never from customer-facing text and not from the request's own words alone:
 *   1 is the report PUBLISHED in storage (`reviews/rNNNN.json`)?  then it is shown free: a second review is never needed             -> `report_published`
 *   2 else, for each earlier review of this version that ENDED (`failed` or `unserved`): the money state of its deterministic job (`readJobMoneyState`, read only):
 *        charged   the points were charged and nothing was shown                                                                      -> `unresolved` (charged)
 *        active    the job still holds the points under an ended request                                                              -> `unresolved` (held)
 *        unknown   a read failed or the rows contradict each other: never read as free                                                -> `unresolved` (unverified)
 *        none, released, settled_free: nothing was charged (a failed review with no charge does not block)
 * No row is written, nothing is released, charged or refunded, and the first review's stored evidence (its row, its job, its ledger rows, its pending objects) is never touched, so the worker's own recovery path (publishing the pending report) stays open.
 * A storage or database error THROWS: the callers answer «unavailable», never «allowed». When no earlier ended review of the version exists nothing is read at all.
 * An administrator's way out of «unresolved» is to publish the stored report (then step 1 applies) or to resolve the charge by hand; both are outside this file.
 */
export type PaidReviewVerdict =
  | { kind: "clear" }
  | { kind: "report_published"; id: string }
  | { kind: "unresolved"; id: string; reason: "charged" | "held" | "unverified" };

/** The statuses of a review request that has ENDED without being a completed (published) one. `completed` is the existing free-reuse rule; `cancelled` never held money. */
const ENDED_UNPUBLISHED = ["failed", "unserved"] as const;

/** Is the report of this version published? A failing list THROWS (it is never read as «not published»). */
export async function reviewReportPublished(client: any, missionId: string, version: number): Promise<boolean> {
  const { data, error } = await client.storage.from(AGENT_BUCKET).list(`${missionId}/reviews`, { limit: 1000, sortBy: { column: "name", order: "asc" } });
  if (error) throw new Error("the reports could not be listed");
  return ((data ?? []) as Array<{ name: string; id?: string | null }>).some((o) => Boolean(o.id) && Number(/^r(\d{4,})\.json$/.exec(o.name)?.[1] ?? 0) === version);
}

export async function paidReviewVerdict(client: any, input: { missionId: string; baseVersion: number; rows: ReadonlyArray<AddonRowLike> }): Promise<PaidReviewVerdict> {
  const earlier = input.rows
    .filter((r) => { const a = readAddonPlan(r.plan); return a !== null && a.kind === "review" && a.of === input.missionId && a.baseVersion === input.baseVersion && (ENDED_UNPUBLISHED as ReadonlyArray<string>).includes(r.status); })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (earlier.length === 0) return { kind: "clear" };
  if (await reviewReportPublished(client, input.missionId, input.baseVersion)) return { kind: "report_published", id: earlier[0].id };
  for (const r of earlier) {
    const state = await readJobMoneyState(client, addonJobId(addonQuoteId(r.id)));
    if (state.kind === "charged") return { kind: "unresolved", id: r.id, reason: "charged" };
    if (state.kind === "active") return { kind: "unresolved", id: r.id, reason: "held" };
    if (state.kind === "unknown") return { kind: "unresolved", id: r.id, reason: "unverified" };
  }
  return { kind: "clear" };
}
