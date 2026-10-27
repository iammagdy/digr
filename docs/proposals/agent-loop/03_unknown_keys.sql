-- NOT APPLIED. Owner applies by hand after review. No money table or function is touched.
-- A field a REAL answer carried that no recipe's field map knows. Never charged, never shown to a customer; it is a work queue for a human or an admin-run exploration.

BEGIN;

CREATE TABLE IF NOT EXISTS public.unknown_keys (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_id   text        NOT NULL CHECK (length(endpoint_id) BETWEEN 3 AND 200),
  key_path      text        NOT NULL CHECK (length(key_path) BETWEEN 1 AND 300),
  value_type    text        NOT NULL CHECK (value_type IN ('string', 'number', 'boolean', 'null', 'array', 'object')),
  sample        jsonb,                                            -- one masked, truncated value
  seen_count    integer     NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now(),
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'mapped', 'ignored')),
  recipe_id     text        REFERENCES public.recipes (id),       -- the recipe whose map now covers it
  UNIQUE (endpoint_id, key_path, value_type)
);

CREATE INDEX IF NOT EXISTS unknown_keys_open_idx ON public.unknown_keys (status, last_seen DESC);

ALTER TABLE public.unknown_keys ENABLE ROW LEVEL SECURITY;      -- no policy: only the service role reads or writes
REVOKE ALL ON public.unknown_keys FROM PUBLIC, anon, authenticated;

COMMIT;
