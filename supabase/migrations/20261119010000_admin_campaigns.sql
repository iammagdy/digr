-- ADMIN CAMPAIGNS (DT-20261118-06 phase 2B; D-0092, D-0094 point 2, applied under D-0093). The admin's e-mail campaigns to customers who chose to receive news.
-- NOT APPLIED by the agent that wrote it: COMMANDER (D-0093) or the owner applies it in the Supabase SQL editor, AFTER downloading /admin/export (the free plan has no backups).
-- ADDITIVE ONLY: two new tables. Nothing existing is read, altered or dropped. No object here references credit_ledger, balances, missions, reserves or charges.
-- No e-mail address and no message body of a customer is stored: a campaign holds the admin's own text; a send row holds a user id, a status and counts-only reasons.
-- Admin-only: RLS is on with NO policy, and every privilege is revoked from PUBLIC, anon and authenticated. Only the server (service_role, after authenticateAdmin) reads and writes.

-- One campaign: the admin's text (the same limits as src/lib/customerMessage.ts CUSTOMER_MESSAGE_LIMITS; a draft may be incomplete, so only the maximums are checked here).
CREATE TABLE IF NOT EXISTS public.admin_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  subject text NOT NULL DEFAULT '' CHECK (char_length(subject) <= 150),
  badge text NOT NULL DEFAULT '' CHECK (char_length(badge) <= 40),
  heading text NOT NULL DEFAULT '' CHECK (char_length(heading) <= 120),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 5000),
  cta_label text NOT NULL DEFAULT '' CHECK (char_length(cta_label) <= 40),
  cta_path text NOT NULL DEFAULT '' CHECK (char_length(cta_path) <= 200),
  -- D-0094 point 4: news reaches only customers whose own setting says yes (prefs.notif.news === true); a later segment may only narrow it
  audience text NOT NULL DEFAULT 'news_opt_in' CHECK (audience IN ('news_opt_in')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'sending', 'sent', 'cancelled')),
  -- +1 on every save: a stale screen can never overwrite a newer draft
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  -- the last test sent to the admin's own address, and the hash of the exact text it showed (an edit makes the test stale)
  test_sent_at timestamptz,
  test_content_hash text CHECK (test_content_hash IS NULL OR char_length(test_content_hash) <= 128),
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_campaigns_created_at_idx ON public.admin_campaigns (created_at DESC);

-- One row per person per campaign (the primary key): a second run of the same campaign can never mail the same person twice. Claimed BEFORE the send; an uncertain
-- delivery keeps its claim and is never retried automatically. No address, no body.
CREATE TABLE IF NOT EXISTS public.admin_campaign_sends (
  campaign_id uuid NOT NULL REFERENCES public.admin_campaigns (id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('claimed', 'sent', 'failed', 'uncertain', 'skipped')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 60),
  provider_message_id text CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, user_id)
);
CREATE INDEX IF NOT EXISTS admin_campaign_sends_status_idx ON public.admin_campaign_sends (campaign_id, status);

ALTER TABLE public.admin_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_campaign_sends ENABLE ROW LEVEL SECURITY;

-- On this project a new table in public is granted to anon, authenticated and service_role by default (pg_default_acl): take everything back, then give the server only what it uses.
REVOKE ALL ON TABLE public.admin_campaigns, public.admin_campaign_sends FROM PUBLIC, anon, authenticated, service_role;
-- never DELETE: a campaign and its send rows are the record of what was sent
GRANT SELECT, INSERT, UPDATE ON TABLE public.admin_campaigns, public.admin_campaign_sends TO service_role;
