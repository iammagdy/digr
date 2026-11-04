import type { AddonRowLike } from "./addonRow";

/** SAFETY FIX B (stub, RED commit): the verdict on earlier reviews of one version. The implementation follows the failing tests. */
export type PaidReviewVerdict =
  | { kind: "clear" }
  | { kind: "report_published"; id: string }
  | { kind: "unresolved"; id: string; reason: "charged" | "held" | "unverified" };

export async function paidReviewVerdict(_client: any, _input: { missionId: string; baseVersion: number; rows: ReadonlyArray<AddonRowLike> }): Promise<PaidReviewVerdict> {
  throw new Error("not implemented");
}
