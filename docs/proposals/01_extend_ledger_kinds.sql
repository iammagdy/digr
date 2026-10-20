-- PROPOSAL (not applied, not in supabase/migrations). Apply order: 1 of 7. Requires 20261018140000_credit_ledger_kinds.sql (already live).
-- Adds the three new kinds of credit to the append-only side table that tells income, promotion and gifts apart forever.
-- No ledger row is touched: credit_ledger already allows type 'grant' for positive credits.
ALTER TABLE public.credit_ledger_kinds DROP CONSTRAINT IF EXISTS credit_ledger_kinds_kind_check;
ALTER TABLE public.credit_ledger_kinds
  ADD CONSTRAINT credit_ledger_kinds_kind_check
  CHECK (kind IN ('topup_instapay', 'promo_code', 'admin_grant', 'bundle_bonus', 'work_email_bonus', 'referral_reward'));
