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
