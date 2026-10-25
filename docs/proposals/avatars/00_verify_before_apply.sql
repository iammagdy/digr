-- READ ONLY. Paste in the Supabase SQL editor BEFORE applying anything: it shows what is live. It changes nothing.
-- If a result differs from the "expected" line, STOP and send the result back: the proposal files assume these baselines.

-- 1. the profile table columns (expected: no avatar_path yet)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'profiles'
ORDER BY ordinal_position;

-- 2. who may UPDATE which profile column (expected: authenticated may update sender_name, sender_phone, updated_at only)
SELECT grantee, column_name, privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public' AND table_name = 'profiles' AND privilege_type = 'UPDATE' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY grantee, column_name;

-- 3. the profile policies (expected: profiles_select and profiles_update, both "own row")
SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'profiles' ORDER BY policyname;

-- 4. the buckets that exist (expected: receipts, results, partials; no avatars)
SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets ORDER BY id;

-- 5. the storage policies that exist (expected: none whose name or text mentions avatars)
SELECT policyname, cmd, roles FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' ORDER BY policyname;
