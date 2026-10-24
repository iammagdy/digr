-- STEP 3 of 3: who may touch the table. NOT APPLIED. Apply after 01 (and 02).
-- Only the server's service_role reads or writes visit records. anon, authenticated and PUBLIC get nothing, and there is NO policy, so RLS refuses them too.
-- DELETE is granted to service_role so the owner can purge old rows by hand when a retention period is chosen (no function or schedule is created here).

ALTER TABLE public.visitor_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.visitor_events FROM PUBLIC;
REVOKE ALL ON TABLE public.visitor_events FROM anon;
REVOKE ALL ON TABLE public.visitor_events FROM authenticated;
REVOKE ALL ON SEQUENCE public.visitor_events_id_seq FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.visitor_events_id_seq FROM anon;
REVOKE ALL ON SEQUENCE public.visitor_events_id_seq FROM authenticated;

GRANT SELECT, INSERT, DELETE ON TABLE public.visitor_events TO service_role;
