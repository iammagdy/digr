-- ROLLBACK of 07. Nothing depends on it except the «آخر طلب ناجح» line of the admin table, which then says the figure is unavailable; the call path is unaffected.
DROP FUNCTION IF EXISTS public.treg_pool_call_health();
