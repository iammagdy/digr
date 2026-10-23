-- PROPOSAL, NOT APPLIED. Run by hand in the Supabase SQL editor after the owner's review.
-- ROLLBACK of step 3: settings_private.pricing.jobMaxPointsCap back to 600
-- 
-- Data only: one stored number. No function, no table definition, no grant and no money table is touched (the ledger and the jobs are not read or written).

UPDATE public.settings_private
SET value = jsonb_set(value, '{jobMaxPointsCap}', to_jsonb(600::int), true),
    updated_at = now()
WHERE key = 'pricing'
  AND COALESCE((value ->> 'jobMaxPointsCap')::numeric, 0) <> 600;
