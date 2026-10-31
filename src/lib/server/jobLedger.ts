import type { JobLedgerRow } from "../walletView";

const PAGE = 1000;
const IDS_PER_READ = 50;

/**
 * EVERY ledger row of the given jobs, from the ledger itself (`credit_ledger`, the table `calculateBalance` sums), read-only. The wallet list shows only the newest rows, but a job's line must be made from ALL of the
 * job's rows (a job whose first rows are older than the window would otherwise show half its money). Paged like the balance read: 1,000 rows per page, a small group of ids per read so the address stays short.
 */
export async function readLedgerRowsOfJobs(client: any, userId: string, jobIds: ReadonlyArray<string>): Promise<JobLedgerRow[]> {
  const out: JobLedgerRow[] = [];
  for (let i = 0; i < jobIds.length; i += IDS_PER_READ) {
    const ids = jobIds.slice(i, i + IDS_PER_READ);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client.from("credit_ledger").select("job_id,type,delta").eq("user_id", userId).in("job_id", ids).order("id", { ascending: true }).range(from, from + PAGE - 1);
      if (error) throw new Error("job_ledger_read_failed");
      for (const row of data ?? []) out.push({ jobId: row.job_id ?? null, type: String(row.type ?? ""), delta: Number(row.delta) || 0 });
      if (!data || data.length < PAGE) break;
    }
  }
  return out;
}
