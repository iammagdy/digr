-- NOT APPLIED. Owner applies by hand after review. No money table or function is touched.
-- A reviewed, versioned recipe: the endpoint, the parameter template (every value with its provenance) and the field map of a request type that was solved once.

BEGIN;

CREATE TABLE IF NOT EXISTS public.recipes (
  id                      text PRIMARY KEY DEFAULT ('rcp_' || replace(gen_random_uuid()::text, '-', '')),
  slug                    text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  version                 integer     NOT NULL CHECK (version >= 1),
  status                  text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'retired')),
  endpoint_id             text        NOT NULL CHECK (length(endpoint_id) BETWEEN 3 AND 200),
  params_template         jsonb       NOT NULL CHECK (jsonb_typeof(params_template) = 'object'),
  field_map               jsonb       NOT NULL CHECK (jsonb_typeof(field_map) = 'object'),
  price_basis             jsonb       NOT NULL CHECK (jsonb_typeof(price_basis) = 'object'),
  fixture_refs            jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fixture_refs) = 'array'),
  catalog_snapshot_sha256 text        CHECK (catalog_snapshot_sha256 IS NULL OR catalog_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_by              text        NOT NULL DEFAULT 'agent',
  reviewed_by             text,
  reviewed_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug, version),
  -- a reviewed recipe names who reviewed it and when, and was proven on at least one fixture
  CONSTRAINT recipes_review_complete CHECK (status <> 'reviewed' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND jsonb_array_length(fixture_refs) >= 1))
);

-- at most ONE reviewed version of a slug is in force at a time (a new version retires the old one first)
CREATE UNIQUE INDEX IF NOT EXISTS recipes_one_reviewed_per_slug ON public.recipes (slug) WHERE status = 'reviewed';
CREATE INDEX IF NOT EXISTS recipes_endpoint_idx ON public.recipes (endpoint_id);

-- a reviewed recipe never changes (only its retirement); a recipe is never deleted once reviewed
CREATE OR REPLACE FUNCTION public.recipes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'reviewed' THEN RAISE EXCEPTION 'a reviewed recipe is never deleted: retire it'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'reviewed' THEN
    IF NEW.status NOT IN ('reviewed', 'retired')
       OR NEW.slug <> OLD.slug OR NEW.version <> OLD.version OR NEW.endpoint_id <> OLD.endpoint_id
       OR NEW.params_template <> OLD.params_template OR NEW.field_map <> OLD.field_map OR NEW.price_basis <> OLD.price_basis
       OR NEW.fixture_refs <> OLD.fixture_refs THEN
      RAISE EXCEPTION 'a reviewed recipe is immutable: create a new version';
    END IF;
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN RAISE EXCEPTION 'a retired recipe stays retired: create a new version'; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS recipes_guard_update ON public.recipes;
CREATE TRIGGER recipes_guard_update BEFORE UPDATE OR DELETE ON public.recipes FOR EACH ROW EXECUTE FUNCTION public.recipes_guard();

ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;      -- no policy: only the service role reads or writes
REVOKE ALL ON public.recipes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recipes_guard() FROM PUBLIC, anon, authenticated;

COMMIT;
