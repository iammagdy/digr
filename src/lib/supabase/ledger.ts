import { SupabaseClient } from "@supabase/supabase-js";

export const CREDIT_LEDGER_TABLE = "credit_ledger";

/**
 * Calculates the true balance of a user across all ledger rows.
 * Implements full server-side pagination to eliminate PostgREST 1,000-row truncation.
 */
export async function calculateBalance(
  client: SupabaseClient | any,
  userId: string
): Promise<number> {
  const query = client
    .from(CREDIT_LEDGER_TABLE)
    .select("delta")
    .eq("user_id", userId);

  // If query does not support range pagination (e.g. simplified test mock without range)
  if (typeof query?.range !== "function") {
    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to calculate balance: ${error.message}`);
    }
    return (data || []).reduce((sum: number, row: any) => sum + Number(row.delta || 0), 0);
  }

  // Paginate through all ledger entries in batches of 1000
  let total = 0;
  let from = 0;
  const batchSize = 1000;

  while (true) {
    const to = from + batchSize - 1;
    const { data, error } = await client
      .from(CREDIT_LEDGER_TABLE)
      .select("delta")
      .eq("user_id", userId)
      .range(from, to);

    if (error) {
      throw new Error(`Failed to calculate balance: ${error.message}`);
    }

    if (!data || data.length === 0) {
      break;
    }

    for (const row of data) {
      total += Number(row.delta || 0);
    }

    if (data.length < batchSize) {
      break;
    }

    from += batchSize;
  }

  return total;
}

export const getBalance = calculateBalance;

/**
 * Calls the atomic PostgreSQL reserve function `reserve_credits_atomic`.
 * - Takes an exclusive lock on the user's profile row
 * - Checks true balance
 * - Idempotently handles res_<jobId>
 * - Returns success, already_reserved, and updated balance
 */
export async function reserveCreditsAtomic(
  adminClient: SupabaseClient,
  userId: string,
  jobId: string,
  amount: number,
  note?: string
): Promise<{
  success: boolean;
  already_reserved?: boolean;
  balance?: number;
  error?: string;
}> {
  if (amount <= 0) {
    throw new Error("Reservation amount must be strictly positive");
  }

  const { data, error } = await adminClient.rpc("reserve_credits_atomic", {
    p_user_id: userId,
    p_job_id: jobId,
    p_amount: amount,
    p_note: note || "حجز رصيد للطلب",
  });

  if (error) {
    throw new Error(`Atomic reservation failed: ${error.message}`);
  }

  return data as {
    success: boolean;
    already_reserved?: boolean;
    balance?: number;
    error?: string;
  };
}

/**
 * Creates a deterministic release entry: ID = rel_<jobId>
 */
export async function releaseCredits(
  adminClient: SupabaseClient,
  userId: string,
  jobId: string,
  amount: number,
  note?: string
) {
  const rowId = `rel_${jobId}`;
  const { data, error } = await adminClient
    .from(CREDIT_LEDGER_TABLE)
    .insert({
      id: rowId,
      user_id: userId,
      delta: Math.abs(amount),
      type: "release",
      job_id: jobId,
      note: note || "إلغاء حجز الرصيد",
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Idempotent release of a job reservation using deterministic ID `rel_<jobId>`.
 * If `rel_<jobId>` already exists (code 23505 unique violation), returns:
 * `{ released: false, alreadyReleased: true, rowId }` without throwing.
 */
export async function releaseReservation(
  adminClient: SupabaseClient,
  userId: string,
  jobId: string,
  amount: number,
  note?: string
): Promise<{ released: boolean; alreadyReleased: boolean; rowId: string }> {
  const rowId = `rel_${jobId}`;
  try {
    await releaseCredits(adminClient, userId, jobId, amount, note);
    return { released: true, alreadyReleased: false, rowId };
  } catch (err: any) {
    if (err?.code === "23505" || err?.status === 409 || err?.message?.includes("duplicate key")) {
      return { released: false, alreadyReleased: true, rowId };
    }
    throw err;
  }
}

/**
 * Creates a deterministic charge entry: ID = chg_<jobId>
 * Strictly capped at reservedCredits.
 */
export async function chargeCredits(
  adminClient: SupabaseClient,
  userId: string,
  jobId: string,
  amount: number,
  reservedCredits?: number,
  note?: string
) {
  let finalAmount = Math.abs(amount);
  if (reservedCredits !== undefined && reservedCredits !== null) {
    finalAmount = Math.min(finalAmount, Math.abs(reservedCredits));
  }
  const rowId = `chg_${jobId}`;

  const { data, error } = await adminClient
    .from(CREDIT_LEDGER_TABLE)
    .insert({
      id: rowId,
      user_id: userId,
      delta: -finalAmount,
      type: "charge",
      job_id: jobId,
      note: note || "خصم تكلفة الطلب الفعلية",
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Executes the release-first completion sequence:
 * 1. Create rel_<jobId> (+reserve)
 *    If rel_ already exists (conflict), aborts without charging (already settled/refunded).
 * 2. If release succeeded, create chg_<jobId> (-chargedCredits, capped at reservedCredits).
 */
export async function completeJobWithRelFirst(
  adminClient: SupabaseClient,
  userId: string,
  jobId: string,
  reservedCredits: number,
  chargedCredits: number,
  note?: string
): Promise<{ released: boolean; charged: boolean; finalCharged: number }> {
  const finalCharged = Math.min(
    Math.abs(reservedCredits),
    Math.max(0, Math.abs(chargedCredits))
  );

  // 1. Release first
  try {
    await releaseCredits(
      adminClient,
      userId,
      jobId,
      reservedCredits,
      note || "إلغاء حجز الرصيد عند اكتمال الطلب"
    );
  } catch (err: any) {
    if (err?.code === "23505" || err?.status === 409 || err?.message?.includes("duplicate key")) {
      return { released: false, charged: false, finalCharged: 0 };
    }
    throw err;
  }

  // 2. Charge delivered credits (only if release succeeded)
  await chargeCredits(
    adminClient,
    userId,
    jobId,
    finalCharged,
    reservedCredits,
    note || "خصم تكلفة الطلب الفعلية"
  );

  return { released: true, charged: true, finalCharged };
}

/**
 * Creates a deterministic top-up entry: ID = top_<topupId>
 */
export async function applyTopup(
  adminClient: SupabaseClient,
  userId: string,
  topupId: string,
  credits: number,
  note?: string
) {
  const rowId = `top_${topupId}`;
  const { data, error } = await adminClient
    .from(CREDIT_LEDGER_TABLE)
    .insert({
      id: rowId,
      user_id: userId,
      delta: Math.abs(credits),
      type: "topup",
      topup_id: topupId,
      note: note || "شحن رصيد معتمد",
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}
