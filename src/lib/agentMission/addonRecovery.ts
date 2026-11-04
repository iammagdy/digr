/**
 * SAFETY FIX C (stub, RED commit): recovery of an add-on whose approval was abandoned. The implementation follows the failing tests.
 */
export type RecoveryOutcome =
  | { kind: "not_applicable" }
  | { kind: "unpaid" }
  | { kind: "no_reservation" }
  | { kind: "active"; recorded: boolean }
  | { kind: "ended_released" }
  | { kind: "charged" }
  | { kind: "unresolved"; why: "read_failed" | "inconsistent" | "settled_without_row" | "hold_mismatch" };

export const RECOVERY_MAX_PER_FILE = 3;

export async function recoverAbandonedAddon(_client: any, _input: { id: string; userId: string; now?: Date }): Promise<RecoveryOutcome> {
  throw new Error("not implemented");
}
export async function recoverFileAddons(_client: any, _input: { missionId: string; userId: string; now?: Date }): Promise<RecoveryOutcome[]> {
  throw new Error("not implemented");
}
