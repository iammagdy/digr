-- ROLLBACK of 01_profiles_avatar_path.sql (proposal only: NOT APPLIED). The application keeps working without the column (the control hides,
-- the letter circle shows). Pictures already saved in the bucket stay there until part 2 is rolled back and the bucket is emptied.

BEGIN;

REVOKE UPDATE (avatar_path) ON public.profiles FROM authenticated;
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_avatar_path_own_folder;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS avatar_path;

COMMIT;
