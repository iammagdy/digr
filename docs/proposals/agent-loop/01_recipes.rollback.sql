-- NOT APPLIED. Rolls back 01_recipes.sql. Drops the recipes table (nothing else depends on it).
BEGIN;
DROP TRIGGER IF EXISTS recipes_guard_update ON public.recipes;
DROP TABLE IF EXISTS public.recipes;
DROP FUNCTION IF EXISTS public.recipes_guard();
COMMIT;
