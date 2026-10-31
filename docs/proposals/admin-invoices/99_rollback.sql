-- ROLLBACK of ADMIN INVOICES (parts 01 to 05). Run only if the feature is abandoned: it DELETES every quote, invoice, client and item type the owner entered.
-- Download /admin/export (the invoice tables are included) BEFORE running it. Nothing outside the invoice_* objects is touched.
DROP FUNCTION IF EXISTS public.invoice_set_status(uuid, uuid, text, integer, jsonb, date, text, text);
DROP FUNCTION IF EXISTS public.invoice_save_draft(uuid, uuid, integer, jsonb);
DROP FUNCTION IF EXISTS public.invoice_create_document(uuid, text, jsonb, uuid, uuid);
DROP FUNCTION IF EXISTS public.invoice__replace_children(uuid, jsonb);
DROP FUNCTION IF EXISTS public.invoice__apply_fields(uuid, jsonb);
DROP TABLE IF EXISTS public.invoice_status_events;
DROP TABLE IF EXISTS public.invoice_lines;
DROP TABLE IF EXISTS public.invoice_batches;
DROP TABLE IF EXISTS public.invoice_documents;
DROP TABLE IF EXISTS public.invoice_number_counters;
DROP TABLE IF EXISTS public.invoice_clients;
DROP TABLE IF EXISTS public.invoice_item_types;
DROP TABLE IF EXISTS public.invoice_settings;
DROP FUNCTION IF EXISTS public.invoice_events_append_only();
DROP FUNCTION IF EXISTS public.invoice_children_guard();
DROP FUNCTION IF EXISTS public.invoice_never_delete();
DROP FUNCTION IF EXISTS public.invoice_documents_guard();
DROP FUNCTION IF EXISTS public.invoice_assign_number();
