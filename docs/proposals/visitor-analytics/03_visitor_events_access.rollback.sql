-- ROLLBACK of step 3. NOT APPLIED. It does NOT give anon or authenticated anything back (the table must never be open to them).
-- It only removes the grant to service_role and turns RLS off again, which returns the table to «nobody but the owner of the table can use it».
-- To remove the table altogether, run the rollback of step 1 instead.
REVOKE ALL ON TABLE public.visitor_events FROM service_role;
ALTER TABLE public.visitor_events DISABLE ROW LEVEL SECURITY;
