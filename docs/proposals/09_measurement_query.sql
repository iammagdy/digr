-- READ-ONLY. Paste in the Supabase SQL editor and run: it reads jobs, provider_costs and job_events and changes nothing.
-- One row per service key (jobs.endpoint_id), completed jobs of the last 90 days: records delivered, provider cost rows (one per chunk),
-- provider USD per record and per chunk, records per chunk, seconds per chunk (median and 90th percentile, gaps over 30 minutes are
-- waiting, not chunks), retries, and what the customer paid per record (1 point = 0.10 EGP).
-- Not in this table: provider calls inside a chunk (not recorded; see docs/LONG_JOB_MEASUREMENT_PLAN.md).
-- The same rule is computed in code by buildCapabilityMeasurements (src/lib/server/measurementReport.ts), which is what the tests pin.
with done as (
  select id, endpoint_id, delivered_units, charged_credits, attempt_count, created_at
  from public.jobs
  where status = 'completed' and delivered_units > 0 and created_at >= now() - interval '90 days'
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
  where p.gap_seconds > 0 and p.gap_seconds <= 1800
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
