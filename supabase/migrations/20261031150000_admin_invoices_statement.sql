-- ADMIN INVOICES, statement mode: the same SQL as docs/proposals/admin-invoices/06_statement_mode.sql, in one file. A DELTA on parts 01 to 05 (the migration 20261031120000_admin_invoices.sql, already applied).
-- NOT APPLIED by the agent that wrote it. The owner applies it in the Supabase SQL editor AFTER downloading /admin/export, then runs 98_verify_after_apply.sql (one read-only SELECT, 23 rows, ok = true).
-- Separate from the points wallet: no object here references credit_ledger, balances, missions, reserves or charges.

-- ADMIN INVOICES, part 6 of 6. PROPOSAL, NOT APPLIED. A DELTA on top of parts 01 to 05 (already applied): «بيان بيانات» (data statement): sectors and counts only, NO prices, NO totals.
-- Download /admin/export BEFORE applying. Additive: no table is dropped, no row is changed (there are no documents yet that this could touch), and the wallet is not involved.
-- It does five things:
--   1. the document type may also be 'statement' (documents and the number counters);
--   2. a statement carries no money, enforced by a table CHECK (dollars only, no rate, no discount, no tax);
--   3. numbering: STM-2026-0001 (the same per-type, per-year counter that never goes down);
--   4. only an INVOICE can be marked paid (a quote or a statement cannot, even by a direct call of the function);
--   5. a statement line must have price 0 (the function that writes lines refuses any other price).
-- The three replaced functions keep their owner, their fixed search_path and their privileges (CREATE OR REPLACE never resets them); the last lines re-assert them anyway.

ALTER TABLE public.invoice_documents DROP CONSTRAINT IF EXISTS invoice_documents_doc_type_check;
ALTER TABLE public.invoice_documents ADD CONSTRAINT invoice_documents_doc_type_check CHECK (doc_type IN ('quote', 'invoice', 'statement'));
ALTER TABLE public.invoice_number_counters DROP CONSTRAINT IF EXISTS invoice_number_counters_doc_type_check;
ALTER TABLE public.invoice_number_counters ADD CONSTRAINT invoice_number_counters_doc_type_check CHECK (doc_type IN ('quote', 'invoice', 'statement'));

ALTER TABLE public.invoice_documents DROP CONSTRAINT IF EXISTS invoice_documents_statement_no_money;
ALTER TABLE public.invoice_documents ADD CONSTRAINT invoice_documents_statement_no_money CHECK (
  doc_type <> 'statement'
  OR (discount_kind = 'none' AND discount_value = 0 AND NOT tax_enabled AND show_usd AND NOT show_points AND NOT show_egp AND rate_egp_per_usd_e4 IS NULL)
);

-- 3. numbering: INV / QUO / STM
CREATE OR REPLACE FUNCTION public.invoice_assign_number() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_year integer := extract(year FROM (now() AT TIME ZONE 'Africa/Cairo'))::integer;
  v_n integer;
BEGIN
  INSERT INTO public.invoice_number_counters AS c (doc_type, year, last_value) VALUES (NEW.doc_type, v_year, 1)
  ON CONFLICT (doc_type, year) DO UPDATE SET last_value = c.last_value + 1
  RETURNING c.last_value INTO v_n;
  NEW.number := (CASE NEW.doc_type WHEN 'invoice' THEN 'INV' WHEN 'statement' THEN 'STM' ELSE 'QUO' END) || '-' || v_year::text || '-'
    || (CASE WHEN v_n < 10000 THEN lpad(v_n::text, 4, '0') ELSE v_n::text END);
  RETURN NEW;
END $$;

-- 5. a statement line has price 0 (the rest of the function is exactly as in part 04)
CREATE OR REPLACE FUNCTION public.invoice__replace_children(p_doc uuid, p_payload jsonb) RETURNS void
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  b jsonb; l jsonb; v_map jsonb := '{}'::jsonb; v_id uuid; v_i integer := 0; v_batch uuid; v_type text;
BEGIN
  IF jsonb_array_length(coalesce(p_payload->'batches', '[]'::jsonb)) > 50 OR jsonb_array_length(coalesce(p_payload->'lines', '[]'::jsonb)) > 500 THEN
    RAISE EXCEPTION 'invoice_too_large';
  END IF;
  SELECT doc_type INTO v_type FROM public.invoice_documents WHERE id = p_doc;
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
    IF v_type = 'statement' AND (l->>'unit_price_usd_centi_cents')::bigint <> 0 THEN RAISE EXCEPTION 'invoice_statement_no_prices'; END IF;
    IF nullif(l->>'batch_key', '') IS NOT NULL THEN
      v_batch := nullif(v_map->>(l->>'batch_key'), '')::uuid;
      IF v_batch IS NULL THEN RAISE EXCEPTION 'invoice_unknown_batch'; END IF;
    END IF;
    INSERT INTO public.invoice_lines (document_id, batch_id, sort_order, item_type_id, item_type_name, description, quantity, unit_price_usd_centi_cents, hidden)
    VALUES (p_doc, v_batch, v_i, nullif(l->>'item_type_id', '')::uuid, coalesce(l->>'item_type_name', ''), coalesce(l->>'description', ''),
            (l->>'quantity')::bigint, (l->>'unit_price_usd_centi_cents')::bigint, coalesce((l->>'hidden')::boolean, false));
  END LOOP;
END $$;

-- 4. only an invoice can be marked paid (the rest of the function is exactly as in part 04)
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
  IF p_to = 'paid' AND v_doc.doc_type <> 'invoice' THEN RAISE EXCEPTION 'invoice_bad_transition'; END IF;

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

-- privileges, re-asserted (CREATE OR REPLACE keeps them; this makes the intent explicit and is harmless to repeat)
REVOKE ALL ON FUNCTION public.invoice_assign_number() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice__replace_children(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.invoice_set_status(uuid, uuid, text, integer, jsonb, date, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_set_status(uuid, uuid, text, integer, jsonb, date, text, text) TO service_role;
