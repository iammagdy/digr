-- 04_report_open_groups.sql
-- Diagnostic report for open job groups, completed-unfrozen parts, and driver heartbeat.
-- Paste-ready in Supabase SQL Editor: single read-only SELECT combining R1, R3, and R2.

WITH r1 AS (
  SELECT
    'R1: open_groups'::text AS section,
    g.id::text AS group_id,
    g.user_id::text AS user_id,
    (g.next_part - 1)::int AS part_index,
    p.job_id::text AS job_id,
    j.status::text AS status,
    ((g.hold_credits - g.drawn_credits) + CASE WHEN j.status IN ('queued','running') THEN j.reserved_credits ELSE 0 END)::numeric AS points_still_held,
    (now() >= g.deadline_at + interval '2 hours 15 minutes')::boolean AS overdue,
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
    NULL::numeric AS points_still_held,
    NULL::boolean AS overdue,
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
    NULL::numeric AS points_still_held,
    NULL::boolean AS overdue,
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
)
SELECT section, group_id, user_id, part_index, job_id, status, points_still_held, overdue, close_reason, driver_silence, detail
FROM (
  SELECT * FROM r1
  UNION ALL
  SELECT * FROM r3
  UNION ALL
  SELECT * FROM r2
) combined
ORDER BY
  CASE
    WHEN section LIKE 'R1%' THEN 1
    WHEN section LIKE 'R3%' THEN 2
    ELSE 3
  END,
  group_id NULLS LAST;
