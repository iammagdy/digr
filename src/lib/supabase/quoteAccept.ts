import { SupabaseClient } from "@supabase/supabase-js";
import { computePlanHash, parseStoredPlan, PlanItem } from "../../functions/shared/planManager";
import { isQuoteExpired } from "../../functions/shared/quotes";
import { reserveCreditsAtomic } from "./ledger";
import crypto from "crypto";


export interface AcceptQuoteOptions {
  userId: string;
  quoteId: string;
  expectedPlanHash?: string;
}

export interface AcceptQuoteResult {
  success: boolean;
  jobId?: string;
  quoteId?: string;
  reservedCredits?: number;
  errorAr?: string;
  statusCode?: number;
}

export const MAX_CONCURRENT_JOBS_PER_USER = 2;

/**
 * Server-side quote acceptance and job initiation on Supabase.
 * - Quote belongs to the verified user
 * - Quote status is 'quoted'
 * - 30-minute expiry check
 * - Plan hash cryptographic binding
 * - Per-user concurrency limit (max 2 active jobs)
 * - Atomic reserve function: reserve_credits_atomic
 * - Status transition to 'accepted'
 * - Job creation (status: queued)
 * - Job event log
 */
export async function acceptQuoteSupabase(
  adminClient: SupabaseClient,
  options: AcceptQuoteOptions
): Promise<AcceptQuoteResult> {
  const { userId, quoteId, expectedPlanHash } = options;

  // 1. Fetch Quote Document
  const { data: quoteDoc, error: quoteErr } = await adminClient
    .from("plans_quotes")
    .select("*")
    .eq("id", quoteId)
    .single();

  if (quoteErr || !quoteDoc) {
    return {
      success: false,
      statusCode: 404,
      errorAr: "عرض السعر غير موجود أو تم حذفه.",
    };
  }

  // 2. Authorization check: Quote belongs to the verified user
  if (quoteDoc.user_id !== userId) {
    return {
      success: false,
      statusCode: 403,
      errorAr: "غير مصرح لك باعتماد هذا العرض.",
    };
  }

  // 3. Status check
  if (quoteDoc.status === "accepted") {
    return {
      success: false,
      statusCode: 409,
      errorAr: "تم بدء تنفيذ هذا العرض مسبقاً ولا يمكن تكراره.",
    };
  }

  if (quoteDoc.status === "expired" || quoteDoc.status === "refused") {
    return {
      success: false,
      statusCode: 409,
      errorAr: "تم انتهاء صلاحية هذا العرض أو استبداله بعرض أحدث.",
    };
  }

  if (quoteDoc.status !== "quoted") {
    return {
      success: false,
      statusCode: 400,
      errorAr: "حالة العرض غير صالحة للبدء.",
    };
  }

  // 4. Expiry check (30 minutes hard limit)
  if (isQuoteExpired(quoteDoc.expires_at)) {
    return {
      success: false,
      statusCode: 410,
      errorAr: "انتهت صلاحية هذا العرض (30 دقيقة). يرجى طلب عرض جديد.",
    };
  }

  // 5. Plan Hash Binding Check
  const rawItems = typeof quoteDoc.items === "string" ? JSON.parse(quoteDoc.items) : (quoteDoc.items || []);
  const parsedPlan = parseStoredPlan(typeof quoteDoc.items === "string" ? quoteDoc.items : JSON.stringify(quoteDoc.items));
  const items: PlanItem[] = parsedPlan.items?.length ? parsedPlan.items : rawItems;

  const computedHash = computePlanHash(items, quoteDoc.output_formats);
  if (expectedPlanHash && expectedPlanHash !== computedHash && expectedPlanHash !== quoteDoc.quote_hash) {
    return {
      success: false,
      statusCode: 400,
      errorAr: "تغيرت تفاصيل الخطة بعد إصدار العرض. يرجى إعادة طلب عرض سعر.",
    };
  }

  // 6. Per-User Concurrency Limit Check (Max 2 concurrent running/queued jobs)
  const { count: activeCount, error: countErr } = await adminClient
    .from("jobs")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["queued", "running"]);

  if (!countErr && typeof activeCount === "number" && activeCount >= MAX_CONCURRENT_JOBS_PER_USER) {
    return {
      success: false,
      statusCode: 429,
      errorAr: `لديك ${activeCount} طلبات قيد المعالجة حالياً. يرجى انتظار اكتمالها قبل بدء طلب جديد (الحد الأقصى: ${MAX_CONCURRENT_JOBS_PER_USER}).`,
    };
  }

  // 7. Plan Items Validation: Single-item constraint & strict unit price check
  if (items.length !== 1) {
    return {
      success: false,
      statusCode: 400,
      errorAr: "عروض الأسعار تدعم تنفيذ قدرة بحثية واحدة لكل طلب حالياً.",
    };
  }

  const firstItem = items[0];
  const unitPrice = (firstItem as any)?.unitPricePoints;
  if (typeof unitPrice !== "number" || !Number.isFinite(unitPrice) || unitPrice <= 0) {
    return {
      success: false,
      statusCode: 400,
      errorAr: "سعر الوحدة غير محدد أو غير صالح في بنود العرض.",
    };
  }

  const requiredPoints = Number(quoteDoc.total_reserved_credits);
  const jobId = `job_${crypto.randomBytes(12).toString("hex")}`;

  // 8. Atomic Reserve Call via Postgres RPC (takes FOR UPDATE profile lock)
  const reserveRes = await reserveCreditsAtomic(
    adminClient,
    userId,
    jobId,
    requiredPoints,
    "حجز رصيد للطلب"
  );

  if (!reserveRes.success) {
    if (reserveRes.error === "insufficient_balance") {
      const balance = reserveRes.balance || 0;
      return {
        success: false,
        statusCode: 402,
        errorAr: `رصيدك الحالي (${balance} نقطة) غير كافٍ لتغطية تكلفة العرض (${requiredPoints} نقطة). يرجى شحن الرصيد أولاً.`,
      };
    }
    return {
      success: false,
      statusCode: 400,
      errorAr: "تعذر حجز الرصيد المطلوب.",
    };
  }

  // 9. Update Quote Document to 'accepted'
  await adminClient
    .from("plans_quotes")
    .update({ status: "accepted" })
    .eq("id", quoteId);

  // 10. Create Job row in 'jobs' with exact unit_price from quote item
  await adminClient
    .from("jobs")
    .insert({
      id: jobId,
      user_id: userId,
      status: "queued",
      endpoint_id: firstItem.endpointId || firstItem.capabilitySlug || "default",
      unit_price: unitPrice,
      target_volume_min: firstItem.targetVolumeMin || 1,
      target_volume_max: firstItem.targetVolumeMax || 1,
      reserved_credits: requiredPoints,
      charged_credits: 0,
      delivered_units: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

  // 10. Create initial progress event in 'job_events'
  await adminClient
    .from("job_events")
    .insert({
      job_id: jobId,
      user_id: userId,
      message: "تم اعتماد الخطة وحجز النقاط بنجاح. جاري بدء معالجة الطلب...",
      units: 0,
      event_type: "progress",
      created_at: new Date().toISOString(),
    });

  return {
    success: true,
    jobId,
    quoteId,
    reservedCredits: requiredPoints,
  };
}
