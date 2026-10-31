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
