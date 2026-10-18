-- Proposal only (not applied by the author): support messages from /contact and from failed-job reports.
-- Not a money table. Written by the server with the service role; customers never read or write it directly.

CREATE TABLE IF NOT EXISTS public.support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 200),
  message text NOT NULL CHECK (char_length(message) BETWEEN 5 AND 4000),
  job_id text,
  source text NOT NULL DEFAULT 'contact' CHECK (source IN ('contact', 'job_report')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'closed')),
  emailed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_messages_created_idx ON public.support_messages (created_at DESC);

ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.support_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.support_messages TO service_role;
