-- Persist planning-stage research attempts so requests rejected before a quote
-- or job still appear in the customer's request history.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS request_status TEXT,
  ADD COLUMN IF NOT EXISTS request_error TEXT,
  ADD COLUMN IF NOT EXISTS request_quote_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'messages_request_status_check'
      AND conrelid = 'public.messages'::regclass
  ) THEN
    ALTER TABLE public.messages
      ADD CONSTRAINT messages_request_status_check
      CHECK (
        request_status IS NULL OR
        request_status IN ('planning', 'needs_input', 'quoted', 'accepted', 'refused', 'failed')
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_messages_request_history
  ON public.messages (user_id, created_at DESC)
  WHERE role = 'user' AND request_status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_request_quote_id
  ON public.messages (request_quote_id)
  WHERE request_quote_id IS NOT NULL;
