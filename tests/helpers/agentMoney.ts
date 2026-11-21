import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MemoryDb } from "./memoryDb";

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

type DeliveryTrial = {
  started: number; due: number; phase: "verifying" | "release_only";
  verify_count: number; release_count: number; candidate: any; delivery: any;
  id: string | null; worker: string | null; verified: boolean;
};

const JOURNAL_RPC = "claim_agent_delivery_attempt_atomic";
const FINALIZE_RPC = "finalize_agent_delivery_atomic";

export function fakeMoneyClient(options: { balance?: number; cap?: number; /** a database where the per-stage settlement was not applied yet: PostgREST answers PGRST202 */ withoutPerStageSettlement?: boolean } = {}) {
  const quotes = new Map<string, FakeQuote>();
  const jobs = new Map<string, FakeJob>();
  const ledger: LedgerRow[] = [{ id: "top_1", delta: options.balance ?? 100_000, type: "topup" }];
  const calls: Array<{ name: string; args: any }> = [];
  const rpcCalls: typeof calls = [];
  const attempts = new Map<string, DeliveryTrial>();
  const receipts = new Map<string, Record<string, unknown>>();
  let deliveryMissions: { get(id: string): { worker_id?: string | null; status?: string } | undefined; park(id: string, due: string): void } | undefined;
  const deliveryJob = (id: string) => {
    const quote = [...quotes.values()].find((candidate) => candidate.status === "accepted" && candidate.items[0]?.missionId === id);
    return quote ? jobs.get(quoteJobId(quote.id)) : undefined;
  };
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
    // DT-20261119-01: the per-stage settlement (supabase/migrations/20261119020000_settle_job_by_stage_atomic.sql), the same rules as the SQL (the replica test runs the SAME scenarios on a real PostgreSQL). A database error is code P0001 like every RAISE EXCEPTION.
    settle_job_by_stage_atomic: (a) => {
      const x = (message: string) => ({ error: { code: "P0001", message } });
      const j = jobs.get(a.p_job_id);
      if (!j) return x(`Job ${a.p_job_id} not found`);
      if (j.status === "completed") return ok({ success: true, already_settled: true, job_id: j.id, charged_credits: j.charged_credits, delivered_units: j.delivered_units });
      if (j.status !== "running") return x(`Cannot settle job ${j.id} with status ${j.status} (must be running)`);
      if (j.lease_until && j.lease_until > Date.now()) {
        if (j.current_cursor === "completed" || j.delivered_units >= j.target_volume_max) j.lease_until = null;
        else return x(`Cannot settle job ${j.id} while active chunk lease is held`);
      }
      if (!(j.unit_price > 0)) return x(`Job ${j.id} has invalid unit_price`);
      if (!(j.reserved_credits > 0)) return x(`Job ${j.id} has invalid reserved_credits`);
      if (!ledger.some((r) => r.id === `res_${j.id}`)) return x(`Reserve record res_${j.id} does not exist`);
      const q = [...quotes.values()].find((z) => quoteJobId(z.id) === j.id && z.user_id === j.user_id);
      if (!q) return x(`Accepted quote for job ${j.id} not found`);
      if (q.status !== "accepted") return x(`Quote for job ${j.id} is not accepted`);
      const item = q.items[0];
      const dec6 = /^[0-9]+(\.[0-9]{1,6})?$/, whole = /^[0-9]+$/;
      const P = item?.stageUnitsPoints, R = item?.stageRowsPlanned;
      const obj = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
      if (!(obj(P) && obj(R) && dec6.test(String(P.base)) && dec6.test(String(P.estimated)) && whole.test(String(R.base)) && whole.test(String(R.estimated)) && Number(P.base) > 0)) return x(`Quote for job ${j.id} has no per-stage unit prices`);
      const U = a.p_units;
      if (!(obj(U) && typeof U.base !== "undefined" && typeof U.estimated !== "undefined" && whole.test(String(U.base)) && whole.test(String(U.estimated)))) return x(`Invalid delivered units per stage for job ${j.id}`);
      const dc = Number(U.base), dp = Number(U.estimated);
      if (dc > Number(R.base) || dp > Number(R.estimated) || dc + dp !== j.delivered_units) return x(`Delivered units per stage do not match job ${j.id}`);
      if (!ledger.some((r) => r.id === `rel_${j.id}`)) insert({ id: `rel_${j.id}`, delta: j.reserved_credits, type: "release", job_id: j.id, user_id: j.user_id });
      const m = (v: number): bigint => BigInt(Math.round(v * 1_000_000)), S = BigInt(1_000_000);
      const ceilMicro = (v: bigint): bigint => (v + S - BigInt(1)) / S;
      const byStage = ceilMicro(BigInt(dc) * m(Number(P.base)) + BigInt(dp) * m(Number(P.estimated)));
      const blended = ceilMicro(BigInt(j.delivered_units) * m(j.unit_price));
      const charge = Number([byStage, blended, BigInt(j.reserved_credits), BigInt(a.p_points_cap ?? 25_000)].reduce((u, v) => (v < u ? v : u)));
      if (!ledger.some((r) => r.id === `chg_${j.id}`) && charge > 0) insert({ id: `chg_${j.id}`, delta: -charge, type: "charge", job_id: j.id, user_id: j.user_id });
      j.status = "completed"; j.charged_credits = charge; j.result_file_id = a.p_result_file_id ?? j.result_file_id; j.lease_until = null;
      return ok({ success: true, already_settled: false, job_id: j.id, user_id: j.user_id, reserved_credits: j.reserved_credits, charged_credits: charge, delivered_units: j.delivered_units, base_units: dc, estimated_units: dp });
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

  function currentDeliveryJob(a: any) {
    const row = deliveryMissions?.get(a.p_mission_id);
    if (deliveryMissions && (!row || !a.p_worker_id || row.worker_id !== a.p_worker_id || row.status !== "executing")) return undefined;
    return deliveryJob(a.p_mission_id);
  }

  handlers[JOURNAL_RPC] = (a) => {
    const job = currentDeliveryJob(a);
    const error = (reason: string) => ok({ kind: "error", error: reason });
    if (!job) return error("unowned_or_unlinked");
    const receipt = receipts.get(job.id);
    if (receipt) return ok({ kind: "receipt", receipt });
    if (job.status === "completed" || ledger.some((row) => row.id === `chg_${job.id}`)) return error("unbound_money");
    const legacy = job.status !== "running" || job.step !== 0;
    const now = Date.now();
    let progress = attempts.get(job.id);
    const id = a.p_trial_id;
    const operation = a.p_operation;
    if (operation === "status") return ok(progress ? { kind: "progress", progress } : { kind: legacy ? "legacy_mismatch" : "not_started" });
    if (operation === "begin") {
      if (progress) return ok({ kind: "progress", progress, began: false });
      progress = { started: now, due: now, phase: legacy ? "release_only" : "verifying",
        verify_count: 0, release_count: 0, candidate: null, delivery: null, id: null, worker: null, verified: false };
      attempts.set(job.id, progress);
      return ok({ kind: "progress", progress, began: !legacy });
    }
    if (!progress) return error("missing_journal");
    const next = () => new Date(progress!.due).toISOString();
    const exhausted = progress.phase === "release_only" && progress.release_count === 2;
    if (operation === "park") {
      if (exhausted) return ok({ kind: "exhausted", progress });
      deliveryMissions?.park(a.p_mission_id, next());
      return ok({ kind: "parked", next_at: next() });
    }
    if (operation === "claim") {
      const issued = () => ok({ kind: "attempt", mode: progress!.phase === "verifying" ? "verify" : "release_unsettled",
        progress: structuredClone(progress), trial_id: id, next_at: next() });
      if (!id) return error("missing_trial");
      if (progress.id === id) return progress.worker === a.p_worker_id ? issued() : error("expired_trial");
      if (exhausted) return ok({ kind: "exhausted", progress });
      if (now < progress.due) return ok({ kind: "wait", progress, next_at: next() });
      if (progress.phase === "release_only" || progress.verify_count === 4 || legacy) {
        progress.phase = "release_only";
        progress.release_count += 1;
        progress.due = Math.max(progress.started + 225000, now + 15000);
      } else {
        const offset = [15000, 60000, 150000, 165000][progress.verify_count];
        progress.verify_count += 1;
        progress.due = Math.max(progress.started + offset, now + 15000);
      }
      Object.assign(progress, { id, worker: a.p_worker_id, verified: false });
      return issued();
    }
    if (!id || progress.id !== id || progress.worker !== a.p_worker_id || progress.phase !== "verifying") return error("expired_trial");
    const value = a.p_binding;
    if (operation === "bind_candidate") {
      if (progress.candidate && !isDeepStrictEqual(progress.candidate, value)) return error("candidate_conflict");
      progress.candidate = structuredClone(value);
    } else if (operation === "bind_snapshot") {
      if (!progress.candidate || value.xlsx_sha !== (progress.candidate.xlsx_sha ?? null) ||
          (progress.delivery && !isDeepStrictEqual(progress.delivery, value))) return error("snapshot_conflict");
      progress.delivery = structuredClone(value);
      progress.verified = true;
    } else if (operation === "unreadable") {
      progress.verified = false;
      if (value.code === "binding_mismatch") {
        progress.phase = "release_only";
        progress.due = now;
      } else progress.due = Math.max(progress.due, now + 15000);
      return ok({ kind: "recorded", next_at: next() });
    } else return error("invalid_operation");
    return ok({ kind: "bound" });
  };

  handlers[FINALIZE_RPC] = (a) => {
    const job = currentDeliveryJob(a);
    if (!job) return no("unowned_or_unlinked");
    const existing = receipts.get(job.id);
    const binding = a.p_delivery;
    const release = a.p_mode === "release_unsettled";
    if (existing) {
      if ((release && binding === null) || (!release && isDeepStrictEqual(attempts.get(job.id)?.delivery, binding))) return ok({ success: true, replayed: true, receipt: existing });
      return no("receipt_conflict");
    }
    const progress = attempts.get(job.id);
    if (!progress || !a.p_trial_id || progress.id !== a.p_trial_id || progress.worker !== a.p_worker_id) return no("expired_trial");
    if (release ? (binding !== null || progress.phase !== "release_only")
      : (!progress.verified || progress.phase !== "verifying" || !isDeepStrictEqual(progress.delivery, binding))) return no("delivery_binding_mismatch");
    const reserve = ledger.find((row) => row.id === `res_${job.id}`);
    if (reserve?.job_id !== job.id || reserve?.delta !== -job.reserved_credits || ledger.some((row) => row.id === `chg_${job.id}`)) return no("unbound_money");
    const before = { ...job };
    const ledgerLength = ledger.length;
    const replayLength = calls.length;
    const run = (name: string, args: any) => {
      const fault = injected.get(name)?.shift();
      if (fault || (options.withoutPerStageSettlement && name === "settle_job_by_stage_atomic")) throw new Error(`injected failure in ${name}`);
      const result = handlers[name](args);
      if (result.error || result.data?.success !== true) throw new Error(`unconfirmed ${name}`);
      calls.push(legacyMoneyCall({ name, args }));
      return result.data;
    };
    const billed = binding?.billable_units ?? 0;
    try {
      if (!release) run("complete_chunk", { p_job_id: job.id, p_expected_step: 0, p_new_cursor: "completed", p_new_delivered_units: billed, p_cost_usd: Number(binding.cost_usd) });
      const result = billed > 0
        ? run(binding.stage_units ? "settle_job_by_stage_atomic" : "settle_job_atomic", {
          p_job_id: job.id, ...(binding.stage_units ? { p_units: binding.stage_units } : {}), p_points_cap: 25000, p_result_file_id: binding.csv_path,
        })
        : run("release_job_atomic", { p_job_id: job.id, p_error_message: binding?.release_reason ?? "تعذّر حفظ ملفات النتيجة، فعاد الحجز المؤقت كاملًا.", p_force: true });
      const charged = result.charged_credits ?? 0;
      const receipt = { ...binding, job_id: job.id, mission_id: a.p_mission_id, kind: billed > 0 ? "settled" : "released",
        physical_units: binding?.physical_units ?? 0, billable_units: billed, charged_credits: charged, refunded_credits: job.reserved_credits - charged };
      receipts.set(job.id, receipt);
      return ok({ success: true, replayed: false, receipt });
    } catch (error) {
      Object.assign(job, before);
      ledger.splice(ledgerLength);
      calls.splice(replayLength);
      return raise(String(error));
    }
  };

  const client = {
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      if (name !== JOURNAL_RPC && name !== FINALIZE_RPC) calls.push({ name, args });
      const h = handlers[name];
      if (options.withoutPerStageSettlement === true && name === "settle_job_by_stage_atomic") return { error: { code: "PGRST202", message: "Could not find the function public.settle_job_by_stage_atomic in the schema cache" } };
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
  function bindDeliveryMissions(source: NonNullable<typeof deliveryMissions>) { deliveryMissions = source; }
  function legacyMoneyCall(call: (typeof calls)[number]): (typeof calls)[number] {
    if (call.name === "release_job_atomic") {
      const { p_force: _force, ...args } = call.args;
      return { name: call.name, args };
    }
    if (call.name === "settle_job_atomic" || call.name === "settle_job_by_stage_atomic") {
      const path = call.args.p_result_file_id;
      return { name: call.name, args: { ...call.args, p_result_file_id: typeof path === "string" ? path.replace(/\/sealed\/[a-f0-9]{64}\//, "/") : path } };
    }
    return call;
  }
  return {
    client, quotes, jobs, ledger, balance, inject, receipts, attempts, bindDeliveryMissions,
    // Keep the shared financial trace live for wrappers that copy this object.
    calls, rpcCalls, legacyMoneyTrace: () => calls,
  };
}

/** The application fake for the atomic wrapper. Transaction/lock semantics are proved separately on PostgreSQL. */
export function withAtomicMissionApproval(db: MemoryDb, money: ReturnType<typeof fakeMoneyClient>) {
  const callPrimitive = money.client.rpc;
  const refuse = (error: string) => ({ data: { success: false, error } });
  let queue = Promise.resolve();
  let dropReply = false;
  let failLink = false;
  let refuseClaim = false;

  async function approve(args: any) {
    const row = db.rows("missions").find((m) => m.id === args.p_mission_id && m.user_id === args.p_user_id);
    if (!row) return refuse("not_plan_ready");
    if (["approved", "executing"].includes(row.status) && row.job_id && row.quote_id) return refuse("already_approved");
    if (row.status !== "plan_ready" || row.job_id || row.quote_id) return refuse("not_plan_ready");
    if (row.updated_at !== args.p_expected_updated_at || !isDeepStrictEqual(row.plan, args.p_expected_plan)) return refuse("stale_plan");
    if (Array.from(money.quotes.values()).some((q) => q.status === "accepted" && q.user_id === args.p_user_id
      && q.items.some((i) => i.missionId === row.id && i.endpointId === "agent-mission" && i.capabilitySlug === "agent-mission"))) {
      return refuse("approval_pending");
    }

    const previous = structuredClone({ quotes: money.quotes, jobs: money.jobs, ledger: money.ledger, row });
    function rollback() {
      money.quotes.clear();
      for (const [id, quote] of previous.quotes) money.quotes.set(id, quote);
      money.jobs.clear();
      for (const [id, job] of previous.jobs) money.jobs.set(id, job);
      money.ledger.splice(0, money.ledger.length, ...previous.ledger);
      Object.assign(row, previous.row);
    }
    try {
      const created = await callPrimitive("create_quote_atomic", {
        p_user_id: args.p_user_id, p_quote_id: args.p_quote_id, p_quote_hash: args.p_quote_hash, p_items: args.p_items,
        p_total_points: args.p_total_points, p_output_formats: args.p_output_formats, p_expires_at: args.p_expires_at,
        p_previous_quote_ids: [],
      });
      if (created.error) throw new Error(created.error.message);
      if (!created.data?.success || created.data.already_created) {
        rollback();
        return refuse("quote_failed");
      }
      const accepted = await callPrimitive("accept_quote_atomic", {
        p_user_id: args.p_user_id, p_quote_id: args.p_quote_id, p_expected_quote_hash: args.p_quote_hash,
      });
      if (accepted.error) throw new Error(accepted.error.message);
      if (!accepted.data?.success) {
        rollback();
        return refuse(accepted.data?.error ?? "accept_failed");
      }
      const jobId = accepted.data.job_id;
      const claimed = refuseClaim ? { data: { claimed: false } } : await callPrimitive("claim_job_chunk", {
        p_job_id: jobId, p_expected_step: 0, p_lease_seconds: args.p_lease_seconds,
      });
      refuseClaim = false;
      if (!claimed.data?.claimed) {
        rollback();
        return refuse("claim_failed");
      }
      if (failLink) {
        failLink = false;
        throw new Error("injected: mission link failed before commit");
      }
      const timestamp = new Date().toISOString();
      Object.assign(row, {
        approved_at: timestamp, approved_by: args.p_actor_id, status: "approved", worker_id: null, lease_until: null,
        job_id: jobId, quote_id: args.p_quote_id, reserved_points: accepted.data.reserved_credits,
        unit_price_points: args.p_items[0].unitPricePoints, error: null, updated_at: timestamp,
      });
      if (dropReply) {
        dropReply = false;
        return { error: { message: "injected: the committed mission RPC reply was lost" } };
      }
      return { data: { success: true, job_id: jobId, quote_id: args.p_quote_id, reserved_credits: accepted.data.reserved_credits } };
    } catch (error) {
      rollback();
      return { error: { message: String(error) } };
    }
  }

  return {
    rpc(name: string, args: any) {
      if (name !== "accept_mission_quote_atomic") return callPrimitive(name, args);
      const result = queue.then(() => approve(args));
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    dropNextReply() { dropReply = true; },
    failNextLink() { failLink = true; },
    refuseNextClaim() { refuseClaim = true; },
  };
}
