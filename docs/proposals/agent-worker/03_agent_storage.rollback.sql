-- NOT APPLIED. Removes the bucket row. Supabase refuses to delete a bucket that still holds objects: empty it first from the dashboard (Storage > agent-missions > select all > delete).
DELETE FROM storage.buckets WHERE id = 'agent-missions';
