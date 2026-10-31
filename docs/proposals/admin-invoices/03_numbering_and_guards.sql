-- ADMIN INVOICES, part 3 of 5. PROPOSAL, NOT APPLIED. ADDITIVE ONLY: trigger functions and triggers on the new tables (needs parts 01 and 02).
-- The database, not the app, enforces: the number, the lock after «مرسلة», the allowed status changes, no deletes, an append-only event log.
-- The status functions of part 04 turn the transaction-local setting app.invoice_fn on; nothing else is expected to.

-- 1. Numbers: INV-2026-0001 / QUO-2026-0001. The counter only goes up (a number is never reused; a rolled-back insert leaves at most a gap).
CREATE OR REPLACE FUNCTION public.invoice_assign_number() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_year integer := extract(year FROM (now() AT TIME ZONE 'Africa/Cairo'))::integer;
  v_n integer;
BEGIN
  INSERT INTO public.invoice_number_counters AS c (doc_type, year, last_value) VALUES (NEW.doc_type, v_year, 1)
  ON CONFLICT (doc_type, year) DO UPDATE SET last_value = c.last_value + 1
  RETURNING c.last_value INTO v_n;
  NEW.number := (CASE NEW.doc_type WHEN 'invoice' THEN 'INV' ELSE 'QUO' END) || '-' || v_year::text || '-'
    || (CASE WHEN v_n < 10000 THEN lpad(v_n::text, 4, '0') ELSE v_n::text END);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS invoice_documents_number ON public.invoice_documents;
CREATE TRIGGER invoice_documents_number BEFORE INSERT ON public.invoice_documents FOR EACH ROW EXECUTE FUNCTION public.invoice_assign_number();

-- 2. A document: fixed fields never change, status changes only through the functions, and after «مسودة» nothing but the status fields may change.
CREATE OR REPLACE FUNCTION public.invoice_documents_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_fn boolean := coalesce(current_setting('app.invoice_fn', true), '') = 'on';
  v_skip text[] := ARRAY['status', 'paid_at', 'payment_reference', 'updated_at', 'updated_by', 'revision'];
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.number IS DISTINCT FROM OLD.number OR NEW.doc_type IS DISTINCT FROM OLD.doc_type
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.converted_from_id IS DISTINCT FROM OLD.converted_from_id OR NEW.duplicated_from_id IS DISTINCT FROM OLD.duplicated_from_id THEN
    RAISE EXCEPTION 'invoice_immutable_field';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT v_fn THEN RAISE EXCEPTION 'invoice_status_via_function_only'; END IF;
    IF NOT ((OLD.status, NEW.status) IN (('draft', 'sent'), ('draft', 'void'), ('sent', 'paid'), ('sent', 'void'))) THEN
      RAISE EXCEPTION 'invoice_bad_transition';
    END IF;
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NOT v_fn OR (to_jsonb(NEW) - v_skip) IS DISTINCT FROM (to_jsonb(OLD) - v_skip) THEN RAISE EXCEPTION 'invoice_locked'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS invoice_documents_guard_t ON public.invoice_documents;
CREATE TRIGGER invoice_documents_guard_t BEFORE UPDATE ON public.invoice_documents FOR EACH ROW EXECUTE FUNCTION public.invoice_documents_guard();

CREATE OR REPLACE FUNCTION public.invoice_never_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
BEGIN RAISE EXCEPTION 'invoice_never_deleted'; END $$;
DROP TRIGGER IF EXISTS invoice_documents_no_delete ON public.invoice_documents;
CREATE TRIGGER invoice_documents_no_delete BEFORE DELETE ON public.invoice_documents FOR EACH ROW EXECUTE FUNCTION public.invoice_never_delete();
DROP TRIGGER IF EXISTS invoice_documents_no_truncate ON public.invoice_documents;
CREATE TRIGGER invoice_documents_no_truncate BEFORE TRUNCATE ON public.invoice_documents FOR EACH STATEMENT EXECUTE FUNCTION public.invoice_never_delete();
DROP TRIGGER IF EXISTS invoice_counters_no_delete ON public.invoice_number_counters;
CREATE TRIGGER invoice_counters_no_delete BEFORE DELETE ON public.invoice_number_counters FOR EACH ROW EXECUTE FUNCTION public.invoice_never_delete();
DROP TRIGGER IF EXISTS invoice_counters_no_truncate ON public.invoice_number_counters;
CREATE TRIGGER invoice_counters_no_truncate BEFORE TRUNCATE ON public.invoice_number_counters FOR EACH STATEMENT EXECUTE FUNCTION public.invoice_never_delete();

-- 3. Lines and batches can change only while their document is a draft (and never move to another document).
CREATE OR REPLACE FUNCTION public.invoice_children_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_doc uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
  v_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.document_id IS DISTINCT FROM OLD.document_id THEN RAISE EXCEPTION 'invoice_immutable_field'; END IF;
  SELECT status INTO v_status FROM public.invoice_documents WHERE id = v_doc;
  IF v_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'invoice_locked'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS invoice_lines_guard ON public.invoice_lines;
CREATE TRIGGER invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_lines FOR EACH ROW EXECUTE FUNCTION public.invoice_children_guard();
DROP TRIGGER IF EXISTS invoice_batches_guard ON public.invoice_batches;
CREATE TRIGGER invoice_batches_guard BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_batches FOR EACH ROW EXECUTE FUNCTION public.invoice_children_guard();

-- 4. The status log is append-only.
CREATE OR REPLACE FUNCTION public.invoice_events_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
BEGIN RAISE EXCEPTION 'invoice_events_append_only'; END $$;
DROP TRIGGER IF EXISTS invoice_events_no_change ON public.invoice_status_events;
CREATE TRIGGER invoice_events_no_change BEFORE UPDATE OR DELETE ON public.invoice_status_events FOR EACH ROW EXECUTE FUNCTION public.invoice_events_append_only();
DROP TRIGGER IF EXISTS invoice_events_no_truncate ON public.invoice_status_events;
CREATE TRIGGER invoice_events_no_truncate BEFORE TRUNCATE ON public.invoice_status_events FOR EACH STATEMENT EXECUTE FUNCTION public.invoice_events_append_only();
