-- PROPOSAL, NOT APPLIED. Run by hand in the Supabase SQL editor after the owner's review.
-- Step 3 of 4: settings_private.pricing.jobMaxPointsCap 600 -> 25000
-- The worker reads this value as the cap of the settlement call. Code never uses a value below the shared constant, so this step keeps the stored number honest; it changes no money table.
-- Data only: one stored number. No function, no table definition, no grant and no money table is touched (the ledger and the jobs are not read or written).

UPDATE public.settings_private
SET value = jsonb_set(value, '{jobMaxPointsCap}', to_jsonb(25000::int), true),
    updated_at = now()
WHERE key = 'pricing'
  AND COALESCE((value ->> 'jobMaxPointsCap')::numeric, 0) <> 25000;
