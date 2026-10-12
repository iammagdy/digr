-- Migration: non_money_schema_enhancements
-- 1. Add cost_usd to public.llm_usage and index on created_at for global LLM spend cap calculation
ALTER TABLE public.llm_usage ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10, 6) DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_llm_usage_created_at ON public.llm_usage(created_at);

-- 2. Add composite index on public.messages for burst rate limit queries (user_id, role, created_at)
CREATE INDEX IF NOT EXISTS idx_messages_rate_limit ON public.messages(user_id, role, created_at DESC);

-- 3. Add descriptive and schema metadata columns to public.capability_registry
ALTER TABLE public.capability_registry ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE public.capability_registry ADD COLUMN IF NOT EXISTS name_en TEXT;
ALTER TABLE public.capability_registry ADD COLUMN IF NOT EXISTS pricing_unit TEXT DEFAULT 'call';
ALTER TABLE public.capability_registry ADD COLUMN IF NOT EXISTS unit_cost_usd NUMERIC;
ALTER TABLE public.capability_registry ADD COLUMN IF NOT EXISTS max_rows INT DEFAULT 1;
ALTER TABLE public.capability_registry ADD COLUMN IF NOT EXISTS pagination_type TEXT DEFAULT 'none';
ALTER TABLE public.capability_registry ADD COLUMN IF NOT EXISTS params JSONB;
ALTER TABLE public.capability_registry ADD COLUMN IF NOT EXISTS params_schema JSONB;

-- 4. Clean up settings_private RLS policy to resolve advisor notice
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' AND tablename = 'settings_private' AND policyname = 'settings_private_admin'
  ) THEN
    CREATE POLICY "settings_private_admin" ON public.settings_private FOR ALL
      USING (is_admin())
      WITH CHECK (is_admin());
  END IF;
END $$;
