import { fakeAddonWorld, type MissionRow } from "./addonWorld";

/**
 * SAFETY ROUND: A FAULT-INJECTING WORLD FOR THE ADD-ON APPROVAL AND ITS RECOVERY. It wraps `fakeAddonWorld` (the hardened money fake behind `rpc`, a tiny `missions` table, a read-only `jobs`) and adds:
 *   - a READ-ONLY `credit_ledger` (the ledger the money fake keeps), so a test can show what the recovery reads and that it never writes;
 *   - a `jobs` read that also answers `reserved_credits` (what the money-state reader needs);
 *   - faults on the `missions` table, by operation and by what the call carries: an UPDATE can fail before it commits, fail AFTER it committed (the answer is an error), throw before or after, answer «no row changed» (not applied) or answer «no row changed» although it was APPLIED
 *     (a lost answer), and a SELECT can fail. A fault fires a fixed number of times and then the table works again (a transient outage), or for ever.
 * Nothing here reaches a database, a provider or the network; any table other than missions, mission_events, jobs and credit_ledger throws.
 */
export type UpdateFault = "error_before" | "error_after" | "throw_before" | "throw_after" | "none_matched" | "lost_ok_answer";
export interface FaultRule {
  /** Which update this applies to, by what it writes. */
  when: (patch: Record<string, unknown>) => boolean;
  mode: UpdateFault;
  /** How many matching calls fail (default: every one, for ever). */
  times?: number;
}
export interface SelectRule {
  /** The columns the select names (so the read-back is told apart from the first read). */
  when: (columns: string) => boolean;
  times?: number;
}

export function safetyWorld(options: { balance?: number; cap?: number; missions?: Map<string, any> } = {}) {
  const w = fakeAddonWorld(options);
  const updateFaults: FaultRule[] = [];
  const selectFaults: SelectRule[] = [];
  const ledgerReads: string[] = [];
  const writes: Array<{ table: string; patch: Record<string, unknown> }> = [];
  let jobsDown = false;
  let ledgerDown = false;

  const base = w.client.from as (name: string) => any;
  const from = (name: string): any => {
    if (name === "jobs") {
      return {
        select: () => ({
          eq: (_k: string, id: string) => ({
            maybeSingle: async () => {
              if (jobsDown) return { data: null, error: { message: "jobs read failed" } };
              const j = w.jobs.get(id);
              return { data: j ? { id: j.id, status: j.status, charged_credits: j.charged_credits, reserved_credits: j.reserved_credits } : null, error: null };
            },
          }),
        }),
      };
    }
    if (name === "credit_ledger") {
      return {
        select: () => ({
          eq: (_k: string, jobId: string) => {
            ledgerReads.push(jobId);
            const out = ledgerDown ? { data: null, error: { message: "ledger read failed" } } : { data: w.ledger.filter((l) => l.job_id === jobId).map((l) => ({ id: l.id, delta: l.delta, type: l.type })), error: null };
            return { then: (resolve: (v: unknown) => void) => resolve(out) };
          },
        }),
      };
    }
    if (name !== "missions") return base(name);
    const q = base("missions");
    const origSelect = q.select.bind(q);
    const origUpdate = q.update.bind(q);
    const origMaybe = q.maybeSingle.bind(q);
    let columns = "";
    q.select = (cols?: string) => { columns = cols ?? ""; return origSelect(cols); };
    q.maybeSingle = async () => {
      const rule = selectFaults.find((r) => r.when(columns) && (r.times === undefined || r.times > 0));
      if (rule) { if (rule.times !== undefined) rule.times -= 1; return { data: null, error: { message: "missions read failed" } }; }
      return origMaybe();
    };
    q.update = (patch: Record<string, unknown>) => {
      writes.push({ table: "missions", patch });
      const api = origUpdate(patch);
      const rule = updateFaults.find((r) => r.when(patch) && (r.times === undefined || r.times > 0));
      if (!rule) return api;
      if (rule.times !== undefined) rule.times -= 1;
      const applied = api.then.bind(api) as (resolve: (v: any) => void) => void;
      api.then = (resolve: (v: any) => void, reject?: (e: unknown) => void) => {
        switch (rule.mode) {
          case "error_before": return resolve({ data: null, error: { message: "update failed before it ran" } });
          case "throw_before": return reject ? reject(new Error("injected: update threw before it ran")) : undefined;
          case "none_matched": return resolve({ data: [], error: null });
          case "error_after": return applied(() => resolve({ data: null, error: { message: "the answer of the update was lost" } }));
          case "throw_after": return applied(() => (reject ? reject(new Error("injected: update threw after it committed")) : undefined));
          case "lost_ok_answer": return applied(() => resolve({ data: [], error: null }));
        }
      };
      return api;
    };
    return q;
  };
  const client = { rpc: w.client.rpc, from };
  return {
    ...w,
    client,
    writes,
    ledgerReads,
    /** Make updates fail by rule. */
    failUpdates: (rule: FaultRule): void => { updateFaults.push(rule); },
    failSelects: (rule: SelectRule): void => { selectFaults.push(rule); },
    /** The whole read of the jobs table / the ledger fails (the database is unreachable for the recovery). */
    setJobsDown: (v: boolean): void => { jobsDown = v; },
    setLedgerDown: (v: boolean): void => { ledgerDown = v; },
    clearFaults: (): void => { updateFaults.length = 0; selectFaults.length = 0; },
  };
}
export type SafetyWorld = ReturnType<typeof safetyWorld>;

/** The patch of the approval's LAST update (it records the job on the row). */
export const recordsJob = (patch: Record<string, unknown>): boolean => "job_id" in patch && patch.job_id !== null && "quote_id" in patch;
export type { MissionRow };
