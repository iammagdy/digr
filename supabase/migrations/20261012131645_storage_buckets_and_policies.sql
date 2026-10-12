-- 1. Create Private Storage Buckets with strict limits
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES 
  ('receipts', 'receipts', false, 10485760, ARRAY['image/png', 'image/jpeg', 'image/webp', 'application/pdf']),
  ('results', 'results', false, 52428800, ARRAY['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'application/pdf']),
  ('partials', 'partials', false, 104857600, NULL)
ON CONFLICT (id) DO UPDATE SET 
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 2. Storage Policies on storage.objects

-- A) Upload receipt: authenticated user into own folder only (first folder must equal auth.uid())
CREATE POLICY "Users can upload receipt into own folder"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'receipts'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

-- B) View receipt: user views own receipt OR admin views any receipt
CREATE POLICY "Users and admins can view receipts"
ON storage.objects FOR SELECT
TO authenticated
USING (
  bucket_id = 'receipts'
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  )
);
