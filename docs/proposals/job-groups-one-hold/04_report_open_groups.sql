-- 04_report_open_groups.sql
-- Diagnostic report for open job groups, completed-unfrozen parts, and driver heartbeat.
-- Safe to run at any time (READ ONLY transaction).

BEGIN TRANSACTION READ ONLY;

-- R1: Open groups and held points
SELECT g.id,
       g.user_id,
       g.created_at,
       g.deadline_at,
       now() - g.deadline_at AS past_deadline,
       (now() >= g.deadline_at + interval '2 hours 15 minutes') AS overdue,
       g.next_part - 1 AS current_part,
       j.status AS current_status,
       j.lease_until,
       j.updated_at,
       g.last_attempt_at,
       g.closing_notice_at,
       (g.hold_credits - g.drawn_credits) + CASE WHEN j.status IN ('queued','running') THEN j.reserved_credits ELSE 0 END AS points_still_held
FROM public.job_groups g
JOIN public.job_group_parts p ON p.group_id = g.id AND p.part_index = g.next_part - 1
JOIN public.jobs j ON j.id = p.job_id
WHERE g.status = 'open'
ORDER BY overdue DESC, g.deadline_at;

-- R3: Completed parts without frozen copy (must always be empty)
SELECT p.group_id,
       p.part_index,
       j.id,
       j.delivered_units,
       j.charged_credits,
       g.status,
       g.close_reason
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
ORDER BY g.status, p.group_id;

-- R2 (LAST): Driver heartbeat (may error if driver_heartbeat table not present)
SELECT last_tick_at,
       now() - last_tick_at AS driver_silence
FROM public.driver_heartbeat
WHERE id = 1;

ROLLBACK;
