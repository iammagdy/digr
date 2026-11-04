/**
 * SAFETY FIX C (stub, RED commit): the read-only reader of a job's money state. The implementation follows the failing tests.
 */
export type JobMoneyState =
  | { kind: "none" }
  | { kind: "active"; status: "queued" | "running"; holdPoints: number }
  | { kind: "released"; holdPoints: number }
  | { kind: "charged"; chargedPoints: number; holdPoints: number }
  | { kind: "settled_free"; holdPoints: number }
  | { kind: "unknown"; why: "read_failed" | "inconsistent" };

export async function readJobMoneyState(_client: any, _jobId: string): Promise<JobMoneyState> {
  throw new Error("not implemented");
}
