-- 04_report_open_groups.sql
-- Report on open job groups. Read-only: ONE final SELECT (no writes, no BEGIN/ROLLBACK), safe to run at any time. Never errors:
-- the driver heartbeat table is only read when it exists.
-- Paste into the Supabase SQL Editor. Result columns: section | group_id | user_id | part_index | job_id | status | current_cursor |
--   lease_until | updated_at | last_attempt_at | closing_notice_at | points_still_held | overdue | wait | close_reason |
--   driver_silence | detail.
-- Rows:
--   R0: summary        FIRST row. status 'WAIT' = at least one part is awaiting freeze -> do NOT run 03 yet; run this file again every
--                      minute or two until the first row says 'OK_TO_RUN_03'. status 'OK_TO_RUN_03' = no part awaits a freeze.
--   R1: open_groups    one row per open group (its current part). wait = 'WAIT awaiting freeze - do not run 03' when the part's status
--                      is 'running' and its current_cursor is 'completed' (its rows are collected and about to be frozen and
--                      delivered; 03 would release it and throw the rows away).
--   R3: unfrozen_completed_parts   completed parts with delivered units and no frozen copy: must always be empty; any row is a bug, report it.
--   R2: driver_heartbeat           'not_installed' when the table does not exist (not an error), else the time since the last tick.
-- overdue = true: the group is more than 2 h 15 min past its deadline: the driver or the database is failing.

WITH r1 AS (
  SELECT
    'R1: open_groups'::text AS section,
    g.id::text AS group_id,
    g.user_id::text AS user_id,
    (g.next_part - 1)::int AS part_index,
    p.job_id::text AS job_id,
    j.status::text AS status,
    j.current_cursor::text AS current_cursor,
    j.lease_until::timestamptz AS lease_until,
    j.updated_at::timestamptz AS updated_at,
    g.last_attempt_at::timestamptz AS last_attempt_at,
    g.closing_notice_at::timestamptz AS closing_notice_at,
    ((g.hold_credits - g.drawn_credits) + CASE WHEN j.status IN ('queued','running') THEN j.reserved_credits ELSE 0 END)::numeric AS points_still_held,
    (now() >= g.deadline_at + interval '2 hours 15 minutes')::boolean AS overdue,
    (CASE WHEN j.status = 'running' AND j.current_cursor = 'completed' THEN 'WAIT awaiting freeze - do not run 03' ELSE NULL END)::text AS wait,
    NULL::text AS close_reason,
    NULL::text AS driver_silence,
    ('created: ' || g.created_at::text || ', deadline: ' || g.deadline_at::text || ', past: ' || (now() - g.deadline_at)::text)::text AS detail
  FROM public.job_groups g
  JOIN public.job_group_parts p ON p.group_id = g.id AND p.part_index = g.next_part - 1
  JOIN public.jobs j ON j.id = p.job_id
  WHERE g.status = 'open'
),
r3 AS (
  SELECT
    'R3: unfrozen_completed_parts'::text AS section,
    p.group_id::text AS group_id,
    NULL::text AS user_id,
    p.part_index::int AS part_index,
    j.id::text AS job_id,
    j.status::text AS status,
    j.current_cursor::text AS current_cursor,
    NULL::timestamptz AS lease_until,
    NULL::timestamptz AS updated_at,
    NULL::timestamptz AS last_attempt_at,
    NULL::timestamptz AS closing_notice_at,
    NULL::numeric AS points_still_held,
    NULL::boolean AS overdue,
    NULL::text AS wait,
    COALESCE(g.close_reason, 'none')::text AS close_reason,
    NULL::text AS driver_silence,
    ('delivered: ' || j.delivered_units::text || ', charged: ' || j.charged_credits::text)::text AS detail
  FROM public.job_group_parts p
  JOIN public.jobs j ON j.id = p.job_id
  JOIN public.job_groups g ON g.id = p.group_id
  WHERE j.status = 'completed'
    AND j.delivered_units > 0
    AND NOT EXISTS (
      SELECT 1 FROM public.job_group_frozen f
      WHERE f.group_id = p.group_id
        AND f.part_index = p.part_index
    )
),
r2 AS (
  SELECT
    'R2: driver_heartbeat'::text AS section,
    NULL::text AS group_id,
    NULL::text AS user_id,
    NULL::int AS part_index,
    NULL::text AS job_id,
    CASE
      WHEN to_regclass('public.driver_heartbeat') IS NULL THEN 'not_installed'
      ELSE 'installed'
    END::text AS status,
    NULL::text AS current_cursor,
    NULL::timestamptz AS lease_until,
    NULL::timestamptz AS updated_at,
    NULL::timestamptz AS last_attempt_at,
    NULL::timestamptz AS closing_notice_at,
    NULL::numeric AS points_still_held,
    NULL::boolean AS overdue,
    NULL::text AS wait,
    NULL::text AS close_reason,
    CASE
      WHEN to_regclass('public.driver_heartbeat') IS NOT NULL THEN
        (xpath('//driver_silence/text()', query_to_xml('SELECT (now() - last_tick_at)::text AS driver_silence FROM public.driver_heartbeat WHERE id = 1', true, false, '')))[1]::text
      ELSE NULL
    END::text AS driver_silence,
    CASE
      WHEN to_regclass('public.driver_heartbeat') IS NULL THEN 'driver_heartbeat: not installed'
      ELSE
        COALESCE(
          (xpath('//detail/text()', query_to_xml('SELECT (''last_tick: '' || last_tick_at::text)::text AS detail FROM public.driver_heartbeat WHERE id = 1', true, false, '')))[1]::text,
          'driver_heartbeat: empty'
        )
    END::text AS detail
),
r0 AS (
  SELECT
    'R0: summary'::text AS section,
    NULL::text AS group_id,
    NULL::text AS user_id,
    NULL::int AS part_index,
    NULL::text AS job_id,
    (CASE WHEN count(*) FILTER (WHERE wait IS NOT NULL) > 0 THEN 'WAIT' ELSE 'OK_TO_RUN_03' END)::text AS status,
    NULL::text AS current_cursor,
    NULL::timestamptz AS lease_until,
    NULL::timestamptz AS updated_at,
    NULL::timestamptz AS last_attempt_at,
    NULL::timestamptz AS closing_notice_at,
    NULL::numeric AS points_still_held,
    NULL::boolean AS overdue,
    (CASE WHEN count(*) FILTER (WHERE wait IS NOT NULL) > 0
          THEN 'WAIT awaiting freeze - do not run 03' ELSE NULL END)::text AS wait,
    NULL::text AS close_reason,
    NULL::text AS driver_silence,
    (CASE WHEN count(*) FILTER (WHERE wait IS NOT NULL) > 0
          THEN count(*) FILTER (WHERE wait IS NOT NULL)::text || ' part(s) awaiting freeze: do NOT run 03; run this file again in 1-2 minutes until this row says OK_TO_RUN_03'
          ELSE 'no part is awaiting freeze (' || count(*)::text || ' open group(s))' END)::text AS detail
  FROM r1
)
SELECT section, group_id, user_id, part_index, job_id, status, current_cursor,
       lease_until, updated_at, last_attempt_at, closing_notice_at,
       points_still_held, overdue, wait, close_reason, driver_silence, detail
FROM (
  SELECT * FROM r0
  UNION ALL
  SELECT * FROM r1
  UNION ALL
  SELECT * FROM r3
  UNION ALL
  SELECT * FROM r2
) combined
ORDER BY
  CASE
    WHEN section LIKE 'R0%' THEN 0
    WHEN section LIKE 'R1%' THEN 1
    WHEN section LIKE 'R3%' THEN 2
    ELSE 3
  END,
  group_id NULLS LAST;
