-- ROLLBACK of part 06 ONLY (the statement mode). It refuses to run while any data statement exists, because a document is never deleted: void them first or keep part 06.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.invoice_documents WHERE doc_type = 'statement') THEN
    RAISE EXCEPTION 'data statements exist: part 06 cannot be rolled back (documents are never deleted)';
  END IF;
END $$;
ALTER TABLE public.invoice_documents DROP CONSTRAINT IF EXISTS invoice_documents_statement_no_money;
ALTER TABLE public.invoice_documents DROP CONSTRAINT IF EXISTS invoice_documents_doc_type_check;
ALTER TABLE public.invoice_documents ADD CONSTRAINT invoice_documents_doc_type_check CHECK (doc_type IN ('quote', 'invoice'));
ALTER TABLE public.invoice_number_counters DROP CONSTRAINT IF EXISTS invoice_number_counters_doc_type_check;
ALTER TABLE public.invoice_number_counters ADD CONSTRAINT invoice_number_counters_doc_type_check CHECK (doc_type IN ('quote', 'invoice'));
-- then run 03_numbering_and_guards.sql and 04_functions.sql again: both are CREATE OR REPLACE and put back the earlier bodies of invoice_assign_number,
-- invoice__replace_children and invoice_set_status (their privileges are not touched).
