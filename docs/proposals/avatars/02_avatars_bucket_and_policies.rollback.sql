-- ROLLBACK of 02_avatars_bucket_and_policies.sql (proposal only: NOT APPLIED). The application keeps working without the bucket: an upload answers
-- with the calm Arabic notice and the letter circle shows.
-- The bucket itself is NOT dropped here: Supabase does not allow removing a bucket that still holds objects, and storage rows are not to be deleted
-- with SQL. To remove it, empty it and delete it from the dashboard (Storage, avatars) or with the Storage API.

BEGIN;

DROP POLICY IF EXISTS "avatars_insert_own" ON storage.objects;
DROP POLICY IF EXISTS "avatars_select_own" ON storage.objects;
DROP POLICY IF EXISTS "avatars_update_own" ON storage.objects;
DROP POLICY IF EXISTS "avatars_delete_own" ON storage.objects;

COMMIT;
