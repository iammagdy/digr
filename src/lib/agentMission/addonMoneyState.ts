/**
 * SAFETY FIX C: THE MONEY STATE OF ONE JOB, READ ONLY. A request whose approval was abandoned (an answer lost, a record not written, a claim that failed) must be judged by what the DATABASE says about its job and its ledger rows, never by the customer-facing text or by the
 * request's own status. This file reads `jobs` and `credit_ledger` (select only: no rpc, no insert, no update, no delete) and names exactly six states:
 *   none         no job row and no ledger row of this job: nothing was ever reserved (confirmed)
 *   active       the job is queued or running, its reserve row matches the job, no release and no charge: the hold is held
 *   released     the job is failed, its reserve row matches, its RELEASE row exists with the reserve's amount, no charge: the hold came back (confirmed by the ledger, not by the status alone)
 *   charged      the job is completed, its release row and its CHARGE row exist, and the charge equals the job's charged points and is within the hold
 *   settled_free completed with a release row and no charge
 *   unknown      a read failed (read_failed), or the rows contradict each other (inconsistent): never read as «none» or «released»
 * The ledger is append-only and deterministic (res_/rel_/chg_ + the job id): this reader relies on those ids and on nothing else. It imports nothing: the money core's ids are passed in by the caller, so the money core can use this file without a cycle.
 */
export type JobMoneyState =
  | { kind: "none" }
  | { kind: "active"; status: "queued" | "running"; holdPoints: number }
  | { kind: "released"; holdPoints: number }
  | { kind: "charged"; chargedPoints: number; holdPoints: number }
  | { kind: "settled_free"; holdPoints: number }
  | { kind: "unknown"; why: "read_failed" | "inconsistent" };

const unknown = (why: "read_failed" | "inconsistent"): JobMoneyState => ({ kind: "unknown", why });
type LedgerLine = { id?: unknown; delta?: unknown; type?: unknown };

export async function readJobMoneyState(client: any, jobId: string): Promise<JobMoneyState> {
  try {
    const jobRead = await client.from("jobs").select("id,status,reserved_credits,charged_credits").eq("id", jobId).maybeSingle();
    const ledgerRead = await client.from("credit_ledger").select("id,delta,type").eq("job_id", jobId);
    if (jobRead?.error || ledgerRead?.error || !Array.isArray(ledgerRead?.data)) return unknown("read_failed");
    const job = jobRead.data as { status?: unknown; reserved_credits?: unknown; charged_credits?: unknown } | null;
    const ledger = ledgerRead.data as LedgerLine[];
    if (!job) return ledger.length === 0 ? { kind: "none" } : unknown("inconsistent");

    const hold = Number(job.reserved_credits);
    if (!Number.isInteger(hold) || hold < 1) return unknown("inconsistent");
    const row = (prefix: string): LedgerLine | undefined => ledger.find((l) => l.id === `${prefix}${jobId}`);
    const [res, rel, chg] = [row("res_"), row("rel_"), row("chg_")];
    if (!res || res.type !== "reserve" || Number(res.delta) !== -hold) return unknown("inconsistent");
    const relOk = rel !== undefined && rel.type === "release" && Number(rel.delta) === hold;
    if (rel !== undefined && !relOk) return unknown("inconsistent");
    if (chg !== undefined && (chg.type !== "charge" || !(Number(chg.delta) < 0))) return unknown("inconsistent");

    switch (job.status) {
      case "queued": case "running":
        return rel === undefined && chg === undefined ? { kind: "active", status: job.status, holdPoints: hold } : unknown("inconsistent");
      case "failed":
        return relOk && chg === undefined ? { kind: "released", holdPoints: hold } : unknown("inconsistent");
      case "completed": {
        if (!relOk) return unknown("inconsistent");
        if (chg === undefined) return Number(job.charged_credits ?? 0) === 0 ? { kind: "settled_free", holdPoints: hold } : unknown("inconsistent");
        const charged = -Number(chg!.delta);
        return Number.isInteger(charged) && charged >= 1 && charged <= hold && charged === Number(job.charged_credits) ? { kind: "charged", chargedPoints: charged, holdPoints: hold } : unknown("inconsistent");
      }
      default:
        return unknown("inconsistent");
    }
  } catch {
    return unknown("read_failed");
  }
}
