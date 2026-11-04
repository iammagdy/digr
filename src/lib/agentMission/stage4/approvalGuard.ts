/** SAFETY FIX B (stub, RED commit): the checks the planned approval route must pass BEFORE approveAddonOnce. UNWIRED: no route calls it. The implementation follows the failing tests. */
export type ApprovalGuardResult =
  | { ok: true }
  | { ok: false; status: 404 | 409 | 503; reason: "not_found" | "not_ready" | "open_addon" | "review_exists" | "review_unresolved" | "unavailable"; messageAr: string };

export async function guardApproval(_client: any, _input: { id: string; userId: string }): Promise<ApprovalGuardResult> {
  throw new Error("not implemented");
}
