-- ROLLBACK of 06. Nothing depends on it except the health check and the admin's «فحص الآن» (they say «SQL 06 not applied» and the call path is unaffected).
DROP FUNCTION IF EXISTS public.treg_pool_keys_for_check(uuid[], integer);
