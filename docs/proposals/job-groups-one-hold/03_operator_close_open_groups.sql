-- 03_operator_close_open_groups.sql
-- Close all currently open job groups by operator.
-- Run 04_report_open_groups.sql first to ensure no parts are awaiting freeze.

SELECT g.id,
       r->>'delivered_total' AS delivered,
       g.asked_original AS asked,
       r->>'charged_total' AS charged,
       r->>'released_credits' AS released,
       r->>'final_line' AS final_line,
       r->>'part_released' AS stopped_running_part,
       r->>'error' AS not_closed_because
FROM public.job_groups g,
LATERAL public.close_job_group_atomic(
  g.id,
  'operator',
  NULL,
  NULL,
  NULL,
  'أوقفنا هذا الجزء من الطلب قبل اكتماله، ولم يُخصم عنه شيء، وما حُجز له حجز مؤقت مُحرَّر.'
) r
WHERE g.status = 'open'
ORDER BY g.id;
