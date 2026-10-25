-- PROPOSAL ONLY: NOT APPLIED (the author has no database access). The owner reviews it and applies it by hand. Part 2 of 2 of docs/proposals/avatars/.
--
-- A PRIVATE bucket «avatars»: at most 2 MB, only jpeg, png and webp. One object per user at {userId}/avatar.{jpg|png|webp}.
-- Public listing does not exist: the bucket is not public, and every policy below is for the signed-in role only and limited to the user's own
-- folder, so a user can insert, replace, read and delete only their own picture and cannot even list another user's folder. The page shows the
-- picture through a short-lived signed address (one hour) made by the user's own session: no public URL is ever stored or shown.
-- (Justification of private over public: a public bucket would make every picture reachable by anyone who learns or guesses the path, forever.
--  The cost of private is one small signed-address request per page load, which is acceptable.)
--
-- What it does NOT touch: no table, no ledger, no money function, no existing bucket or policy. Idempotent.

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', false, 2097152, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- the object name must be exactly {own uid}/avatar.{ext}
DROP POLICY IF EXISTS "avatars_insert_own" ON storage.objects;
CREATE POLICY "avatars_insert_own" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'avatars'
  AND (storage.foldername(name))[1] = (select auth.uid())::text
  AND name ~ '^[0-9a-f-]{36}/avatar\.(jpg|png|webp)$'
);

DROP POLICY IF EXISTS "avatars_select_own" ON storage.objects;
CREATE POLICY "avatars_select_own" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid())::text);

DROP POLICY IF EXISTS "avatars_update_own" ON storage.objects;
CREATE POLICY "avatars_update_own" ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid())::text)
WITH CHECK (
  bucket_id = 'avatars'
  AND (storage.foldername(name))[1] = (select auth.uid())::text
  AND name ~ '^[0-9a-f-]{36}/avatar\.(jpg|png|webp)$'
);

DROP POLICY IF EXISTS "avatars_delete_own" ON storage.objects;
CREATE POLICY "avatars_delete_own" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid())::text);

COMMIT;
