# Proposal: store the rejection reason on the top-up row

**STATUS: NOT APPLIED. Nothing in this file has been run. The owner applies SQL by hand after review.**

## Why this is a proposal, not a change
The customer's top-up page now shows the reason of a rejected request **without any SQL**: the reject route already writes the reason into the
customer's own notification (`notifications.id = 'notif_<topup id>'`, body «تم رفض طلب الشحن. السبب: …»), the customer can read their own
notifications under the existing `notifications_select` policy, and the page reads that one row (PR "Show the rejection reason to the customer").

That works, but it is indirect:
- the reason lives only in a notification text, so the page parses the words after «السبب:»;
- `public.topups` has no reason column, and `reject_topup_atomic(p_topup_id text)` only sets `status = 'rejected'` (the admin form's text goes to the notification, the e-mail and the audit log, never to the row);
- the page's existing `r.reject_reason` read (and the admin page's `rejectReason`) therefore always come back empty.

## What would make it durable (needs SQL)
1. A column: `ALTER TABLE public.topups ADD COLUMN reject_reason text CHECK (reject_reason IS NULL OR char_length(reject_reason) <= 256);`
2. The function stores it (a new overload; the old one-argument call in the deployed route keeps working until the route is changed):
```sql
CREATE OR REPLACE FUNCTION public.reject_topup_atomic(p_topup_id text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_topup public.topups%ROWTYPE;
BEGIN
  SELECT * INTO v_topup FROM public.topups WHERE id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'topup_not_found'); END IF;
  IF v_topup.status = 'rejected' THEN RETURN jsonb_build_object('success', true, 'already_rejected', true, 'topup_id', p_topup_id); END IF;
  IF v_topup.status <> 'pending' THEN RETURN jsonb_build_object('success', false, 'error', 'invalid_status'); END IF;
  UPDATE public.topups SET status = 'rejected', reject_reason = left(btrim(p_reason), 256) WHERE id = p_topup_id;
  RETURN jsonb_build_object('success', true, 'already_rejected', false, 'topup_id', p_topup_id);
END; $$;
REVOKE ALL ON FUNCTION public.reject_topup_atomic(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_topup_atomic(text, text) TO service_role;
```
3. The route passes `{ p_topup_id, p_reason: rejectReason }` (a code change, not SQL).
4. No RLS or grant change: `topups_select` already lets the customer read their own rows, and the page already reads `reject_reason` and prefers it over the notification text.

## Not needed for the current page
Nothing above is required for the customer to see the reason today. Apply it only if the owner wants the reason stored on the request itself.
