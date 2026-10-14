-- Step 1: Tables and Indexes

-- 1. Helper Function: Admin Check
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO service_role, authenticated;

-- 2. Profiles Table
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  email TEXT,
  sender_name TEXT,
  sender_phone TEXT,
  deletion_scheduled_for TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- 3. Credit Ledger Table
CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  delta NUMERIC NOT NULL,
  type TEXT NOT NULL,
  job_id TEXT,
  topup_id TEXT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_id ON public.credit_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_job_id ON public.credit_ledger(job_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_topup_id ON public.credit_ledger(topup_id);

-- 4. Topups Table
CREATE TABLE IF NOT EXISTS public.topups (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  amount_egp NUMERIC NOT NULL,
  reference TEXT UNIQUE NOT NULL,
  sender_name TEXT NOT NULL,
  sender_phone TEXT NOT NULL,
  receipt_file_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT chk_topups_amount_positive CHECK (amount_egp > 0),
  CONSTRAINT chk_topups_status CHECK (status IN ('pending', 'approved', 'rejected'))
);
CREATE INDEX IF NOT EXISTS idx_topups_user_id ON public.topups(user_id);
CREATE INDEX IF NOT EXISTS idx_topups_reference ON public.topups(reference);

-- 5. Jobs Table
CREATE TABLE IF NOT EXISTS public.jobs (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL,
  endpoint_id TEXT,
  target_volume_min INT,
  target_volume_max INT,
  reserved_credits NUMERIC,
  charged_credits NUMERIC,
  delivered_units INT DEFAULT 0,
  current_cursor TEXT,
  accumulated_cost_usd NUMERIC DEFAULT 0,
  attempt_count INT DEFAULT 0,
  result_file_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT chk_jobs_status CHECK (status IN ('queued', 'running', 'completed', 'failed', 'refused'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_user_id ON public.jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON public.jobs(status);

-- 6. Job Events Table
CREATE TABLE IF NOT EXISTS public.job_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  message TEXT NOT NULL,
  units INT DEFAULT 0,
  event_type TEXT DEFAULT 'progress',
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON public.job_events(job_id);
CREATE INDEX IF NOT EXISTS idx_job_events_user_id ON public.job_events(user_id);

-- 7. Plans and Quotes Table
CREATE TABLE IF NOT EXISTS public.plans_quotes (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  quote_hash TEXT NOT NULL,
  status TEXT DEFAULT 'quoted' NOT NULL,
  items JSONB NOT NULL,
  total_reserved_credits NUMERIC NOT NULL,
  output_formats JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT chk_quotes_status CHECK (status IN ('quoted', 'accepted', 'expired', 'refused'))
);
CREATE INDEX IF NOT EXISTS idx_plans_quotes_user_id ON public.plans_quotes(user_id);
CREATE INDEX IF NOT EXISTS idx_plans_quotes_hash ON public.plans_quotes(quote_hash);

-- 8. Conversations Table
CREATE TABLE IF NOT EXISTS public.conversations (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,
  status TEXT,
  brief JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON public.conversations(user_id);

-- 9. Messages Table
CREATE TABLE IF NOT EXISTS public.messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content_ar TEXT NOT NULL,
  clarification_items JSONB,
  plan JSONB,
  quote JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT chk_messages_role CHECK (role IN ('user', 'assistant', 'system'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON public.messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON public.messages(user_id);

-- 10. Notes Table
CREATE TABLE IF NOT EXISTS public.notes (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_user_id ON public.notes(user_id);

-- 11. Artifact Versions Table
CREATE TABLE IF NOT EXISTS public.artifact_versions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  file_id_xlsx TEXT,
  file_id_pdf TEXT,
  file_id_csv TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_job_id ON public.artifact_versions(job_id);
CREATE INDEX IF NOT EXISTS idx_artifact_versions_user_id ON public.artifact_versions(user_id);

-- 12. Notifications Table
CREATE TABLE IF NOT EXISTS public.notifications (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read BOOLEAN DEFAULT FALSE NOT NULL,
  link TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON public.notifications(user_id);

-- 13. Admin Audit Log Table
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_actor_id ON public.admin_audit_log(actor_id);

-- 14. Provider Costs Table
CREATE TABLE IF NOT EXISTS public.provider_costs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id TEXT REFERENCES public.jobs(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  units INT DEFAULT 1,
  cost_usd NUMERIC NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_costs_job_id ON public.provider_costs(job_id);

-- 15. Settings Tables
CREATE TABLE IF NOT EXISTS public.settings_public (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.settings_private (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- 16. Capability Registry Table
CREATE TABLE IF NOT EXISTS public.capability_registry (
  slug TEXT PRIMARY KEY,
  name_ar TEXT NOT NULL,
  description_ar TEXT,
  endpoint_id TEXT NOT NULL,
  unit_price_credits NUMERIC NOT NULL,
  enabled BOOLEAN DEFAULT TRUE NOT NULL
);

-- 17. LLM Usage Table
CREATE TABLE IF NOT EXISTS public.llm_usage (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  tokens_in INT DEFAULT 0,
  tokens_out INT DEFAULT 0,
  model TEXT,
  latency_ms INT DEFAULT 0,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_user_id ON public.llm_usage(user_id);

-- 18. Templates Table
CREATE TABLE IF NOT EXISTS public.templates (
  id TEXT PRIMARY KEY,
  title_ar TEXT NOT NULL,
  prompt_ar TEXT NOT NULL,
  category TEXT,
  enabled BOOLEAN DEFAULT TRUE NOT NULL
);

-- 19. Capability Requests Table
CREATE TABLE IF NOT EXISTS public.capability_requests (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capability_requests_user_id ON public.capability_requests(user_id);
