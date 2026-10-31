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
