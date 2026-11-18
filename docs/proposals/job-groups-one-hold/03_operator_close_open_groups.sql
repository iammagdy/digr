-- 03_operator_close_open_groups.sql
-- Close all currently open job groups by operator.
--
-- OPERATOR PROCEDURE (Plain, Numbered Steps):
-- 1. Before running 03, run 04_report_open_groups.sql in Supabase SQL Editor.
-- 2. Check the FIRST row (R0: summary):
--    - It must say OK_TO_RUN_03.
--    - If it says WAIT, a part is awaiting freeze (R1 rows with a WAIT flag and current_cursor = completed):
--      do NOT run 03; run 04 again every 1-2 minutes until the first row says OK_TO_RUN_03.
-- 3. Run this script (03_operator_close_open_groups.sql) ONLY when no WAIT row remains (summary says OK_TO_RUN_03).
-- 4. Send the screenshot of each result to COMMANDER.

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
