/**
 * A fake of the database's MONEY FUNCTIONS that the agent is allowed to call, with the same arithmetic as the real ones (create_quote_atomic, accept_quote_atomic, claim_job_chunk,
 * complete_chunk, settle_job_atomic, release_job_atomic: supabase/migrations). `from()` on any table throws: a test that passes proves the code wrote no money table by hand.
 */
export interface FakeJob { id: string; user_id: string; status: string; reserved_credits: number; unit_price: number; delivered_units: number; target_volume_max: number; step: number; lease_until: number | null; charged_credits: number | null; result_file_id: string | null; accumulated_cost_usd: number; current_cursor: string | null }
export interface LedgerRow { id: string; delta: number; type: string }

export function fakeMoneyClient(options: { balance?: number; cap?: number } = {}) {
  const quotes = new Map<string, { id: string; user_id: string; hash: string; items: any[]; total: number; status: string; expires: number }>();
  const jobs = new Map<string, FakeJob>();
  const ledger: LedgerRow[] = [{ id: "top_1", delta: options.balance ?? 100_000, type: "topup" }];
  const calls: Array<{ name: string; args: any }> = [];
  const balance = () => ledger.reduce((n, r) => n + r.delta, 0);
  const cap = options.cap ?? 25_000;

  const handlers: Record<string, (a: any) => { data?: any; error?: any }> = {
    create_quote_atomic: (a) => {
      if (a.p_total_points <= 0 || a.p_total_points > cap) return { error: { message: `quote reserve must be between 0 and ${cap} points` } };
      quotes.set(a.p_quote_id, { id: a.p_quote_id, user_id: a.p_user_id, hash: a.p_quote_hash, items: a.p_items, total: a.p_total_points, status: "quoted", expires: new Date(a.p_expires_at).getTime() });
      return { data: { success: true, quote_id: a.p_quote_id } };
    },
    accept_quote_atomic: (a) => {
      const q = quotes.get(a.p_quote_id);
      if (!q) return { data: { success: false, error: "quote_not_found" } };
      if (q.hash !== a.p_expected_quote_hash) return { data: { success: false, error: "quote_hash_mismatch" } };
      if (q.items.length !== 1 || !(q.items[0].unitPricePoints > 0)) return { data: { success: false, error: "missing_item_unit_price" } };
      if (q.items[0].targetVolumeMax > 5000) return { data: { success: false, error: "invalid_target_volume" } };
      if ([...jobs.values()].filter((j) => j.user_id === q.user_id && (j.status === "queued" || j.status === "running")).length >= 2) return { data: { success: false, error: "concurrency_limit" } };
      if (balance() < q.total) return { data: { success: false, error: "insufficient_balance", balance: balance() } };
      const id = `job_quote_${a.p_quote_id.slice(-8)}`;
      ledger.push({ id: `res_${id}`, delta: -q.total, type: "reserve" });
      jobs.set(id, { id, user_id: q.user_id, status: "queued", reserved_credits: q.total, unit_price: q.items[0].unitPricePoints, delivered_units: 0, target_volume_max: q.items[0].targetVolumeMax, step: 0, lease_until: null, charged_credits: null, result_file_id: null, accumulated_cost_usd: 0, current_cursor: null });
      q.status = "accepted";
      return { data: { success: true, quote_id: q.id, job_id: id, reserved_credits: q.total } };
    },
    claim_job_chunk: (a) => {
      const j = jobs.get(a.p_job_id);
      if (!j) return { data: { claimed: false, error: "job_not_found" } };
      if (j.lease_until && j.lease_until > Date.now()) return { data: { claimed: false, error: "lease_active" } };
      j.status = "running";
      j.lease_until = Date.now() + a.p_lease_seconds * 1000;
      return { data: { claimed: true, job_id: j.id, step: j.step } };
    },
    complete_chunk: (a) => {
      const j = jobs.get(a.p_job_id)!;
      if (a.p_new_delivered_units > j.target_volume_max) return { error: { message: "Delivered units exceeds target_volume_max" } };
      j.step += 1; j.delivered_units = a.p_new_delivered_units; j.current_cursor = a.p_new_cursor; j.lease_until = null; j.accumulated_cost_usd += a.p_cost_usd;
      return { data: { success: true } };
    },
    settle_job_atomic: (a) => {
      const j = jobs.get(a.p_job_id)!;
      if (j.status === "completed") return { data: { success: true, already_settled: true, charged_credits: j.charged_credits } };
      if (j.status !== "running") return { error: { message: `Cannot settle job with status ${j.status}` } };
      if (j.lease_until && j.lease_until > Date.now()) return { error: { message: "active chunk lease" } };
      ledger.push({ id: `rel_${j.id}`, delta: j.reserved_credits, type: "release" });
      const charge = Math.min(Math.ceil(j.delivered_units * j.unit_price - 1e-9), j.reserved_credits, a.p_points_cap);
      if (charge > 0) ledger.push({ id: `chg_${j.id}`, delta: -charge, type: "charge" });
      j.status = "completed"; j.charged_credits = charge; j.result_file_id = a.p_result_file_id;
      return { data: { success: true, already_settled: false, reserved_credits: j.reserved_credits, charged_credits: charge, delivered_units: j.delivered_units } };
    },
    release_job_atomic: (a) => {
      const j = jobs.get(a.p_job_id)!;
      if (j.status === "completed") return { error: { message: "Cannot release already completed job" } };
      if (j.lease_until && j.lease_until > Date.now()) return { error: { message: `Cannot release job ${j.id} while active chunk lease is held` } }; // as the real function does
      if (j.status !== "failed") { ledger.push({ id: `rel_${j.id}`, delta: j.reserved_credits, type: "release" }); j.status = "failed"; j.lease_until = null; }
      return { data: { success: true, released_credits: j.reserved_credits } };
    },
  };

  const client = {
    rpc: async (name: string, args: any) => { calls.push({ name, args }); const h = handlers[name]; return h ? h(args) : { error: { message: `unknown function ${name}` } }; },
    from: (table: string) => { throw new Error(`a table was touched by hand: ${table}`); },
  };
  return { client, quotes, jobs, ledger, calls, balance };
}
