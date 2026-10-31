-- ADMIN INVOICES (quotes and invoices for hand-made research work): one file with the same SQL as docs/proposals/admin-invoices/01..05, in order.
-- NOT APPLIED by the agent that wrote it. The owner applies it (in five small parts from docs/proposals/admin-invoices/, or this file in one piece) in the
-- Supabase SQL editor, AFTER downloading /admin/export (the free plan has no backups), then runs 98_verify_after_apply.sql (one read-only SELECT).
-- Separate from the points wallet: no object here references credit_ledger, balances, missions, reserves or charges.

-- ADMIN INVOICES, part 1 of 5. PROPOSAL, NOT APPLIED. ADDITIVE ONLY: three new tables. Nothing existing is read, altered or dropped.
-- Run the parts in order (01 to 05), each one on its own in the Supabase SQL editor. Download /admin/export BEFORE applying (the free plan has no backups).
-- This feature is separate from the points wallet: no table here references credit_ledger, balances, missions, reserves or charges.

-- Seller text printed on every document (the owner edits it from the admin page). Tax / commercial-register lines print only when filled.
CREATE TABLE IF NOT EXISTS public.invoice_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  seller_name_ar text NOT NULL DEFAULT 'ديجر' CHECK (char_length(seller_name_ar) BETWEEN 1 AND 120),
  seller_email text NOT NULL DEFAULT 'support@diger.tech' CHECK (char_length(seller_email) <= 200),
  seller_website text NOT NULL DEFAULT 'diger.tech' CHECK (char_length(seller_website) <= 200),
  seller_tax_number text CHECK (seller_tax_number IS NULL OR char_length(seller_tax_number) <= 60),
  seller_commercial_register text CHECK (seller_commercial_register IS NULL OR char_length(seller_commercial_register) <= 60),
  -- the last exchange rate the owner typed (EGP per USD x 10,000): only a convenience to prefill the next document
  last_rate_egp_per_usd_e4 bigint CHECK (last_rate_egp_per_usd_e4 IS NULL OR last_rate_egp_per_usd_e4 BETWEEN 10000 AND 10000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
INSERT INTO public.invoice_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- The owner's item types. The default price is the owner's SALE price in hundredths of a cent (45 = 0.45 cent). Never a cost.
CREATE TABLE IF NOT EXISTS public.invoice_item_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_ar text NOT NULL CHECK (char_length(btrim(name_ar)) BETWEEN 1 AND 80),
  default_unit_price_usd_centi_cents bigint NOT NULL DEFAULT 0 CHECK (default_unit_price_usd_centi_cents BETWEEN 0 AND 100000000),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS invoice_item_types_name_uq ON public.invoice_item_types (lower(btrim(name_ar)));
-- the four starting types, price 0 until the owner sets his own sale prices
INSERT INTO public.invoice_item_types (name_ar, sort_order) VALUES
  ('شركة', 1), ('مدير', 2), ('بريد إلكتروني', 3), ('رقم هاتف', 4)
ON CONFLICT DO NOTHING;

-- Saved clients (reusable). A document copies the client's text, so editing a client never changes an issued document.
CREATE TABLE IF NOT EXISTS public.invoice_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL CHECK (char_length(btrim(company_name)) BETWEEN 1 AND 160),
  contact_name text NOT NULL DEFAULT '' CHECK (char_length(contact_name) <= 160),
  email text NOT NULL DEFAULT '' CHECK (char_length(email) <= 200),
  phone text NOT NULL DEFAULT '' CHECK (char_length(phone) <= 60),
  address text NOT NULL DEFAULT '' CHECK (char_length(address) <= 400),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 1000),
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

-- ADMIN INVOICES, part 2 of 5. PROPOSAL, NOT APPLIED. ADDITIVE ONLY: five new tables (needs part 01). Money is stored as INTEGERS only:
--   unit price  = hundredths of a US cent (bigint)      line total = USD cents (bigint)      points = whole points      EGP = qirsh (1/100 EGP)
--   exchange rate = EGP per USD x 10,000 (bigint)       point value = EGP x 10,000 (1000 = 0.10 EGP)      percent = basis points (1000 = 10%)
-- No float, numeric or money column exists in this feature.

-- Gap-tolerant, never-reused numbering: one counter per document type and year. Only the trigger of part 03 touches it.
CREATE TABLE IF NOT EXISTS public.invoice_number_counters (
  id bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  doc_type text NOT NULL CHECK (doc_type IN ('quote', 'invoice')),
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  last_value integer NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_type, year)
);

CREATE TABLE IF NOT EXISTS public.invoice_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type text NOT NULL CHECK (doc_type IN ('quote', 'invoice')),
  number text NOT NULL UNIQUE,                       -- INV-2026-0001 / QUO-2026-0001, written by the trigger of part 03, never by the app or a model
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  revision integer NOT NULL DEFAULT 1,               -- +1 on every draft save: a stale screen cannot overwrite or issue a newer draft
  client_id uuid REFERENCES public.invoice_clients (id) ON DELETE RESTRICT,
  client_company text NOT NULL DEFAULT '' CHECK (char_length(client_company) <= 160),
  client_contact text NOT NULL DEFAULT '' CHECK (char_length(client_contact) <= 160),
  client_email text NOT NULL DEFAULT '' CHECK (char_length(client_email) <= 200),
  client_phone text NOT NULL DEFAULT '' CHECK (char_length(client_phone) <= 60),
  client_address text NOT NULL DEFAULT '' CHECK (char_length(client_address) <= 400),
  issue_date date NOT NULL DEFAULT ((now() AT TIME ZONE 'Africa/Cairo')::date),
  due_date date,
  show_usd boolean NOT NULL DEFAULT true,
  show_points boolean NOT NULL DEFAULT false,
  show_egp boolean NOT NULL DEFAULT false,
  rate_egp_per_usd_e4 bigint CHECK (rate_egp_per_usd_e4 IS NULL OR rate_egp_per_usd_e4 BETWEEN 10000 AND 10000000),
  credit_value_e4 integer NOT NULL DEFAULT 1000 CHECK (credit_value_e4 BETWEEN 100 AND 100000),
  discount_kind text NOT NULL DEFAULT 'none' CHECK (discount_kind IN ('none', 'amount', 'percent')),
  discount_value bigint NOT NULL DEFAULT 0 CHECK (discount_value >= 0),      -- USD cents for 'amount', basis points for 'percent'
  tax_enabled boolean NOT NULL DEFAULT false,
  tax_label text NOT NULL DEFAULT 'ضريبة' CHECK (char_length(tax_label) BETWEEN 1 AND 60),
  tax_bp integer NOT NULL DEFAULT 0 CHECK (tax_bp BETWEEN 0 AND 10000),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
  payment_instructions text NOT NULL DEFAULT '' CHECK (char_length(payment_instructions) <= 2000),
  instapay_address text NOT NULL DEFAULT '' CHECK (char_length(instapay_address) <= 120),   -- copied from the admin settings when the draft is saved
  show_instapay_qr boolean NOT NULL DEFAULT true,
  paid_at date,
  payment_reference text NOT NULL DEFAULT '' CHECK (char_length(payment_reference) <= 200),
  converted_from_id uuid REFERENCES public.invoice_documents (id) ON DELETE RESTRICT,
  duplicated_from_id uuid REFERENCES public.invoice_documents (id) ON DELETE RESTRICT,
  -- frozen when the document is issued (status 'sent'): the same numbers the PDF and PNG show, from then on
  subtotal_usd_cents bigint, discount_usd_cents bigint, tax_usd_cents bigint, total_usd_cents bigint,
  subtotal_points bigint, discount_points bigint, tax_points bigint, total_points bigint,
  subtotal_egp_qirsh bigint, discount_egp_qirsh bigint, tax_egp_qirsh bigint, total_egp_qirsh bigint,
  locked_at timestamptz,
  created_by uuid REFERENCES auth.users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT invoice_documents_one_currency CHECK (show_usd OR show_points OR show_egp),
  CONSTRAINT invoice_documents_rate_needed CHECK (NOT (show_points OR show_egp) OR rate_egp_per_usd_e4 IS NOT NULL),
  CONSTRAINT invoice_documents_discount_ok CHECK ((discount_kind = 'none' AND discount_value = 0) OR (discount_kind = 'amount') OR (discount_kind = 'percent' AND discount_value <= 10000)),
  CONSTRAINT invoice_documents_dates_ok CHECK (due_date IS NULL OR due_date >= issue_date),
  CONSTRAINT invoice_documents_frozen CHECK (status IN ('draft', 'void') OR (total_usd_cents IS NOT NULL AND locked_at IS NOT NULL)),  -- a voided draft was never frozen
  CONSTRAINT invoice_documents_paid_date CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS invoice_documents_status_idx ON public.invoice_documents (status, created_at DESC);
CREATE INDEX IF NOT EXISTS invoice_documents_client_idx ON public.invoice_documents (client_id);

CREATE TABLE IF NOT EXISTS public.invoice_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.invoice_documents (id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  sort_order integer NOT NULL,
  summary_only boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, document_id)
);
CREATE INDEX IF NOT EXISTS invoice_batches_doc_idx ON public.invoice_batches (document_id, sort_order);

CREATE TABLE IF NOT EXISTS public.invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.invoice_documents (id) ON DELETE RESTRICT,
  batch_id uuid,
  sort_order integer NOT NULL,
  item_type_id uuid REFERENCES public.invoice_item_types (id) ON DELETE RESTRICT,
  item_type_name text NOT NULL DEFAULT '' CHECK (char_length(item_type_name) <= 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  quantity bigint NOT NULL CHECK (quantity BETWEEN 1 AND 10000000),
  unit_price_usd_centi_cents bigint NOT NULL CHECK (unit_price_usd_centi_cents BETWEEN 0 AND 100000000),
  -- round_half_up(quantity x unit / 100), once per line: bigint division truncates, so +50 rounds .5 up
  line_total_usd_cents bigint GENERATED ALWAYS AS (((quantity * unit_price_usd_centi_cents) + 50) / 100) STORED,
  hidden boolean NOT NULL DEFAULT false,
  line_total_points bigint,        -- frozen at issue
  line_total_egp_qirsh bigint,     -- frozen at issue
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (batch_id, document_id) REFERENCES public.invoice_batches (id, document_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS invoice_lines_doc_idx ON public.invoice_lines (document_id, sort_order);

-- Every status change, append-only (part 03 blocks UPDATE, DELETE and TRUNCATE; part 05 takes the privileges away).
CREATE TABLE IF NOT EXISTS public.invoice_status_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES public.invoice_documents (id) ON DELETE RESTRICT,
  from_status text,
  to_status text NOT NULL CHECK (to_status IN ('draft', 'sent', 'paid', 'void')),
  admin_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  paid_at date,
  payment_reference text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoice_status_events_doc_idx ON public.invoice_status_events (document_id, id);

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

-- ADMIN INVOICES, part 4 of 5. PROPOSAL, NOT APPLIED. ADDITIVE ONLY: five functions (needs parts 01 to 03). They are the ONLY way the app writes a document,
-- its batches, its lines or its status log: each call is one transaction that takes the document row FOR UPDATE first.
-- They read and write only the invoice_* tables: no wallet, ledger, balance, mission, reserve or charge table is touched, and marking a document
-- paid only records the date and a reference (it never credits points).

-- helper: copy the document fields of the payload onto a DRAFT document
CREATE OR REPLACE FUNCTION public.invoice__apply_fields(p_id uuid, p_payload jsonb) RETURNS void
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  UPDATE public.invoice_documents SET
    client_id = nullif(p_payload->>'client_id', '')::uuid,
    client_company = coalesce(p_payload->>'client_company', ''),
    client_contact = coalesce(p_payload->>'client_contact', ''),
    client_email = coalesce(p_payload->>'client_email', ''),
    client_phone = coalesce(p_payload->>'client_phone', ''),
    client_address = coalesce(p_payload->>'client_address', ''),
    issue_date = coalesce(nullif(p_payload->>'issue_date', '')::date, issue_date),
    due_date = nullif(p_payload->>'due_date', '')::date,
    show_usd = coalesce((p_payload->>'show_usd')::boolean, show_usd),
    show_points = coalesce((p_payload->>'show_points')::boolean, show_points),
    show_egp = coalesce((p_payload->>'show_egp')::boolean, show_egp),
    rate_egp_per_usd_e4 = nullif(p_payload->>'rate_egp_per_usd_e4', '')::bigint,
    credit_value_e4 = coalesce((p_payload->>'credit_value_e4')::integer, credit_value_e4),
    discount_kind = coalesce(p_payload->>'discount_kind', 'none'),
    discount_value = coalesce((p_payload->>'discount_value')::bigint, 0),
    tax_enabled = coalesce((p_payload->>'tax_enabled')::boolean, false),
    tax_label = coalesce(nullif(p_payload->>'tax_label', ''), 'ضريبة'),
    tax_bp = coalesce((p_payload->>'tax_bp')::integer, 0),
    notes = coalesce(p_payload->>'notes', ''),
    payment_instructions = coalesce(p_payload->>'payment_instructions', ''),
    instapay_address = coalesce(p_payload->>'instapay_address', ''),
    show_instapay_qr = coalesce((p_payload->>'show_instapay_qr')::boolean, true)
  WHERE id = p_id;
END $$;

-- helper: replace the batches and lines of a DRAFT document with the payload's (at most 50 batches and 500 lines)
CREATE OR REPLACE FUNCTION public.invoice__replace_children(p_doc uuid, p_payload jsonb) RETURNS void
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  b jsonb; l jsonb; v_map jsonb := '{}'::jsonb; v_id uuid; v_i integer := 0; v_batch uuid;
BEGIN
  IF jsonb_array_length(coalesce(p_payload->'batches', '[]'::jsonb)) > 50 OR jsonb_array_length(coalesce(p_payload->'lines', '[]'::jsonb)) > 500 THEN
    RAISE EXCEPTION 'invoice_too_large';
  END IF;
  DELETE FROM public.invoice_lines WHERE document_id = p_doc;
  DELETE FROM public.invoice_batches WHERE document_id = p_doc;
  FOR b IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'batches', '[]'::jsonb)) LOOP
    v_i := v_i + 1;
    INSERT INTO public.invoice_batches (document_id, title, sort_order, summary_only)
    VALUES (p_doc, b->>'title', v_i, coalesce((b->>'summary_only')::boolean, false)) RETURNING id INTO v_id;
    v_map := v_map || jsonb_build_object(b->>'key', v_id::text);
  END LOOP;
  v_i := 0;
  FOR l IN SELECT * FROM jsonb_array_elements(coalesce(p_payload->'lines', '[]'::jsonb)) LOOP
    v_i := v_i + 1;
    v_batch := NULL;
    IF nullif(l->>'batch_key', '') IS NOT NULL THEN
      v_batch := nullif(v_map->>(l->>'batch_key'), '')::uuid;
      IF v_batch IS NULL THEN RAISE EXCEPTION 'invoice_unknown_batch'; END IF;
    END IF;
    INSERT INTO public.invoice_lines (document_id, batch_id, sort_order, item_type_id, item_type_name, description, quantity, unit_price_usd_centi_cents, hidden)
    VALUES (p_doc, v_batch, v_i, nullif(l->>'item_type_id', '')::uuid, coalesce(l->>'item_type_name', ''), coalesce(l->>'description', ''),
            (l->>'quantity')::bigint, (l->>'unit_price_usd_centi_cents')::bigint, coalesce((l->>'hidden')::boolean, false));
  END LOOP;
END $$;

-- a new draft (also used for «convert quote to invoice» and «duplicate»: the app builds the payload from the source and passes the source id)
CREATE OR REPLACE FUNCTION public.invoice_create_document(p_admin uuid, p_type text, p_payload jsonb, p_converted_from uuid DEFAULT NULL, p_duplicated_from uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM set_config('app.invoice_fn', 'on', true);
  IF p_admin IS NULL THEN RAISE EXCEPTION 'invoice_admin_required'; END IF;
  INSERT INTO public.invoice_documents (doc_type, number, created_by, updated_by, converted_from_id, duplicated_from_id)
  VALUES (p_type, '', p_admin, p_admin, p_converted_from, p_duplicated_from) RETURNING id INTO v_id;
  PERFORM public.invoice__apply_fields(v_id, p_payload);
  PERFORM public.invoice__replace_children(v_id, p_payload);
  INSERT INTO public.invoice_status_events (document_id, from_status, to_status, admin_id, note)
  VALUES (v_id, NULL, 'draft', p_admin, CASE WHEN p_converted_from IS NOT NULL THEN 'converted_from_quote' WHEN p_duplicated_from IS NOT NULL THEN 'duplicated' ELSE 'created' END);
  RETURN v_id;
END $$;

-- save a draft (whole document at once); a stale screen (older revision) is refused. Returns the new revision.
CREATE OR REPLACE FUNCTION public.invoice_save_draft(p_id uuid, p_admin uuid, p_expected_revision integer, p_payload jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_doc public.invoice_documents%ROWTYPE;
BEGIN
  PERFORM set_config('app.invoice_fn', 'on', true);
  IF p_admin IS NULL THEN RAISE EXCEPTION 'invoice_admin_required'; END IF;
  SELECT * INTO v_doc FROM public.invoice_documents WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
  IF v_doc.status <> 'draft' THEN RAISE EXCEPTION 'invoice_locked'; END IF;
  IF p_expected_revision IS DISTINCT FROM v_doc.revision THEN RAISE EXCEPTION 'invoice_stale'; END IF;
  PERFORM public.invoice__apply_fields(p_id, p_payload);
  PERFORM public.invoice__replace_children(p_id, p_payload);
  UPDATE public.invoice_documents SET revision = revision + 1, updated_at = now(), updated_by = p_admin WHERE id = p_id;
  RETURN v_doc.revision + 1;
END $$;

-- the only way a status changes. «sent» freezes the numbers the app computed (the function re-checks the USD sum and the line count itself);
-- «paid» records the date and reference; «void» only voids. Each change writes its event with the admin id in the same transaction.
CREATE OR REPLACE FUNCTION public.invoice_set_status(
  p_id uuid, p_admin uuid, p_to text, p_expected_revision integer, p_frozen jsonb, p_paid_at date, p_reference text, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_doc public.invoice_documents%ROWTYPE; v_count integer; v_sum bigint; v_done integer; t jsonb;
BEGIN
  PERFORM set_config('app.invoice_fn', 'on', true);
  IF p_admin IS NULL THEN RAISE EXCEPTION 'invoice_admin_required'; END IF;
  SELECT * INTO v_doc FROM public.invoice_documents WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice_not_found'; END IF;
  IF NOT ((v_doc.status, p_to) IN (('draft', 'sent'), ('draft', 'void'), ('sent', 'paid'), ('sent', 'void'))) THEN
    RAISE EXCEPTION 'invoice_bad_transition';
  END IF;

  IF p_to = 'sent' THEN
    IF p_expected_revision IS DISTINCT FROM v_doc.revision THEN RAISE EXCEPTION 'invoice_stale'; END IF;
    t := p_frozen->'totals';
    IF t IS NULL THEN RAISE EXCEPTION 'invoice_frozen_required'; END IF;
    SELECT count(*), coalesce(sum(line_total_usd_cents), 0) INTO v_count, v_sum FROM public.invoice_lines WHERE document_id = p_id;
    IF v_count = 0 THEN RAISE EXCEPTION 'invoice_no_lines'; END IF;
    IF jsonb_array_length(coalesce(p_frozen->'lines', '[]'::jsonb)) <> v_count OR (t->>'subtotal_usd_cents')::bigint IS DISTINCT FROM v_sum THEN
      RAISE EXCEPTION 'invoice_stale';
    END IF;
    IF v_doc.rate_egp_per_usd_e4 IS NOT NULL AND (t->>'total_points' IS NULL OR t->>'total_egp_qirsh' IS NULL) THEN
      RAISE EXCEPTION 'invoice_frozen_required';
    END IF;
    UPDATE public.invoice_lines l SET line_total_points = f.points, line_total_egp_qirsh = f.egp, updated_at = now()
    FROM jsonb_to_recordset(p_frozen->'lines') AS f(id uuid, points bigint, egp bigint)
    WHERE l.id = f.id AND l.document_id = p_id;
    GET DIAGNOSTICS v_done = ROW_COUNT;
    IF v_done <> v_count THEN RAISE EXCEPTION 'invoice_stale'; END IF;
    UPDATE public.invoice_documents SET
      subtotal_usd_cents = (t->>'subtotal_usd_cents')::bigint, discount_usd_cents = (t->>'discount_usd_cents')::bigint,
      tax_usd_cents = (t->>'tax_usd_cents')::bigint, total_usd_cents = (t->>'total_usd_cents')::bigint,
      subtotal_points = (t->>'subtotal_points')::bigint, discount_points = (t->>'discount_points')::bigint,
      tax_points = (t->>'tax_points')::bigint, total_points = (t->>'total_points')::bigint,
      subtotal_egp_qirsh = (t->>'subtotal_egp_qirsh')::bigint, discount_egp_qirsh = (t->>'discount_egp_qirsh')::bigint,
      tax_egp_qirsh = (t->>'tax_egp_qirsh')::bigint, total_egp_qirsh = (t->>'total_egp_qirsh')::bigint,
      locked_at = now(), status = 'sent', updated_at = now(), updated_by = p_admin
    WHERE id = p_id;
  ELSIF p_to = 'paid' THEN
    IF p_paid_at IS NULL THEN RAISE EXCEPTION 'invoice_paid_date_required'; END IF;
    UPDATE public.invoice_documents SET status = 'paid', paid_at = p_paid_at, payment_reference = coalesce(p_reference, ''), updated_at = now(), updated_by = p_admin WHERE id = p_id;
  ELSE
    UPDATE public.invoice_documents SET status = 'void', updated_at = now(), updated_by = p_admin WHERE id = p_id;
  END IF;

  INSERT INTO public.invoice_status_events (document_id, from_status, to_status, admin_id, note, paid_at, payment_reference)
  VALUES (p_id, v_doc.status, p_to, p_admin, coalesce(p_note, ''), CASE WHEN p_to = 'paid' THEN p_paid_at END, CASE WHEN p_to = 'paid' THEN coalesce(p_reference, '') ELSE '' END);
END $$;

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

REVOKE ALL ON FUNCTION public.invoice_create_document(uuid, text, jsonb, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_save_draft(uuid, uuid, integer, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_set_status(uuid, uuid, text, integer, jsonb, date, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice__apply_fields(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice__replace_children(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_assign_number() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_documents_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_never_delete() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_children_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_events_append_only() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_create_document(uuid, text, jsonb, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoice_save_draft(uuid, uuid, integer, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.invoice_set_status(uuid, uuid, text, integer, jsonb, date, text, text) TO service_role;
