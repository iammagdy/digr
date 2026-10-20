/**
 * What the platform measured about each service, per service key (`jobs.endpoint_id`): records delivered, provider cost rows (one per
 * chunk), provider USD per record and per chunk, records per chunk, seconds per chunk, retries, and what the customer paid per record.
 *
 * `MEASUREMENT_SQL` is ONE read-only statement for the owner to paste in the SQL editor (it only reads `jobs`, `provider_costs` and
 * `job_events`; it was run on the production schema with the SELECT-only access). `buildCapabilityMeasurements` computes the same
 * numbers from the same rows in code, so the rule is tested and the query can be checked against it.
 *
 * Not recorded anywhere today, so not reported: the number of provider CALLS inside a chunk (one cost row covers all the calls of a chunk;
 * the tester reads the call count from the provider's usage panel for the small measurement requests in docs/LONG_JOB_MEASUREMENT_PLAN.md).
 */

export const MEASUREMENT_WINDOW_DAYS = 90;
/** A gap between two page lines longer than this is the job waiting, not a chunk (the same limit the progress line uses). */
export const IDLE_GAP_SECONDS = 1800;

export const MEASUREMENT_SQL = `with done as (
  select id, endpoint_id, delivered_units, charged_credits, attempt_count, created_at
  from public.jobs
  where status = 'completed' and delivered_units > 0 and created_at >= now() - interval '${MEASUREMENT_WINDOW_DAYS} days'
),
cost as (
  select c.job_id, count(*) as cost_rows, count(*) filter (where c.is_estimate) as estimate_rows, coalesce(sum(c.cost_usd), 0) as provider_usd
  from public.provider_costs c
  where c.provider = 'treg' and c.job_id in (select id from done)
  group by c.job_id
),
pages as (
  select e.job_id,
         extract(epoch from (e.created_at - lag(e.created_at, 1, j.created_at) over (partition by e.job_id order by e.created_at))) as gap_seconds
  from public.job_events e
  join done j on j.id = e.job_id
  where e.event_type = 'progress' and e.message like 'الصفحة%'
),
timing as (
  select d.endpoint_id,
         percentile_cont(0.5) within group (order by p.gap_seconds) as seconds_per_chunk_p50,
         percentile_cont(0.9) within group (order by p.gap_seconds) as seconds_per_chunk_p90
  from pages p join done d on d.id = p.job_id
  where p.gap_seconds > 0 and p.gap_seconds <= ${IDLE_GAP_SECONDS}
  group by d.endpoint_id
)
select d.endpoint_id as service_key,
       count(*) as jobs,
       sum(d.delivered_units) as delivered_records,
       coalesce(sum(c.cost_rows), 0) as cost_rows_chunks,
       coalesce(sum(c.estimate_rows), 0) as estimate_rows,
       round(coalesce(sum(c.provider_usd), 0)::numeric, 6) as provider_usd,
       round((sum(c.provider_usd) / nullif(sum(d.delivered_units), 0))::numeric, 6) as provider_usd_per_record,
       round((sum(c.provider_usd) / nullif(sum(c.cost_rows), 0))::numeric, 6) as provider_usd_per_chunk,
       round((sum(d.delivered_units)::numeric / nullif(sum(c.cost_rows), 0)), 2) as records_per_chunk,
       round(max(t.seconds_per_chunk_p50)::numeric, 1) as seconds_per_chunk_p50,
       round(max(t.seconds_per_chunk_p90)::numeric, 1) as seconds_per_chunk_p90,
       sum(d.attempt_count) as retries,
       round((sum(d.charged_credits) / nullif(sum(d.delivered_units), 0))::numeric, 4) as customer_points_per_record
from done d
left join cost c on c.job_id = d.id
left join timing t on t.endpoint_id = d.endpoint_id
group by d.endpoint_id
order by sum(d.delivered_units) desc;
`;

export interface MeasurementJob { id: string; endpoint_id: string; status: string; delivered_units: number; charged_credits: number; attempt_count: number; created_at: string }
export interface MeasurementCost { job_id: string; provider: string; cost_usd: number; is_estimate?: boolean | null }
export interface MeasurementEvent { job_id: string; event_type: string; message: string; created_at: string }

export interface CapabilityMeasurement {
  serviceKey: string;
  jobs: number;
  deliveredRecords: number;
  costRowsChunks: number;
  estimateRows: number;
  providerUsd: number;
  providerUsdPerRecord: number | null;
  providerUsdPerChunk: number | null;
  recordsPerChunk: number | null;
  secondsPerChunkP50: number | null;
  secondsPerChunkP90: number | null;
  retries: number;
  customerPointsPerRecord: number | null;
  /** 1 point = 0.10 EGP. */
  customerEgpPerRecord: number | null;
}

/** Postgres' percentile_cont: linear interpolation between the two closest ranks. */
export function percentileCont(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

const roundTo = (value: number | null, digits: number): number | null => (value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export function buildCapabilityMeasurements(input: { jobs: MeasurementJob[]; costs: MeasurementCost[]; events: MeasurementEvent[]; now?: number }): CapabilityMeasurement[] {
  const now = input.now ?? Date.now();
  const since = now - MEASUREMENT_WINDOW_DAYS * 86_400_000;
  const done = input.jobs.filter((job) => job.status === "completed" && job.delivered_units > 0 && Date.parse(job.created_at) >= since);
  const byId = new Map(done.map((job) => [job.id, job]));

  const costOf = new Map<string, { rows: number; estimates: number; usd: number }>();
  for (const cost of input.costs) {
    if (cost.provider !== "treg" || !byId.has(cost.job_id)) continue;
    const entry = costOf.get(cost.job_id) ?? { rows: 0, estimates: 0, usd: 0 };
    entry.rows += 1;
    if (cost.is_estimate) entry.estimates += 1;
    entry.usd += Number(cost.cost_usd) || 0;
    costOf.set(cost.job_id, entry);
  }

  // seconds between a job's page lines (the first one counted from the job's start), per service key
  const gapsOf = new Map<string, number[]>();
  const pagesByJob = new Map<string, MeasurementEvent[]>();
  for (const event of input.events) {
    if (event.event_type !== "progress" || !event.message.startsWith("الصفحة") || !byId.has(event.job_id)) continue;
    const list = pagesByJob.get(event.job_id) ?? [];
    list.push(event);
    pagesByJob.set(event.job_id, list);
  }
  for (const [jobId, pages] of pagesByJob) {
    const job = byId.get(jobId)!;
    pages.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    let previous = Date.parse(job.created_at);
    for (const page of pages) {
      const at = Date.parse(page.created_at);
      const gap = (at - previous) / 1000;
      previous = at;
      if (gap > 0 && gap <= IDLE_GAP_SECONDS) {
        const list = gapsOf.get(job.endpoint_id) ?? [];
        list.push(gap);
        gapsOf.set(job.endpoint_id, list);
      }
    }
  }

  const groups = new Map<string, MeasurementJob[]>();
  for (const job of done) groups.set(job.endpoint_id, [...(groups.get(job.endpoint_id) ?? []), job]);

  const rows: CapabilityMeasurement[] = [];
  for (const [serviceKey, jobs] of groups) {
    const delivered = jobs.reduce((sum, job) => sum + job.delivered_units, 0);
    const charged = jobs.reduce((sum, job) => sum + (Number(job.charged_credits) || 0), 0);
    let costRows = 0; let estimateRows = 0; let usd = 0;
    for (const job of jobs) {
      const entry = costOf.get(job.id);
      if (!entry) continue;
      costRows += entry.rows; estimateRows += entry.estimates; usd += entry.usd;
    }
    const gaps = (gapsOf.get(serviceKey) ?? []).sort((a, b) => a - b);
    const pointsPerRecord = ratio(charged, delivered);
    rows.push({
      serviceKey,
      jobs: jobs.length,
      deliveredRecords: delivered,
      costRowsChunks: costRows,
      estimateRows,
      providerUsd: roundTo(usd, 6) ?? 0,
      // no cost row at all is unknown, never a cost of zero
      providerUsdPerRecord: costRows > 0 ? roundTo(ratio(usd, delivered), 6) : null,
      providerUsdPerChunk: roundTo(ratio(usd, costRows), 6),
      recordsPerChunk: roundTo(ratio(delivered, costRows), 2),
      secondsPerChunkP50: roundTo(percentileCont(gaps, 0.5), 1),
      secondsPerChunkP90: roundTo(percentileCont(gaps, 0.9), 1),
      retries: jobs.reduce((sum, job) => sum + (Number(job.attempt_count) || 0), 0),
      customerPointsPerRecord: roundTo(pointsPerRecord, 4),
      customerEgpPerRecord: roundTo(pointsPerRecord === null ? null : pointsPerRecord * 0.1, 4),
    });
  }
  return rows.sort((a, b) => b.deliveredRecords - a.deliveredRecords);
}
