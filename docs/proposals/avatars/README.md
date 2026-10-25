# Profile picture: SQL proposal (NOT APPLIED)

The author of this proposal has **no database access**. Nothing here has been run. The owner reviews each file and applies it by hand in the
Supabase SQL editor, in this order, after running `00_verify_before_apply.sql` (read-only) and checking its results against the "expected" lines.

| File | What it does | Undo |
|---|---|---|
| `00_verify_before_apply.sql` | Read-only: shows the profile columns and grants, the buckets and the storage policies that exist today. | none needed |
| `01_profiles_avatar_path.sql` | One nullable column `profiles.avatar_path`, a CHECK that keeps it inside the user's own folder, and an UPDATE grant on that one column for the signed-in role. | `01_profiles_avatar_path.rollback.sql` |
| `02_avatars_bucket_and_policies.sql` | A private bucket `avatars` (2 MB, jpeg/png/webp) and four policies (insert, select, update, delete) limited to the user's own folder. | `02_avatars_bucket_and_policies.rollback.sql` |

Plain summary: a user may keep one picture, stored privately under their own folder, and shown through a short-lived address. Nobody else can
read, list, replace or delete it. No money table or function is touched, and nothing is granted to anonymous visitors.

The site already ships the screens for it and works **before** these files are applied: while the column is missing the upload control stays
hidden and the letter circle shows; while the bucket is missing an upload answers with a calm Arabic notice. Applying the files switches the
feature on without a new deploy.

Known gap (not part of these files): the account-deletion flow does not remove the picture object; it stays in the private bucket until the
user removes it, or an admin empties the folder. A cleanup step can be added to the deletion route later.
