-- ROLLBACK of step 1. NOT APPLIED. Drops the table and every visit record in it (nothing else depends on it: no money table, no function, no foreign key).
-- Run the rollbacks in the order 03, 02, 01. The site keeps working without the table: the beacon route drops what it cannot store and the admin screen says the tracking is not enabled.
DROP TABLE IF EXISTS public.visitor_events;
