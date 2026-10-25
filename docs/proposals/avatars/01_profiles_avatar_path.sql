-- PROPOSAL ONLY: NOT APPLIED (the author has no database access). The owner reviews it and applies it by hand. Part 1 of 2 of docs/proposals/avatars/.
--
-- The profile picture: ONE nullable column on the user-facing profile table, holding the object path inside the private bucket «avatars»
-- (created by part 2). The application treats a missing column as «no picture feature yet» and hides the upload control, so this file can be
-- applied before or after part 2 and the site keeps working either way.
--
-- What it does NOT touch: no ledger, jobs, topups, plans_quotes or provider_costs table; no money function; no existing column or grant.
-- Security:
--  * the signed-in user may update ONLY this one extra column of their own row (the existing column-level grant model: UPDATE is revoked from
--    everyone and granted per column; the existing profiles_update policy keeps it to the user's own row);
--  * a CHECK keeps the saved path inside the user's own folder and in the one shape the storage policies accept, so a user cannot point their
--    profile at someone else's object even by writing the column directly;
--  * nothing is granted to anon or PUBLIC.
-- Idempotent.

BEGIN;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS avatar_path text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_avatar_path_own_folder' AND conrelid = 'public.profiles'::regclass) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_avatar_path_own_folder
      CHECK (avatar_path IS NULL OR avatar_path ~ ('^' || id::text || '/avatar\.(jpg|png|webp)$'));
  END IF;
END $$;

-- the existing model: UPDATE is revoked table-wide and granted column by column. Only the new column is added to the grant.
REVOKE UPDATE (avatar_path) ON public.profiles FROM PUBLIC, anon;
GRANT UPDATE (avatar_path) ON public.profiles TO authenticated;

COMMIT;
