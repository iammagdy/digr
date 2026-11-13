# Proposal: settlement fenced by mission ownership in the database (NOT APPLIED)

Status: proposal only. It changes financial SQL, so it needs the owner's explicit approval. Nothing here has been run.

## What round 56 fixed in code (no SQL)

`ensureOwned` (agent/src/ownership.ts) runs on the line before every `settleMission` / `settleAddon` call. It now passes only on positive evidence: an atomic lease renewal (`UPDATE missions SET lease_until = … WHERE id = $1 AND worker_id = $me AND status IN ('planning','executing') RETURNING id`) that returns the mission. A database error, a timeout, a missing row, a row with no owner, a row that is no longer running, or a renewal the store cannot confirm all refuse. The run then writes nothing, and the existing lease path (`agent_claim_mission`, expired-lease branch) hands the mission to a worker that resumes it and settles once.

The renewal also closes most of the read-check-write window: for the next lease period (120 s), no other worker can claim the mission.

## What remains

The settlement RPC itself is not fenced. If the settlement call hangs for more than the lease period *and* this worker's heartbeats fail during that time, a second worker can claim the mission and settle it concurrently.

- **Double charge: not possible.** `complete_chunk(p_expected_step 0)` answers `already_completed` on a second call, `settle_job_atomic` is idempotent per job, and `release_job_atomic` refuses a settled job. Ledger ids are deterministic (`res_` / `rel_` / `chg_` + job id), and the primary key rejects a second row.
- **Wrong outcome: possible but rare.** If one worker's zero-delivery release (files failed) lands before the other worker's charge, the charge is refused. The mission then ends `failed` with a published but unpaid file. The customer is not overcharged; the platform under-collects. Since round 56 the refused party records `settlement <code>` and tells the customer that an admin will review it; it no longer claims «nothing was charged».

## Proposed SQL (for review)

A wrapper the worker calls instead of the three money functions directly. It locks the mission row and checks ownership in the same transaction as the money movement:

```sql
CREATE OR REPLACE FUNCTION public.agent_settle_owned(
  p_mission_id text, p_worker_id text, p_job_id text,
  p_delivered_units integer, p_cost_usd numeric, p_points_cap integer,
  p_result_file_id text, p_release_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_owner text; v_status text; v_job text;
BEGIN
  SELECT worker_id, status, job_id INTO v_owner, v_status, v_job
  FROM public.missions WHERE id = p_mission_id FOR UPDATE;
  IF NOT FOUND OR v_owner IS DISTINCT FROM p_worker_id OR v_status NOT IN ('executing')
     OR v_job IS DISTINCT FROM p_job_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_owner');
  END IF;
  -- then exactly the calls settleMission makes today, inside this transaction:
  -- complete_chunk(p_job_id, 0, 'completed', p_delivered_units, p_cost_usd)
  -- and settle_job_atomic(p_job_id, p_points_cap, p_result_file_id), or release_job_atomic when p_delivered_units = 0
  ...
END $$;
REVOKE ALL ON FUNCTION public.agent_settle_owned(text,text,text,integer,numeric,integer,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_settle_owned(text,text,text,integer,numeric,integer,text,text) TO service_role;
```

Because the claim takes the same row lock (`FOR UPDATE SKIP LOCKED`), a takeover cannot interleave with a settlement.

## What approval would cover

- One new `SECURITY DEFINER` function, granted to `service_role` only.
- No change to `settle_job_atomic`, `complete_chunk`, `release_job_atomic`, the ledger, pricing, or balances.
- Worker change: `settleMission` / `settleAddon` call the wrapper when a worker id is present.
- Tests on a scratch PostgreSQL (the method of docs/MONEY-PR-7A.md section 12) before it is applied.
