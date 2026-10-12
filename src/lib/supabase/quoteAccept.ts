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
  currentBalance?: number;
}

export const MAX_CONCURRENT_JOBS_PER_USER = 2;

/**
 * Converts English digits (0-9) to Arabic-Indic digits (٠-٩).
 */
export function toArabicDigits(val: number | string): string {
  const arabicDigits = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
  return String(val).replace(/[0-9]/g, (d) => arabicDigits[Number(d)]);
}

/**
 * Server-side atomic quote acceptance and job initiation on Supabase.
 * Delegates all concurrency locks, balance checks, credit reservation,
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

  // Never return raw database error messages or SQL syntax to callers
  if (rpcErr) {
    console.error("[acceptQuoteSupabase] RPC Execution Error:", rpcErr);
    return {
      success: false,
      statusCode: 500,
      errorAr: "حدث خطأ أثناء معالجة اعتماد العرض. يرجى المحاولة مرة أخرى.",
    };
  }

  if (!rpcRes?.success) {
    const errCode = rpcRes?.error;

    // 402 Insufficient Balance with current balance rendered in Arabic-Indic numerals
    if (errCode === "insufficient_balance") {
      const balanceNum = Number(rpcRes?.balance ?? 0);
      const balanceArabic = toArabicDigits(balanceNum);
      return {
        success: false,
        statusCode: 402,
        currentBalance: balanceNum,
        errorAr: `رصيدك الحالي (${balanceArabic} نقطة) غير كافٍ لتغطية تكلفة هذا العرض. يرجى شحن الرصيد أولاً.`,
      };
    }

    // 410 Expired Quote
    if (errCode === "quote_expired") {
      return {
        success: false,
        statusCode: 410,
        errorAr: "انتهت صلاحية هذا العرض (30 دقيقة). يرجى طلب عرض جديد.",
      };
    }

    // 429 Concurrency Limit
    if (errCode === "concurrency_limit" || errCode === "concurrency_limit_exceeded") {
      return {
        success: false,
        statusCode: 429,
        errorAr: "لديك طلبات قيد المعالجة حالياً تجاوزت الحد الأقصى (طلبان نشطان). يرجى الانتظار حتى اكتمال أحدهما.",
      };
    }

    // 409 Quote Already Accepted or invalid status
    if (errCode === "invalid_quote_status") {
      return {
        success: false,
        statusCode: 409,
        errorAr: "حالة العرض غير صالحة للبدء.",
      };
    }

    // 404 Quote Not Found
    if (errCode === "quote_not_found") {
      return {
        success: false,
        statusCode: 404,
        errorAr: "عرض السعر غير موجود أو تم حذفه.",
      };
    }

    // 403 Quote User Mismatch
    if (errCode === "quote_user_mismatch") {
      return {
        success: false,
        statusCode: 403,
        errorAr: "غير مصرح لك باعتماد هذا العرض.",
      };
    }

    // 400 Hash mismatch or single-item restriction
    if (errCode === "quote_hash_mismatch") {
      return {
        success: false,
        statusCode: 400,
        errorAr: "تغيرت تفاصيل الخطة بعد إصدار العرض. يرجى إعادة طلب عرض سعر.",
      };
    }

    if (errCode === "single_item_quote_required") {
      return {
        success: false,
        statusCode: 400,
        errorAr: "عروض الأسعار تدعم تنفيذ قدرة بحثية واحدة لكل طلب حالياً.",
      };
    }

    if (errCode === "missing_item_unit_price" || errCode === "invalid_item_unit_price") {
      return {
        success: false,
        statusCode: 400,
        errorAr: "سعر الوحدة غير محدد أو غير صالح في بنود العرض.",
      };
    }

    // Default 400 with clean Arabic text, never leaking raw strings
    return {
      success: false,
      statusCode: 400,
      errorAr: "تعذر اعتماد العرض. يرجى المحاولة مرة أخرى أو مراجعة المشرف.",
    };
  }

  // Idempotent duplicate accept check
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
