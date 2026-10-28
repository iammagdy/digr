-- NOT APPLIED. Owner applies by hand. A PRIVATE bucket for everything a mission saves: raw TREG pages (raw/), code outputs (out/), saved rows (rows/) and result files (result/).
-- No policy is created on storage.objects for this bucket: with RLS on, only the service role (the worker and the admin routes) can read or write it.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('agent-missions', 'agent-missions', false, 52428800,
  ARRAY['application/json', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;
