import { createHash } from "node:crypto";

/**
 * A fake of the database's MONEY FUNCTIONS that the agent is allowed to call, with the same arithmetic and the same rules as the real ones (create_quote_atomic, accept_quote_atomic, claim_job_chunk,
 * complete_chunk, settle_job_atomic, release_job_atomic: the LIVE definitions, read once (read-only) and compared with supabase/migrations: docs/MONEY-PR-7A.md section 12). `from()` on any table throws: a test that passes
 * proves the code wrote no money table by hand.
 *
 * What it enforces (the real functions do): a ledger id is UNIQUE (a second insert of the same id is a database error), create_quote_atomic is idempotent on the same id and contents and raises on a
 * conflicting re-use, accept_quote_atomic answers `already_accepted` on an accepted quote and refuses any other status than `quoted`, the job id is job_quote_<md5(quote id)>, a job sells at most 5,000
 * units, a user has at most two active jobs, and an `insufficient_balance` answer writes nothing. The balance is the sum of the whole ledger (the fake has one user).
 * `inject(name, "before" | "after")` makes the NEXT call of that function fail: "before" = nothing committed, "after" = committed but the answer is lost (the caller sees an error).
 */
export interface FakeJob { id: string; user_id: string; status: string; reserved_credits: number; unit_price: number; delivered_units: number; target_volume_max: number; step: number; lease_until: number | null; charged_credits: number | null; result_file_id: string | null; accumulated_cost_usd: number; current_cursor: string | null; endpoint_id: string; target_volume_min: number; error_message: string | null }
export interface LedgerRow { id: string; delta: number; type: string; job_id?: string; user_id?: string }
export interface FakeQuote { id: string; user_id: string; hash: string; items: any[]; total: number; status: string; expires: number; formats: string[] }

export const quoteJobId = (quoteId: string): string => `job_quote_${createHash("md5").update(quoteId).digest("hex")}`;

export function fakeMoneyClient(options: { balance?: number; cap?: number } = {}) {
  const quotes = new Map<string, FakeQuote>();
  const jobs = new Map<string, FakeJob>();
  const ledger: LedgerRow[] = [{ id: "top_1", delta: options.balance ?? 100_000, type: "topup" }];
  const calls: Array<{ name: string; args: any }> = [];
  const injected = new Map<string, Array<"before" | "after">>();
  const balance = () => ledger.reduce((n, r) => n + r.delta, 0);
  const cap = options.cap ?? 25_000;
  /** The ledger's primary key: a second row with the same id is an error, never a second row. */
  const insert = (row: LedgerRow): void => { if (ledger.some((r) => r.id === row.id)) throw new Error(`duplicate key value violates unique constraint "credit_ledger_pkey" (${row.id})`); ledger.push(row); };
  const ok = (data: any) => ({ data });
  const no = (error: string, extra: Record<string, unknown> = {}) => ({ data: { success: false, error, ...extra } });
  const raise = (message: string) => ({ error: { message } });
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  const handlers: Record<string, (a: any) => { data?: any; error?: any }> = {
    create_quote_atomic: (a) => {
      if (!a.p_user_id || !String(a.p_quote_id ?? "").trim() || !String(a.p_quote_hash ?? "").trim()) return raise("user, quote id, and quote hash are required");
      if (!Array.isArray(a.p_items) || a.p_items.length === 0) return raise("quote items must be a non-empty JSON array");
      if (!(a.p_total_points > 0) || a.p_total_points > cap) return raise(`quote reserve must be between 0 and ${cap} points`);
      if (!Array.isArray(a.p_output_formats) || a.p_output_formats.length === 0 || a.p_output_formats.some((f: string) => !["xlsx", "csv", "pdf"].includes(f))) return raise("unsupported output formats");
      if (!a.p_expires_at || new Date(a.p_expires_at).getTime() <= Date.now()) return raise("quote expiry must be in the future");
      const existing = quotes.get(a.p_quote_id);
      if (existing) {
        if (existing.user_id !== a.p_user_id || existing.hash !== a.p_quote_hash || !same(existing.items, a.p_items) || existing.total !== a.p_total_points) return raise(`quote idempotency conflict for ${a.p_quote_id}`);
        return ok({ success: true, quote_id: existing.id, status: existing.status, total_reserved_credits: existing.total, expires_at: new Date(existing.expires).toISOString(), already_created: true });
      }
      quotes.set(a.p_quote_id, { id: a.p_quote_id, user_id: a.p_user_id, hash: a.p_quote_hash, items: a.p_items, total: a.p_total_points, status: "quoted", expires: new Date(a.p_expires_at).getTime(), formats: a.p_output_formats });
      return ok({ success: true, quote_id: a.p_quote_id, status: "quoted", total_reserved_credits: a.p_total_points, expires_at: a.p_expires_at });
    },
    accept_quote_atomic: (a) => {
      if (!a.p_quote_id || !a.p_user_id || !/^[0-9a-f]{64}$/.test(String(a.p_expected_quote_hash ?? ""))) return no("invalid_required_argument");
      const q = quotes.get(a.p_quote_id);
      if (!q) return no("quote_not_found");
      if (q.user_id !== a.p_user_id) return no("quote_user_mismatch");
      if (q.hash !== a.p_expected_quote_hash) return no("quote_hash_mismatch");
      const id = quoteJobId(q.id);
      if (q.status === "accepted") {
        const job = jobs.get(id);
        const res = ledger.find((r) => r.id === `res_${id}`);
        if (!job || !res || job.reserved_credits !== q.total || res.delta !== -q.total) return raise(`Accepted quote ${q.id} has inconsistent job or reservation`);
        return ok({ success: true, already_accepted: true, quote_id: q.id, job_id: id, reserved_credits: q.total });
      }
      if (q.status !== "quoted") return no("invalid_quote_status", { status: q.status });
      if (q.expires <= Date.now()) return no("quote_expired");
      if (!(q.total > 0)) return no("invalid_reserved_credits");
      if (q.items.length !== 1) return no("single_item_quote_required");
      const item = q.items[0];
      if (typeof item?.unitPricePoints !== "number") return no("missing_item_unit_price");
      if (!(item.unitPricePoints > 0)) return no("invalid_item_unit_price");
      const min = Number(item.targetVolumeMin ?? 1), max = Number(item.targetVolumeMax ?? 1);
      if (min < 1 || max < min || max > 5000) return no("invalid_target_volume");
      if ([...jobs.values()].filter((j) => j.user_id === q.user_id && (j.status === "queued" || j.status === "running")).length >= 2) return no("concurrency_limit");
      // reserve_credits_atomic: the balance is checked first, and a refusal writes nothing
      if (ledger.some((r) => r.id === `res_${id}`)) return no("inconsistent_reservation");
      if (balance() < q.total) return no("insufficient_balance", { balance: balance() });
      insert({ id: `res_${id}`, delta: -q.total, type: "reserve", job_id: id, user_id: q.user_id });
      jobs.set(id, { id, user_id: q.user_id, status: "queued", endpoint_id: String(item.endpointId || item.capabilitySlug || "default"), target_volume_min: min, reserved_credits: q.total, unit_price: item.unitPricePoints, delivered_units: 0, target_volume_max: max, step: 0, lease_until: null, charged_credits: 0, result_file_id: null, accumulated_cost_usd: 0, current_cursor: null, error_message: null });
      q.status = "accepted";
      return ok({ success: true, already_accepted: false, quote_id: q.id, job_id: id, reserved_credits: q.total });
    },
    claim_job_chunk: (a) => {
      if (a.p_expected_step === null || a.p_expected_step === undefined) return raise("p_expected_step must not be NULL");
      const j = jobs.get(a.p_job_id);
      if (!j) return ok({ claimed: false, error: "job_not_found", job_id: a.p_job_id });
      if (j.status !== "queued" && j.status !== "running") return ok({ claimed: false, error: "invalid_status", status: j.status });
      if (j.current_cursor === "completed" || j.delivered_units >= j.target_volume_max) return ok({ claimed: false, error: "already_completed" });
      if (j.step !== a.p_expected_step) return ok({ claimed: false, error: "step_mismatch", current_step: j.step });
      if (j.lease_until && j.lease_until > Date.now()) return ok({ claimed: false, error: "lease_active" });
      j.status = "running";
      j.lease_until = Date.now() + a.p_lease_seconds * 1000;
      return ok({ claimed: true, job_id: j.id, user_id: j.user_id, step: j.step, delivered_units: j.delivered_units, endpoint_id: j.endpoint_id, unit_price: j.unit_price, target_volume_max: j.target_volume_max, reserved_credits: j.reserved_credits });
    },
    complete_chunk: (a) => {
      const j = jobs.get(a.p_job_id);
      if (!j) return raise(`Job ${a.p_job_id} not found`);
      if (j.step > a.p_expected_step) return ok({ success: true, already_completed: true, job_id: j.id, current_step: j.step, delivered_units: j.delivered_units });
      if (j.step < a.p_expected_step) return raise(`Step mismatch for job ${j.id}`);
      if (a.p_new_delivered_units < j.delivered_units) return raise("Delivered units cannot decrease");
      if (a.p_new_delivered_units > j.target_volume_max) return raise("Delivered units exceeds target_volume_max");
      j.step += 1; j.delivered_units = a.p_new_delivered_units; j.current_cursor = a.p_new_cursor; j.lease_until = null; j.accumulated_cost_usd += a.p_cost_usd ?? 0;
      return ok({ success: true, already_completed: false, job_id: j.id, step: j.step, delivered_units: j.delivered_units, cursor: j.current_cursor });
    },
    settle_job_atomic: (a) => {
      const j = jobs.get(a.p_job_id);
      if (!j) return raise(`Job ${a.p_job_id} not found`);
      if (j.status === "completed") return ok({ success: true, already_settled: true, job_id: j.id, charged_credits: j.charged_credits, delivered_units: j.delivered_units });
      if (j.status !== "running") return raise(`Cannot settle job ${j.id} with status ${j.status} (must be running)`);
      if (j.lease_until && j.lease_until > Date.now()) {
        if (j.current_cursor === "completed" || j.delivered_units >= j.target_volume_max) j.lease_until = null;
        else return raise(`Cannot settle job ${j.id} while active chunk lease is held`);
      }
      if (!(j.unit_price > 0)) return raise(`Job ${j.id} has invalid unit_price`);
      if (!(j.reserved_credits > 0)) return raise(`Job ${j.id} has invalid reserved_credits`);
      if (!ledger.some((r) => r.id === `res_${j.id}`)) return raise(`Reserve record res_${j.id} does not exist`);
      // RELEASE FIRST, then the charge: both only if absent
      if (!ledger.some((r) => r.id === `rel_${j.id}`)) insert({ id: `rel_${j.id}`, delta: j.reserved_credits, type: "release", job_id: j.id, user_id: j.user_id });
      const charge = Math.min(Math.ceil(j.delivered_units * j.unit_price - 1e-9), j.reserved_credits, a.p_points_cap ?? 25_000);
      if (!ledger.some((r) => r.id === `chg_${j.id}`) && charge > 0) insert({ id: `chg_${j.id}`, delta: -charge, type: "charge", job_id: j.id, user_id: j.user_id });
      j.status = "completed"; j.charged_credits = charge; j.result_file_id = a.p_result_file_id ?? j.result_file_id; j.lease_until = null;
      return ok({ success: true, already_settled: false, job_id: j.id, user_id: j.user_id, reserved_credits: j.reserved_credits, charged_credits: charge, delivered_units: j.delivered_units });
    },
    release_job_atomic: (a) => {
      const j = jobs.get(a.p_job_id);
      if (!j) return raise(`Job ${a.p_job_id} not found`);
      if (j.status === "completed") return raise(`Cannot release already completed job ${j.id}`);
      if (j.status !== "queued" && j.status !== "running" && j.status !== "failed") return raise(`Cannot release job ${j.id} with status ${j.status}`);
      if (!(j.reserved_credits > 0)) return raise(`Job ${j.id} has invalid reserved_credits`);
      if (!ledger.some((r) => r.id === `res_${j.id}`)) return raise(`Reserve record res_${j.id} does not exist`);
      const hasRelease = ledger.some((r) => r.id === `rel_${j.id}`);
      if (hasRelease && j.status === "failed") return ok({ success: true, already_released: true, job_id: j.id, released_credits: j.reserved_credits });
      if (j.lease_until && j.lease_until > Date.now() && a.p_force !== true) return raise(`Cannot release job ${j.id} while active chunk lease is held`);
      if (!hasRelease) insert({ id: `rel_${j.id}`, delta: j.reserved_credits, type: "release", job_id: j.id, user_id: j.user_id });
      j.status = "failed"; j.charged_credits = 0; j.lease_until = null; j.error_message = a.p_error_message ?? j.error_message ?? "فشلت المهمة";
      return ok({ success: true, already_released: false, job_id: j.id, user_id: j.user_id, released_credits: j.reserved_credits });
    },
  };

  const client = {
    rpc: async (name: string, args: any) => {
      calls.push({ name, args });
      const h = handlers[name];
      if (!h) return { error: { message: `unknown function ${name}` } };
      const fault = injected.get(name)?.shift();
      if (fault === "before") throw new Error(`injected: ${name} failed before it ran`);
      let out: { data?: any; error?: any };
      // a database error inside a function rolls the whole call back (the fake's functions check before they write, so a throw here only comes from the ledger's unique key)
      try { out = h(args); } catch (e) { out = { error: { message: String((e as Error).message) } }; }
      if (fault === "after") throw new Error(`injected: the answer of ${name} was lost`);
      return out;
    },
    from: (table: string) => { throw new Error(`a table was touched by hand: ${table}`); },
  };
  /** The NEXT call of `name` fails: "before" = it never ran, "after" = it ran and committed but the caller never got the answer. */
  const inject = (name: string, when: "before" | "after"): void => { injected.set(name, [...(injected.get(name) ?? []), when]); };
  return { client, quotes, jobs, ledger, calls, balance, inject };
}
