-- ADMIN INVOICES, part 5 of 5. PROPOSAL, NOT APPLIED. Security for the new tables and functions only (needs parts 01 to 04). Nothing existing is changed.
-- RLS is on and there is NO policy for anon or authenticated, so a customer reads and writes nothing; all privileges are taken from them and from PUBLIC.
-- Only service_role (the app's server routes, after their own admin check) may use them, and it may only READ the document tables:
-- every document, batch, line and status-log write goes through the functions of part 04.

ALTER TABLE public.invoice_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_item_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_status_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.invoice_settings, public.invoice_item_types, public.invoice_clients, public.invoice_number_counters,
  public.invoice_documents, public.invoice_batches, public.invoice_lines, public.invoice_status_events FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.invoice_settings, public.invoice_item_types, public.invoice_clients, public.invoice_number_counters,
  public.invoice_documents, public.invoice_batches, public.invoice_lines, public.invoice_status_events TO service_role;
GRANT INSERT, UPDATE ON TABLE public.invoice_settings, public.invoice_item_types, public.invoice_clients TO service_role;

-- On this project a new function in public is executable by anon, authenticated and service_role by default (pg_default_acl), and by PUBLIC in Postgres itself,
-- so EVERY invoice function is revoked from all four. Then only the three runtime functions are granted back, to service_role alone.
-- The seven others (two helpers, five trigger functions) run only inside the three runtime functions (as their owner) or as triggers: nobody else may call them.
REVOKE ALL ON FUNCTION public.invoice_create_document(uuid, text, jsonb, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice_save_draft(uuid, uuid, integer, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice_set_status(uuid, uuid, text, integer, jsonb, date, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice__apply_fields(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice__replace_children(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice_assign_number() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice_documents_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice_never_delete() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice_children_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice_events_append_only() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_create_document(uuid, text, jsonb, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoice_save_draft(uuid, uuid, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoice_set_status(uuid, uuid, text, integer, jsonb, date, text, text) TO service_role;
