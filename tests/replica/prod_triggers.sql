-- The three append-only triggers of production (pg_get_triggerdef, read 2026-10-21). Created after the trigger functions are loaded.
CREATE TRIGGER trg_block_ledger_mutation BEFORE DELETE OR UPDATE ON public.credit_ledger FOR EACH ROW EXECUTE FUNCTION block_ledger_mutation();
CREATE TRIGGER trg_block_ledger_truncate BEFORE TRUNCATE ON public.credit_ledger FOR EACH STATEMENT EXECUTE FUNCTION block_ledger_truncate();
CREATE TRIGGER trg_block_credit_kind_mutation BEFORE DELETE OR UPDATE ON public.credit_ledger_kinds FOR EACH ROW EXECUTE FUNCTION block_credit_kind_mutation();
