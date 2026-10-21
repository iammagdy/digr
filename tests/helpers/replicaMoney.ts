import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";

/** Drives the REAL production functions (loaded into the replica) the way the app does: quote, accept, chunks, settle or release. */

export const SAFETY_BUFFER = 1.15;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A unit price held as an exact decimal: `thousandths / 1000`. ceil(delivered x price) is then exact integer math. */
export function exactCharge(delivered: number, unitThousandths: number): number {
  const num = BigInt(delivered) * BigInt(unitThousandths);
  return Number((num + BigInt(999)) / BigInt(1000));
}
export function exactReserve(volume: number, unitThousandths: number): number {
  // ceil(volume x price x 1.15) = ceil(volume x thousandths x 115 / 100000)
  const num = BigInt(volume) * BigInt(unitThousandths) * BigInt(115);
  return Number((num + BigInt(99999)) / BigInt(100000));
}
export const priceOf = (thousandths: number) => thousandths / 1000;

export async function seedUser(pool: Pool, balance: number): Promise<string> {
  const id = randomUUID();
  await pool.query("insert into auth.users(id) values ($1)", [id]);
  await pool.query("insert into public.profiles(id, email) values ($1, $2)", [id, `${id}@example.test`]);
  if (balance > 0) {
    await pool.query("insert into public.credit_ledger(id,user_id,delta,type,note) values ($1,$2,$3,'grant','test grant')", [`grant_${id}`, id, balance]);
  }
  return id;
}

export const balanceOf = async (pool: Pool, userId: string): Promise<number> =>
  Number((await pool.query("select coalesce(sum(delta),0) as b from public.credit_ledger where user_id=$1", [userId])).rows[0].b);

export interface QuoteInput {
  unit: number;
  volume: number;
  /** override the reserve (default: ceil(volume x unit x 1.15) computed exactly) */
  reserve?: number;
  quoteId?: string;
}

export function hash64(seed: string): string { return createHash("sha256").update(seed).digest("hex"); }

export async function createQuote(pool: Pool, userId: string, q: QuoteInput & { reserve: number }) {
  const quoteId = q.quoteId ?? `quote_${randomUUID()}`;
  const items = [{ capabilitySlug: "x-posts", endpointId: "test.endpoint", targetVolumeMin: 1, targetVolumeMax: q.volume, unitPricePoints: q.unit }];
  const res = await pool.query(
    "select public.create_quote_atomic($1::uuid,$2,$3,$4::jsonb,$5::numeric,$6::text[],$7::timestamptz,'{}'::text[]) as r",
    [userId, quoteId, hash64(quoteId), JSON.stringify(items), q.reserve, ["xlsx"], new Date(Date.now() + 30 * 60_000).toISOString()],
  );
  return { quoteId, quoteHash: hash64(quoteId), result: res.rows[0].r };
}

export async function acceptQuote(pool: Pool, userId: string, quoteId: string) {
  const res = await pool.query("select public.accept_quote_atomic($1,$2::uuid,$3) as r", [quoteId, userId, hash64(quoteId)]);
  return res.rows[0].r as Record<string, any>;
}

/** Quote + accept: returns the job id on success. */
export async function startJob(pool: Pool, userId: string, q: QuoteInput) {
  const reserve = q.reserve ?? exactReserve(q.volume, Math.round(q.unit * 1000));
  const created = await createQuote(pool, userId, { ...q, reserve });
  const accepted = await acceptQuote(pool, userId, created.quoteId);
  return { ...created, reserve, accepted, jobId: accepted.job_id as string | undefined };
}

/** Collect `delivered` records in chunks of `chunk` through the real claim / complete functions; `finish` marks the cursor completed. */
export async function deliver(pool: Pool, jobId: string, delivered: number, chunk = 50, finish = true) {
  let done = 0;
  let step = 0;
  while (done < delivered) {
    const claim = (await pool.query("select public.claim_job_chunk($1,$2,60) as r", [jobId, step])).rows[0].r;
    if (!claim.claimed) throw new Error(`claim refused: ${JSON.stringify(claim)}`);
    done = Math.min(delivered, done + chunk);
    const last = done >= delivered;
    await pool.query("select public.complete_chunk($1,$2,$3,$4,0)", [jobId, step, last && finish ? "completed" : `cursor_${step + 1}`, done]);
    step += 1;
  }
  if (delivered === 0) {
    const claim = (await pool.query("select public.claim_job_chunk($1,0,60) as r", [jobId])).rows[0].r;
    if (claim.claimed) await pool.query(finish ? "select public.complete_chunk($1,0,'completed',0,0)" : "update public.jobs set lease_until = null where id = $1", [jobId]);
  }
}

export async function settle(pool: Pool, jobId: string, cap: number) {
  return (await pool.query("select public.settle_job_atomic($1,$2::numeric,null) as r", [jobId, cap])).rows[0].r as Record<string, any>;
}

export async function ledgerOf(pool: Pool, jobId: string) {
  const rows = (await pool.query("select id, type, delta::float8 as delta from public.credit_ledger where job_id=$1 order by created_at, id", [jobId])).rows;
  const byType = (t: string) => rows.filter((r) => r.type === t);
  const sum = (t: string) => byType(t).reduce((s: number, r: any) => s + Number(r.delta), 0);
  return { rows, reserve: sum("reserve"), release: sum("release"), charge: sum("charge"), net: rows.reduce((s: number, r: any) => s + Number(r.delta), 0), counts: { reserve: byType("reserve").length, release: byType("release").length, charge: byType("charge").length } };
}
