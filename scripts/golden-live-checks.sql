-- GOLDEN / BENCHMARK LIVE CHECKS (S1 item 0.2). A PROPOSAL: READ-ONLY SELECTs for the owner to run by hand after a merge.
-- Nothing here is run by the code, the tests or the deploy. No INSERT, UPDATE, DELETE, DDL. Replace :mission_id with the mission under test.
-- Source of the columns: docs/proposals/agent-worker/01_agent_tables.sql and docs/AUDIT-2026-11.md section 7.0.

-- 1. delivered vs approved, charge and the pipeline that ran (the `pipe_new` internal count is written by the worker: 1 = new pipeline, 0 = old)
select id, status, reserved_points, unit_price_points, delivered_units, charged_points,
       planning_treg_usd + execution_treg_usd as treg_usd, planning_llm_usd + execution_llm_usd as llm_usd
from missions where id = :mission_id;

select created_at, counts->>'pipe_new' as pipe_new
from mission_events where mission_id = :mission_id and counts ? 'pipe_new' order by created_at;

-- 2. seconds from creation to the plan card, and planning tokens (section 7.2)
select extract(epoch from (e.created_at - m.created_at)) as seconds_to_plan
from missions m join mission_events e on e.mission_id = m.id and e.kind = 'plan' where m.id = :mission_id order by e.created_at limit 1;

select counts->>'tok_out' as tok_out, counts->>'tok_in' as tok_in
from mission_events where mission_id = :mission_id and kind = 'call' and counts->>'tok_phase' = '0';

-- 3. planning telemetry per turn (S1 item 0.4): counts only
select created_at, counts->>'turn_n' as turn, counts->>'turn_rss_mb' as rss_mb, counts->>'turn_out' as out_tokens,
       counts->>'turn_cache_read' as cache_read, counts->>'turn_cache_write' as cache_write
from mission_events where mission_id = :mission_id and counts ? 'turn_n' order by created_at;

-- 4. calls with 0 rows and their cost
select endpoint_id, status, rows_returned, cost_usd from mission_calls where mission_id = :mission_id and coalesce(rows_returned, 0) = 0 order by created_at;

-- 5. every company / item comes from a recorded call (benchmarks 8 and 9): the calls the mission made, by endpoint
select endpoint_id, phase, count(*) as calls, sum(coalesce(rows_returned, 0)) as rows from mission_calls where mission_id = :mission_id group by 1, 2 order by 2, 1;

-- 6. no mission running right now (a merge condition)
select status, count(*) from missions where status in ('queued', 'planning', 'approved', 'executing') group by status;
