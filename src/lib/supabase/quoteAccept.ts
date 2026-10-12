import { SupabaseClient } from "@supabase/supabase-js";

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
  alreadyAccepted?: boolean;
  errorAr?: string;
  statusCode?: number;
}

export const MAX_CONCURRENT_JOBS_PER_USER = 2;

/**
 * Server-side atomic quote acceptance and job initiation on Supabase.
 * Delegates 100% of concurrency locks, balance check, credit reservation,
 * and deterministic job creation to the approved accept_quote_atomic RPC.
 */
export async function acceptQuoteSupabase(
  adminClient: SupabaseClient,
  options: AcceptQuoteOptions
): Promise<AcceptQuoteResult> {
  const { userId, quoteId, expectedPlanHash } = options;

  if (!quoteId || typeof quoteId !== "string" || !userId || typeof userId !== "string") {
    return {
      success: false,
      statusCode: 400,
      errorAr: "معرف المستخدم ومعرف عرض السعر مطلوبان.",
    };
  }

  // If expectedPlanHash is not supplied by the caller, fetch quote_hash directly
  let hashToVerify = expectedPlanHash;
  if (!hashToVerify) {
    const { data: quoteDoc, error: qErr } = await adminClient
      .from("plans_quotes")
      .select("quote_hash")
      .eq("id", quoteId)
      .single();

    if (qErr || !quoteDoc) {
      return {
        success: false,
        statusCode: 404,
        errorAr: "عرض السعر غير موجود أو تم حذفه.",
      };
    }
    hashToVerify = quoteDoc.quote_hash;
  }

  // Execute approved accept_quote_atomic RPC (security definer, profile lock, release-first sequence)
  const { data: rpcRes, error: rpcErr } = await adminClient.rpc("accept_quote_atomic", {
    p_quote_id: quoteId,
    p_user_id: userId,
    p_expected_quote_hash: hashToVerify,
  });

  if (rpcErr) {
    return {
      success: false,
      statusCode: 400,
      errorAr: rpcErr.message || "تعذر اعتماد العرض في قاعدة البيانات.",
    };
  }

  if (!rpcRes?.success) {
    const errMap: Record<string, { status: number; msg: string }> = {
      quote_not_found: { status: 404, msg: "عرض السعر غير موجود أو تم حذفه." },
      quote_user_mismatch: { status: 403, msg: "غير مصرح لك باعتماد هذا العرض." },
      quote_hash_mismatch: { status: 400, msg: "تغيرت تفاصيل الخطة بعد إصدار العرض. يرجى إعادة طلب عرض سعر." },
      invalid_quote_status: { status: 409, msg: "حالة العرض غير صالحة للبدء." },
      quote_expired: { status: 410, msg: "انتهت صلاحية هذا العرض (30 دقيقة). يرجى طلب عرض جديد." },
      concurrency_limit_exceeded: { status: 429, msg: "لديك طلبات قيد المعالجة حالياً تجاوزت الحد الأقصى (طلبان نشطان)." },
      insufficient_balance: { status: 402, msg: "رصيدك الحالي غير كافٍ لتغطية تكلفة العرض. يرجى شحن الرصيد أولاً." },
      single_item_quote_required: { status: 400, msg: "عروض الأسعار تدعم تنفيذ قدرة بحثية واحدة لكل طلب حالياً." },
      missing_item_unit_price: { status: 400, msg: "سعر الوحدة غير محدد أو غير صالح في بنود العرض." },
      invalid_required_argument: { status: 400, msg: "بيانات العرض أو بصمة الخطة غير صالحة." },
    };

    const mapped = errMap[rpcRes?.error] || {
      status: 400,
      msg: rpcRes?.error || "تعذر اعتماد العرض.",
    };

    return {
      success: false,
      statusCode: mapped.status,
      errorAr: mapped.msg,
    };
  }

  if (rpcRes.already_accepted) {
    return {
      success: false,
      statusCode: 409,
      errorAr: "تم بدء تنفيذ هذا العرض مسبقاً ولا يمكن تكراره.",
    };
  }

  return {
    success: true,
    jobId: rpcRes.job_id,
    quoteId: rpcRes.quote_id,
    reservedCredits: Number(rpcRes.reserved_credits),
    alreadyAccepted: Boolean(rpcRes.already_accepted),
  };
}
